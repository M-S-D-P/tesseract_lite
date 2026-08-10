import { requireAdmin, errorResponse } from "@/lib/auth";
import { listAnthropicModels } from "@/lib/chat/providers";

// GET /api/admin/models — the live Anthropic model list, so newly released
// Claude models are a dropdown pick rather than a code change.
export async function GET() {
  try {
    await requireAdmin();
    const anthropic = await listAnthropicModels();
    return Response.json({
      models: anthropic,
      providers: {
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
        // Only relevant to embeddings — chat never uses OpenAI in Lite.
        openaiEmbeddings: Boolean(process.env.OPENAI_API_KEY),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
