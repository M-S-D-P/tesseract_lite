import { requireUser, errorResponse } from "@/lib/auth";
import { getDb, uid } from "@/lib/db";

export async function GET() {
  try {
    const user = await requireUser();
    const sets = getDb()
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM eval_questions q WHERE q.set_id = s.id) AS questions
         FROM eval_sets s WHERE s.org_id = ? ORDER BY s.created_at DESC`
      )
      .all(user.orgId);
    return Response.json({ sets });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const { name } = (await request.json()) as { name?: string };
    const id = uid();
    getDb()
      .prepare("INSERT INTO eval_sets (id, org_id, name) VALUES (?, ?, ?)")
      .run(id, user.orgId, (name || "Evaluation set").slice(0, 120));
    return Response.json({ id });
  } catch (e) {
    return errorResponse(e);
  }
}
