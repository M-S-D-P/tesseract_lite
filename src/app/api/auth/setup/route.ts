import { getDb, uid } from "@/lib/db";
import { hashPassword, setSessionCookie } from "@/lib/auth";

// First-run bootstrap: creates the initial admin account.
// Only works while the users table is empty.
export async function POST(request: Request) {
  const { email, password, name } = await request.json();
  if (!email || !password || String(password).length < 8) {
    return Response.json(
      { error: "Email and a password of at least 8 characters are required" },
      { status: 400 }
    );
  }
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  if (count > 0) {
    return Response.json({ error: "Setup already completed" }, { status: 403 });
  }
  const id = uid();
  const orgId = uid();
  db.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run(orgId, "My Organization");
  db.prepare(
    "INSERT INTO users (id, org_id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?, 'admin')"
  ).run(id, orgId, String(email).trim(), name ?? null, await hashPassword(password));
  await setSessionCookie({
    id,
    email,
    name: name ?? null,
    role: "admin",
    orgId,
    mustChangePassword: false,
  });
  return Response.json({ ok: true });
}

export async function GET() {
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  return Response.json({ needsSetup: count === 0 });
}
