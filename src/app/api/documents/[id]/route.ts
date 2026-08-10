import fs from "fs";
import path from "path";
import { getDb, UPLOADS_DIR } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth";
import { extractText } from "@/lib/rag/extract";

const MAX_PREVIEW_BYTES = 300 * 1024;

function loadDoc(id: string, orgId: string) {
  return getDb()
    .prepare(
      `SELECT d.id, d.name, d.mime, d.stored_path, r.name AS resource_name, r.type AS resource_type
       FROM documents d LEFT JOIN resources r ON r.id = d.resource_id
       WHERE d.id = ? AND d.org_id = ?`
    )
    .get(id, orgId) as
    | {
        id: string;
        name: string;
        mime: string | null;
        stored_path: string | null;
        resource_name: string | null;
        resource_type: string | null;
      }
    | undefined;
}

// Extract one file's section out of a repo bundle ("## File: <path>" headers),
// stripping the surrounding code fence.
function extractBundleSection(bundle: string, wantedPath: string): string | null {
  const re = /^## File: (.+)$/gm;
  const matches = [...bundle.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    if (matches[i][1].trim() !== wantedPath) continue;
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : bundle.length;
    let section = bundle.slice(start, end).trim();
    section = section.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
    return section;
  }
  return null;
}

// GET /api/documents/:id?path=<repo file path> — source preview for the
// citation viewer. Returns the cited file's real content (bundle-extracted
// for repo citations) so retrieval is visibly grounded.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const wantedPath = new URL(request.url).searchParams.get("path");
    const doc = loadDoc(id, user.orgId);
    if (!doc) return Response.json({ error: "Not found" }, { status: 404 });
    if (!doc.stored_path) {
      return Response.json({
        name: doc.name,
        resourceName: doc.resource_name,
        path: wantedPath,
        content: null,
        note: "Original content is not stored for this document (chat attachment).",
      });
    }
    const full = path.join(UPLOADS_DIR, doc.stored_path);
    const buffer = fs.readFileSync(full);
    let content: string;
    let displayName = doc.name;
    if (wantedPath && buffer.includes("## File: ")) {
      const section = extractBundleSection(buffer.toString("utf8"), wantedPath);
      if (section === null) {
        return Response.json({ error: "File not found in bundle" }, { status: 404 });
      }
      content = section;
      displayName = wantedPath;
    } else {
      content = await extractText(buffer, doc.name, doc.mime ?? undefined);
    }
    const truncated = content.length > MAX_PREVIEW_BYTES;
    return Response.json({
      name: displayName,
      documentName: doc.name,
      resourceName: doc.resource_name,
      path: wantedPath ?? null,
      content: content.slice(0, MAX_PREVIEW_BYTES),
      truncated,
      lines: content.split("\n").length,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
