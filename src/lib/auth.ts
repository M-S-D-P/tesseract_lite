import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { getDb } from "./db";

export const SESSION_COOKIE = "tesseract_session";
const SESSION_DAYS = 7;

function secret() {
  return new TextEncoder().encode(
    process.env.AUTH_SECRET || "dev-change-me-to-a-long-random-string"
  );
}

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "member";
  orgId: string;
};

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 10);
}

export async function verifyPassword(pw: string, hash: string) {
  return bcrypt.compare(pw, hash);
}

export async function createSessionToken(user: SessionUser) {
  return new SignJWT({
    email: user.email,
    name: user.name,
    role: user.role,
    orgId: user.orgId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
}

export async function setSessionCookie(user: SessionUser) {
  const token = await createSessionToken(user);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
    path: "/",
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export async function verifySessionToken(
  token: string
): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      id: payload.sub as string,
      email: payload.email as string,
      name: (payload.name as string) ?? null,
      role: payload.role as "admin" | "member",
      orgId: (payload.orgId as string) ?? "",
    };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await verifySessionToken(token);
  if (!session) return null;
  // Confirm the user still exists and is active; org comes from the DB, not
  // the token, so org migrations take effect immediately.
  const row = getDb()
    .prepare("SELECT id, email, name, role, status, org_id FROM users WHERE id = ?")
    .get(session.id) as
    | {
        id: string;
        email: string;
        name: string | null;
        role: string;
        status: string;
        org_id: string | null;
      }
    | undefined;
  if (!row || row.status !== "active" || !row.org_id) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as "admin" | "member",
    orgId: row.org_id,
  };
}

export type Org = {
  id: string;
  name: string;
  plan: string;
  seats: number;
};

export function getOrg(orgId: string): Org | null {
  return (
    (getDb().prepare("SELECT * FROM orgs WHERE id = ?").get(orgId) as Org | undefined) ??
    null
  );
}

// Lite is a self-hosted, unmetered deployment — there is no subscription or
// trial to expire. The check stays as a single place to reinstate a gate if
// one is ever needed; today it only proves the org exists.
export function requireActiveSubscription(orgId: string) {
  const org = getOrg(orgId);
  if (!org) throw new HttpError(403, "Organization not found");
  return org;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requireUser(): Promise<SessionUser> {
  const s = await getSession();
  if (!s) throw new HttpError(401, "Not authenticated");
  return s;
}

export async function requireAdmin(): Promise<SessionUser> {
  const s = await requireUser();
  if (s.role !== "admin") throw new HttpError(403, "Admin access required");
  return s;
}

export function errorResponse(e: unknown) {
  if (e instanceof HttpError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  console.error(e);
  return Response.json({ error: "Internal error" }, { status: 500 });
}
