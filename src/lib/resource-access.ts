import { getDb } from "./db";
import { HttpError, type SessionUser } from "./auth";

export type ResourceRow = {
  id: string;
  org_id: string;
  type: string;
  name: string;
  ref: string | null;
  branch: string | null;
  visibility: string;
  created_by: string | null;
};

// Facets are private to whoever created them unless shared with the whole
// organization. Reading a shared facet is fine for anyone in the org; changing
// or deleting one is reserved for its owner (and admins, who have to be able
// to clean up after people who leave).
//
// "Not found" rather than "forbidden" on a read miss: whether a facet exists
// is itself something other people's private facets should not reveal.
export function loadResource(
  id: string,
  user: SessionUser,
  access: "read" | "write" = "read"
): ResourceRow {
  const row = getDb()
    .prepare("SELECT * FROM resources WHERE id = ? AND org_id = ?")
    .get(id, user.orgId) as ResourceRow | undefined;

  const visible =
    row && (row.visibility === "org" || row.created_by === user.id);
  if (!row || !visible) throw new HttpError(404, "Not found");

  if (access === "write" && row.created_by !== user.id && user.role !== "admin") {
    throw new HttpError(
      403,
      "This facet belongs to someone else. Ask them, or an administrator, to change it."
    );
  }
  return row;
}
