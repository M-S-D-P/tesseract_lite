import { getDb, uid } from "@/lib/db";
import { requireUser, requireActiveSubscription, errorResponse } from "@/lib/auth";
import { ingestDocument, summarizeResourceStatus } from "@/lib/rag/ingest";
import { parseGithubUrl } from "@/lib/github";
import { enqueueJob } from "@/lib/jobs";

export const maxDuration = 600;

export async function GET() {
  try {
    const user = await requireUser();
    const db = getDb();
    // Own facets plus anything explicitly shared with the organization.
    const resources = db
      .prepare(
        `SELECT r.*, u.email AS owner_email
         FROM resources r
         LEFT JOIN users u ON u.id = r.created_by
         WHERE r.org_id = ? AND (r.visibility = 'org' OR r.created_by = ?)
         ORDER BY r.created_at DESC`
      )
      .all(user.orgId, user.id) as { id: string; created_by: string | null }[];
    const withStatus = resources.map((r) => ({
      ...r,
      mine: r.created_by === user.id,
      sync: summarizeResourceStatus(r.id),
    }));
    return Response.json({ resources: withStatus });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/resources
// - multipart form-data with `files` → knowledge-base file upload
// - JSON {type:'github', url} → repository ingestion (async)
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireActiveSubscription(user.orgId);
    const db = getDb();
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      const body = (await request.json()) as {
        type?: string;
        url?: string;
        spaceKey?: string;
        branch?: string;
        shareWithOrg?: boolean;
      };
      if (body.type === "confluence") {
        // Personal space keys (~123...) are case-sensitive — never uppercase.
        const raw = body.spaceKey?.trim();
        const spaceKey = raw?.startsWith("~") ? raw : raw?.toUpperCase();
        if (!spaceKey) {
          return Response.json({ error: "A Confluence space key is required" }, { status: 400 });
        }
        const id = uid();
        db.prepare(
          "INSERT INTO resources (id, org_id, type, name, ref, visibility, status, created_by) VALUES (?, ?, 'confluence', ?, ?, ?, 'pending', ?)"
        ).run(
          id,
          user.orgId,
          `Confluence: ${spaceKey}`,
          spaceKey,
          body.shareWithOrg ? "org" : "private",
          user.id
        );
        enqueueJob("confluence_ingest", { resourceId: id, spaceKey });
        return Response.json({ id, status: "pending" });
      }
      if (body.type !== "github" || !body.url) {
        return Response.json({ error: "Expected {type:'github', url} or {type:'confluence', spaceKey}" }, { status: 400 });
      }
      const parsed = parseGithubUrl(body.url);
      if (!parsed) {
        return Response.json({ error: "Not a valid GitHub repository URL" }, { status: 400 });
      }
      // Explicit field wins over a branch embedded in a /tree/ URL.
      const branch = body.branch?.trim() || parsed.branch || null;
      const id = uid();
      db.prepare(
        `INSERT INTO resources (id, org_id, type, name, ref, branch, visibility, status, created_by)
         VALUES (?, ?, 'github', ?, ?, ?, ?, 'pending', ?)`
      ).run(
        id,
        user.orgId,
        `${parsed.owner}/${parsed.repo}`,
        body.url,
        branch,
        body.shareWithOrg ? "org" : "private",
        user.id
      );
      // Durable background job; survives restarts, the UI polls status.
      enqueueJob("github_ingest", { resourceId: id, url: body.url, branch });
      return Response.json({ id, status: "pending" });
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch (e) {
      // A truncated body (over proxyClientMaxBodySize) surfaces here as a
      // boundary error — report the real cause instead of "Internal error".
      if (/boundary|FormData/i.test((e as Error).message)) {
        return Response.json(
          {
            error:
              "Upload too large for the server to accept in one request. Raise experimental.proxyClientMaxBodySize in next.config.ts, or add these files in smaller batches.",
          },
          { status: 413 }
        );
      }
      throw e;
    }
    const files = form.getAll("files") as File[];
    const paths = form.getAll("paths").map(String);
    // Uploads are private to the uploader unless they tick "share".
    const visibility = form.get("shareWithOrg") === "true" ? "org" : "private";
    if (files.length === 0) {
      return Response.json({ error: "No files provided" }, { status: 400 });
    }

    // Folder upload: relative paths present → stage to disk, ingest as one
    // resource via a durable background job.
    if (paths.length === files.length && paths.some((p) => p.includes("/"))) {
      const folderName = paths[0].split("/")[0] || "folder";
      const id = uid();
      db.prepare(
        "INSERT INTO resources (id, org_id, type, name, ref, visibility, status, created_by) VALUES (?, ?, 'folder', ?, ?, ?, 'pending', ?)"
      ).run(id, user.orgId, `Folder: ${folderName}`, folderName, visibility, user.id);
      const { stagingDirFor } = await import("@/lib/folder");
      const fs = await import("fs");
      const path = await import("path");
      const stagingDir = stagingDirFor(id);
      for (let i = 0; i < files.length; i++) {
        const rel = paths[i]
          .split("/")
          .slice(1) // drop the root folder segment
          .join("/")
          .replace(/\.\./g, "_");
        if (!rel) continue;
        const dest = path.join(stagingDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(await files[i].arrayBuffer()));
      }
      enqueueJob("folder_ingest", { resourceId: id });
      return Response.json({ id, status: "pending" });
    }

    const created: { id: string; name: string }[] = [];
    for (const file of files) {
      const id = uid();
      db.prepare(
        "INSERT INTO resources (id, org_id, type, name, ref, visibility, status, created_by) VALUES (?, ?, 'file', ?, ?, ?, 'processing', ?)"
      ).run(id, user.orgId, file.name, file.name, visibility, user.id);
      created.push({ id, name: file.name });
      const buffer = Buffer.from(await file.arrayBuffer());
      // Ingest inline (dual-write); errors land on the resource row.
      try {
        const res = await ingestDocument({
          target: { scope: "kb", resourceId: id },
          name: file.name,
          buffer,
          mime: file.type || undefined,
        });
        const ok = res.localOk;
        db.prepare("UPDATE resources SET status = ?, error = ? WHERE id = ?").run(
          ok ? "ready" : "error",
          ok
            ? null
            : "sync incomplete — indexing failed",
          id
        );
      } catch (e) {
        db.prepare("UPDATE resources SET status = 'error', error = ? WHERE id = ?").run(
          (e as Error).message,
          id
        );
      }
    }
    return Response.json({ created });
  } catch (e) {
    return errorResponse(e);
  }
}
