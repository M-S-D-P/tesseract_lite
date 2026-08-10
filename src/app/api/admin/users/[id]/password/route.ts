import crypto from "crypto";
import { getDb } from "@/lib/db";
import { requireAdmin, hashPassword, errorResponse } from "@/lib/auth";

// Ambiguity-free alphabet — these get read aloud and typed by hand.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function tempPassword(length = 16) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// POST /api/admin/users/[id]/password — issue a new temporary password.
// There is no mail server on this deployment, so the administrator reads the
// generated password back to its owner. It is returned exactly once and is
// not stored in plaintext anywhere; the account is forced to replace it on
// next use.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdmin();
    const { id } = await params;
    const db = getDb();

    const user = db
      .prepare("SELECT id, email, auth_provider, org_id FROM users WHERE id = ?")
      .get(id) as
      | { id: string; email: string; auth_provider: string; org_id: string | null }
      | undefined;

    // Tenancy: an admin may only reset accounts inside their own organization.
    if (!user || user.org_id !== admin.orgId) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }
    if (user.auth_provider !== "password") {
      return Response.json(
        { error: "This account signs in through single sign-on and has no password" },
        { status: 400 }
      );
    }

    const password = tempPassword();
    db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?"
    ).run(await hashPassword(password), id);

    return Response.json({ email: user.email, password });
  } catch (e) {
    return errorResponse(e);
  }
}
