import { getDb } from "./db";

// Append-only usage ledger. Fed by the three places work happens:
// embedding calls, vector-store uploads, and chat completions.
export type MetricKind =
  | "embeddings_created"
  | "embedding_tokens"
  | "chat_input_tokens"
  | "chat_output_tokens"
  | "chat_requests"
  | "vs_uploads"
  | "vs_upload_bytes"
  | "local_searches"
  | "file_searches"
  | "cache_hits"
  | "cache_misses"
  | "cag_answers"
  | "cache_rejected";

export function recordMetric(
  orgId: string | null,
  kind: MetricKind,
  value: number,
  model?: string,
  meta?: Record<string, unknown>
) {
  if (!value || value < 0) return;
  try {
    getDb()
      .prepare(
        "INSERT INTO metrics (org_id, kind, value, model, meta) VALUES (?, ?, ?, ?, ?)"
      )
      .run(orgId, kind, Math.round(value), model ?? null, meta ? JSON.stringify(meta) : null);
  } catch (e) {
    // Metrics must never break the pipeline.
    console.error("metric write failed:", (e as Error).message);
  }
}

export function metricTotal(orgId: string, kind: MetricKind): number {
  const row = getDb()
    .prepare(
      "SELECT COALESCE(SUM(value), 0) AS total FROM metrics WHERE org_id = ? AND kind = ?"
    )
    .get(orgId, kind) as { total: number };
  return row.total;
}

export function metricTotalsByModel(
  orgId: string,
  kind: MetricKind
): { model: string; total: number }[] {
  return getDb()
    .prepare(
      "SELECT COALESCE(model, 'unknown') AS model, SUM(value) AS total FROM metrics WHERE org_id = ? AND kind = ? GROUP BY model ORDER BY total DESC"
    )
    .all(orgId, kind) as { model: string; total: number }[];
}

// Daily sums for the last `days` days, zero-filled, oldest first.
export function metricDaily(
  orgId: string,
  kinds: MetricKind[],
  days: number
): { date: string; total: number }[] {
  const placeholders = kinds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT date(created_at) AS d, SUM(value) AS total
       FROM metrics
       WHERE org_id = ? AND kind IN (${placeholders}) AND created_at >= datetime('now', ?)
       GROUP BY date(created_at)`
    )
    .all(orgId, ...kinds, `-${days} days`) as { d: string; total: number }[];
  const byDay = new Map(rows.map((r) => [r.d, r.total]));
  const out: { date: string; total: number }[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10);
    out.push({ date: d, total: byDay.get(d) ?? 0 });
  }
  return out;
}
