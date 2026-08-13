import { requireUser, errorResponse } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { visibleSourceIds } from "@/lib/runtime/sources";

// A request belongs to the source that captured it, so it is visible to
// whoever owns that source. Machine-ingested traffic (no source) is org-wide.
function visibleRequest(
  row: { source_id?: string | null } | undefined,
  visible: string[] | null
): boolean {
  if (!row) return false;
  if (visible === null) return true;
  const sid = row.source_id ?? null;
  return sid === null || visible.includes(sid);
}


// Full detail for one observed request: every query with its source line,
// N+1 verdict, and any metaprogramming Rails announced while it ran.
export async function GET(_r: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const request = db
      .prepare("SELECT * FROM runtime_requests WHERE id = ? AND org_id = ?")
      .get(id, user.orgId) as { source_id?: string | null } | undefined;
    const visible = visibleSourceIds(user.orgId, user.id, user.role === "admin");
    if (!visibleRequest(request, visible)) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const queries = db
      .prepare(
        `SELECT fingerprint, sql, tables, duration_ms, cached, source, source_method
         FROM runtime_queries WHERE request_id = ? ORDER BY rowid`
      )
      .all(id);
    return Response.json({ request, queries });
  } catch (e) {
    return errorResponse(e);
  }
}
