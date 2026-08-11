import { requireUser, errorResponse } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";

// Synthesize ground-truth questions from the corpus itself: each question is
// generated from one chunk, and that chunk's document becomes the expected
// retrieval target. Runs as a durable job — generation is many model calls.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const set = getDb()
      .prepare("SELECT id FROM eval_sets WHERE id = ? AND org_id = ?")
      .get(id, user.orgId);
    if (!set) return Response.json({ error: "Not found" }, { status: 404 });
    const { count } = (await request.json().catch(() => ({}))) as { count?: number };
    const n = Math.max(1, Math.min(100, Number(count) || 10));
    const jobId = enqueueJob("eval_generate", {
      orgId: user.orgId,
      setId: id,
      count: String(n),
      // Questions come from the facets this person can actually retrieve.
      userId: user.id,
    });
    return Response.json({ jobId, count: n });
  } catch (e) {
    return errorResponse(e);
  }
}
