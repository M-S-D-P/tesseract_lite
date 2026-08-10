import { getDb } from "@/lib/db";
import { verifyPassword, setSessionCookie } from "@/lib/auth";

export async function POST(request: Request) {
  const { email, password } = await request.json();
  if (!email || !password) {
    return Response.json({ error: "Email and password are required" }, { status: 400 });
  }
  const db = getDb();
  const user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(String(email).trim()) as
    | {
        id: string;
        email: string;
        name: string | null;
        role: "admin" | "member";
        password_hash: string | null;
        status: string;
        org_id: string;
        must_change_password: number;
      }
    | undefined;
  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return Response.json({ error: "Invalid email or password" }, { status: 401 });
  }
  if (user.status !== "active") {
    return Response.json({ error: "Account is deactivated" }, { status: 403 });
  }
  const mustChangePassword = user.must_change_password === 1;
  await setSessionCookie({ ...user, orgId: user.org_id, mustChangePassword });
  return Response.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    // The login page sends them to /change-password instead of the app.
    mustChangePassword,
  });
}
