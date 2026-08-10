import { requireUser, errorResponse } from "@/lib/auth";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const run = db
      .prepare("SELECT * FROM eval_runs WHERE id = ? AND org_id = ?")
      .get(id, user.orgId);
    if (!run) return Response.json({ error: "Not found" }, { status: 404 });
    const results = db
      .prepare(
        `SELECT r.*, q.question, q.expected, q.source_label
         FROM eval_results r JOIN eval_questions q ON q.id = r.question_id
         WHERE r.run_id = ? ORDER BY r.rowid`
      )
      .all(id);
    return Response.json({ run, results });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const run = db
      .prepare("SELECT id FROM eval_runs WHERE id = ? AND org_id = ?")
      .get(id, user.orgId);
    if (!run) return Response.json({ error: "Not found" }, { status: 404 });
    db.prepare("DELETE FROM eval_results WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM eval_runs WHERE id = ?").run(id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
