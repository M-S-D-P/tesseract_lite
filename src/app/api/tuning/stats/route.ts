import { requireUser, errorResponse } from "@/lib/auth";
import { currentVectorDim, getDb } from "@/lib/db";
import { getNumSetting } from "@/lib/settings";
import { embeddingConfig } from "@/lib/rag/embeddings";

// Live corpus statistics for the tuning page — the same numbers the SQL in
// the docs returns, so what the UI claims can always be checked by hand.
export async function GET() {
  try {
    const user = await requireUser();
    const db = getDb();
    const orgId = user.orgId;

    const docs = db
      .prepare("SELECT COUNT(*) n FROM documents WHERE org_id = ?")
      .get(orgId) as { n: number };
    const resources = db
      .prepare("SELECT COUNT(*) n FROM resources WHERE org_id = ?")
      .get(orgId) as { n: number };

    const embedding = embeddingConfig(orgId);
    let store = "sqlite-vec";
    let dims = currentVectorDim();
    let chunks = 0;
    let avgChars = 0;
    let maxChars = 0;
    let minChars = 0;

    if (process.env.PGVECTOR_URL) {
      store = "pgvector";
      const { getPool } = await import("@/lib/rag/local-pg");
      const { rows } = await getPool().query(
        `SELECT COUNT(*)::int AS n,
                COALESCE(AVG(length(content)), 0)::int AS avg_chars,
                COALESCE(MAX(length(content)), 0)::int AS max_chars,
                COALESCE(MIN(length(content)), 0)::int AS min_chars,
                COALESCE(MAX(vector_dims(embedding)), 0)::int AS dims
         FROM chunks WHERE org_id = $1 AND thread_id IS NULL`,
        [orgId]
      );
      chunks = rows[0].n;
      avgChars = rows[0].avg_chars;
      maxChars = rows[0].max_chars;
      minChars = rows[0].min_chars;
      if (rows[0].dims) dims = rows[0].dims;
    } else {
      const r = db
        .prepare(
          `SELECT COUNT(*) n,
                  COALESCE(CAST(AVG(LENGTH(c.content)) AS INTEGER), 0) avg_chars,
                  COALESCE(MAX(LENGTH(c.content)), 0) max_chars,
                  COALESCE(MIN(LENGTH(c.content)), 0) min_chars
           FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE d.org_id = ? AND c.thread_id IS NULL`
        )
        .get(orgId) as { n: number; avg_chars: number; max_chars: number; min_chars: number };
      chunks = r.n;
      avgChars = r.avg_chars;
      maxChars = r.max_chars;
      minChars = r.min_chars;
    }

    // Chunks whose length exceeds the configured size were indexed under an
    // older setting — a direct signal that a re-sync is needed.
    const configuredSize = getNumSetting(orgId, "chunk_size");

    return Response.json({
      store,
      backend: store,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
      dimensions: dims,
      documents: docs.n,
      resources: resources.n,
      chunks,
      avgChars,
      maxChars,
      minChars,
      configuredSize,
      stale: maxChars > configuredSize * 1.1,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
