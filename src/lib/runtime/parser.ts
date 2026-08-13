// Rails development/production log parser.
//
// A Rails request is not one log line, it is a burst of them:
//
//   Started POST "/v1/x/move_ins/review_cost" for 127.0.0.1 at 2026-08-07 ...
//   Processing by Api::MoveIns::ReviewCostController#create as JSON
//     Parameters: {"facility_id"=>"3307c114"}
//     Facility Load (0.4ms)  SELECT "facilities".* FROM "facilities" WHERE ...
//     Unit Load (12.1ms)  SELECT "units".* FROM "units" WHERE "units"."id" = $1
//   Completed 500 Internal Server Error in 412ms (Views: 3.1ms | ActiveRecord: 88.0ms)
//
// So the parser is a state machine that accumulates lines into a request and
// emits it when the request completes (or when a new one starts).

export type RuntimeQuery = {
  fingerprint: string;
  sql: string;
  tables: string[];
  durationMs: number | null;
  cached: boolean;
  // From the "↳ app/models/user.rb:289:in `method'" line Rails emits under
  // each query. This is what turns "a query ran" into "THIS line ran it".
  source: string | null;
  method: string | null;
};

export type RuntimeRequest = {
  method: string | null;
  path: string | null;
  controller: string | null;
  action: string | null;
  format: string | null;
  status: number | null;
  durationMs: number | null;
  viewMs: number | null;
  dbMs: number | null;
  allocations: number | null;
  startedAt: string | null;
  queries: RuntimeQuery[];
  errorClass: string | null;
  errorMessage: string | null;
  // Rails announces runtime metaprogramming in the log — scopes overwriting
  // generated methods. Direct evidence for the "how do you handle
  // metaprogramming" question, captured rather than inferred.
  metaprogramming: { kind: string; target: string }[];
};

// ANSI colour codes are on by default in Rails development logs.
const ANSI = /\[[0-9;]*m/g;

const RE = {
  // "  ↳ app/models/user.rb:289:in `find_first_by_auth_conditions'"
  source: /^\s*↳\s+(.+?):(\d+):in\s+[`'](.+?)'/,
  // "Creating scope :turned_on. Overwriting existing method ApiAssociation.turned_on."
  scopeOverwrite:
    /^Creating scope :(\w+)\.\s*Overwriting existing method\s+([\w:]+\.\w+)\./,
  redirected: /^Redirected to\s+(\S+)/,
  started: /^Started\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+"([^"]+)"(?:\s+for\s+\S+)?(?:\s+at\s+(.+))?$/,
  processing: /^Processing by\s+([\w:]+)#(\w+)\s+as\s+(\S+)/,
  completed: /^Completed\s+(\d{3})\b.*?\bin\s+([\d.]+)ms(?:\s*\(([^)]*)\))?/,
  // "  User Load (0.4ms)  SELECT ...", "  CACHE Company Load (0.0ms)  SELECT ...",
  // "  TRANSACTION (1.2ms)  BEGIN", "   (4.0ms)  SELECT SUM(...)"
  sql: /^\s*(CACHE\s+)?([\w:]+(?:::\w+)*(?:\s+\w+\??)?\s+)?\(([\d.]+)ms\)\s+(SELECT|INSERT|UPDATE|DELETE|WITH|BEGIN|COMMIT|ROLLBACK|SHOW)\b(.*)$/i,
  error: /^([A-Z][\w:]*(?:Error|Exception|Invalid|NotFound|Denied))\s*(?:\((.*)\))?/,
  errorLine: /^\s*(?:\d+:\s*)?([\w:]*(?:Error|Exception))[:\s]+(.*)$/,
};

// Strips literals so "WHERE id = 42" and "WHERE id = 99" share a fingerprint —
// which is what makes N+1 detection possible.
export function fingerprintSql(sql: string): string {
  return sql
    .replace(/'[^']*'/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/\b\d+\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function tablesFromSql(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+["`']?([a-zA-Z_][\w.]*)["`']?/gi;
  for (const m of sql.matchAll(re)) {
    const t = m[1].toLowerCase();
    if (!t.startsWith("pg_") && t !== "sqlite_master") out.add(t);
  }
  return [...out];
}

function emptyRequest(): RuntimeRequest {
  return {
    method: null,
    path: null,
    controller: null,
    action: null,
    format: null,
    status: null,
    durationMs: null,
    viewMs: null,
    dbMs: null,
    allocations: null,
    startedAt: null,
    queries: [],
    errorClass: null,
    errorMessage: null,
    metaprogramming: [],
  };
}

// Feed lines in; completed requests come out. One instance per connection.
export class RailsLogParser {
  private current: RuntimeRequest | null = null;
  private onRequest: (r: RuntimeRequest) => void;
  // Metaprogramming notices logged at boot, before any request is open.
  private pendingMeta: { kind: string; target: string }[] = [];

  constructor(onRequest: (r: RuntimeRequest) => void) {
    this.onRequest = onRequest;
  }

  push(rawLine: string) {
    const line = rawLine.replace(ANSI, "").trimEnd();
    if (!line.trim()) return;

    // Rails logs metaprogramming as it happens — capture it wherever it lands.
    const scope = line.match(RE.scopeOverwrite);
    if (scope) {
      const entry = { kind: `scope :${scope[1]}`, target: scope[2] };
      if (this.current) this.current.metaprogramming.push(entry);
      else this.pendingMeta.push(entry);
      return;
    }

    const started = line.match(RE.started);
    if (started) {
      // A new request while one is open means the previous never completed
      // (crash, or an interleaved worker) — emit what we have.
      if (this.current?.path) this.flush();
      this.current = emptyRequest();
      this.current.metaprogramming = this.pendingMeta.splice(0);
      this.current.method = started[1];
      this.current.path = started[2];
      this.current.startedAt = started[3] ?? null;
      return;
    }

    if (!this.current) {
      // Tolerate logs that start mid-stream: a Processing line is enough.
      if (RE.processing.test(line)) this.current = emptyRequest();
      else return;
    }

    const processing = line.match(RE.processing);
    if (processing) {
      this.current.controller = processing[1];
      this.current.action = processing[2];
      this.current.format = processing[3];
      return;
    }

    // "↳ app/models/user.rb:289:in `find_first_by_auth_conditions'" attributes
    // the PRECEDING query to an exact source line.
    const src = line.match(RE.source);
    if (src) {
      const last = this.current.queries[this.current.queries.length - 1];
      if (last && !last.source) {
        last.source = `${src[1]}:${src[2]}`;
        last.method = src[3];
      }
      return;
    }

    const sql = line.match(RE.sql);
    if (sql) {
      const verb = sql[4].toUpperCase();
      // Transaction control is not a query; counting it would distort N+1.
      if (verb === "BEGIN" || verb === "COMMIT" || verb === "ROLLBACK") return;
      const statement = `${sql[4]}${sql[5] ?? ""}`.trim();
      this.current.queries.push({
        fingerprint: fingerprintSql(statement),
        sql: statement.slice(0, 2000),
        tables: tablesFromSql(statement),
        durationMs: Number(sql[3]),
        cached: Boolean(sql[1]),
        source: null,
        method: null,
      });
      return;
    }

    const completed = line.match(RE.completed);
    if (completed) {
      this.current.status = Number(completed[1]);
      this.current.durationMs = Number(completed[2]);
      const detail = completed[3] ?? "";
      const views = detail.match(/Views:\s*([\d.]+)ms/);
      const db = detail.match(/ActiveRecord:\s*([\d.]+)ms/);
      const alloc = detail.match(/Allocations:\s*(\d+)/);
      this.current.viewMs = views ? Number(views[1]) : null;
      this.current.dbMs = db ? Number(db[1]) : null;
      this.current.allocations = alloc ? Number(alloc[1]) : null;
      this.flush();
      return;
    }

    if (!this.current.errorClass) {
      const err = line.match(RE.error) ?? line.match(RE.errorLine);
      if (err) {
        this.current.errorClass = err[1];
        this.current.errorMessage = (err[2] ?? "").slice(0, 500) || null;
      }
    }
  }

  flush() {
    const r = this.current;
    this.current = null;
    if (r && (r.path || r.controller)) this.onRequest(r);
  }
}

// Same request, same statement shape, many times = N+1.
export function detectNPlusOne(
  queries: RuntimeQuery[],
  threshold = 5
): { fingerprint: string; count: number; totalMs: number } | null {
  const counts = new Map<string, { count: number; totalMs: number }>();
  for (const q of queries) {
    if (q.cached) continue; // a cache hit did not touch the database
    const e = counts.get(q.fingerprint) ?? { count: 0, totalMs: 0 };
    e.count++;
    e.totalMs += q.durationMs ?? 0;
    counts.set(q.fingerprint, e);
  }
  let worst: { fingerprint: string; count: number; totalMs: number } | null = null;
  for (const [fingerprint, e] of counts) {
    if (e.count >= threshold && (!worst || e.count > worst.count)) {
      worst = { fingerprint, count: e.count, totalMs: Math.round(e.totalMs * 10) / 10 };
    }
  }
  return worst;
}
