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

// PATCH — change the sync schedule.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { syncInterval, visibility } = (await request.json()) as {
      syncInterval?: string;
      visibility?: string;
    };
    const db = getDb();
    loadResource(id, user, "write");

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
