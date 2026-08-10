import { Pool } from "pg";
import { getChunkConfig, getNumSetting } from "../settings";
import { getDb } from "../db";
import { embedTexts, chunkText, type LocalSearchResult } from "./local";
import { embeddingConfig } from "./embeddings";
import { recordMetric } from "../metrics";

// pgvector backend for the vector index. Enabled when PGVECTOR_URL is set;
// otherwise the embedded sqlite-vec index is used and nothing here runs.
//
// Document and resource metadata stays in SQLite either way — Postgres holds
// only chunks and embeddings, which is what buys the real WHERE-clause tenant
// filtering on ANN search.

declare global {
  // eslint-disable-next-line no-var
  var __tesseractPg: Pool | undefined;
  // eslint-disable-next-line no-var
  var __tesseractPgReady: Promise<void> | undefined;
  // eslint-disable-next-line no-var
  var __tesseractPgDim: number | undefined;
}

export function pgEnabled(): boolean {
  return Boolean(process.env.PGVECTOR_URL);
}

// Exposed for the evaluation harness and the tuning stats route, which read
// chunk statistics directly.
export function getPool(): Pool {
  return pool();
}

function pool(): Pool {
  if (!globalThis.__tesseractPg) {
    globalThis.__tesseractPg = new Pool({
      connectionString: process.env.PGVECTOR_URL,
      max: 5,
    });
  }
  return globalThis.__tesseractPg;
}

// The pgvector column width is fixed at creation, exactly like the sqlite-vec
// one. Switching embedding provider changes the width, so the table has to be
// rebuilt — same contract as ensureVectorGeometry() on the SQLite side.
async function currentColumnDim(): Promise<number | null> {
  const { rows } = await pool().query(
    `SELECT a.atttypmod AS dim
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'chunks' AND a.attname = 'embedding' AND a.attnum > 0`
  );
  if (rows.length === 0) return null;
  const dim = Number(rows[0].dim);
  return Number.isFinite(dim) && dim > 0 ? dim : null;
}

async function ensureSchema(orgId: string): Promise<void> {
  const dim = embeddingConfig(orgId).dimensions;
  // A provider switch since the last call invalidates the cached readiness.
  if (globalThis.__tesseractPgDim !== dim) {
    globalThis.__tesseractPgReady = undefined;
    globalThis.__tesseractPgDim = dim;
  }
  if (!globalThis.__tesseractPgReady) {
    globalThis.__tesseractPgReady = (async () => {
      const p = pool();
      await p.query("CREATE EXTENSION IF NOT EXISTS vector");

      const existing = await currentColumnDim();
      if (existing !== null && existing !== dim) {
        console.log(
          `pgvector: embedding width changed ${existing} → ${dim}; rebuilding the index (a full re-sync is required)`
        );
        await p.query("DROP TABLE IF EXISTS chunks");
        // Documents keep their rows but lose their vectors — clearing the hash
        // makes the next sync treat every one of them as changed.
        getDb().exec("UPDATE documents SET content_hash = NULL");
      }

      await p.query(`
        CREATE TABLE IF NOT EXISTS chunks (
          id BIGSERIAL PRIMARY KEY,
          org_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          resource_id TEXT,
          thread_id TEXT,
          content TEXT NOT NULL,
          meta JSONB NOT NULL DEFAULT '{}',
          embedding vector(${dim})
        )`);
      await p.query(
        "CREATE INDEX IF NOT EXISTS idx_pg_chunks_doc ON chunks(document_id)"
      );
      await p.query(
        "CREATE INDEX IF NOT EXISTS idx_pg_chunks_org ON chunks(org_id)"
      );
      // Bulk-migrate BEFORE building the ANN index — building the graph over
      // existing rows yields far better recall than inserting into a fresh one.
      await migrateFromSqlite(dim);
      await p.query(
        "CREATE INDEX IF NOT EXISTS idx_pg_chunks_hnsw ON chunks USING hnsw (embedding vector_cosine_ops)"
      );
    })();
  }
  return globalThis.__tesseractPgReady;
}

function toVectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(",")}]`;
}

// One-time copy of existing sqlite-vec embeddings into Postgres. Vectors are
// reused as-is, so turning pgvector on costs zero re-embedding — but only when
// the two indexes were built by the same embedder.
async function migrateFromSqlite(dim: number) {
  const p = pool();
  const { rows } = await p.query("SELECT 1 FROM chunks LIMIT 1");
  if (rows.length > 0) return;
  const db = getDb();
  const sqliteChunks = db
    .prepare(
      `SELECT c.id, c.document_id, c.resource_id, c.thread_id, c.content, c.meta,
              d.org_id, v.embedding
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       JOIN vec_chunks v ON v.chunk_id = c.id`
    )
    .all() as {
    id: number;
    document_id: string;
    resource_id: string | null;
    thread_id: string | null;
    content: string;
    meta: string;
    org_id: string;
    embedding: Buffer;
  }[];
  if (sqliteChunks.length === 0) return;
  // Float32 → 4 bytes each. A width mismatch means the SQLite index was built
  // by a different embedder; copying it would poison every search.
  const sqliteDim = sqliteChunks[0].embedding.byteLength / 4;
  if (sqliteDim !== dim) {
    console.log(
      `pgvector: skipping migration — sqlite-vec index is ${sqliteDim}-dim, pgvector is ${dim}-dim. Re-sync each facet to populate Postgres.`
    );
    return;
  }
  console.log(`pgvector: migrating ${sqliteChunks.length} chunks from sqlite-vec…`);
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    for (const c of sqliteChunks) {
      const floats = new Float32Array(
        c.embedding.buffer.slice(
          c.embedding.byteOffset,
          c.embedding.byteOffset + c.embedding.byteLength
        )
      );
      await client.query(
        `INSERT INTO chunks (org_id, document_id, resource_id, thread_id, content, meta, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [
          c.org_id,
          c.document_id,
          c.resource_id,
          c.thread_id,
          c.content,
          c.meta || "{}",
          toVectorLiteral(floats),
        ]
      );
    }
    await client.query("COMMIT");
    console.log("pgvector: migration complete");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function splitBundleSections(text: string): { path: string | null; text: string }[] {
  const matches = [...text.matchAll(/^## File: (.+)$/gm)];
  if (matches.length === 0) return [{ path: null, text }];
  const sections: { path: string | null; text: string }[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    const body = text.slice(start, end).trim();
    if (body) sections.push({ path: matches[i][1].trim(), text: body });
  }
  return sections;
}

export async function pgIndexDocument(opts: {
  orgId: string;
  documentId: string;
  resourceId?: string | null;
  threadId?: string | null;
  text: string;
  meta?: Record<string, unknown>;
}): Promise<number> {
  await ensureSchema(opts.orgId);
  const sections = splitBundleSections(opts.text);
  const chunks: { text: string; meta: Record<string, unknown> }[] = [];
  for (const section of sections) {
    for (const piece of chunkText(section.text, getChunkConfig(opts.orgId))) {
      chunks.push({
        text: piece,
        meta: { ...(opts.meta ?? {}), path: section.path ?? opts.meta?.path },
      });
    }
  }
  if (chunks.length === 0) return 0;
  const embeddings = await embedTexts(opts.orgId, chunks.map((c) => c.text));
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO chunks (org_id, document_id, resource_id, thread_id, content, meta, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [
          opts.orgId,
          opts.documentId,
          opts.resourceId ?? null,
          opts.threadId ?? null,
          chunks[i].text,
          JSON.stringify(chunks[i].meta),
          toVectorLiteral(embeddings[i]),
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return chunks.length;
}

export async function pgHasChunks(orgId: string, threadId: string): Promise<boolean> {
  await ensureSchema(orgId);
  const { rows } = await pool().query(
    "SELECT 1 FROM chunks WHERE org_id = $1 AND (thread_id IS NULL OR thread_id = $2) LIMIT 1",
    [orgId, threadId]
  );
  return rows.length > 0;
}

export async function pgDeleteDocument(orgId: string, documentId: string) {
  await ensureSchema(orgId);
  await pool().query("DELETE FROM chunks WHERE document_id = $1", [documentId]);
}

export async function pgSearch(
  orgId: string,
  query: string,
  opts: { threadId?: string | null; k?: number; resourceIds?: string[] } = {}
): Promise<LocalSearchResult[]> {
  await ensureSchema(orgId);
  const k = opts.k ?? (getNumSetting(orgId, "retrieval_k") || 8);
  recordMetric(orgId, "local_searches", 1);
  const [embedding] = await embedTexts(orgId, [query]);
  const client = await pool().connect();
  let rows;
  try {
    await client.query("BEGIN");
    // Exact scan: the HNSW graph showed poor recall on this bundle-heavy
    // dataset (near-duplicate vectors), and at current scale an exact scan is
    // ~tens of ms and guaranteed correct. Revisit ANN past ~500k chunks.
    await client.query("SET LOCAL enable_indexscan = off");
    await client.query("SET LOCAL enable_bitmapscan = off");
    const scopeClause = opts.resourceIds?.length
      ? " AND (resource_id = ANY($5) OR thread_id = $3)"
      : "";
    const params: unknown[] = [toVectorLiteral(embedding), orgId, opts.threadId ?? null, k];
    if (opts.resourceIds?.length) params.push(opts.resourceIds);
    ({ rows } = await client.query(
      `SELECT document_id, content, meta, embedding <=> $1::vector AS distance
       FROM chunks
       WHERE org_id = $2 AND (thread_id IS NULL OR thread_id = $3)${scopeClause}
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      params
    ));
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  // Names resolve from SQLite (documents/resources live there).
  const db = getDb();
  const nameFor = db.prepare(
    `SELECT d.name AS document_name, r.name AS resource_name
     FROM documents d LEFT JOIN resources r ON r.id = d.resource_id
     WHERE d.id = ?`
  );
  return rows.map((r) => {
    const names = nameFor.get(r.document_id) as
      | { document_name: string; resource_name: string | null }
      | undefined;
    const meta = (r.meta ?? {}) as { path?: string };
    let path = meta.path ?? null;
    if (path && path.includes(", ")) path = null; // legacy bundle path list
    const url = path?.startsWith("http") ? path : null;
    if (url) path = null;
    const sourceLabel = path
      ? names?.resource_name
        ? `${names.resource_name}: ${path}`
        : path
      : (names?.document_name ?? "document");
    return {
      content: r.content as string,
      documentId: r.document_id as string,
      documentName: names?.document_name ?? "document",
      sourceLabel,
      path,
      url,
      distance: Number(r.distance),
    };
  });
}
