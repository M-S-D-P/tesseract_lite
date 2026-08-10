import { getSetting } from "./settings";

export type ReasoningTier = "low" | "medium" | "high";

// A reasoning tier maps to an admin-configurable (per-org) Claude model plus a
// reasoning effort. Lite is Claude-only: every tier must be an Anthropic id.
export function resolveModel(
  orgId: string,
  tier: ReasoningTier
): { model: string; effort: ReasoningTier } {
  const model = getSetting(orgId, `model_${tier}`) || getSetting(orgId, "model_medium");
  return { model, effort: tier };
}
