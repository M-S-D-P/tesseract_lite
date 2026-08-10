"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import {
  SlidersHorizontal,
  FlaskConical,
  Play,
  Sparkles,
  Trash2,
  RefreshCw,
  Database,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Zap,
} from "lucide-react";
import { PageShell } from "@/components/TopBar";
import { Badge, Button, Input, Spinner, cx } from "@/components/ui";

type Stats = {
  store: string;
  backend: string;
  embeddingModel: string;
  dimensions: number;
  documents: number;
  resources: number;
  chunks: number;
  avgChars: number;
  maxChars: number;
  minChars: number;
  configuredSize: number;
  stale: boolean;
};

type EvalSet = { id: string; name: string; questions: number; created_at: string };

type EvalRun = {
  id: string;
  set_id: string;
  set_name: string;
  label: string;
  config: string;
  status: string;
  error: string | null;
  done_count: number;
  total_count: number;
  metrics: string;
  created_at: string;
};

type Metrics = {
  questions: number;
  scored: number;
  hitRate: number;
  mrr: number;
  correctness: number;
  groundedness: number;
  avgLatencyMs: number;
  tokensIn: number;
  tokensOut: number;
  errors: number;
};

export default function TuningPage() {
  const [tab, setTab] = useState<"params" | "eval">("params");
  return (
    <PageShell title="Tuning & Evaluation">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-xl font-semibold">Tuning &amp; Evaluation</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Change how documents are split, embedded, and retrieved — then measure
          what the change did. Every evaluation run pins the configuration it ran
          under, so two runs compare two configurations rather than two guesses.
        </p>

        <div className="mt-6 flex gap-1 border-b border-border-app">
          {(
            [
              ["params", "Parameters", <SlidersHorizontal key="a" className="size-4" />],
              ["eval", "Evaluation", <FlaskConical key="b" className="size-4" />],
            ] as const
          ).map(([key, label, icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cx(
                "-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm cursor-pointer",
                tab === key
                  ? "border-accent text-foreground"
                  : "border-transparent text-muted hover:text-foreground"
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>

        <div className="mt-6">
          {tab === "params" ? <ParametersTab /> : <EvaluationTab />}
        </div>
      </div>
    </PageShell>
  );
}

// --- Parameters ------------------------------------------------------------

const FIELDS: {
  key: string;
  label: string;
  help: string;
  type?: "number" | "text" | "select";
  options?: string[];
  reindex?: boolean;
}[] = [
  {
    key: "chunk_size",
    label: "Chunk size (characters)",
    help: "How much text goes into one indexed unit. Larger keeps more context together but dilutes the embedding; smaller is sharper but fragments reasoning across chunks. 3600 ≈ 900 tokens.",
    type: "number",
    reindex: true,
  },
  {
    key: "chunk_overlap",
    label: "Chunk overlap (characters)",
    help: "Text repeated between adjacent chunks so an answer spanning a boundary is not lost. Typically 10–15% of chunk size.",
    type: "number",
    reindex: true,
  },
  {
    key: "embedding_provider",
    label: "Embedding provider",
    help: "Local runs a sentence-transformer on this server (384-dim, no vendor key). OpenAI uses text-embedding-3-small (1536-dim, needs OPENAI_API_KEY). Chat is Claude either way. Switching invalidates every existing vector — the corpus must be fully re-indexed.",
    type: "select",
    options: ["local", "openai"],
    reindex: true,
  },
  {
    key: "retrieval_k",
    label: "Top-K retrieved chunks",
    help: "How many chunks are handed to the model per search. Higher recall, more tokens, more room for distraction. Takes effect immediately — no re-index.",
    type: "number",
  },
  {
    key: "temperature",
    label: "Temperature",
    help: "Sampling randomness, 0–2. Blank uses the provider default. Reasoning models (GPT-5.6, Claude thinking) ignore this — the reasoning tier is the equivalent control there.",
    type: "text",
  },
  {
    key: "eval_judge_model",
    label: "Judge model",
    help: "Model used to generate evaluation questions and grade answers. Keep this fixed while comparing runs, or you are measuring the judge instead of the change.",
    type: "text",
  },
];

function ParametersTab() {
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    const res = await fetch("/api/tuning/stats");
    if (res.ok) setStats(await res.json());
  }, []);

  useEffect(() => {
    fetch("/api/admin/settings").then(async (r) => {
      if (r.ok) setSettings((await r.json()).settings);
      else setError("Admin access is required to change these parameters.");
    });
    loadStats();
  }, [loadStats]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    const body: Record<string, string> = {};
    for (const f of FIELDS) body[f.key] = settings[f.key] ?? "";
    const res = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Save failed");
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    loadStats();
  };

  if (error && !settings) return <p className="text-sm text-danger">{error}</p>;
  if (!settings) return <Spinner />;

  return (
    <div className="space-y-6">
      <CorpusPanel stats={stats} onRefresh={loadStats} />

      <div className="rounded-xl border border-border-app">
        {FIELDS.map((f, i) => (
          <div
            key={f.key}
            className={cx(
              "flex flex-col gap-3 p-4 sm:flex-row sm:items-start",
              i > 0 && "border-t border-border-app"
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">{f.label}</label>
                {f.reindex && (
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    re-index
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{f.help}</p>
            </div>
            <div className="w-full shrink-0 sm:w-52">
              {f.type === "select" ? (
                <select
                  value={settings[f.key] ?? ""}
                  onChange={(e) =>
                    setSettings({ ...settings, [f.key]: e.target.value })
                  }
                  className="w-full rounded-lg border border-border-app bg-surface px-2.5 py-1.5 text-sm"
                >
                  {f.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  type={f.type === "number" ? "number" : "text"}
                  value={settings[f.key] ?? ""}
                  placeholder={f.key === "temperature" ? "provider default" : ""}
                  onChange={(e) =>
                    setSettings({ ...settings, [f.key]: e.target.value })
                  }
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving}>
          {saving ? <Spinner className="size-4" /> : null} Save parameters
        </Button>
        {saved && <span className="text-sm text-success">Saved</span>}
        <p className="text-xs text-muted">
          Chunking and embedding changes apply to documents indexed afterwards —
          re-sync a facet to rebuild it under the new settings.
        </p>
      </div>
    </div>
  );
}

function CorpusPanel({ stats, onRefresh }: { stats: Stats | null; onRefresh: () => void }) {
  if (!stats) return null;
  const cells = [
    ["Store", stats.store],
    ["Serving", stats.backend],
    ["Documents", stats.documents.toLocaleString()],
    ["Chunks", stats.chunks.toLocaleString()],
    ["Dimensions", String(stats.dimensions)],
    ["Avg chunk", `${stats.avgChars.toLocaleString()} ch`],
    ["Min / Max", `${stats.minChars} / ${stats.maxChars.toLocaleString()}`],
    ["Embedding", stats.embeddingModel.replace("text-embedding-", "")],
  ];
  return (
    <div className="rounded-xl border border-border-app bg-surface-2/40 p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Database className="size-4 text-accent" /> Indexed corpus
        </h2>
        <button
          onClick={onRefresh}
          className="rounded p-1 text-muted hover:text-foreground cursor-pointer"
          title="Refresh"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-4">
        {cells.map(([k, v]) => (
          <div key={k}>
            <div className="text-[11px] uppercase tracking-wide text-muted">{k}</div>
            <div className="text-sm font-medium tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      {stats.stale && (
        <p className="mt-3 flex items-start gap-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Some chunks are longer than the configured size of{" "}
          {stats.configuredSize.toLocaleString()} characters — they were indexed
          under a previous setting. Re-sync affected facets to rebuild them.
        </p>
      )}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
  sub,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  sub: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg border border-border-app p-3 text-left hover:bg-surface-2/50 cursor-pointer"
    >
      <span
        className={cx(
          "mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors",
          checked ? "bg-accent" : "bg-surface-2 border border-border-app"
        )}
      >
        <span
          className={cx(
            "size-4 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0"
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium">
          {label}
          <span className={cx("text-[10px] uppercase tracking-wide", checked ? "text-accent" : "text-muted")}>
            {checked ? "on" : "off"}
          </span>
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{sub}</span>
      </span>
    </button>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

// --- Evaluation ------------------------------------------------------------

function EvaluationTab() {
  const [sets, setSets] = useState<EvalSet[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [newName, setNewName] = useState("");
  const [genCount, setGenCount] = useState("15");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([fetch("/api/eval/sets"), fetch("/api/eval/runs")]);
    if (s.ok) setSets((await s.json()).sets);
    if (r.ok) setRuns((await r.json()).runs);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while a run or generation is in flight.
  useEffect(() => {
    const active = runs.some((r) => r.status === "queued" || r.status === "running");
    if (!active && !busy) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [runs, busy, load]);

  const createSet = async () => {
    if (!newName.trim()) return;
    setBusy("create");
    await fetch("/api/eval/sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });
    setNewName("");
    setBusy(null);
    load();
  };

  const generate = async (setId: string) => {
    setBusy(setId);
    await fetch(`/api/eval/sets/${setId}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: Number(genCount) || 10 }),
    });
    setTimeout(() => {
      setBusy(null);
      load();
    }, 1500);
  };

  const runNow = async (setId: string) => {
    const label = prompt(
      "Label this run (what are you testing?)",
      "baseline"
    );
    if (label === null) return;
    setBusy(setId);
    const res = await fetch("/api/eval/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setId, label }),
    });
    setBusy(null);
    if (!res.ok) alert((await res.json()).error ?? "Could not start run");
    load();
  };

  const deleteSet = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}" and all of its runs?`)) return;
    await fetch(`/api/eval/sets/${id}`, { method: "DELETE" });
    load();
  };

  const list = sets;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-sm font-medium">Question sets</h2>
        <p className="mt-1 max-w-2xl text-xs text-muted">
          A question set is your ground truth. Generating questions samples real
          chunks from the indexed corpus and asks the judge model to write a
          question only that chunk can answer — so the document it came from
          becomes the correct retrieval target, scored objectively.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            placeholder="New set name — e.g. “Discourse retrieval baseline”"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="min-w-[240px] flex-1"
          />
          <Button onClick={createSet} disabled={busy === "create" || !newName.trim()}>
            {busy === "create" ? <Spinner className="size-4" /> : null} Create set
          </Button>
        </div>

        <div className="mt-3 overflow-hidden rounded-xl border border-border-app">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-app bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5 font-medium">Set</th>
                <th className="px-4 py-2.5 font-medium">Questions</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="bg-surface">
              {list.map((s) => (
                <tr key={s.id} className="border-b border-border-app last:border-0">
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  <td className="px-4 py-3 tabular-nums text-muted">{s.questions}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <input
                        value={genCount}
                        onChange={(e) => setGenCount(e.target.value)}
                        className="w-14 rounded-md border border-border-app bg-surface px-2 py-1 text-xs tabular-nums"
                        title="How many questions to generate"
                      />
                      <Button
                        variant="outline"
                        onClick={() => generate(s.id)}
                        disabled={busy === s.id}
                      >
                        {busy === s.id ? (
                          <Spinner className="size-3.5" />
                        ) : (
                          <Sparkles className="size-3.5" />
                        )}
                        Generate
                      </Button>
                      <Button onClick={() => runNow(s.id)} disabled={s.questions === 0}>
                        <Play className="size-3.5" /> Run
                      </Button>
                      <button
                        onClick={() => deleteSet(s.id, s.name)}
                        className="rounded p-1.5 text-muted hover:text-danger cursor-pointer"
                        aria-label="Delete set"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && list.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-sm text-muted">
                    No question sets yet. Create one, then generate questions from
                    your indexed corpus.
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center">
                    <Spinner />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <RunsSection runs={runs} onChanged={load} />
    </div>
  );
}

const METRIC_COLS: {
  key: keyof Metrics;
  label: string;
  fmt: (v: number) => string;
  higherIsBetter: boolean;
}[] = [
  { key: "hitRate", label: "Hit rate", fmt: (v) => `${Math.round(v * 100)}%`, higherIsBetter: true },
  { key: "mrr", label: "MRR", fmt: (v) => v.toFixed(2), higherIsBetter: true },
  {
    key: "correctness",
    label: "Correctness",
    fmt: (v) => `${Math.round(v * 100)}%`,
    higherIsBetter: true,
  },
  {
    key: "groundedness",
    label: "Grounded",
    fmt: (v) => `${Math.round(v * 100)}%`,
    higherIsBetter: true,
  },
  {
    key: "avgLatencyMs",
    label: "Latency",
    fmt: (v) => `${(v / 1000).toFixed(1)}s`,
    higherIsBetter: false,
  },
];

function RunsSection({ runs, onChanged }: { runs: EvalRun[]; onChanged: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const done = runs.filter((r) => r.status === "done");
  const best: Partial<Record<keyof Metrics, number>> = {};
  for (const col of METRIC_COLS) {
    const vals = done
      .map((r) => (JSON.parse(r.metrics || "{}") as Metrics)[col.key])
      .filter((v) => typeof v === "number");
    if (vals.length > 1) {
      best[col.key] = col.higherIsBetter ? Math.max(...vals) : Math.min(...vals);
    }
  }

  return (
    <section>
      <h2 className="text-sm font-medium">Runs</h2>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        <strong className="font-medium text-foreground">Hit rate</strong> and{" "}
        <strong className="font-medium text-foreground">MRR</strong> measure
        retrieval objectively — whether the source document came back, and how
        high it ranked. <strong className="font-medium text-foreground">Correctness</strong>{" "}
        and <strong className="font-medium text-foreground">grounded</strong> are
        judge scores for the answer and whether it stuck to the retrieved
        context. Best value in each column is highlighted.
      </p>

      <div className="mt-3 overflow-x-auto rounded-xl border border-border-app">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-border-app bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-2.5 font-medium">Run</th>
              <th className="px-4 py-2.5 font-medium">Configuration</th>
              {METRIC_COLS.map((c) => (
                <th key={c.key} className="px-3 py-2.5 text-right font-medium">
                  {c.label}
                </th>
              ))}
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="bg-surface">
            {runs.map((r) => {
              const cfg = JSON.parse(r.config || "{}");
              const m = JSON.parse(r.metrics || "{}") as Metrics;
              const isDone = r.status === "done";
              return (
                <Fragment key={r.id}>
                  <tr className="border-b border-border-app last:border-0">
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                        className="flex items-center gap-1.5 text-left cursor-pointer"
                      >
                        {expanded === r.id ? (
                          <ChevronDown className="size-3.5 text-muted" />
                        ) : (
                          <ChevronRight className="size-3.5 text-muted" />
                        )}
                        <span className="font-medium">{r.label || "unlabelled"}</span>
                      </button>
                      <div className="mt-0.5 pl-5 text-[11px] text-muted">{r.set_name}</div>
                      {!isDone && (
                        <div className="mt-1 pl-5">
                          {r.status === "error" ? (
                            <Badge tone="danger">error</Badge>
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              <Spinner className="size-3" />
                              <span className="text-[11px] text-muted">
                                {r.done_count}/{r.total_count}
                              </span>
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <ConfigChip label="store" value={cfg.backend} />
                        <ConfigChip label="chunk" value={cfg.chunkSize} />
                        <ConfigChip label="ovlp" value={cfg.chunkOverlap} />
                        <ConfigChip label="k" value={cfg.retrievalK} />
                        <ConfigChip label="temp" value={cfg.temperature || "default"} />
                        <ConfigChip label="model" value={cfg.model} />
                      </div>
                    </td>
                    {METRIC_COLS.map((c) => {
                      const v = m[c.key];
                      const isBest = best[c.key] !== undefined && v === best[c.key];
                      return (
                        <td
                          key={c.key}
                          className={cx(
                            "px-3 py-3 text-right tabular-nums",
                            isBest ? "font-semibold text-accent" : "text-foreground"
                          )}
                        >
                          {isDone && typeof v === "number" ? c.fmt(v) : "—"}
                        </td>
                      );
                    })}
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={async () => {
                          if (!confirm("Delete this run?")) return;
                          await fetch(`/api/eval/runs/${r.id}`, { method: "DELETE" });
                          onChanged();
                        }}
                        className="rounded p-1.5 text-muted hover:text-danger cursor-pointer"
                        aria-label="Delete run"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr>
                      <td colSpan={METRIC_COLS.length + 3} className="bg-surface-2/40 px-4 py-3">
                        <RunDetail runId={r.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {runs.length === 0 && (
              <tr>
                <td
                  colSpan={METRIC_COLS.length + 3}
                  className="px-4 py-8 text-center text-sm text-muted"
                >
                  No runs yet. Run a question set to get a baseline, change a
                  parameter, then run it again to see the difference.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ConfigChip({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="rounded border border-border-app bg-surface px-1.5 py-0.5 text-[10px] text-muted">
      {label} <span className="font-medium text-foreground">{String(value)}</span>
    </span>
  );
}

type ResultRow = {
  id: string;
  question: string;
  expected: string;
  answer: string;
  source_label: string | null;
  hit: number;
  rank: number | null;
  correctness: number | null;
  groundedness: number | null;
  judge_note: string | null;
  latency_ms: number;
  error: string | null;
};

function RunDetail({ runId }: { runId: string }) {
  const [rows, setRows] = useState<ResultRow[] | null>(null);

  useEffect(() => {
    fetch(`/api/eval/runs/${runId}`).then(async (r) => {
      if (r.ok) setRows((await r.json()).results);
    });
  }, [runId]);

  if (!rows) return <Spinner className="size-4" />;
  if (rows.length === 0) return <p className="text-xs text-muted">No results recorded.</p>;

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.id} className="rounded-lg border border-border-app bg-surface p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium">{row.question}</p>
            <div className="flex shrink-0 items-center gap-1.5">
              {row.hit ? (
                <Badge tone="success">rank {row.rank}</Badge>
              ) : (
                <Badge tone="danger">missed</Badge>
              )}
              {row.correctness !== null && (
                <Badge tone={row.correctness >= 4 ? "success" : row.correctness >= 2 ? "warn" : "danger"}>
                  {row.correctness}/5
                </Badge>
              )}
            </div>
          </div>
          {row.source_label && (
            <p className="mt-1 text-[11px] text-muted">
              expected source: <span className="font-mono">{row.source_label}</span>
            </p>
          )}
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Reference</div>
              <p className="mt-0.5 text-xs leading-relaxed">{row.expected}</p>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Answer</div>
              <p className="mt-0.5 text-xs leading-relaxed">
                {row.error ? (
                  <span className="text-danger">{row.error}</span>
                ) : (
                  row.answer
                )}
              </p>
            </div>
          </div>
          {row.judge_note && (
            <p className="mt-2 border-t border-border-app pt-2 text-[11px] italic text-muted">
              {row.judge_note}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
