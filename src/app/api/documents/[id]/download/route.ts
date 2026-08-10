import fs from "fs";
import path from "path";
import { getDb, UPLOADS_DIR } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth";

// GET /api/documents/:id/download?path=… — original file, or a single file
// extracted from a repo bundle when ?path is given.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const wantedPath = new URL(request.url).searchParams.get("path");
    const doc = getDb()
      .prepare(
        "SELECT name, mime, stored_path FROM documents WHERE id = ? AND org_id = ?"
      )
      .get(id, user.orgId) as
      | { name: string; mime: string | null; stored_path: string | null }
      | undefined;
    if (!doc?.stored_path) {
      return Response.json({ error: "No stored content" }, { status: 404 });
    }
    const buffer = fs.readFileSync(path.join(UPLOADS_DIR, doc.stored_path));

    if (wantedPath && buffer.includes("## File: ")) {
      const bundle = buffer.toString("utf8");
      const re = /^## File: (.+)$/gm;
      const matches = [...bundle.matchAll(re)];
      for (let i = 0; i < matches.length; i++) {
        if (matches[i][1].trim() !== wantedPath) continue;
        const start = matches[i].index! + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index! : bundle.length;
        const section = bundle
          .slice(start, end)
          .trim()
          .replace(/^```[a-z]*\n?/, "")
          .replace(/\n?```$/, "");
        return new Response(section, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="${path.basename(wantedPath)}"`,
          },
        });
      }
      return Response.json({ error: "File not found in bundle" }, { status: 404 });
    }

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": doc.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${doc.name.replace(/[^\w.\- ]/g, "_")}"`,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
