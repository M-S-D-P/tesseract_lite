import { getDb } from "./db";

export const SETTING_DEFAULTS: Record<string, string> = {
  // --- Chat: Claude only. Each reasoning tier maps to an Anthropic model.
  model_low: "claude-haiku-4-5-20251001",
  model_medium: "claude-sonnet-5",
  model_high: "claude-opus-5",
  // --- Embeddings. Anthropic has no embeddings API, so retrieval runs either
  // on a CPU-local model (default — needs no second vendor key) or on OpenAI
  // when the org supplies OPENAI_API_KEY. Switching providers changes the
  // vector geometry and forces a re-index; the Admin UI warns before doing it.
  embedding_provider: "local", // 'local' | 'openai'
  embedding_model_local: "Xenova/all-MiniLM-L6-v2", // 384-dim, ~90MB, CPU
  embedding_model_openai: "text-embedding-3-small", // 1536-dim
  // --- Tunable retrieval parameters (see /tuning). Chunking values apply to
  // documents indexed AFTER the change — existing chunks keep their geometry
  // until the resource is re-synced.
  chunk_size: "3600", // characters (~900 tokens)
  chunk_overlap: "400", // characters carried between adjacent chunks
  retrieval_k: "8", // chunks returned per knowledge-base search
  min_score: "0", // 0 = keep all; else drop results below this similarity (0-1)
  temperature: "", // blank = provider default; ignored by reasoning models
  eval_judge_model: "claude-sonnet-5",
  corpus_version: "0", // bumped on every ingest/delete
  system_prompt:
    "You are Tesseract, an internal knowledge assistant. When a question could involve the organization's code, documents, or internal knowledge, ALWAYS search the knowledge base first and ground your answer in what you find — quote or reference the retrieved material rather than answering from memory. Be direct and cite the sources you used. When citing Confluence pages, include their URL (retrieved pages carry a Source: line). When an architecture, flow, or sequence explanation would benefit from a diagram, include a Mermaid code block (```mermaid) — the UI renders it as an interactive diagram. When the user asks for a spreadsheet, workbook, plan file, or exportable document, call the generate_file tool (xlsx/csv/docx/pdf) instead of saying you cannot attach files.",
  // GitHub connector. Needed only for private repositories; public ones clone
  // without it. A classic PAT with `repo`, or a fine-grained token with
  // Contents: Read. Falls back to the GITHUB_TOKEN environment variable.
  github_token: "",
  // Confluence REST connector (API-token based; email is the token owner's)
  confluence_base_url: "",
  confluence_email: "",
  confluence_api_token: "",
};

// All settings are per-organization.
export function getSetting(orgId: string, key: string): string {
  const row = getDb()
    .prepare("SELECT value FROM org_settings WHERE org_id = ? AND key = ?")
    .get(orgId, key) as { value: string } | undefined;
  return row?.value ?? SETTING_DEFAULTS[key] ?? "";
}

// Numeric settings fall back to the default when unset or unparseable, so a
// bad value in the DB can never take retrieval down.
export function getNumSetting(orgId: string, key: string): number {
  const n = Number(getSetting(orgId, key));
  if (Number.isFinite(n)) return n;
  return Number(SETTING_DEFAULTS[key] ?? 0);
}

// The chunking geometry used at index time.
export function getChunkConfig(orgId: string): { size: number; overlap: number } {
  const size = Math.max(200, Math.min(20000, getNumSetting(orgId, "chunk_size")));
  const overlap = Math.max(0, Math.min(size - 100, getNumSetting(orgId, "chunk_overlap")));
  return { size, overlap };
}

export function setSetting(orgId: string, key: string, value: string) {
  getDb()
    .prepare(
      "INSERT INTO org_settings (org_id, key, value) VALUES (?, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value"
    )
    .run(orgId, key, value);
}

// Bumped whenever the corpus changes, so anything keyed to a corpus snapshot
// (evaluation runs, saved reports) can tell it is looking at stale ground.
export function bumpCorpusVersion(orgId: string) {
  setSetting(orgId, "corpus_version", String(Date.now()));
}

export function getAllSettings(orgId: string): Record<string, string> {
  const rows = getDb()
    .prepare("SELECT key, value FROM org_settings WHERE org_id = ?")
    .all(orgId) as { key: string; value: string }[];
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}
