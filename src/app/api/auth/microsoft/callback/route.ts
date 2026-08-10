import { cookies } from "next/headers";
import { getDb, uid } from "@/lib/db";
import { setSessionCookie } from "@/lib/auth";

// Completes the Entra ID flow. Sign-in policy:
// - existing active user with matching email → signed in
// - pending (unexpired, unaccepted) invite with matching email → account created
// - otherwise rejected, so SSO does not become an open signup door
export async function GET(request: Request) {
  const url = new URL(request.url);
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const fail = (msg: string) =>
    Response.redirect(`${appUrl}/login?error=${encodeURIComponent(msg)}`);

  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) return fail("Microsoft SSO is not configured");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const jar = await cookies();
  const expectedState = jar.get("ms_oauth_state")?.value;
  jar.delete("ms_oauth_state");
  if (!code || !state || state !== expectedState) return fail("Sign-in was cancelled or invalid");

  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: `${appUrl}/api/auth/microsoft/callback`,
      }),
    }
  );
  if (!tokenRes.ok) return fail("Microsoft token exchange failed");
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return fail("No identity returned by Microsoft");

  // The id_token comes directly from Microsoft over TLS in a server-to-server
  // exchange, so decoding its payload here is safe without signature checks.
  const payload = JSON.parse(
    Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8")
  ) as { email?: string; preferred_username?: string; name?: string };
  const email = (payload.email || payload.preferred_username || "").trim();
  if (!email || !email.includes("@")) return fail("Microsoft account has no email");

  const db = getDb();
  const user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email) as
    | { id: string; email: string; name: string | null; role: "admin" | "member"; status: string; org_id: string }
    | undefined;

  if (user) {
    if (user.status !== "active") return fail("Account is deactivated");
    await setSessionCookie({ ...user, orgId: user.org_id });
    return Response.redirect(appUrl);
  }

  const invite = db
    .prepare(
      "SELECT * FROM invites WHERE email = ? AND accepted_at IS NULL AND expires_at > datetime('now')"
    )
    .get(email) as { id: string; role: string; org_id: string } | undefined;
  if (!invite) return fail("No account or invite found for this Microsoft account");

  const id = uid();
  db.prepare(
    "INSERT INTO users (id, org_id, email, name, role, auth_provider) VALUES (?, ?, ?, ?, ?, 'microsoft')"
  ).run(id, invite.org_id, email, payload.name ?? null, invite.role);
  db.prepare("UPDATE invites SET accepted_at = datetime('now') WHERE id = ?").run(invite.id);
  await setSessionCookie({
    id,
    email,
    name: payload.name ?? null,
    role: invite.role as "admin" | "member",
    orgId: invite.org_id,
  });
  return Response.redirect(appUrl);
}
