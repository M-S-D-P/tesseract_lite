"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Database,
  Layers,
  MessageSquare,
  Boxes,
  Workflow,
  ChevronRight,
} from "lucide-react";
import { PageShell } from "@/components/TopBar";
import { Badge, ProgressBar, Spinner, cx } from "@/components/ui";

type Metrics = {
  retrievalBackend: string;
  graph: { entities: number; edges: number };
  sources: {
    byType: { type: string; count: number }[];
    documents: number;
    chunks: number;
    drift: number;
  };
  embeddings: { vectors: number; tokens: number; daily: { date: string; total: number }[] };
  hostedStore: { uploads: number; bytes: number };
  retrieval: { fileSearches: number; localSearches: number };
  chat: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    byModel: { model: string; total: number }[];
    daily: { date: string; total: number }[];
  };
  jobs: {
    id: string;
    type: string;
    status: string;
    attempts: number;
    error: string | null;
    created_at: string;
  }[];
  activeJobs: number;
  resources: {
    id: string;
    name: string;
    status: string;
    progress_phase: string | null;
    progress_done: number | null;
    progress_total: number | null;
    sync_interval: string;
    next_sync_at: string | null;
  }[];
};

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

const TYPE_LABELS: Record<string, string> = {
  github: "repos",
  confluence: "spaces",
  folder: "folders",
  file: "files",
};

export default function PipelinePage() {
  const [m, setM] = useState<Metrics | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/metrics");
    if (res.ok) setM(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll fast while work is flowing, slower when idle.
  useEffect(() => {
    const t = setInterval(load, m && m.activeJobs > 0 ? 3000 : 12000);
    return () => clearInterval(t);
  }, [load, m]);

  if (!m) {
    return (
      <PageShell title="Pipeline">
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      </PageShell>
    );
  }

  const processing = m.resources.filter(
    (r) => r.status === "processing" || r.status === "pending"
  );
  const scheduled = m.resources.filter((r) => r.sync_interval !== "manual");
  const flowing = m.activeJobs > 0;

  return (
    <PageShell title="Pipeline">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold">Pipeline</h1>
              <p className="mt-1 text-sm text-muted">
                Live view of the facet pipeline — sources through ingestion,
                embedding, both vector stores, and retrieval.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {flowing ? (
                <Badge tone="accent">
                  ⚡ {m.activeJobs} job{m.activeJobs === 1 ? "" : "s"} running
                </Badge>
              ) : (
                <Badge tone="success">✓ idle — all work complete</Badge>
              )}
            </div>
          </div>

          {/* Stage cards */}
          <div className="mt-6 flex flex-col items-stretch gap-2 xl:flex-row xl:items-start">
            <StageCard
              icon={<Boxes className="size-4" />}
              title="Sources"
              flowing={flowing}
            >
              {m.sources.byType.length === 0 && (
                <p className="text-xs text-muted">Nothing connected yet</p>
              )}
              {m.sources.byType.map((t) => (
                <Stat
                  key={t.type}
                  label={TYPE_LABELS[t.type] ?? t.type}
                  value={fmt(t.count)}
                />
              ))}
              <div className="mt-2 text-[11px] text-muted">
                {scheduled.length > 0
                  ? `${scheduled.length} on sync schedule`
                  : "no sync schedules"}
              </div>
            </StageCard>

            <Connector active={flowing} />

            <StageCard
              icon={<Workflow className="size-4" />}
              title="Ingestion"
              flowing={flowing}
            >
              <Stat label="queue" value={String(m.activeJobs)} />
              {processing.slice(0, 3).map((r) => (
                <div key={r.id} className="mt-1">
                  <div className="truncate text-[11px]">{r.name}</div>
                  <ProgressBar
                    phase={r.progress_phase ?? "queued"}
                    done={r.progress_done}
                    total={r.progress_total}
                  />
                </div>
              ))}
              {processing.length === 0 && (
                <p className="text-xs text-muted">No active ingestion</p>
              )}
            </StageCard>

            <Connector active={flowing} />

            <StageCard
              icon={<Layers className="size-4" />}
              title="Embedding"
              flowing={flowing}
            >
              <Stat label="embeddings generated" value={fmt(m.embeddings.vectors)} hero />
              <Stat label="embedding tokens" value={fmt(m.embeddings.tokens)} />
              <Sparkline
                data={m.embeddings.daily}
                label="embedding tokens · last 14 days"
              />
            </StageCard>

            <Connector active={flowing} />

            <StageCard
              icon={<Database className="size-4" />}
              title="Dual stores"
              flowing={flowing}
            >
              <div className="flex gap-4">
                <Stat label="hosted uploads" value={fmt(m.hostedStore.uploads)} />
                <Stat label="local chunks" value={fmt(m.sources.chunks)} />
              </div>
              <Stat label="documents" value={fmt(m.sources.documents)} />
              {m.graph.entities > 0 && (
                <Stat
                  label="app graph (entities · edges)"
                  value={`${fmt(m.graph.entities)} · ${fmt(m.graph.edges)}`}
                />
              )}
              <div className="mt-1.5">
                {m.sources.drift === 0 ? (
                  <Badge tone="success">✓ stores in sync</Badge>
                ) : (
                  <Badge tone="warn">⚠ {m.sources.drift} docs drifted</Badge>
                )}
              </div>
              <div className="mt-1 text-[11px] text-muted">
                {fmtBytes(m.hostedStore.bytes)} uploaded to OpenAI
              </div>
            </StageCard>

            <Connector active={flowing} />

            <StageCard
              icon={<MessageSquare className="size-4" />}
              title="Retrieval & chat"
              flowing={flowing}
            >
              <div className="mb-1.5">
                <Badge tone="accent">
                  serving: {m.retrievalBackend === "openai" ? "OpenAI-hosted" : "local"}
                </Badge>
              </div>
              <div className="flex gap-4">
                <Stat
                  label="facet searches"
                  value={fmt(m.retrieval.fileSearches + m.retrieval.localSearches)}
                />
                <Stat label="chats" value={fmt(m.chat.requests)} />
              </div>
              <div className="flex gap-4">
                <Stat label="tokens in" value={fmt(m.chat.inputTokens)} />
                <Stat label="tokens out" value={fmt(m.chat.outputTokens)} />
              </div>
              <Sparkline data={m.chat.daily} label="chat tokens · last 14 days" />
            </StageCard>
          </div>

          {/* Model usage + schedules */}
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <section className="rounded-xl border border-border-app bg-surface p-4">
              <h2 className="text-sm font-semibold">Output tokens by model</h2>
              {m.chat.byModel.length === 0 && (
                <p className="mt-2 text-xs text-muted">No chat usage yet</p>
              )}
              <div className="mt-2 flex flex-col gap-1.5">
                {m.chat.byModel.map((row) => {
                  const max = m.chat.byModel[0]?.total || 1;
                  return (
                    <div key={row.model} className="flex items-center gap-2 text-xs">
                      <span className="w-36 truncate font-mono">{row.model}</span>
                      <div className="h-3.5 flex-1 overflow-hidden rounded bg-surface-2">
                        <div
                          className="h-full rounded bg-accent/70"
                          style={{ width: `${Math.max((row.total / max) * 100, 2)}%` }}
                          title={`${row.model}: ${row.total.toLocaleString()} output tokens`}
                        />
                      </div>
                      <span className="w-14 text-right tabular-nums text-muted">
                        {fmt(row.total)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-xl border border-border-app bg-surface p-4">
              <h2 className="text-sm font-semibold">Sync schedules</h2>
              {scheduled.length === 0 && (
                <p className="mt-2 text-xs text-muted">
                  All resources on manual sync — set schedules on the Knowledge page.
                </p>
              )}
              <div className="mt-2 flex flex-col gap-1.5">
                {scheduled.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    <Badge>{r.sync_interval}</Badge>
                    <span className="w-40 text-right text-muted">
                      {r.next_sync_at
                        ? `next: ${new Date(r.next_sync_at).toLocaleString()}`
                        : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Jobs */}
          <section className="mt-6 rounded-xl border border-border-app bg-surface p-4">
            <h2 className="text-sm font-semibold">Background jobs</h2>
            {m.jobs.length === 0 && (
              <p className="mt-2 text-xs text-muted">No jobs yet</p>
            )}
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <tbody>
                  {m.jobs.map((j) => (
                    <tr key={j.id} className="border-b border-border-app last:border-0">
                      <td className="py-1.5 pr-3 font-mono">{j.type}</td>
                      <td className="py-1.5 pr-3">
                        {j.status === "done" && <Badge tone="success">done</Badge>}
                        {j.status === "running" && (
                          <span className="inline-flex items-center gap-1">
                            <Spinner className="size-3" />
                            <Badge tone="accent">running</Badge>
                          </span>
                        )}
                        {j.status === "queued" && <Badge tone="warn">queued</Badge>}
                        {j.status === "error" && <Badge tone="danger">failed</Badge>}
                      </td>
                      <td className="py-1.5 pr-3 text-muted">
                        {j.attempts > 1 ? `attempt ${j.attempts}` : ""}
                      </td>
                      <td className="py-1.5 pr-3 text-muted">
                        {new Date(j.created_at.replace(" ", "T") + "Z").toLocaleString()}
                      </td>
                      <td className="max-w-64 truncate py-1.5 text-danger" title={j.error ?? ""}>
                        {j.error ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </PageShell>
  );
}

function StageCard({
  icon,
  title,
  flowing,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  flowing: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        "min-w-0 flex-1 rounded-xl border bg-surface p-4",
        flowing ? "border-accent/40" : "border-border-app"
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="text-accent">{icon}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

function Connector({ active }: { active: boolean }) {
  return (
    <div className="flex items-center justify-center py-1 xl:h-24 xl:py-0">
      <ChevronRight
        className={cx(
          "size-4 rotate-90 xl:rotate-0",
          active ? "animate-pulse text-accent" : "text-muted/50"
        )}
      />
    </div>
  );
}

function Stat({ label, value, hero }: { label: string; value: string; hero?: boolean }) {
  return (
    <div className="mt-1">
      <div className={cx("tabular-nums", hero ? "text-2xl font-semibold" : "text-base font-medium")}>
        {value}
      </div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

// Single-series sparkline: 2px accent line over a soft area fill, per-point
// hover via native titles. Identity is named by the label — no legend needed.
function Sparkline({
  data,
  label,
}: {
  data: { date: string; total: number }[];
  label: string;
}) {
  const W = 220;
  const H = 40;
  const max = Math.max(...data.map((d) => d.total), 1);
  const pts = data.map((d, i) => ({
    x: (i / Math.max(data.length - 1, 1)) * (W - 4) + 2,
    y: H - 3 - (d.total / max) * (H - 8),
    ...d,
  }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${H - 1} L${pts[0].x.toFixed(1)},${H - 1} Z`;
  return (
    <div className="mt-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-10 w-full"
        role="img"
        aria-label={label}
      >
        <path d={area} fill="var(--accent)" opacity="0.12" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        {pts.map((p) => (
          <circle key={p.date} cx={p.x} cy={p.y} r="6" fill="transparent">
            <title>{`${p.date}: ${p.total.toLocaleString()} tokens`}</title>
          </circle>
        ))}
      </svg>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  );
}
