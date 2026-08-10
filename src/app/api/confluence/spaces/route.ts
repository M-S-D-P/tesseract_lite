import { getDb } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth";
import { listConfluenceSpaces } from "@/lib/confluence";

export async function GET() {
  try {
    const user = await requireUser();
    const spaces = await listConfluenceSpaces(user.orgId);
    const added = new Map(
      (
        getDb()
          .prepare("SELECT id, ref FROM resources WHERE type = 'confluence' AND org_id = ?")
          .all(user.orgId) as { id: string; ref: string | null }[]
      ).map((r) => [r.ref, r.id])
    );
    return Response.json({
      spaces: spaces.map((s) => ({
        ...s,
        added: added.has(s.key),
        resourceId: added.get(s.key) ?? null,
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
