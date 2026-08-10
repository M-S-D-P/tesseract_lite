import { requireUser, errorResponse } from "@/lib/auth";
import { confluenceStatus } from "@/lib/confluence";
import { getSetting } from "@/lib/settings";

export async function GET() {
  try {
    const user = await requireUser();
    const baseUrl = getSetting(user.orgId, "confluence_base_url");
    if (!baseUrl || !getSetting(user.orgId, "confluence_api_token")) {
      return Response.json({
        connected: false,
        configured: false,
        error: "Not configured — set site URL, email, and API token in Admin → Settings",
      });
    }
    const status = await confluenceStatus(user.orgId);
    let site = baseUrl;
    try {
      site = new URL(baseUrl).host;
    } catch {
      /* keep the raw value if it isn't a parseable URL */
    }
    return Response.json({ ...status, configured: true, site });
  } catch (e) {
    return errorResponse(e);
  }
}
