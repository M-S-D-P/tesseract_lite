import { getDb } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth";
import { loadResource } from "@/lib/resource-access";
import { deleteResource, summarizeResourceStatus } from "@/lib/rag/ingest";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const resource = loadResource(id, user);
    const documents = getDb()
      .prepare(
        "SELECT id, name, path, size, openai_status, local_status, error FROM documents WHERE resource_id = ? ORDER BY name"
      )
      .all(id);
    return Response.json({ resource, documents, sync: summarizeResourceStatus(id) });
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH — change the sync schedule, sharing, or (GitHub only) the tracked
// branch.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { syncInterval, visibility, branch } = (await request.json()) as {
      syncInterval?: string;
      visibility?: string;
      branch?: string;
    };
    const db = getDb();
    const resource = loadResource(id, user, "write");

    // Switching branches re-clones from scratch: the old branch's content
    // has to go, not just gain new siblings, so every existing document is
    // deleted (from both stores) before the fresh ingest is queued.
    if (branch !== undefined) {
      if (resource.type !== "github") {
        return Response.json(
          { error: "Only GitHub resources track a branch" },
          { status: 400 }
        );
      }
      const trimmed = branch.trim();
      if (!trimmed) {
        return Response.json({ error: "Branch cannot be empty" }, { status: 400 });
      }
      if (trimmed !== resource.branch) {
        const { deleteDocument } = await import("@/lib/rag/ingest");
        const docs = db
          .prepare("SELECT id FROM documents WHERE resource_id = ?")
          .all(id) as { id: string }[];
        for (const d of docs) await deleteDocument(d.id);
        db.prepare(
          "UPDATE resources SET branch = ?, status = 'processing', error = NULL WHERE id = ?"
        ).run(trimmed, id);
        const { enqueueJob } = await import("@/lib/jobs");
        enqueueJob("github_ingest", { resourceId: id, url: resource.ref, branch: trimmed });
      }
      if (syncInterval === undefined && visibility === undefined) {
        return Response.json({ ok: true });
      }
    }

    // Sharing a facet with the organization, or taking it back private.
    if (visibility !== undefined) {
      if (visibility !== "org" && visibility !== "private") {
        return Response.json(
          { error: "visibility must be 'org' or 'private'" },
          { status: 400 }
        );
      }
      db.prepare("UPDATE resources SET visibility = ? WHERE id = ?").run(visibility, id);
      if (syncInterval === undefined) return Response.json({ ok: true });
    }

    const { SYNC_INTERVALS } = await import("@/lib/jobs");
    if (syncInterval !== "manual" && !SYNC_INTERVALS[syncInterval ?? ""]) {
      return Response.json(
        { error: "syncInterval must be one of: manual, 6h, daily, weekly" },
        { status: 400 }
      );
    }
    const hours = SYNC_INTERVALS[syncInterval ?? ""];
    db.prepare(
      "UPDATE resources SET sync_interval = ?, next_sync_at = ? WHERE id = ?"
    ).run(
      syncInterval,
      hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null,
      id
    );
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

// Deleting removes the resource from BOTH vector stores.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    loadResource(id, user, "write");
    await deleteResource(id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
