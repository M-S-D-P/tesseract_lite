import { requireUser, errorResponse } from "@/lib/auth";
import { getDb, uid } from "@/lib/db";
import { visibleSourceIds } from "@/lib/runtime/sources";

// Turns one observed request into a grounded question.
//
// The runtime evidence is embedded in the prompt rather than left for the model
// to fetch, so the answer starts from facts — this exact request, these exact
// queries, these exact source lines — and the model spends its tool calls on
// the CODE (search_knowledge_base, query_app_graph) instead of rediscovering
// what we already observed. That join is the whole point: telemetry alone is an
// APM, source alone is grep.

type Row = {
  id: string;
  source_id: string | null;
  method: string | null;
  path: string | null;
  controller: string | null;
  action: string | null;
  status: number | null;
  duration_ms: number | null;
  view_ms: number | null;
  db_ms: number | null;
  sql_count: number;
  tables: string;
  n_plus_one: string | null;
  metaprogramming: string;
  error_class: string | null;
  error_message: string | null;
};

type Query = {
  sql: string;
  duration_ms: number | null;
  cached: number;
  source: string | null;
  source_method: string | null;
  fingerprint: string;
};

export const PRESETS: Record<string, { label: string; ask: string }> = {
  trace: {
    label: "Trace this request through the code",
    ask: "Walk me through exactly what this request did, end to end. Use the source code to explain what each stage is doing and why — the controller action, the models involved, the service objects, and what each query is for. Cite the files.",
  },
  slow: {
    label: "Why is it slow?",
    ask: "Explain why this request is slow. Work from the per-query timings and the exact source lines below, look up those files in the codebase, and tell me specifically what to change. Rank the fixes by impact.",
  },
  meta: {
    label: "What metaprogramming ran?",
    ask: "Rails uses heavy metaprogramming — concerns, generated association and attribute methods, scopes that overwrite methods, delegation, Devise, method_missing. FIRST call query_runtime with action=metaprogramming: it returns the methods that actually executed which are NOT defined in the source file they came from, checked against the indexed code. Ground your answer in that list and in the evidence below — do not infer from general knowledge of what Rails usually generates. Then explain what each generated method does, look up the concern or macro that produced it in the codebase, and state exactly what reading the source alone would have missed. If the list is empty, say so plainly rather than speculating.",
  },
  blast: {
    label: "Blast radius of these tables",
    ask: "This request touched the tables listed below. Using the application graph, tell me the blast radius of changing each one: which models map to them, what associations exist, which controllers and background jobs would be affected, and what the migration risk is.",
  },
  gap: {
    label: "Static vs runtime gap",
    ask: "Compare what static analysis of the source knows against what this runtime observation proves. Call query_runtime with action=coverage as well. Tell me specifically: what does runtime reveal that reading the code could not, and what does the code reveal that this traffic could not?",
  },
  document: {
    label: "Document this flow",
    ask: "Produce documentation for this request flow: a Mermaid sequence diagram of the path through controller, services, models and database, followed by a plain-English explanation an engineer new to the codebase could follow. Ground it in the actual source files.",
  },
};

function buildEvidence(r: Row, queries: Query[]): string {
  const tables = JSON.parse(r.tables || "[]") as string[];
  const meta = JSON.parse(r.metaprogramming || "[]") as { kind: string; target: string }[];
  const nPlus = r.n_plus_one
    ? (JSON.parse(r.n_plus_one) as { fingerprint: string; count: number; totalMs: number })
    : null;

  const lines: string[] = [];
  lines.push("OBSERVED RUNTIME EVIDENCE (captured live from the running application):");
  lines.push("");
  lines.push(`Request:     ${r.method ?? "?"} ${r.path ?? "?"}`);
  lines.push(`Handled by:  ${r.controller ?? "?"}#${r.action ?? "?"}`);
  lines.push(`Result:      ${r.status ?? "?"}${r.error_class ? ` — ${r.error_class}: ${r.error_message ?? ""}` : ""}`);
  lines.push(
    `Timing:      ${Math.round(r.duration_ms ?? 0)}ms total` +
      (r.view_ms !== null ? ` · ${r.view_ms}ms views` : "") +
      (r.db_ms !== null ? ` · ${r.db_ms}ms database` : "") +
      ` · ${r.sql_count} queries`
  );
  if (tables.length) lines.push(`Tables:      ${tables.join(", ")}`);

  if (nPlus) {
    lines.push("");
    lines.push(
      `N+1 DETECTED: the same statement ran ${nPlus.count} times in this single request (${nPlus.totalMs}ms total):`
    );
    lines.push(`  ${nPlus.fingerprint.slice(0, 300)}`);
  }

  if (meta.length) {
    lines.push("");
    lines.push("METAPROGRAMMING OBSERVED (Rails reported these at runtime):");
    for (const m of meta) lines.push(`  ${m.kind} → overwrote ${m.target}`);
  }

  // Source attribution is the differentiator — lead with it.
  const attributed = queries.filter((q) => q.source);
  if (attributed.length) {
    lines.push("");
    lines.push("QUERIES BY SOURCE LINE (which line of code issued each query):");
    const bySource = new Map<string, { n: number; ms: number; method: string | null }>();
    for (const q of attributed) {
      const key = q.source!;
      const e = bySource.get(key) ?? { n: 0, ms: 0, method: q.source_method };
      e.n++;
      e.ms += q.duration_ms ?? 0;
      bySource.set(key, e);
    }
    const ranked = [...bySource.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 15);
    for (const [src, e] of ranked) {
      lines.push(
        `  ${src}${e.method ? ` in \`${e.method}'` : ""} — ${e.n}×, ${e.ms.toFixed(1)}ms`
      );
    }
  }

  const slowest = [...queries]
    .filter((q) => !q.cached)
    .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
    .slice(0, 6);
  if (slowest.length) {
    lines.push("");
    lines.push("SLOWEST STATEMENTS:");
    for (const q of slowest) {
      lines.push(`  (${q.duration_ms}ms) ${q.sql.slice(0, 220)}`);
    }
  }

  return lines.join("\n");
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { preset, custom } = (await request.json().catch(() => ({}))) as {
      preset?: string;
      custom?: string;
    };
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM runtime_requests WHERE id = ? AND org_id = ?")
      .get(id, user.orgId) as Row | undefined;
    const visible = visibleSourceIds(user.orgId, user.id, user.role === "admin");
    if (
      !row ||
      (visible !== null && row.source_id !== null && !visible.includes(row.source_id))
    ) {
      return Response.json({ error: "Request not found" }, { status: 404 });
    }

    const queries = db
      .prepare(
        `SELECT sql, duration_ms, cached, source, source_method, fingerprint
         FROM runtime_queries WHERE request_id = ? ORDER BY rowid`
      )
      .all(id) as Query[];

    const ask = custom?.trim() || PRESETS[preset ?? "trace"]?.ask || PRESETS.trace.ask;
    const message = `${ask}\n\n---\n${buildEvidence(row, queries)}\n---\n\nThe runtime facts above are already established — do not re-derive them. Make at most THREE targeted lookups against the indexed codebase, application graph or documentation to explain the code behind them, then answer. Cite the files you use.`;

    // A fresh thread keeps the demo clean and makes the answer shareable.
    const threadId = uid();
    db.prepare(
      "INSERT INTO threads (id, user_id, org_id, title) VALUES (?, ?, ?, ?)"
    ).run(
      threadId,
      user.id,
      user.orgId,
      `${row.method ?? ""} ${row.path ?? "request"}`.trim().slice(0, 60)
    );

    return Response.json({ threadId, message });
  } catch (e) {
    return errorResponse(e);
  }
}
