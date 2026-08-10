import { requireUser, errorResponse } from "@/lib/auth";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const set = db
      .prepare("SELECT * FROM eval_sets WHERE id = ? AND org_id = ?")
      .get(id, user.orgId);
    if (!set) return Response.json({ error: "Not found" }, { status: 404 });
    const questions = db
      .prepare("SELECT * FROM eval_questions WHERE set_id = ? ORDER BY created_at")
      .all(id);
    return Response.json({ set, questions });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const set = db
      .prepare("SELECT id FROM eval_sets WHERE id = ? AND org_id = ?")
      .get(id, user.orgId);
    if (!set) return Response.json({ error: "Not found" }, { status: 404 });
    const runs = db.prepare("SELECT id FROM eval_runs WHERE set_id = ?").all(id) as {
      id: string;
    }[];
    for (const r of runs) db.prepare("DELETE FROM eval_results WHERE run_id = ?").run(r.id);
    db.prepare("DELETE FROM eval_runs WHERE set_id = ?").run(id);
    db.prepare("DELETE FROM eval_questions WHERE set_id = ?").run(id);
    db.prepare("DELETE FROM eval_sets WHERE id = ?").run(id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
