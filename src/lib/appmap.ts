import { getDb } from "./db";

// AppMap runtime-trace connector (platform diagram stages 4/5).
// Parses *.appmap.json exports: the classMap becomes function/class entities,
// http_server_request events become runtime route entities, and sql_query
// events become trace→table edges — all merged into the same knowledge graph
// the query_app_graph tool serves. A text summary is returned for RAG.

type CodeObject = {
  name: string;
  type: string; // package | class | function
  location?: string; // "app/models/facility.rb:1795" — Ruby's source_location
  static?: boolean;
  children?: CodeObject[];
};

type AppMapEvent = {
  event: "call" | "return";
  http_server_request?: { request_method?: string; path_info?: string; normalized_path_info?: string };
  sql_query?: { sql?: string };
  defined_class?: string;
  method_id?: string;
  static?: boolean;
  path?: string;
  lineno?: number;
  elapsed?: number;
};

type AppMap = {
  metadata?: { name?: string; language?: { name?: string }; recorder?: { name?: string } };
  classMap?: CodeObject[];
  events?: AppMapEvent[];
};

function tablesFromSql(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+["'`]?(\w+)["'`]?/gi)) {
    const t = m[1].toLowerCase();
    if (!["select", "values", "dual"].includes(t)) out.add(t);
  }
  return [...out];
}

export function isAppMapFile(name: string): boolean {
  return name.endsWith(".appmap.json");
}

export function analyzeAppMap(
  orgId: string,
  resourceId: string,
  filename: string,
  buffer: Buffer
): { summary: string; entities: number; edges: number; methods: number } | null {
  let map: AppMap;
  try {
    map = JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
  if (!map.classMap && !map.events) return null;

  const traceName = map.metadata?.name || filename.replace(/\.appmap\.json$/, "");
  const entities: { kind: string; name: string; file?: string; meta: Record<string, unknown> }[] = [];
  const edges: { src_kind: string; src: string; rel: string; dst_kind: string; dst: string; meta: Record<string, unknown> }[] = [];

  entities.push({
    kind: "trace",
    name: traceName,
    file: filename,
    meta: {
      language: map.metadata?.language?.name,
      recorder: map.metadata?.recorder?.name,
    },
  });

  // Every function the trace saw, with the location Ruby reports for it. This
  // is the field that makes AppMap strictly better evidence than a log line:
  // it is Method#source_location, so for a generated method it points at the
  // define_method block rather than at a def that does not exist.
  const methods = new Map<
    string,
    {
      definedClass: string;
      methodId: string;
      isStatic: boolean;
      path: string | null;
      lineno: number | null;
      executions: number;
      totalMs: number;
    }
  >();
  const methodKey = (cls: string, m: string) => `${cls}#${m}`;

  // classMap → classes/functions observed at runtime
  const functions: string[] = [];
  const classes: string[] = [];
  const walk = (objs: CodeObject[], prefix: string) => {
    for (const o of objs) {
      const qualified = prefix ? `${prefix}::${o.name}` : o.name;
      if (o.type === "class") {
        classes.push(qualified);
        entities.push({
          kind: "class",
          name: qualified,
          file: o.location?.split(":")[0],
          meta: { runtime: true },
        });
        edges.push({
          src_kind: "trace", src: traceName, rel: "observed",
          dst_kind: "class", dst: qualified, meta: {},
        });
      }
      if (o.type === "function") {
        functions.push(qualified);
        const [locPath, locLine] = (o.location ?? "").split(":");
        const definedClass = prefix || "";
        methods.set(methodKey(definedClass, o.name), {
          definedClass,
          methodId: o.name,
          isStatic: Boolean(o.static),
          path: locPath || null,
          lineno: locLine ? Number(locLine) : null,
          executions: 0,
          totalMs: 0,
        });
      }
      if (o.children) walk(o.children, o.type === "package" ? qualified : qualified);
    }
  };
  walk(map.classMap ?? [], "");

  // events → runtime routes + SQL table access
  const routes = new Set<string>();
  const sqlTables = new Set<string>();
  for (const ev of map.events ?? []) {
    if (ev.event !== "call") continue;
    if (ev.http_server_request) {
      const verb = ev.http_server_request.request_method ?? "GET";
      const pathInfo =
        ev.http_server_request.normalized_path_info ??
        ev.http_server_request.path_info ??
        "/";
      routes.add(`${verb} ${pathInfo}`);
    }
    if (ev.sql_query?.sql) {
      for (const t of tablesFromSql(ev.sql_query.sql)) sqlTables.add(t);
    }
    // Call events carry the execution itself. Count them, and fall back to the
    // event's own path/lineno when the classMap did not describe the method.
    if (ev.method_id) {
      const cls = ev.defined_class ?? "";
      const key = methodKey(cls, ev.method_id);
      const existing = methods.get(key);
      if (existing) {
        existing.executions += 1;
        existing.totalMs += (ev.elapsed ?? 0) * 1000;
        if (!existing.path && ev.path) {
          existing.path = ev.path;
          existing.lineno = ev.lineno ?? null;
        }
      } else {
        methods.set(key, {
          definedClass: cls,
          methodId: ev.method_id,
          isStatic: Boolean(ev.static),
          path: ev.path ?? null,
          lineno: ev.lineno ?? null,
          executions: 1,
          totalMs: (ev.elapsed ?? 0) * 1000,
        });
      }
    }
  }
  for (const r of routes) {
    entities.push({ kind: "route", name: r, file: filename, meta: { runtime: true } });
    edges.push({ src_kind: "trace", src: traceName, rel: "handles", dst_kind: "route", dst: r, meta: {} });
  }
  for (const t of sqlTables) {
    edges.push({ src_kind: "trace", src: traceName, rel: "queries", dst_kind: "table", dst: t, meta: {} });
  }

  // Persist into the shared knowledge graph (append; keyed by resource)
  const db = getDb();
  const tx = db.transaction(() => {
    const insE = db.prepare(
      "INSERT OR IGNORE INTO kg_entities (org_id, resource_id, kind, name, file, meta) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const e of entities) {
      insE.run(orgId, resourceId, e.kind, e.name, e.file ?? null, JSON.stringify(e.meta));
    }
    const insR = db.prepare(
      "INSERT INTO kg_edges (org_id, resource_id, src_kind, src, rel, dst_kind, dst, file, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const e of edges) {
      insR.run(orgId, resourceId, e.src_kind, e.src, e.rel, e.dst_kind, e.dst, filename, JSON.stringify(e.meta));
    }

    // Method-level runtime evidence. Replaced wholesale for this facet so a
    // re-upload does not double-count.
    db.prepare("DELETE FROM runtime_methods WHERE org_id = ? AND resource_id = ?").run(
      orgId,
      resourceId
    );
    const insM = db.prepare(
      `INSERT INTO runtime_methods
       (org_id, resource_id, origin, trace, defined_class, method_id, is_static, path, lineno, executions, total_ms)
       VALUES (?,?,'appmap',?,?,?,?,?,?,?,?)`
    );
    for (const m of methods.values()) {
      if (!m.methodId) continue;
      insM.run(
        orgId, resourceId, traceName, m.definedClass || null, m.methodId,
        m.isStatic ? 1 : 0, m.path, m.lineno,
        m.executions, Math.round(m.totalMs * 10) / 10
      );
    }
  });
  tx();

  // RAG summary document text
  const summary = [
    `# AppMap trace: ${traceName}`,
    ``,
    `Language: ${map.metadata?.language?.name ?? "unknown"}; recorder: ${map.metadata?.recorder?.name ?? "unknown"}.`,
    ``,
    routes.size > 0 ? `## HTTP routes exercised\n${[...routes].map((r) => `- ${r}`).join("\n")}` : "",
    sqlTables.size > 0 ? `## Database tables queried\n${[...sqlTables].map((t) => `- ${t}`).join("\n")}` : "",
    classes.length > 0 ? `## Classes observed at runtime\n${classes.slice(0, 120).map((c) => `- ${c}`).join("\n")}` : "",
    functions.length > 0 ? `## Functions observed\n${functions.slice(0, 200).map((f) => `- ${f}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { summary, entities: entities.length, edges: edges.length, methods: methods.size };
}
