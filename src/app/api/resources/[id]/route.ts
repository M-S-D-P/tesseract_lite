import { getDb } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth";
import { deleteResource, summarizeResourceStatus } from "@/lib/rag/ingest";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const resource = getDb()
      .prepare("SELECT * FROM resources WHERE id = ? AND org_id = ?")
      .get(id, user.orgId);
    if (!resource) return Response.json({ error: "Not found" }, { status: 404 });
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
    const { syncInterval } = await request.json();
    const { SYNC_INTERVALS } = await import("@/lib/jobs");
    if (syncInterval !== "manual" && !SYNC_INTERVALS[syncInterval]) {
      return Response.json(
        { error: "syncInterval must be one of: manual, 6h, daily, weekly" },
        { status: 400 }
      );
    }
    const db = getDb();
    const resource = db
      .prepare("SELECT id FROM resources WHERE id = ? AND org_id = ?")
      .get(id, user.orgId);
    if (!resource) return Response.json({ error: "Not found" }, { status: 404 });
    const hours = SYNC_INTERVALS[syncInterval];
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
    const owned = getDb()
      .prepare("SELECT id FROM resources WHERE id = ? AND org_id = ?")
      .get(id, user.orgId);
    if (!owned) return Response.json({ error: "Not found" }, { status: 404 });
    await deleteResource(id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
