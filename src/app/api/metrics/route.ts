import { getDb } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth";
import { metricTotal, metricTotalsByModel, metricDaily } from "@/lib/metrics";
import { getSetting } from "@/lib/settings";
import { keyFingerprint } from "@/lib/openai";

export async function GET() {
  try {
    const user = await requireUser();
    const orgId = user.orgId;
    const db = getDb();
    const fp = keyFingerprint();

    const sourcesByType = db
      .prepare("SELECT type, COUNT(*) AS count FROM resources WHERE org_id = ? GROUP BY type")
      .all(orgId) as { type: string; count: number }[];
    const docs = db.prepare("SELECT COUNT(*) AS c FROM documents WHERE org_id = ?").get(orgId) as { c: number };
    const chunks = db
      .prepare("SELECT COUNT(*) AS c FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.org_id = ?")
      .get(orgId) as { c: number };
    const drift = db
      .prepare(
        `SELECT COUNT(*) AS c FROM documents
         WHERE org_id = ? AND (local_status != 'synced'
            OR openai_status != 'synced' OR openai_key_fp != ?)`
      )
      .get(orgId, fp) as { c: number };
    const jobs = db
      .prepare(
        "SELECT id, type, status, attempts, error, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT 20"
      )
      .all();
    const activeJobs = db
      .prepare("SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','running')")
      .get() as { c: number };
    const resources = db
      .prepare(
        `SELECT id, type, name, status, error, progress_phase, progress_done, progress_total,
                sync_interval, last_synced_at, next_sync_at
         FROM resources WHERE org_id = ? ORDER BY created_at DESC`
      )
      .all(orgId);

    const kgEntities = db.prepare("SELECT COUNT(*) AS c FROM kg_entities WHERE org_id = ?").get(orgId) as { c: number };
    const kgEdges = db.prepare("SELECT COUNT(*) AS c FROM kg_edges WHERE org_id = ?").get(orgId) as { c: number };

    return Response.json({
      retrievalBackend: getSetting(orgId, "retrieval_backend"),
      graph: { entities: kgEntities.c, edges: kgEdges.c },
      sources: { byType: sourcesByType, documents: docs.c, chunks: chunks.c, drift: drift.c },
      embeddings: {
        vectors: metricTotal(orgId, "embeddings_created"),
        tokens: metricTotal(orgId, "embedding_tokens"),
        daily: metricDaily(orgId, ["embedding_tokens"], 14),
      },
      hostedStore: {
        uploads: metricTotal(orgId, "vs_uploads"),
        bytes: metricTotal(orgId, "vs_upload_bytes"),
      },
      retrieval: {
        fileSearches: metricTotal(orgId, "file_searches"),
        localSearches: metricTotal(orgId, "local_searches"),
      },
      chat: {
        requests: metricTotal(orgId, "chat_requests"),
        inputTokens: metricTotal(orgId, "chat_input_tokens"),
        outputTokens: metricTotal(orgId, "chat_output_tokens"),
        byModel: metricTotalsByModel(orgId, "chat_output_tokens"),
        daily: metricDaily(orgId, ["chat_input_tokens", "chat_output_tokens"], 14),
      },
      jobs,
      activeJobs: activeJobs.c,
      resources,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
