import fs from "fs";
import { requireUser, errorResponse } from "@/lib/auth";
import { getDb, uid } from "@/lib/db";
import { listSources, startSource, type RuntimeSource } from "@/lib/runtime/sources";

export async function GET() {
  try {
    const user = await requireUser();
    const db = getDb();
    const sources = listSources(user.orgId, user.id, user.role === "admin");
    // Offer the indexed repos so a source can be tied to its codebase. Facets
    // are owned, so this lists only the caller's own plus those shared with the
    // organization — the same rule /api/resources applies.
    const resources = db
      .prepare(
        `SELECT id, name FROM resources
         WHERE org_id = ? AND type IN ('github','folder')
           AND (visibility = 'org' OR created_by = ?)
         ORDER BY name`
      )
      .all(user.orgId, user.id);
    // Per-source traffic, so the UI can show what each one has captured.
    const counts = db
      .prepare(
        `SELECT source_id, COUNT(*) n FROM runtime_requests
         WHERE org_id = ? AND source_id IS NOT NULL GROUP BY source_id`
      )
      .all(user.orgId) as { source_id: string; n: number }[];
    const byId = Object.fromEntries(counts.map((c) => [c.source_id, c.n]));
    return Response.json({
      sources: sources.map((s) => ({ ...s, captured: byId[s.id] ?? 0 })),
      resources,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as Partial<RuntimeSource>;
    const kind = body.kind === "file" ? "file" : "port";
    const name = (body.name ?? "").trim() || "Untitled app";

    if (kind === "port") {
      const port = Number(body.port);
      if (!port || port < 1024 || port > 65535) {
        return Response.json(
          { error: "Port must be between 1024 and 65535" },
          { status: 400 }
        );
      }
      // Deliberately not scoped to the caller: listeners bind on the Tesseract
      // server, not on the developer's machine, so a port can only ever be
      // claimed once here however many people are streaming.
      const clash = getDb()
        .prepare("SELECT id FROM runtime_sources WHERE port = ? AND enabled = 1")
        .get(port);
      if (clash) {
        return Response.json(
          {
            error: `Port ${port} is already claimed by another source. Listeners bind on the Tesseract server rather than on your machine, so pick a different one — your app just pipes to whichever port you choose.`,
          },
          { status: 400 }
        );
      }
    } else {
      const path = (body.file_path ?? "").trim();
      if (!path) return Response.json({ error: "A log file path is required" }, { status: 400 });
      if (!fs.existsSync(path)) {
        return Response.json({ error: `File not found: ${path}` }, { status: 400 });
      }
    }

    const id = uid();
    getDb()
      .prepare(
        `INSERT INTO runtime_sources (id, org_id, name, kind, port, file_path, app_url, resource_id, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        user.orgId,
        name.slice(0, 80),
        kind,
        kind === "port" ? Number(body.port) : null,
        kind === "file" ? (body.file_path ?? "").trim() : null,
        (body.app_url ?? "").trim() || null,
        body.resource_id || null,
        user.id
      );

    const created = getDb()
      .prepare("SELECT * FROM runtime_sources WHERE id = ?")
      .get(id) as RuntimeSource;
    startSource(created);
    return Response.json({ id });
  } catch (e) {
    return errorResponse(e);
  }
}
