import { getDb } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const thread = db
      .prepare("SELECT id, title, filters, created_at FROM threads WHERE id = ? AND user_id = ?")
      .get(id, user.id);
    if (!thread) return Response.json({ error: "Not found" }, { status: 404 });
    const messages = db
      .prepare(
        "SELECT id, role, content, attachments, citations, status, meta, created_at FROM messages WHERE thread_id = ? ORDER BY created_at, rowid"
      )
      .all(id);
    return Response.json({ thread, messages });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const thread = db
      .prepare("SELECT id FROM threads WHERE id = ? AND user_id = ?")
      .get(id, user.id);
    if (!thread) return Response.json({ error: "Not found" }, { status: 404 });
    db.prepare("DELETE FROM messages WHERE thread_id = ?").run(id);
    db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
