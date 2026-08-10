import { getSession, getOrg } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ user: null }, { status: 401 });
  const org = getOrg(session.orgId);
  return Response.json({
    user: session,
    org: org ? { id: org.id, name: org.name } : null,
    // Every page shell reads this and sends the user to /change-password.
    mustChangePassword: session.mustChangePassword,
    microsoftSso: Boolean(process.env.MS_CLIENT_ID && process.env.MS_TENANT_ID),
  });
}
