import { requireUser, errorResponse } from "@/lib/auth";
import { getDb, uid } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { currentConfig } from "@/lib/eval";

export async function GET() {
  try {
    const user = await requireUser();
    const runs = getDb()
      .prepare(
        `SELECT r.*, s.name AS set_name FROM eval_runs r
         JOIN eval_sets s ON s.id = r.set_id
         WHERE r.org_id = ? ORDER BY r.created_at DESC LIMIT 50`
      )
      .all(user.orgId);
    return Response.json({ runs });
  } catch (e) {
    return errorResponse(e);
  }
}

// A run pins the configuration it executed under, so comparing two runs
// compares two configurations rather than two moments in time.
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const { setId, label, overrides } = (await request.json()) as {
      setId: string;
      label?: string;
      overrides?: Partial<ReturnType<typeof currentConfig>>;
    };
    const db = getDb();
    const set = db
      .prepare("SELECT id FROM eval_sets WHERE id = ? AND org_id = ?")
      .get(setId, user.orgId);
    if (!set) return Response.json({ error: "Set not found" }, { status: 404 });
    const count = db
      .prepare("SELECT COUNT(*) n FROM eval_questions WHERE set_id = ?")
      .get(setId) as { n: number };
    if (count.n === 0) {
      return Response.json({ error: "This set has no questions yet" }, { status: 400 });
    }

    const config = { ...currentConfig(user.orgId), ...(overrides ?? {}) };
    const id = uid();
    db.prepare(
      `INSERT INTO eval_runs (id, org_id, set_id, label, config, status, total_count)
       VALUES (?, ?, ?, ?, ?, 'queued', ?)`
    ).run(id, user.orgId, setId, (label || "").slice(0, 120), JSON.stringify(config), count.n);
    enqueueJob("eval_run", { runId: id });
    return Response.json({ id, config });
  } catch (e) {
    return errorResponse(e);
  }
}
