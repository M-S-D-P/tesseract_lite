import { requireUser, requireActiveSubscription, errorResponse } from "@/lib/auth";
import { runCompletion, type Attachment, type StreamEvent } from "@/lib/chat/completion";
import type { ReasoningTier } from "@/lib/openai";

export const maxDuration = 600;

// POST /api/threads/:id/completion — streams SSE, knoh-style.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let user;
  try {
    user = await requireUser();
    requireActiveSubscription(user.orgId);
  } catch (e) {
    return errorResponse(e);
  }
  const { id } = await params;
  const body = (await request.json()) as {
    message: string;
    reasoning?: ReasoningTier;
    webSearch?: boolean;
    model?: string;
    resourceIds?: string[];
    attachments?: Attachment[];
  };
  if (!body.message?.trim()) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // client went away
        }
      };
      try {
        await runCompletion({
          threadId: id,
          userId: user.id,
          orgId: user.orgId,
          message: body.message,
          reasoning: (["low", "medium", "high"] as const).includes(
            body.reasoning as ReasoningTier
          )
            ? (body.reasoning as ReasoningTier)
            : "medium",
          webSearch: Boolean(body.webSearch),
          model: typeof body.model === "string" ? body.model.slice(0, 100) : undefined,
          resourceIds: Array.isArray(body.resourceIds)
            ? body.resourceIds.filter((r) => typeof r === "string").slice(0, 50)
            : undefined,
          attachments: body.attachments ?? [],
          emit,
          signal: request.signal,
        });
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
