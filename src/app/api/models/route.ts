import { requireUser, errorResponse } from "@/lib/auth";
import { listAnthropicModels } from "@/lib/chat/providers";

// GET /api/models — model catalog for the chat composer's model switcher.
// Lite is Claude-only, so there is exactly one group. Any signed-in user;
// cached in-process for 5 minutes.

type Catalog = {
  groups: { provider: string; models: string[] }[];
  fetchedAt: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __tesseractModelCatalog: Catalog | undefined;
}

export async function GET() {
  try {
    await requireUser();
    const cached = globalThis.__tesseractModelCatalog;
    if (cached && Date.now() - cached.fetchedAt < 5 * 60_000) {
      return Response.json({ groups: cached.groups });
    }
    const anthropic = await listAnthropicModels();
    const groups = [{ provider: "Anthropic", models: anthropic }].filter(
      (g) => g.models.length > 0
    );
    globalThis.__tesseractModelCatalog = { groups, fetchedAt: Date.now() };
    return Response.json({ groups });
  } catch (e) {
    return errorResponse(e);
  }
}
