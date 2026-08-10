import { getSetting } from "../settings";
import { recordMetric } from "../metrics";

// Anthropic has no embeddings API, so retrieval needs its own provider.
//
//   local  — Transformers.js runs a small sentence-transformer on the CPU.
//            No second vendor key, no data leaving the box. Default.
//   openai — text-embedding-3-small. Better recall, needs OPENAI_API_KEY.
//
// The two produce different vector geometries (384 vs 1536 dimensions), so
// switching providers invalidates the index — see ensureVectorGeometry.

export type EmbeddingProvider = "local" | "openai";

export type EmbeddingConfig = {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
};

export const LOCAL_EMBEDDING_DIM = 384; // all-MiniLM-L6-v2
export const OPENAI_EMBEDDING_DIM = 1536; // text-embedding-3-small

export function embeddingConfig(orgId: string): EmbeddingConfig {
  const provider =
    getSetting(orgId, "embedding_provider") === "openai" ? "openai" : "local";
  return provider === "openai"
    ? {
        provider,
        model: getSetting(orgId, "embedding_model_openai") || "text-embedding-3-small",
        dimensions: OPENAI_EMBEDDING_DIM,
      }
    : {
        provider,
        model: getSetting(orgId, "embedding_model_local") || "Xenova/all-MiniLM-L6-v2",
        dimensions: LOCAL_EMBEDDING_DIM,
      };
}

// Is the selected provider actually usable right now? Surfaced in Admin so a
// missing key is a visible warning instead of a failed ingestion.
export function embeddingProviderError(orgId: string): string | null {
  const cfg = embeddingConfig(orgId);
  if (cfg.provider === "openai" && !process.env.OPENAI_API_KEY) {
    return "Embedding provider is set to OpenAI but OPENAI_API_KEY is not set. Switch to the local embedder or add the key.";
  }
  return null;
}

// ------------------------------------------------------------- local model

type FeatureExtractor = (
  text: string[],
  opts: { pooling: "mean"; normalize: boolean }
) => Promise<{ tolist: () => number[][] }>;

declare global {
  // eslint-disable-next-line no-var
  var __tesseractEmbedder: Promise<FeatureExtractor> | undefined;
  // eslint-disable-next-line no-var
  var __tesseractEmbedderModel: string | undefined;
}

// The model is downloaded once into node_modules/@huggingface cache (or
// TRANSFORMERS_CACHE) and then loaded from disk. First call is slow; every
// later call reuses the warm pipeline held on globalThis.
async function localEmbedder(model: string): Promise<FeatureExtractor> {
  if (globalThis.__tesseractEmbedder && globalThis.__tesseractEmbedderModel === model) {
    return globalThis.__tesseractEmbedder;
  }
  globalThis.__tesseractEmbedderModel = model;
  globalThis.__tesseractEmbedder = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    // Offline-friendly: prefer a pre-downloaded cache, never phone home for
    // model *metadata* once the files are present.
    if (process.env.TRANSFORMERS_CACHE) env.cacheDir = process.env.TRANSFORMERS_CACHE;
    const extractor = await pipeline("feature-extraction", model, { dtype: "fp32" });
    return extractor as unknown as FeatureExtractor;
  })();
  return globalThis.__tesseractEmbedder;
}

async function embedLocal(
  orgId: string,
  texts: string[],
  cfg: EmbeddingConfig
): Promise<Float32Array[]> {
  const extractor = await localEmbedder(cfg.model);
  const out: Float32Array[] = [];
  // Small batches keep peak RSS bounded on a modest Ubuntu VM.
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, 8000));
    const result = await extractor(batch, { pooling: "mean", normalize: true });
    for (const vec of result.tolist()) out.push(new Float32Array(vec));
    recordMetric(orgId, "embeddings_created", batch.length, cfg.model);
  }
  return out;
}

// ------------------------------------------------------------------ OpenAI

async function embedOpenAI(
  orgId: string,
  texts: string[],
  cfg: EmbeddingConfig
): Promise<Float32Array[]> {
  const { getOpenAI } = await import("../openai");
  const client = getOpenAI();
  const out: Float32Array[] = [];
  const BATCH = 100;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, 24000));
    const res = await client.embeddings.create({
      model: cfg.model,
      input: batch,
      dimensions: cfg.dimensions,
    });
    for (const item of res.data) out.push(new Float32Array(item.embedding));
    recordMetric(orgId, "embeddings_created", res.data.length, cfg.model);
    recordMetric(orgId, "embedding_tokens", res.usage?.total_tokens ?? 0, cfg.model);
  }
  return out;
}

export async function embedTexts(
  orgId: string,
  texts: string[]
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const cfg = embeddingConfig(orgId);
  const error = embeddingProviderError(orgId);
  if (error) throw new Error(error);
  return cfg.provider === "openai"
    ? embedOpenAI(orgId, texts, cfg)
    : embedLocal(orgId, texts, cfg);
}
