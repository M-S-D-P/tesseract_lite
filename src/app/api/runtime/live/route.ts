import { requireUser, errorResponse } from "@/lib/auth";
import { subscribe, recentRequests } from "@/lib/runtime/store";
import { visibleSourceIds } from "@/lib/runtime/sources";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

// SSE feed of requests as they arrive, seeded with recent history.
export async function GET() {
  try {
    const user = await requireUser();
    const visible = visibleSourceIds(user.orgId, user.id, user.role === "admin");
    const allowed = visible === null ? null : new Set(visible);
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
            );
          } catch {
            /* client gone */
          }
        };
        send("history", recentRequests(user.orgId, 40, visible).reverse());
        unsubscribe = subscribe(user.orgId, (r) => {
          // Live rows carry their source so one developer's traffic never
          // shows up in another's stream.
          const sid = (r as { sourceId?: string | null }).sourceId ?? null;
          if (allowed && sid !== null && !allowed.has(sid)) return;
          send("request", r);
        });
        const ping = setInterval(() => send("ping", { t: Date.now() }), 20000);
        (controller as unknown as { _cleanup?: () => void })._cleanup = () => {
          clearInterval(ping);
          unsubscribe?.();
        };
      },
      cancel(controller) {
        (controller as unknown as { _cleanup?: () => void })._cleanup?.();
        unsubscribe?.();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
