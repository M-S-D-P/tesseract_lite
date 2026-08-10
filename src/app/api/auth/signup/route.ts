import { getDb, uid } from "@/lib/db";
import { hashPassword, setSessionCookie } from "@/lib/auth";

// Self-serve organization signup: creates an org on a 14-day trial with the
// signing-up user as its admin.
export async function POST(request: Request) {
  const { orgName, name, email, password } = await request.json();
  if (!orgName?.trim()) {
    return Response.json({ error: "Organization name is required" }, { status: 400 });
  }
  if (!email || !String(email).includes("@") || !password || String(password).length < 8) {
    return Response.json(
      { error: "A valid email and a password of at least 8 characters are required" },
      { status: 400 }
    );
  }
  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(String(email).trim());
  if (existing) {
    return Response.json(
      { error: "An account with this email already exists — sign in instead" },
      { status: 409 }
    );
  }
  const orgId = uid();
  const userId = uid();
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run(
      orgId,
      String(orgName).trim()
    );
    db.prepare(
      "INSERT INTO users (id, org_id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?, 'admin')"
    ).run(userId, orgId, String(email).trim(), name ?? null, "");
  });
  tx();
  // bcrypt outside the transaction (async), then set the real hash
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    await hashPassword(password),
    userId
  );
  await setSessionCookie({
    id: userId,
    email: String(email).trim(),
    name: name ?? null,
    role: "admin",
    orgId,
  });
  return Response.json({ ok: true });
}
