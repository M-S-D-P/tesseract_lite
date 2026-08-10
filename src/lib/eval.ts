import { getDb, uid } from "./db";
import { getNumSetting, getSetting } from "./settings";
import { searchLocal } from "./rag/local";
import { embeddingConfig } from "./rag/embeddings";
import { answerWithoutTools } from "./chat/providers";

// Retrieval-and-answer evaluation harness.
//
// The hard part of evaluating a RAG system is ground truth. This builds it
// synthetically: sample a chunk from the corpus, ask a model to write a
// question that ONLY that chunk can answer, and record which document it came
// from. Retrieval is then scored objectively — did the source document come
// back, and at what rank — while answer quality is scored by a judge model
// against the expected answer. Every run pins the configuration it ran under,
// so two runs are directly comparable.

export type EvalConfig = {
  backend: "sqlite-vec" | "pgvector";
  model: string;
  judgeModel: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  retrievalK: number;
  temperature: string;
};

export function currentConfig(orgId: string): EvalConfig {
  const embedding = embeddingConfig(orgId);
  return {
    backend: process.env.PGVECTOR_URL ? "pgvector" : "sqlite-vec",
    model: getSetting(orgId, "model_medium"),
    judgeModel: getSetting(orgId, "eval_judge_model") || getSetting(orgId, "model_medium"),
    embeddingModel: `${embedding.provider}:${embedding.model}`,
    chunkSize: getNumSetting(orgId, "chunk_size"),
    chunkOverlap: getNumSetting(orgId, "chunk_overlap"),
    retrievalK: getNumSetting(orgId, "retrieval_k") || 8,
    temperature: getSetting(orgId, "temperature"),
  };
}

// --- model plumbing --------------------------------------------------------

// Single-shot completion against Claude. Token usage is recorded by the
// provider layer into the metrics ledger, so this only returns the text.
async function complete(
  orgId: string,
  model: string,
  input: string
): Promise<{ text: string }> {
  const text = await answerWithoutTools({
    orgId,
    model,
    tier: "medium",
    systemPrompt:
      "You are an evaluation harness. Follow the instructions exactly and return only what is asked for.",
    userText: input,
  });
  return { text };
}

function parseJson(text: string): Record<string, unknown> | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence ? fence[1] : text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

// --- question generation ---------------------------------------------------

type SampledChunk = { content: string; documentId: string };

async function sampleChunks(orgId: string, n: number): Promise<SampledChunk[]> {
  if (process.env.PGVECTOR_URL) {
    const { getPool } = await import("./rag/local-pg");
    const { rows } = await getPool().query(
      `SELECT content, document_id FROM chunks
       WHERE org_id = $1 AND thread_id IS NULL AND length(content) > 400
       ORDER BY random() LIMIT $2`,
      [orgId, n]
    );
    return rows.map((r: { content: string; document_id: string }) => ({
      content: r.content,
      documentId: r.document_id,
    }));
  }
  const rows = getDb()
    .prepare(
      `SELECT c.content, c.document_id FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.org_id = ? AND c.thread_id IS NULL AND length(c.content) > 400
       ORDER BY RANDOM() LIMIT ?`
    )
    .all(orgId, n) as { content: string; document_id: string }[];
  return rows.map((r) => ({ content: r.content, documentId: r.document_id }));
}

const GEN_PROMPT = `You are building an evaluation set for a retrieval system over an engineering knowledge base.

Below is one excerpt from the corpus. Write ONE specific question that this excerpt answers, and the correct answer.

Rules:
- The question must be answerable ONLY from this excerpt — it must reference concrete specifics (a class, method, table, endpoint, setting, or policy named in the text).
- Do NOT write questions like "what does this document say" or questions that mention "the excerpt".
- The question must make sense to someone who has never seen this text.
- The answer must be 1-3 sentences, factual, drawn strictly from the excerpt.

Respond with JSON only: {"question": "...", "answer": "..."}

EXCERPT:
`;

export async function generateQuestions(
  orgId: string,
  setId: string,
  count: number
): Promise<number> {
  const db = getDb();
  const model = getSetting(orgId, "eval_judge_model") || getSetting(orgId, "model_medium");
  const chunks = await sampleChunks(orgId, count);
  let created = 0;
  for (const chunk of chunks) {
    try {
      const { text } = await complete(
        orgId,
        model,
        GEN_PROMPT + chunk.content.slice(0, 6000)
      );
      const parsed = parseJson(text);
      const question = String(parsed?.question ?? "").trim();
      const answer = String(parsed?.answer ?? "").trim();
      if (!question || !answer) continue;
      const doc = db
        .prepare("SELECT name FROM documents WHERE id = ?")
        .get(chunk.documentId) as { name: string } | undefined;
      db.prepare(
        `INSERT INTO eval_questions (id, set_id, org_id, question, expected, source_document_id, source_label)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(uid(), setId, orgId, question, answer, chunk.documentId, doc?.name ?? null);
      created++;
    } catch {
      // A failed generation just means one fewer question; keep going.
    }
  }
  return created;
}

// --- running an evaluation -------------------------------------------------

const ANSWER_PROMPT = (context: string, question: string) =>
  `Answer the question using ONLY the context below. If the context does not contain the answer, say exactly "NOT FOUND". Be concise and factual.

CONTEXT:
${context}

QUESTION: ${question}

ANSWER:`;

const JUDGE_PROMPT = (question: string, expected: string, actual: string, context: string) =>
  `You are grading a retrieval-augmented answer. Be strict and consistent.

QUESTION: ${question}

REFERENCE ANSWER: ${expected}

CANDIDATE ANSWER: ${actual}

RETRIEVED CONTEXT THE CANDIDATE WAS GIVEN:
${context.slice(0, 8000)}

Score two things on a 0-5 integer scale:
- "correctness": does the candidate convey the same facts as the reference? 5 = fully correct, 3 = partially, 0 = wrong or "NOT FOUND" when the reference has an answer.
- "groundedness": is every claim in the candidate supported by the retrieved context? 5 = fully supported, 0 = fabricated.

Respond with JSON only: {"correctness": N, "groundedness": N, "note": "one short sentence"}`;

export async function runEval(runId: string): Promise<void> {
  const db = getDb();
  const run = db.prepare("SELECT * FROM eval_runs WHERE id = ?").get(runId) as
    | { id: string; org_id: string; set_id: string; config: string }
    | undefined;
  if (!run) return;
  const cfg: EvalConfig = JSON.parse(run.config);
  const orgId = run.org_id;

  const questions = db
    .prepare("SELECT * FROM eval_questions WHERE set_id = ? ORDER BY created_at")
    .all(run.set_id) as {
    id: string;
    question: string;
    expected: string;
    source_document_id: string | null;
  }[];

  db.prepare(
    "UPDATE eval_runs SET status = 'running', total_count = ?, done_count = 0 WHERE id = ?"
  ).run(questions.length, runId);

  let done = 0;
  for (const q of questions) {
    const started = Date.now();
    try {
      const results = await searchLocal(orgId, q.question, { k: cfg.retrievalK });

      // Objective retrieval score: did the document the question came from
      // come back, and where in the ranking?
      const idx = results.findIndex((r) => r.documentId === q.source_document_id);
      const hit = idx >= 0 ? 1 : 0;
      const rank = idx >= 0 ? idx + 1 : null;

      const context = results
        .map((r, i) => `[${i + 1}] ${r.sourceLabel}${r.path ? ` — ${r.path}` : ""}\n${r.content}`)
        .join("\n\n---\n\n");

      const answered = await complete(orgId, cfg.model, ANSWER_PROMPT(context, q.question));

      let correctness: number | null = null;
      let groundedness: number | null = null;
      let note = "";
      try {
        const judged = await complete(
          orgId,
          cfg.judgeModel,
          JUDGE_PROMPT(q.question, q.expected, answered.text, context)
        );
        const parsed = parseJson(judged.text);
        if (parsed) {
          correctness = Number(parsed.correctness);
          groundedness = Number(parsed.groundedness);
          note = String(parsed.note ?? "");
          if (!Number.isFinite(correctness)) correctness = null;
          if (!Number.isFinite(groundedness)) groundedness = null;
        }
      } catch {
        /* judging failed; retrieval metrics still stand */
      }

      db.prepare(
        `INSERT INTO eval_results
         (id, run_id, question_id, answer, retrieved, hit, rank, correctness, groundedness, judge_note, latency_ms, tokens_in, tokens_out)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uid(),
        runId,
        q.id,
        answered.text,
        JSON.stringify(
          results.map((r) => ({ name: r.sourceLabel, path: r.path, documentId: r.documentId }))
        ),
        hit,
        rank,
        correctness,
        groundedness,
        note,
        Date.now() - started,
        // Token usage is recorded centrally in the metrics ledger by the
        // provider layer; the per-result columns stay for schema compatibility.
        0,
        0
      );
    } catch (e) {
      db.prepare(
        `INSERT INTO eval_results (id, run_id, question_id, error, latency_ms)
         VALUES (?, ?, ?, ?, ?)`
      ).run(uid(), runId, q.id, (e as Error).message, Date.now() - started);
    }
    done++;
    db.prepare("UPDATE eval_runs SET done_count = ? WHERE id = ?").run(done, runId);
  }

  const metrics = computeMetrics(runId);
  db.prepare(
    "UPDATE eval_runs SET status = 'done', metrics = ?, finished_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(metrics), runId);
}

export type EvalMetrics = {
  questions: number;
  scored: number;
  hitRate: number; // fraction where the source document was retrieved
  mrr: number; // mean reciprocal rank of the source document
  correctness: number; // 0-1 (judge score / 5)
  groundedness: number; // 0-1
  avgLatencyMs: number;
  tokensIn: number;
  tokensOut: number;
  errors: number;
};

export function computeMetrics(runId: string): EvalMetrics {
  const rows = getDb()
    .prepare("SELECT * FROM eval_results WHERE run_id = ?")
    .all(runId) as {
    hit: number;
    rank: number | null;
    correctness: number | null;
    groundedness: number | null;
    latency_ms: number;
    tokens_in: number;
    tokens_out: number;
    error: string | null;
  }[];
  const ok = rows.filter((r) => !r.error);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const corr = ok.map((r) => r.correctness).filter((x): x is number => x !== null);
  const grnd = ok.map((r) => r.groundedness).filter((x): x is number => x !== null);
  return {
    questions: rows.length,
    scored: ok.length,
    hitRate: mean(ok.map((r) => r.hit)),
    mrr: mean(ok.map((r) => (r.rank ? 1 / r.rank : 0))),
    correctness: mean(corr) / 5,
    groundedness: mean(grnd) / 5,
    avgLatencyMs: Math.round(mean(ok.map((r) => r.latency_ms))),
    tokensIn: rows.reduce((a, r) => a + (r.tokens_in ?? 0), 0),
    tokensOut: rows.reduce((a, r) => a + (r.tokens_out ?? 0), 0),
    errors: rows.length - ok.length,
  };
}
