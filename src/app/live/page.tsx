"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Copy,
  Database,
  Radio,
  Trash2,
  Zap,
  Sparkles,
  X,
  Plug,
  Plus,
  FileText,
  Power,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { PageShell } from "@/components/TopBar";
import { Badge, Button, Spinner, cx } from "@/components/ui";

type Req = {
  id: string;
  method: string | null;
  path: string | null;
  controller: string | null;
  action: string | null;
  status: number | null;
  duration_ms?: number | null;
  durationMs?: number | null;
  db_ms?: number | null;
  dbMs?: number | null;
  sql_count?: number;
  sqlCount?: number;
  tables?: string | string[];
  n_plus_one?: string | null;
  nPlusOne?: { fingerprint: string; count: number; totalMs: number } | null;
  error_class?: string | null;
  errorClass?: string | null;
  created_at?: string;
  at?: string;
};

type Coverage = {
  staticControllers: number;
  liveControllers: number;
  exercised: string[];
  unexercised: string[];
  unexercisedCount: number;
  undiscovered: string[];
  coverage: number;
  usage: { controller: string; hits: number; avg_ms: number }[];
};

type Summary = {
  totals: { requests: number; avg_ms: number; errors: number; n_plus_one: number; queries: number };
  slowest: { controller: string; action: string; hits: number; avg_ms: number; max_ms: number; avg_queries: number }[];
  failing: { controller: string; action: string; status: number; error_class: string | null; hits: number }[];
  hotQueries: { fingerprint: string; executions: number; total_ms: number }[];
  nPlusOne: { controller: string; action: string; n_plus_one: string; hits: number }[];
  ingestToken: string;
  logPort: string;
};

const dur = (r: Req) => r.durationMs ?? r.duration_ms ?? null;
const sqlCount = (r: Req) => r.sqlCount ?? r.sql_count ?? 0;
const nPlus = (r: Req) => {
  if (r.nPlusOne) return r.nPlusOne;
  if (typeof r.n_plus_one === "string" && r.n_plus_one) {
    try {
      return JSON.parse(r.n_plus_one) as { count: number };
    } catch {
      return null;
    }
  }
  return null;
};

export default function LivePage() {
  const [requests, setRequests] = useState<Req[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [meta, setMeta] = useState<MetaReport | null>(null);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const loadSummary = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      fetch("/api/runtime/summary?minutes=60"),
      fetch("/api/runtime/coverage"),
      fetch("/api/runtime/metaprogramming"),
    ]);
    if (a.ok) setSummary(await a.json());
    if (b.ok) setCoverage(await b.json());
    if (c.ok) setMeta(await c.json());
  }, []);

  useEffect(() => {
    loadSummary();
    const t = setInterval(loadSummary, 10000);
    return () => clearInterval(t);
  }, [loadSummary]);

  useEffect(() => {
    const es = new EventSource("/api/runtime/live");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("history", (e) => {
      setRequests(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener("request", (e) => {
      if (pausedRef.current) return;
      const req = JSON.parse((e as MessageEvent).data) as Req;
      setRequests((prev) => [...prev.slice(-199), req]);
    });
    return () => es.close();
  }, []);

  const statusTone = (s: number | null) =>
    !s ? "neutral" : s >= 500 ? "danger" : s >= 400 ? "warn" : "success";

  return (
    <PageShell title="Live runtime">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              Live runtime
              <span
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px]",
                  connected ? "bg-success/10 text-success" : "bg-surface-2 text-muted"
                )}
              >
                <Radio className={cx("size-3", connected && "animate-pulse")} />
                {connected ? "listening" : "disconnected"}
              </span>
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Runtime observation feeding the code map — not a monitoring
              dashboard. An APM sees traffic; it never parsed your source, so it
              cannot tell you which controllers in the codebase serve no traffic
              at all, or which serve traffic without existing in the source.
              That comparison needs both halves in one graph.
            </p>
          </div>
          <Button variant="outline" onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>

        {coverage && coverage.staticControllers > 0 && (
          <CoveragePanel coverage={coverage} />
        )}
        {meta && meta.observedMethods > 0 && <MetaprogrammingPanel report={meta} />}

        <SourceManager onChanged={loadSummary} ingestToken={summary?.ingestToken} />

        {summary && summary.totals.requests > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat icon={<Activity className="size-3.5" />} label="Requests / 60m" value={summary.totals.requests.toLocaleString()} />
            <Stat label="Avg duration" value={`${Math.round(summary.totals.avg_ms)}ms`} />
            <Stat icon={<Database className="size-3.5" />} label="SQL queries" value={summary.totals.queries.toLocaleString()} />
            <Stat icon={<AlertTriangle className="size-3.5" />} label="5xx errors" value={String(summary.totals.errors)} tone={summary.totals.errors > 0 ? "danger" : undefined} />
            <Stat icon={<Zap className="size-3.5" />} label="N+1 requests" value={String(summary.totals.n_plus_one)} tone={summary.totals.n_plus_one > 0 ? "warn" : undefined} />
          </div>
        )}

        {/* Live tail */}
        <h2 className="mt-8 text-sm font-medium">Request stream</h2>
        <div className="mt-2 overflow-hidden rounded-xl border border-border-app">
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full table-fixed text-sm">
              <thead className="sticky top-0 bg-surface-2">
                <tr className="border-b border-border-app text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="w-[8%] px-3 py-2 font-medium">Status</th>
                  <th className="w-[42%] px-3 py-2 font-medium">Request</th>
                  <th className="w-[26%] px-3 py-2 font-medium">Controller#action</th>
                  <th className="w-[12%] px-3 py-2 text-right font-medium">SQL</th>
                  <th className="w-[12%] px-3 py-2 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="bg-surface">
                {[...requests].reverse().map((r) => {
                  const np = nPlus(r);
                  return (
                    <tr
                      key={r.id}
                      onClick={() => setSelected(r.id)}
                      className={cx(
                        "cursor-pointer border-b border-border-app last:border-0 hover:bg-surface-2/60",
                        selected === r.id && "bg-accent/5"
                      )}
                    >
                      <td className="px-3 py-2">
                        <Badge tone={statusTone(r.status) as "success" | "warn" | "danger" | "neutral"}>
                          {r.status ?? "—"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <div className="truncate font-mono text-xs" title={r.path ?? ""}>
                          <span className="text-muted">{r.method}</span> {r.path}
                        </div>
                        {(r.errorClass ?? r.error_class) && (
                          <div className="truncate text-[11px] text-danger">
                            {r.errorClass ?? r.error_class}
                          </div>
                        )}
                      </td>
                      <td className="truncate px-3 py-2 text-xs" title={`${r.controller}#${r.action}`}>
                        {r.controller ? `${r.controller}#${r.action}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums">
                        {sqlCount(r)}
                        {np && (
                          <span className="ml-1 rounded bg-warn/10 px-1 text-[10px] text-warn" title={`Same query ${np.count}×`}>
                            N+1
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums">
                        {dur(r) !== null ? `${Math.round(dur(r)!)}ms` : "—"}
                      </td>
                    </tr>
                  );
                })}
                {requests.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted">
                      Waiting for traffic. Pipe a Rails log in using one of the commands above.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {summary && summary.slowest.length > 0 && (
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <Panel title="Slowest actions">
              {summary.slowest.map((s, i) => (
                <Row
                  key={i}
                  left={`${s.controller}#${s.action}`}
                  sub={`${s.hits} hits · ${s.avg_queries ?? 0} queries avg`}
                  right={`${s.avg_ms}ms`}
                  rightSub={`max ${s.max_ms}ms`}
                />
              ))}
            </Panel>
            <Panel title="Failing endpoints">
              {summary.failing.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted">No failures in this window.</p>
              ) : (
                summary.failing.map((f, i) => (
                  <Row
                    key={i}
                    left={f.controller ? `${f.controller}#${f.action}` : "—"}
                    sub={f.error_class ?? ""}
                    right={String(f.status)}
                    rightSub={`${f.hits}×`}
                    tone="danger"
                  />
                ))
              )}
            </Panel>
            <Panel title="Hottest SQL">
              {summary.hotQueries.map((q, i) => (
                <Row
                  key={i}
                  left={q.fingerprint.slice(0, 70)}
                  mono
                  right={`${q.executions}×`}
                  rightSub={`${q.total_ms}ms`}
                />
              ))}
            </Panel>
            <Panel title="N+1 patterns">
              {summary.nPlusOne.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted">None detected.</p>
              ) : (
                summary.nPlusOne.map((n, i) => {
                  let parsed: { count?: number } = {};
                  try {
                    parsed = JSON.parse(n.n_plus_one);
                  } catch {}
                  return (
                    <Row
                      key={i}
                      left={`${n.controller}#${n.action}`}
                      sub={`repeated query ×${parsed.count ?? "?"}`}
                      right={`${n.hits}×`}
                      tone="warn"
                    />
                  );
                })
              )}
            </Panel>
          </div>
        )}
      </div>
      {selected && <RequestDrawer id={selected} onClose={() => setSelected(null)} />}
    </PageShell>
  );
}

// --- Ask the assistant about ONE observed request --------------------------
//
// Each preset maps to a question KJ raised about reverse-engineering Rails.
// The runtime evidence travels with the question, so the answer joins live
// telemetry to the source, the app graph and the docs in one turn.
const PRESETS = [
  { key: "trace", label: "Trace through the code", hint: "controller → services → models → SQL" },
  { key: "slow", label: "Why is it slow?", hint: "per-line attribution, ranked fixes" },
  { key: "meta", label: "What metaprogramming ran?", hint: "concerns, scopes, dynamic dispatch" },
  { key: "blast", label: "Blast radius of these tables", hint: "models, jobs, migration risk" },
  { key: "gap", label: "Static vs runtime gap", hint: "what each half alone would miss" },
  { key: "document", label: "Document this flow", hint: "sequence diagram + explanation" },
];

type Detail = {
  request: Req & {
    tables: string;
    metaprogramming: string;
    view_ms: number | null;
    error_message: string | null;
  };
  queries: {
    sql: string;
    duration_ms: number | null;
    cached: number;
    source: string | null;
    source_method: string | null;
  }[];
};

function RequestDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState("");

  useEffect(() => {
    fetch(`/api/runtime/requests/${id}`).then(async (r) => {
      if (r.ok) setDetail(await r.json());
    });
  }, [id]);

  const ask = async (preset?: string, customText?: string) => {
    setBusy(preset ?? "custom");
    const res = await fetch(`/api/runtime/requests/${id}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset, custom: customText }),
    });
    setBusy(null);
    if (!res.ok) return alert((await res.json()).error ?? "Could not start analysis");
    const { threadId, message } = await res.json();
    // The chat workspace picks this up and sends it once on mount.
    sessionStorage.setItem("tesseract:autoAsk", JSON.stringify({ threadId, message }));
    router.push(`/?t=${threadId}`);
  };

  const r = detail?.request;
  const tables: string[] = r ? JSON.parse(r.tables || "[]") : [];
  const meta: { kind: string; target: string }[] = r
    ? JSON.parse(r.metaprogramming || "[]")
    : [];
  const bySource = new Map<string, { n: number; ms: number; method: string | null }>();
  for (const q of detail?.queries ?? []) {
    if (!q.source) continue;
    const e = bySource.get(q.source) ?? { n: 0, ms: 0, method: q.source_method };
    e.n++;
    e.ms += q.duration_ms ?? 0;
    bySource.set(q.source, e);
  }
  const sources = [...bySource.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-border-app bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border-app px-5 py-4">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm">
              {r ? `${r.method} ${r.path}` : "Loading…"}
            </div>
            {r && (
              <div className="mt-0.5 text-xs text-muted">
                {r.controller}#{r.action} · {Math.round(dur(r) ?? 0)}ms · {sqlCount(r)} queries
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-foreground cursor-pointer"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!detail && <Spinner />}
          {r && (
            <>
              <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles className="size-4 text-accent" /> Ask across code, graph
                  and docs
                </div>
                <p className="mt-1 text-xs text-muted">
                  This request&apos;s runtime evidence travels with the question —
                  the assistant joins it to the indexed source, the application
                  graph and Confluence.
                </p>
                <div className="mt-3 grid gap-1.5">
                  {PRESETS.map((p) => (
                    <button
                      key={p.key}
                      onClick={() => ask(p.key)}
                      disabled={Boolean(busy)}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border-app bg-surface px-3 py-2 text-left hover:border-accent cursor-pointer disabled:opacity-60"
                    >
                      <span className="min-w-0">
                        <span className="block text-xs font-medium">{p.label}</span>
                        <span className="block text-[10px] text-muted">{p.hint}</span>
                      </span>
                      {busy === p.key ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <Sparkles className="size-3.5 shrink-0 text-muted" />
                      )}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && custom.trim()) ask(undefined, custom.trim());
                    }}
                    placeholder="Or ask your own question about this request…"
                    className="min-w-0 flex-1 rounded-lg border border-border-app bg-surface px-2.5 py-1.5 text-xs outline-none"
                  />
                  <Button
                    onClick={() => custom.trim() && ask(undefined, custom.trim())}
                    disabled={!custom.trim() || Boolean(busy)}
                  >
                    Ask
                  </Button>
                </div>
              </div>

              {nPlus(r) && (
                <div className="mt-4 rounded-lg border border-warn/40 bg-warn/5 p-3">
                  <div className="text-xs font-medium text-warn">
                    N+1 — same statement ran {nPlus(r)!.count}× in this request
                  </div>
                </div>
              )}

              {meta.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-xs font-medium">Metaprogramming observed</h3>
                  <div className="mt-1.5 space-y-1">
                    {meta.map((m, i) => (
                      <div key={i} className="rounded border border-border-app px-2 py-1 text-[11px]">
                        <span className="font-mono text-accent">{m.kind}</span>{" "}
                        <span className="text-muted">overwrote</span>{" "}
                        <span className="font-mono">{m.target}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {sources.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-xs font-medium">Queries by source line</h3>
                  <p className="text-[10px] text-muted">
                    Which line of code issued the SQL — not available from an APM.
                  </p>
                  <div className="mt-1.5 space-y-1">
                    {sources.map(([src, e]) => (
                      <div
                        key={src}
                        className="flex items-center justify-between gap-2 rounded border border-border-app px-2 py-1"
                      >
                        <span className="min-w-0 truncate font-mono text-[10px]" title={src}>
                          {src}
                          {e.method && <span className="text-muted"> in {e.method}</span>}
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-muted">
                          {e.n}× · {e.ms.toFixed(1)}ms
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {tables.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-xs font-medium">Tables touched</h3>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {tables.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px]"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// The differentiator: what the stream taught the map.
type MetaReport = {
  announced: { kind: string; target: string }[];
  generated: {
    method: string;
    file: string;
    executions: number;
    totalMs: number;
    chunksSeen: number;
    via: string | null;
    origin: "log" | "appmap";
  }[];
  generatedCount: number;
  definedCount: number;
  unknownCount: number;
  unindexedFiles: string[];
  observedMethods: number;
};

// The claim this product has to earn: reading the source cannot tell you which
// methods Rails will generate at runtime. Watching it run can, and this is that
// list — every method checked against the indexed source of its own file.
function MetaprogrammingPanel({ report }: { report: MetaReport }) {
  return (
    <div className="mt-5 rounded-xl border border-border-app bg-surface-2/40 p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Sparkles className="size-4 text-accent" /> Metaprogramming observed
      </h2>
      <p className="mt-1 text-xs text-muted">
        Methods that actually executed, checked against the indexed source of the
        file each one came from. Static analysis cannot produce this list. AppMap
        traces cover every call, including methods that touch no database; the
        log can only reveal a method that was on the stack when SQL ran.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Methods observed" value={String(report.observedMethods)} />
        <Stat
          label="Not in their source"
          value={String(report.generatedCount)}
          tone={report.generatedCount > 0 ? "danger" : undefined}
        />
        <Stat label="Found in source" value={String(report.definedCount)} />
        <Stat label="File not indexed" value={String(report.unknownCount)} />
      </div>

      {report.generated.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-medium text-danger">
            Generated at runtime — executed, but not written in the file it
            reports as its source
          </div>
          <div className="mt-1.5 space-y-1">
            {report.generated.slice(0, 12).map((g) => (
              <div
                key={g.file + g.method}
                className="flex items-baseline justify-between gap-3 rounded-lg bg-surface px-2.5 py-1.5"
              >
                <span className="min-w-0 truncate font-mono text-[11px]">
                  <span className="text-accent">{g.method}</span>
                  <span className="text-muted"> — {g.file}</span>
                  {g.via && (
                    <span className="text-muted"> · generated by {g.via}</span>
                  )}
                  <span className="text-muted">
                    {" "}
                    · {g.origin === "appmap" ? "AppMap call event" : "log attribution"}
                  </span>
                </span>
                <span
                  className="shrink-0 text-[10px] tabular-nums text-muted"
                  title={`judged against ${g.chunksSeen} indexed chunk(s) of this file`}
                >
                  {g.executions}x · {g.totalMs}ms
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {report.announced.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-medium text-muted">
            Announced by Rails as it happened
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {report.announced.slice(0, 12).map((a) => (
              <span
                key={a.kind + a.target}
                className="rounded-md bg-surface px-2 py-1 font-mono text-[10px]"
              >
                {a.kind} → {a.target}
              </span>
            ))}
          </div>
        </div>
      )}

      {report.unknownCount > 0 && (
        <p className="mt-3 rounded-lg bg-surface px-2.5 py-2 text-[11px] text-muted">
          {report.unknownCount} observed method
          {report.unknownCount === 1 ? "" : "s"} came from{" "}
          {report.unindexedFiles.length} file
          {report.unindexedFiles.length === 1 ? "" : "s"} that are not indexed,
          so no claim is made about them either way. Index the repository this
          app runs to judge them.
        </p>
      )}
    </div>
  );
}

function CoveragePanel({ coverage }: { coverage: Coverage }) {
  const pct = Math.round(coverage.coverage * 100);
  return (
    <div className="mt-5 rounded-xl border border-accent/30 bg-accent/5 p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Zap className="size-4 text-accent" /> Code coverage from live traffic
      </h2>
      <p className="mt-1 text-xs text-muted">
        Static analysis found every controller in the source. Runtime shows which
        ones are actually used. Neither half answers this alone.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Controllers in source" value={String(coverage.staticControllers)} />
        <Stat label="Exercised by traffic" value={String(coverage.exercised.length)} />
        <Stat
          label="Never exercised"
          value={String(coverage.unexercisedCount)}
          tone="warn"
        />
        <Stat
          label="Traffic, absent from source"
          value={String(coverage.undiscovered.length)}
          tone={coverage.undiscovered.length > 0 ? "danger" : undefined}
        />
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-[11px] text-muted">
          <span>{pct}% of controllers exercised</span>
          <span>{coverage.unexercisedCount} candidates for review</span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {coverage.undiscovered.length > 0 && (
        <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-2.5">
          <div className="text-[11px] font-medium text-danger">
            Serving traffic but not found by static analysis
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {coverage.undiscovered.map((c) => (
              <span key={c} className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px]">
                {c}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-muted">
            Engine mounts or dynamically defined controllers — the blind spot
            static analysis is accused of, made visible.
          </p>
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
          Show {coverage.unexercisedCount} controllers with no observed traffic
        </summary>
        <div className="mt-2 flex flex-wrap gap-1">
          {coverage.unexercised.map((c) => (
            <span
              key={c}
              className="rounded border border-border-app px-1.5 py-0.5 font-mono text-[10px] text-muted"
            >
              {c}
            </span>
          ))}
        </div>
      </details>
    </div>
  );
}

type Source = {
  id: string;
  name: string;
  kind: "port" | "file";
  port: number | null;
  file_path: string | null;
  app_url: string | null;
  resource_id: string | null;
  enabled: number;
  status: string;
  error: string | null;
  captured: number;
  last_seen_at: string | null;
};

// Any locally running application can be connected here: bind a port it pipes
// into, or point at its log file and it needs no change at all.
function SourceManager({
  onChanged,
  ingestToken,
}: {
  onChanged: () => void;
  ingestToken?: string;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [resources, setResources] = useState<{ id: string; name: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    kind: "port" as "port" | "file",
    port: "9100",
    file_path: "",
    app_url: "",
    resource_id: "",
    // Picking the codebase can also mean indexing it here and now, rather than
    // leaving for /facets and coming back to finish this form.
    facetMode: "existing" as "existing" | "new",
    repoUrl: "",
    repoBranch: "",
    shareWithOrg: false,
  });
  // A facet created by this form survives a failed source creation, so a retry
  // links the existing one instead of indexing the same repository twice.
  const createdFacetRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/runtime/sources");
    if (r.ok) {
      const d = await r.json();
      setSources(d.sources);
      setResources(d.resources);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);

    // Index the repository first when the user chose to add one here: the
    // source is worth little without the code it should line up against.
    let resourceId = form.resource_id;
    if (form.facetMode === "new") {
      if (createdFacetRef.current) {
        resourceId = createdFacetRef.current;
      } else {
        const url = form.repoUrl.trim();
        if (!url) {
          setBusy(false);
          return setError("A GitHub repository URL is required to add a facet");
        }
        const fr = await fetch("/api/resources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "github",
            url,
            branch: form.repoBranch.trim() || undefined,
            shareWithOrg: form.shareWithOrg,
          }),
        });
        if (!fr.ok) {
          setBusy(false);
          return setError((await fr.json()).error ?? "Could not add the facet");
        }
        resourceId = (await fr.json()).id as string;
        createdFacetRef.current = resourceId;
      }
    }

    const res = await fetch("/api/runtime/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        resource_id: resourceId || null,
        port: form.kind === "port" ? Number(form.port) : undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) return setError((await res.json()).error ?? "Could not add source");
    setAdding(false);
    createdFacetRef.current = null;
    setForm({
      ...form,
      name: "",
      file_path: "",
      app_url: "",
      facetMode: "existing",
      resource_id: "",
      repoUrl: "",
      repoBranch: "",
      shareWithOrg: false,
    });
    load();
    onChanged();
  };

  const toggle = async (s: Source) => {
    await fetch(`/api/runtime/sources/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    load();
  };

  const setResource = async (s: Source, resourceId: string) => {
    await fetch(`/api/runtime/sources/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_id: resourceId || null }),
    });
    load();
  };

  const remove = async (s: Source) => {
    if (!confirm(`Remove "${s.name}"? Captured telemetry is kept.`)) return;
    await fetch(`/api/runtime/sources/${s.id}`, { method: "DELETE" });
    load();
    onChanged();
  };

  const tone = (s: Source) =>
    s.status === "error" ? "danger" : s.enabled ? "success" : "neutral";

  return (
    <div className="mt-5 rounded-xl border border-border-app bg-surface-2/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Plug className="size-4 text-accent" /> Connected applications
        </h2>
        <Button variant="outline" onClick={() => setAdding((v) => !v)}>
          <Plus className="size-3.5" /> Add source
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted">
        Point this at any Rails app you are running — bind a port it pipes into,
        or tail its log file directly so the app needs no change at all. Add as
        many as you like, one per app or per branch; they are yours alone, and
        only your questions and stream see their traffic.
      </p>

      {adding && (
        <div className="mt-3 rounded-lg border border-border-app bg-surface p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-[11px] text-muted">
              Name
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="FMS dev"
                className="mt-1 w-full rounded-lg border border-border-app bg-surface px-2.5 py-1.5 text-xs text-foreground outline-none"
              />
            </label>
            <label className="text-[11px] text-muted">
              Transport
              <select
                value={form.kind}
                onChange={(e) =>
                  setForm({ ...form, kind: e.target.value as "port" | "file" })
                }
                className="mt-1 w-full rounded-lg border border-border-app bg-surface px-2.5 py-1.5 text-xs text-foreground"
              >
                <option value="port">TCP port — the app pipes to us</option>
                <option value="file">Log file — we tail it</option>
              </select>
            </label>
            {form.kind === "port" ? (
              <label className="text-[11px] text-muted">
                Port to listen on
                <input
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-border-app bg-surface px-2.5 py-1.5 text-xs tabular-nums text-foreground outline-none"
                />
              </label>
            ) : (
              <label className="text-[11px] text-muted">
                Absolute log file path
                <input
                  value={form.file_path}
                  onChange={(e) => setForm({ ...form, file_path: e.target.value })}
                  placeholder="/Users/you/app/log/development.log"
                  className="mt-1 w-full rounded-lg border border-border-app bg-surface px-2.5 py-1.5 font-mono text-[11px] text-foreground outline-none"
                />
              </label>
            )}
            <label className="text-[11px] text-muted">
              App URL (optional)
              <input
                value={form.app_url}
                onChange={(e) => setForm({ ...form, app_url: e.target.value })}
                placeholder="http://localhost:3000"
                className="mt-1 w-full rounded-lg border border-border-app bg-surface px-2.5 py-1.5 text-xs text-foreground outline-none"
              />
            </label>
          </div>

          {/* The codebase this app runs. Runtime observation is only half the
              story — the comparison against source is the point — so a facet
              can be indexed right here instead of in a separate trip. */}
          <div className="mt-2 rounded-lg border border-border-app bg-surface-2/40 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-muted">Its indexed codebase</span>
              <div className="flex items-center gap-1 text-[11px]">
                {(
                  [
                    ["existing", "Pick a facet"],
                    ["new", "Add a facet"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setForm({ ...form, facetMode: mode })}
                    className={cx(
                      "rounded-md px-2 py-1 cursor-pointer",
                      form.facetMode === mode
                        ? "bg-surface text-accent"
                        : "text-muted hover:text-foreground"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {form.facetMode === "existing" ? (
              <select
                value={form.resource_id}
                onChange={(e) => setForm({ ...form, resource_id: e.target.value })}
                className="mt-2 w-full rounded-lg border border-border-app bg-surface px-2.5 py-1.5 text-xs text-foreground"
              >
                <option value="">— none —</option>
                {resources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="text-[11px] text-muted sm:col-span-2">
                  GitHub repository URL
                  <input
                    value={form.repoUrl}
                    onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
                    placeholder="https://github.com/org/app"
                    className="mt-1 w-full rounded-lg border border-border-app bg-surface px-2.5 py-1.5 font-mono text-[11px] text-foreground outline-none"
                  />
                </label>
                <label className="text-[11px] text-muted">
                  Branch (optional)
                  <input
                    value={form.repoBranch}
                    onChange={(e) => setForm({ ...form, repoBranch: e.target.value })}
                    placeholder="repository default"
                    className="mt-1 w-full rounded-lg border border-border-app bg-surface px-2.5 py-1.5 text-xs text-foreground outline-none"
                  />
                </label>
                <label className="mt-4 flex items-center gap-2 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={form.shareWithOrg}
                    onChange={(e) => setForm({ ...form, shareWithOrg: e.target.checked })}
                    className="size-3.5 accent-current"
                  />
                  Share with the organization
                </label>
                <p className="text-[11px] text-muted sm:col-span-2">
                  Indexing starts in the background; the source is linked to it
                  immediately and lines up as soon as the repository is ready.
                </p>
              </div>
            )}
          </div>

          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={busy}>
              {busy ? <Spinner className="size-3.5" /> : null} Add &amp; start
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {sources.map((s) => (
          <div key={s.id} className="rounded-lg border border-border-app bg-surface p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {s.kind === "file" ? (
                    <FileText className="size-3.5 text-muted" />
                  ) : (
                    <Plug className="size-3.5 text-muted" />
                  )}
                  <span className="text-sm font-medium">{s.name}</span>
                  <Badge tone={tone(s) as "success" | "danger" | "neutral"}>
                    {s.status}
                  </Badge>
                  {s.captured > 0 && (
                    <span className="text-[10px] text-muted">
                      {s.captured.toLocaleString()} captured
                    </span>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-muted">
                  {s.kind === "port" ? `tcp://localhost:${s.port}` : s.file_path}
                </div>
                {s.error && <div className="mt-0.5 text-[11px] text-danger">{s.error}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => toggle(s)}
                  className={cx(
                    "rounded p-1.5 cursor-pointer",
                    s.enabled ? "text-success hover:bg-surface-2" : "text-muted hover:text-foreground"
                  )}
                  title={s.enabled ? "Stop listener" : "Start listener"}
                >
                  <Power className="size-4" />
                </button>
                <button
                  onClick={() => remove(s)}
                  className="rounded p-1.5 text-muted hover:text-danger cursor-pointer"
                  title="Remove"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={s.resource_id ?? ""}
                onChange={(e) => setResource(s, e.target.value)}
                className="rounded-md border border-border-app bg-surface px-1.5 py-0.5 text-[11px] text-muted"
                title="Which indexed codebase this app's source lives in"
              >
                <option value="">no codebase linked</option>
                {resources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              {s.kind === "port" && s.enabled && (
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded border border-border-app bg-surface-2/60 px-2 py-1 font-mono text-[10px]">
                  {`tail -f log/development.log | nc localhost ${s.port}`}
                </code>
              )}
              {s.kind === "port" && s.enabled && (
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(
                      `tail -f log/development.log | nc localhost ${s.port}`
                    )
                  }
                  className="shrink-0 rounded p-1 text-muted hover:text-foreground cursor-pointer"
                  title="Copy"
                >
                  <Copy className="size-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
        {sources.length === 0 && (
          <p className="rounded-lg border border-dashed border-border-app px-3 py-6 text-center text-xs text-muted">
            No applications connected yet.
          </p>
        )}
      </div>

      {ingestToken && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-muted hover:text-foreground">
            Streaming from another host? Use the HTTP endpoint
          </summary>
          <code className="mt-1 block overflow-x-auto whitespace-pre rounded border border-border-app bg-surface p-2 font-mono text-[10px]">
            {`tail -f log/development.log | curl -N -X POST http://localhost:3002/api/runtime/ingest \\\n  -H "X-Tesseract-Token: ${ingestToken}" --data-binary @-`}
          </code>
        </details>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  tone?: "danger" | "warn";
}) {
  return (
    <div className="rounded-lg border border-border-app p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
        {icon}
        {label}
      </div>
      <div
        className={cx(
          "mt-1 text-lg font-semibold tabular-nums",
          tone === "danger" && "text-danger",
          tone === "warn" && "text-warn"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="mt-2 overflow-hidden rounded-xl border border-border-app bg-surface">
        {children}
      </div>
    </div>
  );
}

function Row({
  left,
  sub,
  right,
  rightSub,
  mono,
  tone,
}: {
  left: string;
  sub?: string;
  right: string;
  rightSub?: string;
  mono?: boolean;
  tone?: "danger" | "warn";
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border-app px-3 py-2 last:border-0">
      <div className="min-w-0">
        <div className={cx("truncate text-xs", mono && "font-mono")} title={left}>
          {left}
        </div>
        {sub && <div className="truncate text-[10px] text-muted">{sub}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div
          className={cx(
            "text-xs font-medium tabular-nums",
            tone === "danger" && "text-danger",
            tone === "warn" && "text-warn"
          )}
        >
          {right}
        </div>
        {rightSub && <div className="text-[10px] text-muted">{rightSub}</div>}
      </div>
    </div>
  );
}
