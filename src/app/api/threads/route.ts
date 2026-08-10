import { getDb, uid } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth";

export async function GET() {
  try {
    const user = await requireUser();
    const threads = getDb()
      .prepare(
        "SELECT id, title, created_at, updated_at FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200"
      )
      .all(user.id);
    return Response.json({ threads });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST() {
  try {
    const user = await requireUser();
    const id = uid();
    getDb()
      .prepare("INSERT INTO threads (id, user_id, org_id) VALUES (?, ?, ?)")
      .run(id, user.id, user.orgId);
    return Response.json({ id, title: "New chat" });
  } catch (e) {
    return errorResponse(e);
  }
}
