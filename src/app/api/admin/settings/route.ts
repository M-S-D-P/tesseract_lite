import { requireAdmin, errorResponse } from "@/lib/auth";
import { getAllSettings, setSetting, SETTING_DEFAULTS } from "@/lib/settings";

const EDITABLE_KEYS = new Set(Object.keys(SETTING_DEFAULTS));

export async function GET() {
  try {
    const admin = await requireAdmin();
    return Response.json({ settings: getAllSettings(admin.orgId) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = (await request.json()) as Record<string, string>;
    for (const [key, value] of Object.entries(body)) {
      if (!EDITABLE_KEYS.has(key)) continue;
      if (key === "embedding_provider" && !["local", "openai"].includes(value)) {
        return Response.json(
          { error: "embedding_provider must be 'local' or 'openai'" },
          { status: 400 }
        );
      }
      setSetting(admin.orgId, key, String(value));
    }
    return Response.json({ settings: getAllSettings(admin.orgId) });
  } catch (e) {
    return errorResponse(e);
  }
}
