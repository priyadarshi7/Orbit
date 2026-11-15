/**
 * Cost estimates are opt-in. Prices change and differ by tier, so none are hard-coded: set MODEL_PRICES in .env
 * to USD per 1 million tokens, keyed by the model spec, e.g.
 *   MODEL_PRICES={"groq:openai/gpt-oss-120b":{"in":0.15,"out":0.6,"cachedIn":0.075}}
 * With no entry for a model, no cost is shown (free tiers and local models report tokens only).
 */
export interface ModelPrice {
  in: number;
  out: number;
  /** Price for cached input tokens; defaults to the normal input price. */
  cachedIn?: number;
}
export type PriceTable = Record<string, ModelPrice>;

export function parsePrices(raw: string | undefined): PriceTable {
  if (!raw?.trim()) return {};
  try {
    const j = JSON.parse(raw) as Record<string, Partial<ModelPrice>>;
    const out: PriceTable = {};
    for (const [k, v] of Object.entries(j)) {
      if (v && Number.isFinite(v.in) && Number.isFinite(v.out)) out[k] = { in: v.in!, out: v.out!, cachedIn: Number.isFinite(v.cachedIn) ? v.cachedIn : undefined };
    }
    return out;
  } catch {
    return {};
  }
}

/** USD for one turn, or undefined when this model has no configured price. */
export function estimateCost(
  prices: PriceTable,
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): number | undefined {
  const p = prices[model];
  if (!p) return undefined;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  return (fresh * p.in + cached * (p.cachedIn ?? p.in) + usage.outputTokens * p.out) / 1_000_000;
}
