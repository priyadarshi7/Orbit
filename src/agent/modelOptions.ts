export type Effort = "low" | "medium" | "high";
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type ProviderOptions = Record<string, { [k: string]: Json }>;

/**
 * Provider-specific knobs that trade reasoning depth for speed. Reasoning tokens are usually the biggest
 * share of time-to-first-token, so this is the first lever to benchmark. Only options known to be valid
 * for the model family are sent; anything else is left at the provider default.
 */
export function providerOptionsFor(spec: string, effort?: Effort): ProviderOptions | undefined {
  if (!effort) return undefined;
  const i = spec.indexOf(":");
  const provider = spec.slice(0, i);
  const id = spec.slice(i + 1);
  if (provider === "groq" && /gpt-oss/.test(id)) return { groq: { reasoningEffort: effort } };
  if (provider === "google" && /^gemini-2\.5/.test(id)) {
    return { google: { thinkingConfig: { thinkingBudget: { low: 512, medium: 2048, high: 8192 }[effort] } } };
  }
  return undefined;
}
