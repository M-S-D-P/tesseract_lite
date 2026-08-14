import { getDb, uid } from "../db";
import { detectNPlusOne, type RuntimeRequest } from "./parser";

// Persists streamed requests and folds the durable signal into the SAME
// knowledge graph the static analyzer and AppMap ingestion write to — so a
// live-observed route or table access is queryable next to a statically
// derived one, and the model does not need to know which is which.

const MAX_REQUESTS = 50_000; // rolling window
let sinceLastPrune = 0;

type Listener = (r: Record<string, unknown>) => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribe(orgId: string, fn: Listener): () => void {
  let set = listeners.get(orgId);
  if (!set) listeners.set(orgId, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

function broadcast(orgId: string, payload: Record<string, unknown>) {
  for (const fn of listeners.get(orgId) ?? []) {
    try {
      fn(payload);
    } catch {
      /* a dead subscriber must never break ingestion */
    }
  }
}

export function recordRequest(
  orgId: string,
  req: RuntimeRequest,
  source = "log",
  sourceId: string | null = null
): string {
  const db = getDb();
  const id = uid();
  const tables = [...new Set(req.queries.flatMap((q) => q.tables))];
  const nPlusOne = detectNPlusOne(req.queries);

  db.prepare(
    `INSERT INTO runtime_requests
     (id, org_id, source, method, path, controller, action, format, status,
      duration_ms, view_ms, db_ms, allocations, sql_count, tables, n_plus_one,
      metaprogramming, error_class, error_message, started_at, source_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    orgId,
    source,
    req.method,
    req.path,
    req.controller,
    req.action,
    req.format,
    req.status,
    req.durationMs,
    req.viewMs,
    req.dbMs,
    req.allocations,
    req.queries.length,
    JSON.stringify(tables),
    nPlusOne ? JSON.stringify(nPlusOne) : null,
    JSON.stringify(req.metaprogramming ?? []),
    req.errorClass,
    req.errorMessage,
    req.startedAt,
    sourceId
  );

  const insQ = db.prepare(
    `INSERT INTO runtime_queries
     (org_id, request_id, fingerprint, sql, tables, duration_ms, cached, source, source_method)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const tx = db.transaction(() => {
    for (const q of req.queries.slice(0, 200)) {
      insQ.run(
        orgId, id, q.fingerprint, q.sql, JSON.stringify(q.tables), q.durationMs,
        q.cached ? 1 : 0, q.source, q.method
      );
    }
  });
  tx();

  enrichGraph(orgId, req, tables);

  broadcast(orgId, {
    id,
    // Carried so a subscriber can tell whether this request is one of theirs.
    sourceId,
    method: req.method,
    path: req.path,
    controller: req.controller,
    action: req.action,
    status: req.status,
    durationMs: req.durationMs,
    dbMs: req.dbMs,
    sqlCount: req.queries.length,
    tables,
    nPlusOne,
    errorClass: req.errorClass,
    errorMessage: req.errorMessage,
    metaprogramming: req.metaprogramming ?? [],
    at: new Date().toISOString(),
  });

  if (++sinceLastPrune > 500) {
    sinceLastPrune = 0;
    prune(orgId);
  }
  return id;
}

// Live traffic becomes graph facts: the route exists, this controller#action
// handles it, and these tables are touched at runtime.
function enrichGraph(orgId: string, req: RuntimeRequest, tables: string[]) {
  if (!req.controller && !req.path) return;
  const db = getDb();
  const resourceId = "live-runtime";

  const insE = db.prepare(
    `INSERT OR IGNORE INTO kg_entities (org_id, resource_id, kind, name, file, meta)
     VALUES (?,?,?,?,?,?)`
  );
  const insR = db.prepare(
    `INSERT INTO kg_edges (org_id, resource_id, src_kind, src, rel, dst_kind, dst, file, meta)
     SELECT ?,?,?,?,?,?,?,?,?
     WHERE NOT EXISTS (
       SELECT 1 FROM kg_edges WHERE org_id = ? AND src = ? AND rel = ? AND dst = ?
     )`
  );

  const tx = db.transaction(() => {
    const routeName = req.method && req.path ? `${req.method} ${normalizePath(req.path)}` : null;
    const actionName = req.controller && req.action ? `${req.controller}#${req.action}` : null;

    if (routeName) {
      insE.run(orgId, resourceId, "route", routeName, null, JSON.stringify({ live: true }));
    }
    if (actionName) {
      insE.run(orgId, resourceId, "controller", req.controller, null, JSON.stringify({ live: true }));
      if (routeName) {
        insR.run(
          orgId, resourceId, "route", routeName, "routes_to", "controller", req.controller, null,
          JSON.stringify({ live: true, action: req.action }),
          orgId, routeName, "routes_to", req.controller
        );
      }
    }
    for (const t of tables) {
      if (actionName) {
        insR.run(
          orgId, resourceId, "controller", req.controller, "queries", "table", t, null,
          JSON.stringify({ live: true }),
          orgId, req.controller, "queries", t
        );
      }
    }
  });
  tx();
}

// /company/2/facility/21884/tenants/8571540 → /company/:id/facility/:id/...
function normalizePath(path: string): string {
  return path
    .split("?")[0]
    .split("/")
    .map((seg) =>
      /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) ? ":id" : seg
    )
    .join("/");
}

function prune(orgId: string) {
  const db = getDb();
  db.prepare(
    `DELETE FROM runtime_requests WHERE org_id = ? AND id NOT IN (
       SELECT id FROM runtime_requests WHERE org_id = ? ORDER BY created_at DESC LIMIT ?
     )`
  ).run(orgId, orgId, MAX_REQUESTS);
  db.prepare(
    `DELETE FROM runtime_queries WHERE org_id = ?
     AND request_id NOT IN (SELECT id FROM runtime_requests WHERE org_id = ?)`
  ).run(orgId, orgId);
}

// --- Read side: what the UI and the chat tool both use --------------------

// Restricts a query to the sources the caller can see. `null` means no
// restriction (an administrator). Requests with no source_id came in over the
// machine ingest endpoint, which is org-wide, so they stay visible either way.
function sourceFilter(sourceIds: string[] | null | undefined): {
  sql: string;
  params: string[];
} {
  if (!sourceIds) return { sql: "", params: [] };
  if (sourceIds.length === 0) return { sql: " AND source_id IS NULL", params: [] };
  const holes = sourceIds.map(() => "?").join(",");
  return {
    sql: ` AND (source_id IS NULL OR source_id IN (${holes}))`,
    params: sourceIds,
  };
}

export function runtimeSummary(
  orgId: string,
  minutes = 60,
  sourceIds?: string[] | null
) {
  const db = getDb();
  const since = `-${Math.max(1, minutes)} minutes`;
  const f = sourceFilter(sourceIds);
  // runtime_queries carries no source of its own, so it is scoped through the
  // request that issued it.
  const qf = !sourceIds
    ? { sql: "", params: [] as string[] }
    : {
        sql: `AND request_id IN (SELECT id FROM runtime_requests WHERE org_id = ?${f.sql})`,
        params: [orgId, ...f.params],
      };
  const base = `FROM runtime_requests WHERE org_id = ? AND created_at > datetime('now', ?)${f.sql}`;

  const totals = db
    .prepare(
      `SELECT COUNT(*) requests,
              COALESCE(AVG(duration_ms),0) avg_ms,
              COALESCE(SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END),0) errors,
              COALESCE(SUM(CASE WHEN n_plus_one IS NOT NULL THEN 1 ELSE 0 END),0) n_plus_one,
              COALESCE(SUM(sql_count),0) queries
       ${base}`
    )
    .get(orgId, since, ...f.params) as Record<string, number>;

  const slowest = db
    .prepare(
      `SELECT controller, action, COUNT(*) hits,
              ROUND(AVG(duration_ms),1) avg_ms, ROUND(MAX(duration_ms),1) max_ms,
              ROUND(AVG(db_ms),1) avg_db_ms, ROUND(AVG(sql_count),1) avg_queries
       ${base} AND controller IS NOT NULL
       GROUP BY controller, action ORDER BY avg_ms DESC LIMIT 10`
    )
    .all(orgId, since, ...f.params);

  const failing = db
    .prepare(
      `SELECT controller, action, status, error_class, error_message, COUNT(*) hits
       ${base} AND (status >= 400 OR error_class IS NOT NULL)
       GROUP BY controller, action, status, error_class ORDER BY hits DESC LIMIT 10`
    )
    .all(orgId, since, ...f.params);

  const hotTables = db
    .prepare(
      `SELECT fingerprint, COUNT(*) executions, ROUND(SUM(duration_ms),1) total_ms
       FROM runtime_queries WHERE org_id = ? AND created_at > datetime('now', ?)
       ${qf.sql}
       GROUP BY fingerprint ORDER BY executions DESC LIMIT 10`
    )
    .all(orgId, since, ...qf.params);

  const nPlusOne = db
    .prepare(
      `SELECT controller, action, n_plus_one, COUNT(*) hits
       ${base} AND n_plus_one IS NOT NULL
       GROUP BY controller, action ORDER BY hits DESC LIMIT 10`
    )
    .all(orgId, since, ...f.params);

  // Which source lines issue the most database work — the single most useful
  // thing the log gives us that static analysis cannot.
  const hotSources = db
    .prepare(
      `SELECT source, source_method, COUNT(*) executions,
              ROUND(SUM(duration_ms),1) total_ms
       FROM runtime_queries
       WHERE org_id = ? AND created_at > datetime('now', ?) AND source IS NOT NULL
       ${qf.sql}
       GROUP BY source, source_method ORDER BY total_ms DESC LIMIT 10`
    )
    .all(orgId, since, ...qf.params);

  const metaprogramming = db
    .prepare(
      `SELECT metaprogramming FROM runtime_requests
       WHERE org_id = ? AND created_at > datetime('now', ?)${f.sql} AND metaprogramming != '[]'
       LIMIT 200`
    )
    .all(orgId, since, ...f.params) as { metaprogramming: string }[];
  const metaSeen = new Map<string, { kind: string; target: string }>();
  for (const row of metaprogramming) {
    try {
      for (const m of JSON.parse(row.metaprogramming) as { kind: string; target: string }[]) {
        metaSeen.set(`${m.kind}|${m.target}`, m);
      }
    } catch {
      /* ignore malformed */
    }
  }

  return {
    windowMinutes: minutes,
    totals,
    slowest,
    failing,
    hotQueries: hotTables,
    hotSources,
    nPlusOne,
    metaprogramming: [...metaSeen.values()],
  };
}

export function recentRequests(
  orgId: string,
  limit = 50,
  sourceIds?: string[] | null
) {
  const f = sourceFilter(sourceIds);
  return getDb()
    .prepare(
      `SELECT id, method, path, controller, action, status, duration_ms, db_ms,
              sql_count, tables, n_plus_one, error_class, error_message, created_at
       FROM runtime_requests WHERE org_id = ?${f.sql}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(orgId, ...f.params, Math.min(200, limit));
}

// The differentiator over an APM.
//
// Datadog sees traffic. It does not parse your source, so it cannot tell you
// which of the 848 routes in routes.rb have never been exercised, nor which
// endpoints serve traffic without appearing in the source at all (engine
// mounts, metaprogrammed routes). That comparison needs BOTH halves — static
// analysis and runtime observation — in one graph, which is what this is.
export function runtimeCoverage(orgId: string, sourceIds?: string[] | null) {
  const db = getDb();
  const f = sourceFilter(sourceIds);

  const staticControllers = db
    .prepare(
      `SELECT DISTINCT name FROM kg_entities
       WHERE org_id = ? AND kind = 'controller' AND resource_id != 'live-runtime'`
    )
    .all(orgId) as { name: string }[];
  // Taken from the observed requests rather than the graph's live-runtime rows:
  // those carry no source, so they could not be attributed to one developer's
  // listeners. Same information, correctly scoped.
  const liveControllers = db
    .prepare(
      `SELECT DISTINCT controller AS name FROM runtime_requests
       WHERE org_id = ? AND controller IS NOT NULL${f.sql}`
    )
    .all(orgId, ...f.params) as { name: string }[];

  const staticSet = new Set(staticControllers.map((r) => r.name));
  const liveSet = new Set(liveControllers.map((r) => r.name));

  const exercised = [...liveSet].filter((n) => staticSet.has(n));
  // In source but never seen serving traffic — dead-code / deprecation candidates.
  const unexercised = [...staticSet].filter((n) => !liveSet.has(n));
  // Serving traffic but absent from static analysis — engine mounts, dynamically
  // defined controllers. Exactly the blind spot static analysis is accused of.
  const undiscovered = [...liveSet].filter((n) => !staticSet.has(n));

  // Traffic per exercised controller, so "used" can be ranked not just flagged.
  const usage = db
    .prepare(
      `SELECT controller, COUNT(*) hits, ROUND(AVG(duration_ms)) avg_ms
       FROM runtime_requests WHERE org_id = ? AND controller IS NOT NULL${f.sql}
       GROUP BY controller ORDER BY hits DESC`
    )
    .all(orgId, ...f.params) as { controller: string; hits: number; avg_ms: number }[];

  return {
    staticControllers: staticSet.size,
    liveControllers: liveSet.size,
    exercised,
    unexercised: unexercised.slice(0, 200),
    unexercisedCount: unexercised.length,
    undiscovered,
    coverage: staticSet.size > 0 ? exercised.length / staticSet.size : 0,
    usage,
  };
}

// --- Metaprogramming: what ran that reading the source would not have shown --
//
// This is the question static analysis genuinely cannot answer, and the reason
// the runtime feed exists. Rails generates methods at boot and on demand —
// concerns, generated association and attribute methods, scopes, delegation,
// method_missing — so a method can execute, issue SQL, and appear nowhere in
// the code you read.
//
// Every query Rails logs carries a "↳ file:line:in `method'" line. We take the
// methods that actually executed and check each one against the INDEXED SOURCE
// of the very file it claims to come from. Three honest outcomes:
//
//   defined   — found in the source. Static analysis would have caught it.
//   generated — the file is indexed, the method is not in it. It was produced
//               at runtime. This is the evidence.
//   unknown   — that file is not in the corpus, so no claim is made either way.
//
// The third bucket matters: absence of a file must never be reported as
// evidence of metaprogramming.

// Rails writes "block (2 levels) in show" and "rescue in create" for nested
// blocks; the owning method is what we want to look for.
function baseMethodName(method: string): string {
  return method
    .replace(/^block\s+(\(\d+\s+levels?\)\s+)?in\s+/, "")
    .replace(/^rescue\s+in\s+/, "")
    .trim();
}

// A frame that is a BLOCK rather than a named method. This matters more than it
// looks: when Ruby manufactures a method with define_method, the running code is
// the block that was passed, so the frame reads "block in <the macro>" or
// "block in <class:Model>" — never the generated method's own name.
function isBlockFrame(method: string): boolean {
  return /^(block\s+(\(\d+\s+levels?\)\s+)?in|rescue\s+in)\s+/.test(method);
}

// Does this file manufacture methods at all? Used to tell a generated method
// body apart from an ordinary block (an each loop inside a normal method).
const GENERATORS = /\b(define_method|define_singleton_method|class_eval|instance_eval|module_eval|store_accessor|delegate)\b/;

// Is this method's name discoverable in the source of this file — as a plain
// def, or as an argument to a macro that declares it?
//
// The boundary is deliberately NOT \b. Ruby method names end in ? and !, and
// \b after a non-word character requires a word character next, which never
// happens in "def valid?(x)" or "def save!\n". Using \b here silently
// misreported every predicate and bang method in the codebase as generated —
// which in Rails is a very large share of all methods.
const AFTER = "(?![A-Za-z0-9_?!])";

function definesMethod(source: string, method: string): boolean {
  const n = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    // A hand-written definition.
    new RegExp(`\\bdef\\s+(self\\.)?${n}${AFTER}`),
    new RegExp(`\\bdefine_method\\s*[(\\s]*[:'"]${n}${AFTER}`),
    new RegExp(`\\balias_method\\s+[:'"]${n}${AFTER}`),
    // Declared by a macro. The method is generated, but its NAME is written
    // here, so static analysis can see it and we must not claim otherwise.
    new RegExp(`\\bscope\\s+:${n}${AFTER}`),
    new RegExp(`\\battr_(reader|writer|accessor)[^\\n]*:${n}${AFTER}`),
    new RegExp(`\\bstore_accessor(_\\w+)?\\s+:\\w+\\s*,\\s*:${n}${AFTER}`),
    new RegExp(`\\bhstore_reference\\s+:\\w+\\s*,\\s*:${n}${AFTER}`),
    // delegate lists run over several lines, so this one may cross newlines.
    new RegExp(`\\bdelegate[\\s\\S]{0,600}?:${n}${AFTER}`),
  ].some((re) => re.test(source));
}

// The indexed text of one repo-relative file, from whichever vector store is
// active. Returns null when the file is not in the corpus at all.
async function indexedFileText(
  orgId: string,
  filePath: string
): Promise<{ text: string; chunks: number } | null> {
  // A high ceiling on purpose: judging a method absent from a file we only
  // partly read would manufacture false evidence.
  if (process.env.PGVECTOR_URL) {
    const { getPool } = await import("../rag/local-pg");
    const { rows } = await getPool().query<{ content: string }>(
      `SELECT content FROM chunks
        WHERE org_id = $1 AND (meta->>'path' = $2 OR meta->>'path' LIKE $3)
        LIMIT 400`,
      [orgId, filePath, `%${filePath}`]
    );
    return rows.length
      ? { text: rows.map((r) => r.content).join("\n"), chunks: rows.length }
      : null;
  }
  const rows = getDb()
    .prepare(
      `SELECT c.content FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.org_id = ?
         AND (json_extract(c.meta,'$.path') = ? OR json_extract(c.meta,'$.path') LIKE ?)
       LIMIT 400`
    )
    .all(orgId, filePath, `%${filePath}`) as { content: string }[];
  return rows.length
    ? { text: rows.map((r) => r.content).join("\n"), chunks: rows.length }
    : null;
}

export type MetaprogrammingFinding = {
  method: string;
  file: string;
  // "log"    — inferred from the ↳ attribution under a SQL statement, so only
  //            methods that were on the stack when a query ran.
  // "appmap" — an instrumented call event, so EVERY method that executed,
  //            including those that touch no database at all.
  origin: "log" | "appmap";
  executions: number;
  totalMs: number;
  // How much indexed text backed the judgement, so a verdict can be audited
  // rather than taken on trust.
  chunksSeen: number;
  // For a generated method body: the macro (or class scope) that produced it.
  via: string | null;
  verdict: "defined" | "generated" | "unknown";
};

export async function metaprogrammingReport(
  orgId: string,
  sourceIds?: string[] | null,
  userId?: string
) {
  const db = getDb();
  const f = sourceFilter(sourceIds);

  // What Rails announced outright while running.
  const announcedRows = db
    .prepare(
      `SELECT metaprogramming FROM runtime_requests
       WHERE org_id = ?${f.sql} AND metaprogramming != '[]' LIMIT 500`
    )
    .all(orgId, ...f.params) as { metaprogramming: string }[];
  const announced = new Map<string, { kind: string; target: string }>();
  for (const row of announcedRows) {
    try {
      for (const m of JSON.parse(row.metaprogramming) as { kind: string; target: string }[]) {
        announced.set(`${m.kind}|${m.target}`, m);
      }
    } catch {
      /* ignore malformed */
    }
  }

  // Every method observed issuing database work, with where it claimed to be.
  const qf = !sourceIds
    ? { sql: "", params: [] as string[] }
    : {
        sql: `AND request_id IN (SELECT id FROM runtime_requests WHERE org_id = ?${f.sql})`,
        params: [orgId, ...f.params],
      };
  const observed = db
    .prepare(
      `SELECT source, source_method, COUNT(*) executions, ROUND(SUM(duration_ms),1) total_ms
       FROM runtime_queries
       WHERE org_id = ? AND source IS NOT NULL AND source_method IS NOT NULL
       ${qf.sql}
       GROUP BY source, source_method
       ORDER BY executions DESC
       LIMIT 300`
    )
    .all(orgId, ...qf.params) as {
    source: string;
    source_method: string;
    executions: number;
    total_ms: number;
  }[];

  // One method called from several lines of the same file is ONE finding. The
  // SQL groups by source, which carries the line number, so fold first.
  const byMethod = new Map<
    string,
    { file: string; frame: string; method: string; executions: number; totalMs: number }
  >();
  for (const row of observed) {
    const file = row.source.replace(/:\d+$/, "");
    const frame = row.source_method.trim();
    const method = baseMethodName(frame);
    if (!method) continue;
    // Keyed on the frame as logged, so "block in hstore_reference" is kept
    // distinct from an ordinary call to hstore_reference.
    const key = `${file}|${frame}`;
    const e = byMethod.get(key) ?? { file, frame, method, executions: 0, totalMs: 0 };
    e.executions += row.executions;
    e.totalMs = Math.round((e.totalMs + row.total_ms) * 10) / 10;
    byMethod.set(key, e);
  }

  const cache = new Map<string, { text: string; chunks: number } | null>();
  const findings: MetaprogrammingFinding[] = [];
  for (const e of byMethod.values()) {
    if (!cache.has(e.file)) cache.set(e.file, await indexedFileText(orgId, e.file));
    const indexed = cache.get(e.file) ?? null;
    let verdict: MetaprogrammingFinding["verdict"];
    let via: string | null = null;
    if (indexed === null) {
      verdict = "unknown";
    } else if (isBlockFrame(e.frame)) {
      // The executing code is a block. If this file manufactures methods, that
      // block IS the body of a generated method — the single most common shape
      // in a Rails codebase, and invisible if you only look for a missing def.
      if (GENERATORS.test(indexed.text)) {
        verdict = "generated";
        via = e.method; // the macro, or <class:Model> for an in-file loop
      } else {
        verdict = "defined";
      }
    } else {
      verdict = definesMethod(indexed.text, e.method) ? "defined" : "generated";
    }
    findings.push({
      method: e.frame,
      file: e.file,
      origin: "log",
      executions: e.executions,
      totalMs: e.totalMs,
      chunksSeen: indexed?.chunks ?? 0,
      via,
      verdict,
    });
  }
  findings.sort((a, b) => b.executions - a.executions);

  // --- AppMap: every instrumented call, not only those that issued SQL -----
  //
  // AppMap records Method#source_location per call, so the check becomes a
  // direct question — is there a definition of this method at the place Ruby
  // says it lives? — with no frame label to parse.
  let appmapRows: {
    defined_class: string | null;
    method_id: string;
    path: string | null;
    lineno: number | null;
    executions: number;
    total_ms: number;
  }[] = [];
  try {
    appmapRows = db
      .prepare(
        `SELECT defined_class, method_id, path, lineno,
                SUM(executions) executions, ROUND(SUM(total_ms),1) total_ms
         FROM runtime_methods
         WHERE org_id = ? AND path IS NOT NULL
           ${userId ? "AND (resource_id IS NULL OR resource_id IN (SELECT id FROM resources WHERE org_id = ? AND (visibility = 'org' OR created_by = ?)))" : ""}
         GROUP BY defined_class, method_id, path, lineno
         ORDER BY SUM(executions) DESC
         LIMIT 400`
      )
      .all(...(userId ? [orgId, orgId, userId] : [orgId])) as typeof appmapRows;
  } catch {
    appmapRows = []; // table not migrated yet
  }

  for (const row of appmapRows) {
    if (!cache.has(row.path!)) cache.set(row.path!, await indexedFileText(orgId, row.path!));
    const indexed = cache.get(row.path!) ?? null;
    findings.push({
      method: row.defined_class ? `${row.defined_class}#${row.method_id}` : row.method_id,
      file: row.path!,
      origin: "appmap",
      executions: row.executions,
      totalMs: row.total_ms,
      chunksSeen: indexed?.chunks ?? 0,
      via: null,
      verdict:
        indexed === null
          ? "unknown"
          : definesMethod(indexed.text, row.method_id)
            ? "defined"
            : "generated",
    });
  }
  findings.sort((a, b) => b.executions - a.executions);

  const generated = findings.filter((x) => x.verdict === "generated");
  const defined = findings.filter((x) => x.verdict === "defined");
  const unknown = findings.filter((x) => x.verdict === "unknown");

  return {
    announced: [...announced.values()],
    // The headline: methods that executed but are not in the source they came from.
    generated: generated.slice(0, 60),
    generatedCount: generated.length,
    definedCount: defined.length,
    // Files we could not judge because they are not indexed — reported, never
    // counted as evidence.
    unknownCount: unknown.length,
    unindexedFiles: [...new Set(unknown.map((x) => x.file))].slice(0, 40),
    observedMethods: findings.length,
    // Split so the difference in evidence quality is visible rather than implied.
    fromAppMap: findings.filter((f) => f.origin === "appmap").length,
    fromLog: findings.filter((f) => f.origin === "log").length,
  };
}

export function hasRuntimeData(orgId: string, sourceIds?: string[] | null): boolean {
  const f = sourceFilter(sourceIds);
  const row = getDb()
    .prepare(`SELECT 1 FROM runtime_requests WHERE org_id = ?${f.sql} LIMIT 1`)
    .get(orgId, ...f.params);
  return Boolean(row);
}
