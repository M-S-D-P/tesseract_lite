import { requireUser, errorResponse } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getSource, loadSource, startSource, stopSource } from "@/lib/runtime/sources";

type Ctx = { params: Promise<{ id: string }> };

// Toggle enabled, rename, or re-point a source; the listener follows.
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await params;
    // Ownership, not just existence: someone else's listener is not yours to
    // re-point, rename or stop.
    const existing = loadSource(id, user.orgId, user.id, user.role === "admin");
    if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

    const body = (await request.json()) as {
      enabled?: boolean;
      name?: string;
      resource_id?: string | null;
      app_url?: string | null;
    };
    const db = getDb();
    if (typeof body.enabled === "boolean") {
      db.prepare("UPDATE runtime_sources SET enabled = ? WHERE id = ?").run(
        body.enabled ? 1 : 0,
        id
      );
    }
    if (typeof body.name === "string") {
      db.prepare("UPDATE runtime_sources SET name = ? WHERE id = ?").run(
        body.name.trim().slice(0, 80) || existing.name,
        id
      );
    }
    if (body.resource_id !== undefined) {
      db.prepare("UPDATE runtime_sources SET resource_id = ? WHERE id = ?").run(
        body.resource_id || null,
        id
      );
    }
    if (body.app_url !== undefined) {
      db.prepare("UPDATE runtime_sources SET app_url = ? WHERE id = ?").run(
        (body.app_url ?? "").trim() || null,
        id
      );
    }

    const updated = getSource(id, user.orgId)!;
    if (updated.enabled) startSource(updated);
    else stopSource(id);
    return Response.json({ ok: true, source: getSource(id, user.orgId) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_r: Request, { params }: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!loadSource(id, user.orgId, user.id, user.role === "admin")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    stopSource(id);
    getDb().prepare("DELETE FROM runtime_sources WHERE id = ?").run(id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
