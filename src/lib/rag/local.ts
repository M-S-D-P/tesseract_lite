import { getDb, ensureVectorGeometry } from "../db";
import { getChunkConfig, getNumSetting } from "../settings";
import { recordMetric } from "../metrics";
import { embedTexts as embedWithProvider, embeddingConfig } from "./embeddings";

const DEFAULT_CHUNK = { size: 3600, overlap: 400 }; // ~900 tokens

// Chunk geometry is configurable per organization (/tuning) — the defaults
// here apply only when no config is passed (e.g. ad-hoc callers).
export function chunkText(
  text: string,
  cfg: { size: number; overlap: number } = DEFAULT_CHUNK
): string[] {
  const CHUNK_SIZE = cfg.size;
  const CHUNK_OVERLAP = cfg.overlap;
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_SIZE) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      // Prefer breaking on a paragraph, then a newline, then a sentence.
      for (const sep of ["\n\n", "\n", ". "]) {
        const idx = clean.lastIndexOf(sep, end);
        if (idx > start + CHUNK_SIZE / 2) {
          end = idx + sep.length;
          break;
        }
      }
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks.filter((c) => c.length > 0);
}

// Embeds through the org's configured provider, first making sure the vector
// table matches that provider's width.
export async function embedTexts(orgId: string, texts: string[]): Promise<Float32Array[]> {
  ensureVectorGeometry(embeddingConfig(orgId).dimensions);
  return embedWithProvider(orgId, texts);
}

// Repo bundles are markdown files with "## File: <path>" section headers.
// Splitting on them lets every chunk carry its true source file path, so
// citations reference real code files instead of bundle names.
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

// Dispatch: pgvector when PGVECTOR_URL is set, embedded sqlite-vec otherwise.
export async function indexDocumentLocally(opts: {
  orgId: string;
  documentId: string;
  resourceId?: string | null;
  threadId?: string | null;
  text: string;
  meta?: Record<string, unknown>;
}) {
  if (process.env.PGVECTOR_URL) {
    const { pgIndexDocument } = await import("./local-pg");
    return pgIndexDocument(opts);
  }
  return sqliteIndexDocument(opts);
}

async function sqliteIndexDocument(opts: {
  orgId: string;
  documentId: string;
  resourceId?: string | null;
  threadId?: string | null;
  text: string;
  meta?: Record<string, unknown>;
}) {
  const sections = splitBundleSections(opts.text);
  const chunks: { text: string; meta: string }[] = [];
  for (const section of sections) {
    for (const piece of chunkText(section.text, getChunkConfig(opts.orgId))) {
      chunks.push({
        text: piece,
        meta: JSON.stringify({ ...(opts.meta ?? {}), path: section.path ?? opts.meta?.path }),
      });
    }
  }
  if (chunks.length === 0) return 0;
  const embeddings = await embedTexts(opts.orgId, chunks.map((c) => c.text));
  const db = getDb();
  const insertChunk = db.prepare(
    "INSERT INTO chunks (document_id, resource_id, thread_id, content, meta) VALUES (?, ?, ?, ?, ?)"
  );
  const insertVec = db.prepare(
    "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)"
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const info = insertChunk.run(
        opts.documentId,
        opts.resourceId ?? null,
        opts.threadId ?? null,
        chunks[i].text,
        chunks[i].meta
      );
      // sqlite-vec requires a strictly INTEGER-typed key; BigInt guarantees it.
      insertVec.run(BigInt(info.lastInsertRowid), Buffer.from(embeddings[i].buffer));
    }
  });
  tx();
  return chunks.length;
}

export async function deleteDocumentLocally(orgId: string, documentId: string) {
  if (process.env.PGVECTOR_URL) {
    const { pgDeleteDocument } = await import("./local-pg");
    await pgDeleteDocument(orgId, documentId);
  }
  // Always clear the SQLite side too: it may still hold chunks from before
  // pgvector was switched on.
  sqliteDeleteDocument(documentId);
}

function sqliteDeleteDocument(documentId: string) {
  const db = getDb();
  const ids = db
    .prepare("SELECT id FROM chunks WHERE document_id = ?")
    .all(documentId) as { id: number }[];
  const delVec = db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?");
  const tx = db.transaction(() => {
    for (const { id } of ids) delVec.run(id);
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
  });
  tx();
}

// Backend-aware existence check (drives whether the KB tool is offered).
export async function hasLocalChunks(
  orgId: string,
  threadId: string
): Promise<boolean> {
  if (process.env.PGVECTOR_URL) {
    const { pgHasChunks } = await import("./local-pg");
    return pgHasChunks(orgId, threadId);
  }
  const row = getDb()
    .prepare(
      "SELECT 1 FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.org_id = ? AND (c.thread_id IS NULL OR c.thread_id = ?) LIMIT 1"
    )
    .get(orgId, threadId);
  return Boolean(row);
}

export type LocalSearchResult = {
  content: string;
  documentId: string;
  documentName: string;
  sourceLabel: string; // real code/file reference, e.g. "owner/repo: app/models/user.rb"
  path: string | null; // repo-relative file path when known
  url: string | null; // web URL for Confluence pages / weblinks
  distance: number;
};

// Searches the org's knowledge base plus (optionally) one thread's
// attachment chunks — the local equivalent of file_search over
// [KB vector store, thread vector store].
export async function searchLocal(
  orgId: string,
  query: string,
  opts: { threadId?: string | null; k?: number; resourceIds?: string[] } = {}
): Promise<LocalSearchResult[]> {
  if (process.env.PGVECTOR_URL) {
    const { pgSearch } = await import("./local-pg");
    return pgSearch(orgId, query, opts);
  }
  return sqliteSearch(orgId, query, opts);
}

async function sqliteSearch(
  orgId: string,
  query: string,
  opts: { threadId?: string | null; k?: number; resourceIds?: string[] } = {}
): Promise<LocalSearchResult[]> {
  const k = opts.k ?? (getNumSetting(orgId, "retrieval_k") || 8);
  recordMetric(orgId, "local_searches", 1);
  const [embedding] = await embedTexts(orgId, [query]);
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.id, c.content, c.document_id, c.thread_id, c.resource_id, c.meta, v.distance,
              d.name AS document_name, r.name AS resource_name
       FROM vec_chunks v
       JOIN chunks c ON c.id = v.chunk_id
       JOIN documents d ON d.id = c.document_id AND d.org_id = ?
       LEFT JOIN resources r ON r.id = d.resource_id
       WHERE v.embedding MATCH ? AND v.k = ?
       ORDER BY v.distance`
    )
    .all(orgId, Buffer.from(embedding.buffer), k * 8) as {
    id: number;
    content: string;
    document_id: string;
    thread_id: string | null;
    meta: string;
    distance: number;
    document_name: string;
    resource_name: string | null;
  }[];
  const wanted = opts.resourceIds?.length ? new Set(opts.resourceIds) : null;
  const scoped = rows.filter((r) => {
    const threadOk =
      r.thread_id === null || Boolean(opts.threadId && r.thread_id === opts.threadId);
    if (!threadOk) return false;
    // Facet scoping: keep selected facets plus this thread's attachments.
    if (wanted) {
      const rid = (r as { resource_id?: string | null }).resource_id ?? null;
      return (rid !== null && wanted.has(rid)) || r.thread_id === opts.threadId;
    }
    return true;
  });
  return scoped.slice(0, k).map((r) => {
    let path: string | null = null;
    try {
      path = (JSON.parse(r.meta).path as string) ?? null;
    } catch {
      /* legacy chunk */
    }
    // Legacy bundle chunks stored a comma-joined path list — not a real reference.
    if (path && path.includes(", ")) path = null;
    const url = path?.startsWith("http") ? path : null;
    if (url) path = null; // a web URL is not a repo path
    const sourceLabel = path
      ? r.resource_name
        ? `${r.resource_name}: ${path}`
        : path
      : r.document_name;
    return {
      content: r.content,
      documentId: r.document_id,
      documentName: r.document_name,
      sourceLabel,
      path,
      url,
      distance: r.distance,
    };
  });
}
