import crypto from "crypto";
import { getDb, uid } from "@/lib/db";
import { requireAdmin, errorResponse } from "@/lib/auth";

export async function GET() {
  try {
    const admin = await requireAdmin();
    const db = getDb();
    const users = db
      .prepare(
        "SELECT id, email, name, role, status, auth_provider, must_change_password, created_at FROM users WHERE org_id = ? ORDER BY created_at"
      )
      .all(admin.orgId);
    const invites = db
      .prepare(
        "SELECT id, email, role, token, expires_at, accepted_at, created_at FROM invites WHERE org_id = ? ORDER BY created_at DESC"
      )
      .all(admin.orgId);
    return Response.json({ users, invites });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/admin/users — create an invite link for an email.
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const { email, role } = await request.json();
    if (!email || !String(email).includes("@")) {
      return Response.json({ error: "A valid email is required" }, { status: 400 });
    }
    const db = getDb();
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(String(email).trim());
    if (existing) {
      return Response.json({ error: "A user with this email already exists" }, { status: 409 });
    }
    const id = uid();
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    // Re-inviting an email replaces any previous pending invite.
    db.prepare("DELETE FROM invites WHERE email = ? AND org_id = ? AND accepted_at IS NULL").run(String(email).trim(), admin.orgId);
    db.prepare(
      "INSERT INTO invites (id, org_id, email, token, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, admin.orgId, String(email).trim(), token, role === "admin" ? "admin" : "member", admin.id, expiresAt);
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    return Response.json({
      id,
      inviteUrl: `${appUrl}/invite/${token}`,
      expiresAt,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
