import crypto from "crypto";
import OpenAI from "openai";
import { getSetting } from "./settings";

// Identifies which OpenAI account/key hosted-store artifacts belong to, so a
// key rotation invalidates stale vector-store references instead of breaking
// chat with "vector store not found".
export function keyFingerprint(): string {
  const key = process.env.OPENAI_API_KEY || "";
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

declare global {
  // eslint-disable-next-line no-var
  var __tesseractOpenAI: OpenAI | undefined;
}

export function getOpenAI(): OpenAI {
  if (!globalThis.__tesseractOpenAI) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set in .env.local");
    globalThis.__tesseractOpenAI = new OpenAI({ apiKey });
  }
  return globalThis.__tesseractOpenAI;
}

export type ReasoningTier = "low" | "medium" | "high";

// Mirrors knoh's AiModelResolver: a reasoning tier maps to an
// admin-configurable (per-org) model plus a reasoning effort parameter.
export function resolveModel(
  orgId: string,
  tier: ReasoningTier
): {
  model: string;
  effort: ReasoningTier;
} {
  const model = getSetting(orgId, `model_${tier}`) || getSetting(orgId, "model_medium");
  return { model, effort: tier };
}
