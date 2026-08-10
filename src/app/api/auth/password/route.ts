import { getDb } from "@/lib/db";
import {
  requireUser,
  hashPassword,
  verifyPassword,
  setSessionCookie,
  errorResponse,
} from "@/lib/auth";

const MIN_LENGTH = 10;

// POST /api/auth/password — the signed-in user replaces their own password.
// Reachable while must_change_password is set; everything else is not.
export async function POST(request: Request) {
  try {
    const user = await requireUser({ allowPendingPassword: true });
    const { currentPassword, newPassword } = (await request.json()) as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!newPassword || newPassword.length < MIN_LENGTH) {
      return Response.json(
        { error: `Your new password must be at least ${MIN_LENGTH} characters` },
        { status: 400 }
      );
    }
    if (newPassword === currentPassword) {
      return Response.json(
        { error: "The new password must be different from the current one" },
        { status: 400 }
      );
    }

    const db = getDb();
    const row = db
      .prepare("SELECT password_hash, auth_provider FROM users WHERE id = ?")
      .get(user.id) as
      | { password_hash: string | null; auth_provider: string }
      | undefined;
    if (!row) return Response.json({ error: "Account not found" }, { status: 404 });

    // SSO accounts have no password to change — sending them here would
    // silently create one that the login page never asks for.
    if (row.auth_provider !== "password" || !row.password_hash) {
      return Response.json(
        { error: "This account signs in through single sign-on and has no password" },
        { status: 400 }
      );
    }

    const ok = await verifyPassword(currentPassword ?? "", row.password_hash);
    if (!ok) {
      return Response.json({ error: "Current password is incorrect" }, { status: 403 });
    }

    db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?"
    ).run(await hashPassword(newPassword), user.id);

    // Reissue the cookie so the rest of the session carries the cleared flag.
    await setSessionCookie({ ...user, mustChangePassword: false });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
