import { getDb } from "@/lib/db";
import { requireAdmin, errorResponse } from "@/lib/auth";

// PATCH /api/admin/users/:id — change role or active status.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdmin();
    const { id } = await params;
    const { role, status } = await request.json();
    if (id === admin.id && (role === "member" || status === "disabled")) {
      return Response.json(
        { error: "You cannot demote or disable your own account" },
        { status: 400 }
      );
    }
    const db = getDb();
    const user = db.prepare("SELECT id FROM users WHERE id = ? AND org_id = ?").get(id, admin.orgId);
    if (!user) return Response.json({ error: "Not found" }, { status: 404 });
    if (role === "admin" || role === "member") {
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
    }
    if (status === "active" || status === "disabled") {
      db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
    }
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE /api/admin/users/:id — also used to revoke a pending invite via ?invite=1
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdmin();
    const { id } = await params;
    const db = getDb();
    if (new URL(request.url).searchParams.get("invite")) {
      db.prepare("DELETE FROM invites WHERE id = ? AND org_id = ?").run(id, admin.orgId);
      return Response.json({ ok: true });
    }
    if (id === admin.id) {
      return Response.json({ error: "You cannot delete your own account" }, { status: 400 });
    }
    db.prepare("DELETE FROM users WHERE id = ? AND org_id = ?").run(id, admin.orgId);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
