import { getDb } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs";

// POST /api/resources/:id/resync — repairs a resource whose stores have
// drifted (failed side, interrupted ingestion, or rotated API key).
// Runs as a durable background job: files re-ingest from stored originals,
// GitHub repos re-clone.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const resource = db
      .prepare("SELECT * FROM resources WHERE id = ? AND org_id = ?")
      .get(id, user.orgId) as { id: string; type: string; ref: string | null } | undefined;
    if (!resource) return Response.json({ error: "Not found" }, { status: 404 });

    db.prepare(
      "UPDATE resources SET status = 'processing', error = NULL WHERE id = ?"
    ).run(id);

    if (resource.type === "github") {
      if (!resource.ref) {
        return Response.json({ error: "Resource has no repository URL" }, { status: 400 });
      }
      enqueueJob("github_resync", { resourceId: id, url: resource.ref });
    } else if (resource.type === "confluence") {
      enqueueJob("confluence_ingest", { resourceId: id, spaceKey: resource.ref ?? "" });
    } else {
      enqueueJob("file_resync", { resourceId: id });
    }
    return Response.json({ status: "processing" });
  } catch (e) {
    return errorResponse(e);
  }
}
