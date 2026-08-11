import { getDb, uid } from "./db";

// SQLite-backed durable job queue (the Solid Queue / Sidekiq pattern,
// minus the extra service). Jobs survive restarts: state lives in the DB,
// and the boot-time worker requeues anything that was mid-flight.

export type JobType =
  | "github_ingest"
  | "github_resync"
  | "file_resync"
  | "confluence_ingest"
  | "folder_ingest"
  | "graph_ingest"
  | "eval_generate"
  | "eval_run";

export const SYNC_INTERVALS: Record<string, number> = {
  "6h": 6,
  daily: 24,
  weekly: 168,
};

function stampSynced(resourceId: string) {
  const db = getDb();
  const row = db
    .prepare("SELECT sync_interval FROM resources WHERE id = ?")
    .get(resourceId) as { sync_interval: string } | undefined;
  if (!row) return;
  const hours = SYNC_INTERVALS[row.sync_interval];
  db.prepare(
    "UPDATE resources SET last_synced_at = datetime('now'), next_sync_at = ? WHERE id = ?"
  ).run(hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null, resourceId);
}

type JobRow = {
  id: string;
  type: JobType;
  payload: string;
  status: string;
  attempts: number;
};

const MAX_ATTEMPTS = 3;
const POLL_MS = 2000;

export function enqueueJob(type: JobType, payload: Record<string, unknown>) {
  const db = getDb();
  const id = uid();
  db.prepare(
    "INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, 'queued')"
  ).run(id, type, JSON.stringify(payload));
  startWorker();
  return id;
}

async function runJob(job: JobRow) {
  const payload = JSON.parse(job.payload) as Record<string, string>;
  // Handlers are imported lazily to avoid circular imports at module load.
  if (job.type === "github_ingest") {
    const { ingestGithubRepo } = await import("./github");
    await ingestGithubRepo(payload.resourceId, payload.url, payload.branch ?? null);
  } else if (job.type === "github_resync") {
    // Repair from stored bundles when they exist (cheap — only failed/stale
    // sides re-ingest); fall back to a full re-clone when they don't.
    const db = getDb();
    const docs = db
      .prepare(
        "SELECT id, stored_path FROM documents WHERE resource_id = ?"
      )
      .all(payload.resourceId) as { id: string; stored_path: string | null }[];
    if (docs.length > 0 && docs.every((d) => d.stored_path)) {
      const { resyncFileResource } = await import("./rag/ingest");
      await resyncFileResource(payload.resourceId);
    } else {
      const { deleteDocument } = await import("./rag/ingest");
      const { ingestGithubRepo } = await import("./github");
      for (const d of docs) await deleteDocument(d.id);
      await ingestGithubRepo(payload.resourceId, payload.url);
    }
  } else if (job.type === "file_resync") {
    const { resyncFileResource } = await import("./rag/ingest");
    await resyncFileResource(payload.resourceId);
  } else if (job.type === "confluence_ingest") {
    const { ingestConfluenceSpace } = await import("./confluence");
    await ingestConfluenceSpace(payload.resourceId, payload.spaceKey);
  } else if (job.type === "folder_ingest") {
    const { ingestStagedFolder } = await import("./folder");
    await ingestStagedFolder(payload.resourceId);
  } else if (job.type === "eval_generate") {
    const { generateQuestions } = await import("./eval");
    await generateQuestions(
      payload.orgId,
      payload.setId,
      Number(payload.count) || 10,
      payload.userId
    );
  } else if (job.type === "eval_run") {
    const { runEval } = await import("./eval");
    try {
      await runEval(payload.runId);
    } catch (e) {
      getDb()
        .prepare("UPDATE eval_runs SET status = 'error', error = ? WHERE id = ?")
        .run((e as Error).message, payload.runId);
      throw e;
    }
  } else if (job.type === "graph_ingest") {
    // Graph-only pass for repos ingested before Rails intelligence existed:
    // shallow clone, extract, discard — no re-embedding.
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const fs = await import("fs");
    const path = await import("path");
    const { REPOS_DIR, uid: mkId } = await import("./db");
    const { isRailsRepo, analyzeRailsRepo } = await import("./rails-graph");
    const { parseGithubUrl } = await import("./github");
    const { setResourceProgress } = await import("./rag/ingest");
    const parsed = parseGithubUrl(payload.url);
    if (!parsed) throw new Error("Not a valid GitHub URL");
    const cloneDir = path.join(REPOS_DIR, `graph-${mkId()}`);
    setResourceProgress(payload.resourceId, "extracting app graph");
    try {
      const token = process.env.GITHUB_TOKEN;
      const cloneUrl = token
        ? `https://x-access-token:${token}@github.com/${parsed.owner}/${parsed.repo}.git`
        : `https://github.com/${parsed.owner}/${parsed.repo}.git`;
      await promisify(execFile)("git", ["clone", "--depth", "1", cloneUrl, cloneDir], {
        timeout: 300_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      if (isRailsRepo(cloneDir)) {
        const counts = analyzeRailsRepo(payload.resourceId, cloneDir);
        const db = getDb();
        const meta = JSON.parse(
          (db.prepare("SELECT meta FROM resources WHERE id = ?").get(payload.resourceId) as { meta: string }).meta || "{}"
        );
        meta.graph = counts;
        db.prepare("UPDATE resources SET meta = ? WHERE id = ?").run(
          JSON.stringify(meta),
          payload.resourceId
        );
      }
    } finally {
      setResourceProgress(payload.resourceId, null);
      fs.rmSync(cloneDir, { recursive: true, force: true });
    }
  } else {
    throw new Error(`Unknown job type: ${job.type}`);
  }
  if (payload.resourceId) stampSynced(payload.resourceId);
}

// Enqueues re-syncs for resources whose schedule is due. next_sync_at is
// pushed forward immediately so a slow job is never double-enqueued.
function scheduleDueSyncs() {
  const db = getDb();
  const due = db
    .prepare(
      `SELECT id, type, ref, sync_interval FROM resources
       WHERE sync_interval != 'manual' AND next_sync_at IS NOT NULL
         AND next_sync_at <= datetime('now')
         AND status NOT IN ('pending', 'processing')`
    )
    .all() as { id: string; type: string; ref: string | null; sync_interval: string }[];
  for (const r of due) {
    const hours = SYNC_INTERVALS[r.sync_interval];
    if (!hours) continue;
    db.prepare("UPDATE resources SET next_sync_at = ?, status = 'pending' WHERE id = ?").run(
      new Date(Date.now() + hours * 3600_000).toISOString(),
      r.id
    );
    if (r.type === "github" && r.ref) {
      enqueueJob("github_resync", { resourceId: r.id, url: r.ref });
    } else if (r.type === "confluence" && r.ref) {
      enqueueJob("confluence_ingest", { resourceId: r.id, spaceKey: r.ref });
    } else {
      enqueueJob("file_resync", { resourceId: r.id });
    }
  }
}

async function tick() {
  scheduleDueSyncs();
  const db = getDb();
  const job = db
    .prepare(
      `UPDATE jobs SET status = 'running', updated_at = datetime('now'), attempts = attempts + 1
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1)
       RETURNING *`
    )
    .get() as JobRow | undefined;
  if (!job) return;
  try {
    await runJob(job);
    db.prepare(
      "UPDATE jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?"
    ).run(job.id);
  } catch (e) {
    const message = (e as Error).message;
    const retry = job.attempts < MAX_ATTEMPTS;
    db.prepare(
      "UPDATE jobs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(retry ? "queued" : "error", message, job.id);
    if (!retry) {
      // Surface terminal failure on the resource the job was serving.
      const payload = JSON.parse(job.payload) as Record<string, string>;
      if (payload.resourceId) {
        db.prepare(
          "UPDATE resources SET status = 'error', error = ? WHERE id = ?"
        ).run(`background job failed: ${message}`, payload.resourceId);
      }
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __tesseractWorker: { running: boolean } | undefined;
}

export function startWorker() {
  if (globalThis.__tesseractWorker) return;
  globalThis.__tesseractWorker = { running: false };
  const db = getDb();
  // Resume: anything 'running' when the previous process died goes back to queued.
  db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run();
  // Resources stuck in processing with no live job are terminal failures.
  db.prepare(
    `UPDATE resources SET status = 'error',
       error = 'Ingestion was interrupted — use Re-sync'
     WHERE status IN ('pending','processing')
       AND id NOT IN (
         SELECT json_extract(payload, '$.resourceId') FROM jobs
         WHERE status IN ('queued','running')
       )`
  ).run();
  setInterval(async () => {
    const w = globalThis.__tesseractWorker!;
    if (w.running) return; // one job at a time; ingestion is I/O heavy
    w.running = true;
    try {
      await tick();
    } catch (e) {
      console.error("job worker tick failed:", (e as Error).message);
    } finally {
      w.running = false;
    }
  }, POLL_MS).unref?.();
}
