import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDb, uid, UPLOADS_DIR } from "../db";
import { bumpCorpusVersion } from "../settings";
import { extractText } from "./extract";
import { indexDocumentLocally, deleteDocumentLocally } from "./local";
import { isAppMapFile, analyzeAppMap } from "../appmap";

export type IngestTarget =
  | { scope: "kb"; resourceId: string }
  | { scope: "thread"; threadId: string };

const KB_FILES_DIR = path.join(UPLOADS_DIR, "kb");

// Live ingestion progress, surfaced as progress bars in the UI.
export function setResourceProgress(
  resourceId: string,
  phase: string | null,
  done?: number,
  total?: number
) {
  getDb()
    .prepare(
      "UPDATE resources SET progress_phase = ?, progress_done = ?, progress_total = ? WHERE id = ?"
    )
    .run(phase, done ?? null, total ?? null, resourceId);
}

// Ingestion: every document is chunked, embedded with the org's configured
// embedder and written to the local sqlite-vec index. Status is tracked on
// the document row so failures are visible and re-syncable, and KB originals
// are kept on disk so a re-index never needs the source system again.
export async function ingestDocument(opts: {
  target: IngestTarget;
  name: string;
  buffer: Buffer;
  mime?: string;
  path?: string;
  precomputedText?: string; // skip extraction when the caller already has text
  existingDocumentId?: string; // re-sync an existing row instead of creating one
}): Promise<{ documentId: string; localOk: boolean }> {
  const db = getDb();
  const isKb = opts.target.scope === "kb";
  // Tenancy: the owning org comes from the resource/thread being written to.
  const orgId = isKb
    ? ((db.prepare("SELECT org_id FROM resources WHERE id = ?").get(
        (opts.target as { resourceId: string }).resourceId
      ) as { org_id: string } | undefined)?.org_id ?? "")
    : ((db.prepare("SELECT org_id FROM threads WHERE id = ?").get(
        (opts.target as { threadId: string }).threadId
      ) as { org_id: string } | undefined)?.org_id ?? "");
  if (!orgId) throw new Error("Cannot resolve organization for ingestion target");
  // Any corpus change retires cached answers for this organization.
  bumpCorpusVersion(orgId);
  const contentHash = crypto.createHash("sha256").update(opts.buffer).digest("hex");
  let documentId = opts.existingDocumentId ?? "";
  let storedPath: string | null = null;

  if (!documentId) {
    documentId = uid();
    if (isKb) {
      fs.mkdirSync(KB_FILES_DIR, { recursive: true });
      storedPath = path.join("kb", `${documentId}__${opts.name.replace(/[^\w.-]/g, "_")}`);
      fs.writeFileSync(path.join(UPLOADS_DIR, storedPath), opts.buffer);
    }
    db.prepare(
      `INSERT INTO documents (id, org_id, resource_id, thread_id, name, path, mime, size, stored_path, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      documentId,
      orgId,
      isKb ? (opts.target as { resourceId: string }).resourceId : null,
      isKb ? null : (opts.target as { threadId: string }).threadId,
      opts.name,
      opts.path ?? null,
      opts.mime ?? null,
      opts.buffer.length,
      storedPath,
      contentHash
    );
  } else {
    db.prepare("UPDATE documents SET content_hash = ? WHERE id = ?").run(
      contentHash,
      documentId
    );
  }

  const errors: string[] = [];

  // AppMap traces: parse into the knowledge graph and index the readable
  // summary (raw trace JSON retrieves poorly). The original stays on disk.
  let effectiveText = opts.precomputedText;
  if (isKb && isAppMapFile(opts.name)) {
    const parsed = analyzeAppMap(
      orgId,
      (opts.target as { resourceId: string }).resourceId,
      opts.name,
      opts.buffer
    );
    if (parsed) effectiveText = parsed.summary;
  }

  let localOk = false;
  try {
    // Re-sync path: clear any partial chunks before re-indexing.
    if (opts.existingDocumentId) await deleteDocumentLocally(orgId, documentId);
    const text =
      effectiveText ?? (await extractText(opts.buffer, opts.name, opts.mime));
    if (!text.trim()) throw new Error("no extractable text");
    await indexDocumentLocally({
      orgId,
      documentId,
      resourceId: isKb ? (opts.target as { resourceId: string }).resourceId : null,
      threadId: isKb ? null : (opts.target as { threadId: string }).threadId,
      text,
      meta: { name: opts.name, path: opts.path },
    });
    db.prepare("UPDATE documents SET local_status = 'synced' WHERE id = ?").run(
      documentId
    );
    localOk = true;
  } catch (e) {
    errors.push(`local: ${(e as Error).message}`);
    db.prepare("UPDATE documents SET local_status = 'error' WHERE id = ?").run(
      documentId
    );
  }

  db.prepare("UPDATE documents SET error = ? WHERE id = ?").run(
    errors.length ? errors.join("; ") : null,
    documentId
  );
  return { documentId, localOk };
}

// Deletes a document from the index plus its row and stored original.
export async function deleteDocument(documentId: string) {
  const db = getDb();
  const doc = db
    .prepare("SELECT * FROM documents WHERE id = ?")
    .get(documentId) as
    | {
        id: string;
        org_id: string;
        thread_id: string | null;
        stored_path: string | null;
      }
    | undefined;
  if (!doc) return;
  await deleteDocumentLocally(doc.org_id, documentId);
  if (doc.stored_path) {
    fs.rmSync(path.join(UPLOADS_DIR, doc.stored_path), { force: true });
  }
  db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
  bumpCorpusVersion(doc.org_id);
}

export async function deleteResource(resourceId: string) {
  const db = getDb();
  const docs = db
    .prepare("SELECT id FROM documents WHERE resource_id = ?")
    .all(resourceId) as { id: string }[];
  for (const d of docs) await deleteDocument(d.id);
  db.prepare("DELETE FROM resources WHERE id = ?").run(resourceId);
}

// Re-indexes every document in a file resource that is not currently synced,
// using the originals kept on disk. (GitHub resources re-clone instead —
// see resync in the resources route.)
export async function resyncFileResource(resourceId: string, force = false) {
  const db = getDb();
  const docs = db
    .prepare("SELECT * FROM documents WHERE resource_id = ?")
    .all(resourceId) as {
    id: string;
    name: string;
    mime: string | null;
    stored_path: string | null;
    local_status: string;
  }[];
  // force bypasses the "already synced" skip — needed for a manual resync
  // after switching vector backends, where local_status may still say
  // "synced" against a backend that isn't the active one anymore.
  const stale = force ? docs : docs.filter((d) => d.local_status !== "synced");
  const unchanged = docs.length - stale.length;
  let failures = 0;
  let done = 0;
  for (const doc of stale) {
    setResourceProgress(
      resourceId,
      unchanged > 0
        ? `re-syncing (${unchanged} unchanged skipped)`
        : "re-syncing documents",
      done,
      stale.length
    );
    if (!doc.stored_path) {
      failures += 1;
      db.prepare("UPDATE documents SET error = ? WHERE id = ?").run(
        "original file not stored; delete and re-upload this resource",
        doc.id
      );
      continue;
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(path.join(UPLOADS_DIR, doc.stored_path));
    } catch {
      failures += 1;
      continue;
    }
    // Force both sides through ingestDocument's normal dual-write; the
    // synced-and-current side is re-uploaded too, keeping the code path single.
    const res = await ingestDocument({
      target: { scope: "kb", resourceId },
      name: doc.name,
      buffer,
      mime: doc.mime ?? undefined,
      existingDocumentId: doc.id,
    });
    if (!res.localOk) failures += 1;
    done += 1;
  }
  setResourceProgress(resourceId, null);
  const metaRow = db.prepare("SELECT meta FROM resources WHERE id = ?").get(resourceId) as
    | { meta: string }
    | undefined;
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(metaRow?.meta || "{}");
  } catch {
    /* keep empty */
  }
  meta.lastSync = {
    unchanged,
    updated: stale.length - failures,
    failed: failures,
    at: new Date().toISOString(),
  };
  db.prepare("UPDATE resources SET status = ?, error = ?, meta = ? WHERE id = ?").run(
    failures ? "error" : "ready",
    failures ? `${failures} document(s) still failing after re-sync` : null,
    JSON.stringify(meta),
    resourceId
  );
  return failures;
}

// Sync summary. Hosted-side counts only documents uploaded under the
// CURRENT API key — after a key rotation they read 0 and need Re-sync.
export function summarizeResourceStatus(resourceId: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN local_status = 'synced' THEN 1 ELSE 0 END) AS local_synced
       FROM documents WHERE resource_id = ?`
    )
    .get(resourceId) as {
    total: number;
    local_synced: number;
  };
}
