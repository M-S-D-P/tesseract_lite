import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "path";
import fs from "fs";

// Vector width of the DEFAULT (local) embedder. The live geometry is whatever
// ensureVectorGeometry last wrote to app_meta — switching embedding providers
// changes it and re-creates the index.
export const DEFAULT_EMBEDDING_DIM = 384;

export const DATA_DIR = path.join(process.cwd(), "data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const REPOS_DIR = path.join(DATA_DIR, "repos");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'self-hosted',
  seats INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Instance-wide bookkeeping that is not per-org (e.g. vector geometry).
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS org_settings (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (org_id, key)
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  auth_provider TEXT NOT NULL DEFAULT 'password',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  token TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  filters TEXT NOT NULL DEFAULT '{}',
  last_response_id TEXT,
  openai_vs_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  response_id TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  citations TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- 'file' | 'github'
  name TEXT NOT NULL,
  ref TEXT,           -- original url / filename
  branch TEXT,        -- github: tracked branch, NULL = repo default
  -- New facets belong to the person who created them. 'org' shares one with
  -- everyone in the organization.
  visibility TEXT NOT NULL DEFAULT 'private',
  status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|ready|error
  error TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  resource_id TEXT,
  thread_id TEXT,     -- set for per-thread chat attachments
  name TEXT NOT NULL,
  path TEXT,
  mime TEXT,
  size INTEGER,
  openai_file_id TEXT,
  openai_status TEXT NOT NULL DEFAULT 'pending', -- pending|synced|error
  local_status TEXT NOT NULL DEFAULT 'pending',  -- pending|synced|error
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_resource ON documents(resource_id);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  resource_id TEXT,
  thread_id TEXT,     -- set for per-thread attachment chunks
  content TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  headers TEXT NOT NULL DEFAULT '{}',
  allowed_tools TEXT, -- JSON array or NULL for all
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|error
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE TABLE IF NOT EXISTS generated_files (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  thread_id TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Configured connections to locally running applications. Each source owns a
-- listener (a TCP port we bind, or a log file we tail) and optionally points at
-- the indexed codebase it belongs to, so runtime observations line up with the
-- right source tree.
--
-- These three tables arrive complete rather than through ALTER migrations: no
-- Lite database has ever had them, so there is nothing to migrate from.
CREATE TABLE IF NOT EXISTS runtime_sources (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'port',   -- port | file
  port INTEGER,
  file_path TEXT,
  app_url TEXT,                        -- where the app itself is served, for reference
  resource_id TEXT,                    -- the indexed repo this app's code lives in
  -- A developer owns the ports they add: they are the only one who sees and
  -- manages them, so several people can stream from their own machines without
  -- tripping over each other. NULL predates ownership.
  created_by TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'stopped', -- listening | tailing | stopped | error
  error TEXT,
  requests_seen INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runtime_sources_org ON runtime_sources(org_id);

-- Live runtime telemetry streamed from a running Rails app (log listener or
-- HTTP ingest). Rolling window; the durable signal is folded into kg_*.
CREATE TABLE IF NOT EXISTS runtime_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'log',
  source_id TEXT,                      -- which configured source produced it
  method TEXT,
  path TEXT,
  controller TEXT,
  action TEXT,
  format TEXT,
  status INTEGER,
  duration_ms REAL,
  view_ms REAL,
  db_ms REAL,
  allocations INTEGER,
  sql_count INTEGER NOT NULL DEFAULT 0,
  tables TEXT NOT NULL DEFAULT '[]',
  n_plus_one TEXT,
  metaprogramming TEXT NOT NULL DEFAULT '[]',
  error_class TEXT,
  error_message TEXT,
  started_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runtime_req_org ON runtime_requests(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_req_ctrl ON runtime_requests(org_id, controller, action);
CREATE TABLE IF NOT EXISTS runtime_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  request_id TEXT,
  fingerprint TEXT NOT NULL,
  sql TEXT NOT NULL,
  tables TEXT NOT NULL DEFAULT '[]',
  duration_ms REAL,
  cached INTEGER NOT NULL DEFAULT 0,
  -- The "↳ app/models/x.rb:12" line Rails prints under each query: what turns
  -- "a query ran" into "this line ran it".
  source TEXT,
  source_method TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runtime_q_org ON runtime_queries(org_id, created_at DESC);
-- Methods observed executing, from an AppMap trace. The log can only reveal a
-- method that happened to be on the stack when SQL was issued; AppMap records
-- EVERY instrumented call together with the location Ruby reports for it
-- (Method#source_location), so a generated method that touches no database at
-- all is visible here and nowhere else.
CREATE TABLE IF NOT EXISTS runtime_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  resource_id TEXT,                    -- the facet the trace was uploaded as
  origin TEXT NOT NULL DEFAULT 'appmap',
  trace TEXT,
  defined_class TEXT,
  method_id TEXT NOT NULL,
  is_static INTEGER NOT NULL DEFAULT 0,
  path TEXT,                           -- where Ruby says the method is defined
  lineno INTEGER,
  executions INTEGER NOT NULL DEFAULT 0,
  total_ms REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runtime_methods_org ON runtime_methods(org_id);
CREATE INDEX IF NOT EXISTS idx_runtime_methods_res ON runtime_methods(resource_id);
CREATE INDEX IF NOT EXISTS idx_runtime_q_fp ON runtime_queries(org_id, fingerprint);
-- Evaluation harness: question sets, runs pinned to a config, per-question results.
CREATE TABLE IF NOT EXISTS eval_sets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS eval_questions (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  question TEXT NOT NULL,
  expected TEXT NOT NULL DEFAULT '',
  source_document_id TEXT,
  source_label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  done_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  metrics TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  retrieved TEXT NOT NULL DEFAULT '[]',
  hit INTEGER NOT NULL DEFAULT 0,
  rank INTEGER,
  correctness REAL,
  groundedness REAL,
  judge_note TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_questions_set ON eval_questions(set_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results(run_id);
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  value INTEGER NOT NULL,
  model TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_metrics_kind_time ON metrics(kind, created_at);
CREATE TABLE IF NOT EXISTS kg_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  kind TEXT NOT NULL,     -- model|table|controller|route|job|service
  name TEXT NOT NULL,
  file TEXT,              -- provenance: repo-relative path
  meta TEXT NOT NULL DEFAULT '{}',
  UNIQUE(resource_id, kind, name)
);
CREATE TABLE IF NOT EXISTS kg_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  src_kind TEXT NOT NULL,
  src TEXT NOT NULL,
  rel TEXT NOT NULL,      -- belongs_to|has_many|has_one|habtm|routes_to|backed_by
  dst_kind TEXT NOT NULL,
  dst TEXT NOT NULL,
  file TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_kg_edges_src ON kg_edges(resource_id, src);
CREATE INDEX IF NOT EXISTS idx_kg_edges_dst ON kg_edges(resource_id, dst);
`;

declare global {
  // eslint-disable-next-line no-var
  var __tesseractDb: Database.Database | undefined;
}

export function getDb(): Database.Database {
  if (globalThis.__tesseractDb) return globalThis.__tesseractDb;
  for (const dir of [DATA_DIR, UPLOADS_DIR, REPOS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path.join(DATA_DIR, "tesseract.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  db.exec(SCHEMA);
  const dim = Number(
    (db.prepare("SELECT value FROM app_meta WHERE key = 'embedding_dim'").get() as
      | { value: string }
      | undefined)?.value ?? DEFAULT_EMBEDDING_DIM
  );
  createVecTable(db, Number.isFinite(dim) && dim > 0 ? dim : DEFAULT_EMBEDDING_DIM);
  // Additive migrations for databases created before these columns existed.
  for (const stmt of [
    "ALTER TABLE documents ADD COLUMN openai_key_fp TEXT",
    "ALTER TABLE documents ADD COLUMN stored_path TEXT",
    "ALTER TABLE threads ADD COLUMN openai_vs_key_fp TEXT",
    "ALTER TABLE resources ADD COLUMN progress_phase TEXT",
    "ALTER TABLE resources ADD COLUMN progress_done INTEGER",
    "ALTER TABLE resources ADD COLUMN progress_total INTEGER",
    "ALTER TABLE resources ADD COLUMN sync_interval TEXT NOT NULL DEFAULT 'manual'",
    "ALTER TABLE resources ADD COLUMN last_synced_at TEXT",
    "ALTER TABLE resources ADD COLUMN next_sync_at TEXT",
    "ALTER TABLE documents ADD COLUMN content_hash TEXT",
    "ALTER TABLE messages ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'",
    // Seeded and admin-reset passwords are handed over in plaintext, so the
    // owner is made to replace them before they can use the app.
    "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
    // Which branch a GitHub resource tracks. NULL means the repo default.
    "ALTER TABLE resources ADD COLUMN branch TEXT",
    // 'private' (only the creator) or 'org' (everyone in the organization).
    // Existing rows predate ownership and were visible to all, so they keep
    // that behaviour rather than silently vanishing from people's facet list.
    "ALTER TABLE resources ADD COLUMN visibility TEXT NOT NULL DEFAULT 'org'",
    // Evaluation is scored against one person's visible corpus.
    "ALTER TABLE eval_runs ADD COLUMN created_by TEXT",
    // Runtime sources belong to the developer who added them.
    "ALTER TABLE runtime_sources ADD COLUMN created_by TEXT",
    // Multi-tenancy
    "ALTER TABLE users ADD COLUMN org_id TEXT",
    "ALTER TABLE invites ADD COLUMN org_id TEXT",
    "ALTER TABLE threads ADD COLUMN org_id TEXT",
    "ALTER TABLE resources ADD COLUMN org_id TEXT",
    "ALTER TABLE documents ADD COLUMN org_id TEXT",
    "ALTER TABLE mcp_servers ADD COLUMN org_id TEXT",
    "ALTER TABLE metrics ADD COLUMN org_id TEXT",
    "ALTER TABLE kg_entities ADD COLUMN org_id TEXT",
    "ALTER TABLE kg_edges ADD COLUMN org_id TEXT",
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // column already exists
    }
  }
  migrateToMultiTenancy(db);
  cleanOrphanClones();
  globalThis.__tesseractDb = db;
  return db;
}

function createVecTable(db: Database.Database, dim: number) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    embedding float[${dim}]
  )`);
  db.prepare(
    "INSERT INTO app_meta (key, value) VALUES ('embedding_dim', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(dim));
}

export function currentVectorDim(): number {
  const row = getDb()
    .prepare("SELECT value FROM app_meta WHERE key = 'embedding_dim'")
    .get() as { value: string } | undefined;
  return Number(row?.value ?? DEFAULT_EMBEDDING_DIM);
}

// Vectors from different embedders are not comparable and sqlite-vec fixes the
// column width at creation, so a provider switch has to discard the index.
// Chunk TEXT survives, but every document must be re-embedded — callers are
// expected to have warned the operator first.
export function ensureVectorGeometry(dim: number): { reindexed: boolean } {
  const db = getDb();
  if (currentVectorDim() === dim) return { reindexed: false };
  const tx = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS vec_chunks");
    db.exec("DELETE FROM chunks");
    // Documents keep their rows but lose their vectors — clearing the hash
    // makes the next sync treat every one of them as changed.
    db.exec("UPDATE documents SET content_hash = NULL");
  });
  tx();
  createVecTable(db, dim);
  return { reindexed: true };
}

// One-time backfill: pre-tenancy databases get a default org owning
// everything that exists, and legacy global settings copy into it.
function migrateToMultiTenancy(db: Database.Database) {
  const hasUsers = db.prepare("SELECT 1 FROM users LIMIT 1").get();
  const hasOrgs = db.prepare("SELECT 1 FROM orgs LIMIT 1").get();
  if (!hasUsers || hasOrgs) return;
  const orgId = crypto.randomUUID();
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO orgs (id, name) VALUES (?, 'Default Organization')").run(orgId);
    for (const table of [
      "users", "invites", "threads", "resources", "documents",
      "mcp_servers", "metrics", "kg_entities", "kg_edges",
    ]) {
      db.prepare(`UPDATE ${table} SET org_id = ? WHERE org_id IS NULL`).run(orgId);
    }
    const legacy = db.prepare("SELECT key, value FROM settings").all() as {
      key: string;
      value: string;
    }[];
    const ins = db.prepare(
      "INSERT OR IGNORE INTO org_settings (org_id, key, value) VALUES (?, ?, ?)"
    );
    for (const s of legacy) ins.run(orgId, s.key, s.value);
  });
  tx();
}

// Repo clones are per-run scratch space; anything left over is from a
// process that died mid-ingestion (the job queue re-runs the work itself).
function cleanOrphanClones() {
  try {
    for (const entry of fs.readdirSync(REPOS_DIR)) {
      fs.rmSync(path.join(REPOS_DIR, entry), { recursive: true, force: true });
    }
  } catch {
    // repos dir missing — nothing to clean
  }
}

export function uid(): string {
  return crypto.randomUUID();
}
