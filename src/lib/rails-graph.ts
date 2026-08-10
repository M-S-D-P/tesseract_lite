import fs from "fs";
import path from "path";
import { getDb } from "./db";

// Rails introspection (diagram stages 6+8, first cut): statically extract a
// repo's real structure — routes/APIs, models + associations, DB schema,
// controllers, jobs — into a knowledge graph with file-level provenance.
// Chat queries it through the query_app_graph tool.

type Entity = { kind: string; name: string; file?: string; meta?: Record<string, unknown> };
type Edge = {
  src_kind: string;
  src: string;
  rel: string;
  dst_kind: string;
  dst: string;
  file?: string;
  meta?: Record<string, unknown>;
};

export function isRailsRepo(dir: string): boolean {
  try {
    if (fs.existsSync(path.join(dir, "config", "routes.rb"))) return true;
    const gemfile = path.join(dir, "Gemfile");
    return fs.existsSync(gemfile) && /gem ['"]rails['"]/.test(fs.readFileSync(gemfile, "utf8"));
  } catch {
    return false;
  }
}

function read(dir: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return null;
  }
}

function listRuby(dir: string, sub: string): string[] {
  const root = path.join(dir, sub);
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".rb")) out.push(path.relative(dir, full));
    }
  };
  walk(root);
  return out;
}

function classify(name: string) {
  return name
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/^([a-z])/, (c) => c.toUpperCase());
}

export function analyzeRailsRepo(resourceId: string, cloneDir: string) {
  const entities: Entity[] = [];
  const edges: Edge[] = [];

  // --- Models: class names + associations ---
  for (const rel of listRuby(cloneDir, "app/models")) {
    const src = read(cloneDir, rel);
    if (!src) continue;
    const classMatch = src.match(/^\s*class\s+([A-Z][\w:]*)\s*<\s*([\w:]+)/m);
    if (!classMatch) continue;
    const model = classMatch[1];
    entities.push({
      kind: "model",
      name: model,
      file: rel,
      meta: { parent: classMatch[2] },
    });
    const assocRe = /^\s*(belongs_to|has_many|has_one|has_and_belongs_to_many)\s+:(\w+)/gm;
    for (const m of src.matchAll(assocRe)) {
      const plural = m[1] === "has_many" || m[1] === "has_and_belongs_to_many";
      edges.push({
        src_kind: "model",
        src: model,
        rel: m[1] === "has_and_belongs_to_many" ? "habtm" : m[1],
        dst_kind: "model",
        dst: classify(plural ? singularize(m[2]) : m[2]),
        file: rel,
      });
    }
  }

  // --- DB schema: tables + columns ---
  const schema = read(cloneDir, "db/schema.rb");
  if (schema) {
    const tableRe = /create_table\s+"(\w+)"[^\n]*\n([\s\S]*?)\n\s*end/g;
    for (const m of schema.matchAll(tableRe)) {
      const columns = [...m[2].matchAll(/t\.(\w+)\s+"(\w+)"/g)].map(
        (c) => `${c[2]}:${c[1]}`
      );
      entities.push({
        kind: "table",
        name: m[1],
        file: "db/schema.rb",
        meta: { columns: columns.slice(0, 60) },
      });
      const model = classify(singularize(m[1]));
      edges.push({
        src_kind: "model",
        src: model,
        rel: "backed_by",
        dst_kind: "table",
        dst: m[1],
        file: "db/schema.rb",
      });
    }
  }

  // --- Routes: verbs, paths, controller#action ---
  const routes = read(cloneDir, "config/routes.rb");
  if (routes) {
    const verbRe = /^\s*(get|post|put|patch|delete)\s+["']([^"']+)["'](?:.*?to:\s*["']([\w/#]+)["'])?/gm;
    for (const m of routes.matchAll(verbRe)) {
      const name = `${m[1].toUpperCase()} ${m[2]}`;
      entities.push({
        kind: "route",
        name,
        file: "config/routes.rb",
        meta: { verb: m[1].toUpperCase(), path: m[2], to: m[3] ?? null },
      });
      if (m[3]) {
        const [ctrl] = m[3].split("#");
        edges.push({
          src_kind: "route",
          src: name,
          rel: "routes_to",
          dst_kind: "controller",
          dst: `${classify(ctrl.split("/").pop() ?? ctrl)}Controller`,
          file: "config/routes.rb",
        });
      }
    }
    const resourcesRe = /^\s*resources?\s+:(\w+)/gm;
    for (const m of routes.matchAll(resourcesRe)) {
      const name = `resources :${m[1]}`;
      entities.push({
        kind: "route",
        name,
        file: "config/routes.rb",
        meta: { restful: true },
      });
      edges.push({
        src_kind: "route",
        src: name,
        rel: "routes_to",
        dst_kind: "controller",
        dst: `${classify(m[1])}Controller`,
        file: "config/routes.rb",
      });
    }
  }

  // --- Controllers: class + actions ---
  for (const rel of listRuby(cloneDir, "app/controllers")) {
    const src = read(cloneDir, rel);
    if (!src) continue;
    const classMatch = src.match(/^\s*class\s+([A-Z][\w:]*Controller)\b/m);
    if (!classMatch) continue;
    const actions = [...src.matchAll(/^\s*def\s+(\w+)/gm)]
      .map((m) => m[1])
      .filter((a) => !a.startsWith("_"))
      .slice(0, 40);
    entities.push({
      kind: "controller",
      name: classMatch[1].split("::").pop()!,
      file: rel,
      meta: { actions, namespace: classMatch[1] },
    });
  }

  // --- Jobs & services ---
  for (const sub of ["app/jobs", "app/services"]) {
    for (const rel of listRuby(cloneDir, sub)) {
      const src = read(cloneDir, rel);
      const classMatch = src?.match(/^\s*class\s+([A-Z][\w:]*)\b/m);
      if (!classMatch) continue;
      entities.push({
        kind: sub.includes("jobs") ? "job" : "service",
        name: classMatch[1].split("::").pop()!,
        file: rel,
      });
    }
  }

  // --- Persist (replace previous graph for this resource) ---
  const db = getDb();
  const orgId = (db.prepare("SELECT org_id FROM resources WHERE id = ?").get(resourceId) as
    | { org_id: string }
    | undefined)?.org_id ?? null;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM kg_entities WHERE resource_id = ?").run(resourceId);
    db.prepare("DELETE FROM kg_edges WHERE resource_id = ?").run(resourceId);
    const insE = db.prepare(
      "INSERT OR IGNORE INTO kg_entities (org_id, resource_id, kind, name, file, meta) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const e of entities) {
      insE.run(orgId, resourceId, e.kind, e.name, e.file ?? null, JSON.stringify(e.meta ?? {}));
    }
    const insR = db.prepare(
      "INSERT INTO kg_edges (org_id, resource_id, src_kind, src, rel, dst_kind, dst, file, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const e of edges) {
      insR.run(orgId, resourceId, e.src_kind, e.src, e.rel, e.dst_kind, e.dst, e.file ?? null, JSON.stringify(e.meta ?? {}));
    }
  });
  tx();
  return { entities: entities.length, edges: edges.length };
}

function singularize(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("zes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function graphHasData(orgId: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM kg_entities WHERE org_id = ? LIMIT 1").get(orgId);
  return Boolean(row);
}

// Executor for the chat-side query_app_graph tool.
export function queryAppGraph(orgId: string, args: {
  action: string;
  name?: string;
  kind?: string;
}): Record<string, unknown> {
  const db = getDb();
  const resourceName = (rid: string) =>
    (db.prepare("SELECT name FROM resources WHERE id = ?").get(rid) as { name: string } | undefined)
      ?.name ?? rid;

  if (args.action === "overview") {
    const counts = db
      .prepare(
        `SELECT r.name AS repo, e.kind, COUNT(*) AS count
         FROM kg_entities e JOIN resources r ON r.id = e.resource_id
         WHERE e.org_id = ?
         GROUP BY e.resource_id, e.kind ORDER BY r.name, e.kind`
      )
      .all(orgId);
    return { overview: counts };
  }

  if (args.action === "list") {
    const rows = db
      .prepare(
        "SELECT resource_id, kind, name, file, meta FROM kg_entities WHERE org_id = ? AND kind = ? ORDER BY name LIMIT 200"
      )
      .all(orgId, args.kind ?? "model") as { resource_id: string; kind: string; name: string; file: string | null; meta: string }[];
    return {
      results: rows.map((r) => ({
        repo: resourceName(r.resource_id),
        kind: r.kind,
        name: r.name,
        file: r.file,
        ...JSON.parse(r.meta),
      })),
    };
  }

  // 'inspect' — everything about one named entity: its metadata + edges both directions
  const name = args.name ?? "";
  const like = `%${name}%`;
  const entities = db
    .prepare(
      "SELECT resource_id, kind, name, file, meta FROM kg_entities WHERE org_id = ? AND name LIKE ? ORDER BY LENGTH(name) LIMIT 10"
    )
    .all(orgId, like) as { resource_id: string; kind: string; name: string; file: string | null; meta: string }[];
  const out = entities.map((e) => {
    const outgoing = db
      .prepare("SELECT rel, dst_kind, dst, file FROM kg_edges WHERE resource_id = ? AND src = ? LIMIT 60")
      .all(e.resource_id, e.name);
    const incoming = db
      .prepare("SELECT rel, src_kind, src, file FROM kg_edges WHERE resource_id = ? AND dst = ? LIMIT 60")
      .all(e.resource_id, e.name);
    return {
      repo: resourceName(e.resource_id),
      kind: e.kind,
      name: e.name,
      file: e.file,
      meta: JSON.parse(e.meta),
      outgoing,
      incoming,
    };
  });
  return { results: out };
}
