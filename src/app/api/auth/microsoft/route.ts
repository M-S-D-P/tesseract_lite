import crypto from "crypto";
import { cookies } from "next/headers";

// Kicks off the Microsoft Entra ID authorization-code flow.
export async function GET() {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  if (!tenant || !clientId) {
    return Response.json({ error: "Microsoft SSO is not configured" }, { status: 501 });
  }
  const state = crypto.randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("ms_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  const redirectUri = `${process.env.APP_URL || "http://localhost:3000"}/api/auth/microsoft/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: "openid profile email User.Read",
    state,
  });
  return Response.redirect(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`
  );
}
