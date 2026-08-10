import { getDb } from "@/lib/db";
import { requireAdmin, errorResponse } from "@/lib/auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdmin();
    const { id } = await params;
    const body = await request.json();
    const db = getDb();
    const row = db.prepare("SELECT id FROM mcp_servers WHERE id = ? AND org_id = ?").get(id, admin.orgId);
    if (!row) return Response.json({ error: "Not found" }, { status: 404 });
    if (typeof body.enabled === "boolean") {
      db.prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?").run(body.enabled ? 1 : 0, id);
    }
    if (typeof body.name === "string" && body.name.trim()) {
      db.prepare("UPDATE mcp_servers SET name = ? WHERE id = ?").run(body.name.trim(), id);
    }
    if (typeof body.url === "string" && /^https?:\/\//.test(body.url)) {
      db.prepare("UPDATE mcp_servers SET url = ? WHERE id = ?").run(body.url.trim(), id);
    }
    if (body.headers && typeof body.headers === "object") {
      db.prepare("UPDATE mcp_servers SET headers = ? WHERE id = ?").run(JSON.stringify(body.headers), id);
    }
    if ("description" in body) {
      db.prepare("UPDATE mcp_servers SET description = ? WHERE id = ?").run(body.description ?? null, id);
    }
    if ("allowedTools" in body) {
      db.prepare("UPDATE mcp_servers SET allowed_tools = ? WHERE id = ?").run(
        Array.isArray(body.allowedTools) && body.allowedTools.length > 0
          ? JSON.stringify(body.allowedTools)
          : null,
        id
      );
    }
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdmin();
    const { id } = await params;
    getDb().prepare("DELETE FROM mcp_servers WHERE id = ? AND org_id = ?").run(id, admin.orgId);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
