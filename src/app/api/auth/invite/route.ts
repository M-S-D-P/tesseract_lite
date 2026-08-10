import { getDb, uid } from "@/lib/db";
import { hashPassword, setSessionCookie } from "@/lib/auth";

// GET /api/auth/invite?token=... — invite details for the accept page
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return Response.json({ error: "Missing token" }, { status: 400 });
  const invite = getDb()
    .prepare("SELECT email, role, expires_at, accepted_at FROM invites WHERE token = ?")
    .get(token) as
    | { email: string; role: string; expires_at: string; accepted_at: string | null }
    | undefined;
  if (!invite) return Response.json({ error: "Invalid invite" }, { status: 404 });
  if (invite.accepted_at) return Response.json({ error: "Invite already used" }, { status: 410 });
  if (new Date(invite.expires_at) < new Date()) {
    return Response.json({ error: "Invite expired" }, { status: 410 });
  }
  return Response.json({ email: invite.email, role: invite.role });
}

// POST /api/auth/invite — accept an invite: set name + password, sign in
export async function POST(request: Request) {
  const { token, name, password } = await request.json();
  if (!token || !password || String(password).length < 8) {
    return Response.json(
      { error: "A password of at least 8 characters is required" },
      { status: 400 }
    );
  }
  const db = getDb();
  const invite = db
    .prepare("SELECT * FROM invites WHERE token = ?")
    .get(token) as
    | { id: string; email: string; role: string; expires_at: string; accepted_at: string | null; org_id: string }
    | undefined;
  if (!invite || invite.accepted_at || new Date(invite.expires_at) < new Date()) {
    return Response.json({ error: "Invalid or expired invite" }, { status: 410 });
  }
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(invite.email);
  if (existing) {
    return Response.json({ error: "An account with this email already exists" }, { status: 409 });
  }
  const id = uid();
  db.prepare(
    "INSERT INTO users (id, org_id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, invite.org_id, invite.email, name ?? null, await hashPassword(password), invite.role);
  db.prepare("UPDATE invites SET accepted_at = datetime('now') WHERE id = ?").run(invite.id);
  await setSessionCookie({
    id,
    email: invite.email,
    name: name ?? null,
    role: invite.role as "admin" | "member",
    // They just chose this password themselves.
    mustChangePassword: false,
    orgId: invite.org_id,
  });
  return Response.json({ ok: true });
}
