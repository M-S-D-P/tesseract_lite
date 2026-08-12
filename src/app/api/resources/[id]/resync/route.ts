import { getDb } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth";
import { loadResource } from "@/lib/resource-access";
import { enqueueJob } from "@/lib/jobs";

// POST /api/resources/:id/resync — repairs a resource whose stores have
// drifted (failed side, interrupted ingestion, rotated API key, or a vector
// backend switch that left content only in the previously-active store).
// Runs as a durable background job: files re-ingest from stored originals,
// GitHub repos re-clone. Manually triggered, so it always does real work —
// force bypasses the "already synced" skip that scheduled syncs rely on to
// avoid redoing unchanged content.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const resource = loadResource(id, user, "write");

    db.prepare(
      "UPDATE resources SET status = 'processing', error = NULL WHERE id = ?"
    ).run(id);

    if (resource.type === "github") {
      if (!resource.ref) {
        return Response.json({ error: "Resource has no repository URL" }, { status: 400 });
      }
      // No branch passed: ingestGithubRepo reads the tracked branch off the
      // resource, so a re-sync stays on whatever branch it was added with.
      // github_resync always re-clones — no force flag needed.
      enqueueJob("github_resync", { resourceId: id, url: resource.ref });
    } else if (resource.type === "confluence") {
      enqueueJob("confluence_ingest", {
        resourceId: id,
        spaceKey: resource.ref ?? "",
        force: true,
      });
    } else {
      enqueueJob("file_resync", { resourceId: id, force: true });
    }
    return Response.json({ status: "processing" });
  } catch (e) {
    return errorResponse(e);
  }
}
