import { tool } from "ai";
import { z } from "zod";
import type { Config } from "../config";
import type { MemoryStore } from "../memory/store";
import type { Clock, PageReader, SearchProvider } from "../ports";
import type { EvidenceRegistry } from "../retrieval/evidence";
import { runRetrieval } from "../retrieval/pipeline";
import type { AgentEventInput, TurnTrace } from "./events";

export interface ToolContext {
  cfg: Config;
  search: SearchProvider;
  reader: PageReader;
  store: MemoryStore | null;
  clock: Clock;
  registry: EvidenceRegistry;
  emit: (e: AgentEventInput) => void;
  trace: TurnTrace;
  signal?: AbortSignal;
  /** ms since the turn started. */
  rel: () => number;
  /** Shrinks evidence budgets when a provider says the request was too large. */
  scale: { value: number };
  /** Called with each round's evidence text once it exists (the turn saves it as a checkpoint). */
  onEvidence?: (text: string) => void;
}

const Input = z.object({
  queries: z
    .array(z.string().min(2).max(200))
    .min(1)
    .describe("1-4 differently-worded search queries, run in parallel."),
  depth: z
    .enum(["snippets", "read"])
    .default("snippets")
    .describe('"read" fetches and reads the top pages (use for prices, specs, dates, comparisons). "snippets" is faster.'),
  recency: z
    .enum(["day", "week", "month", "year", "any"])
    .default("any")
    .describe("Restrict to recent results when the user wants fresh information."),
});

/**
 * The one tool. Budgets (rounds, queries per round, repeated queries) are
 * enforced here in code; the prompt only describes them.
 */
export function createSearchTool(ctx: ToolContext) {
  const { cfg } = ctx;
  const seen = new Set<string>();
  let rounds = 0;
  let spent = 0; // evidence tokens already handed to the model this turn

  return tool({
    description:
      "Search the web. Returns numbered evidence passages with source, domain and publish date. Cite them as [n].",
    inputSchema: Input,
    execute: async (input): Promise<string> => {
      rounds++;
      if (rounds > cfg.budgets.maxSearchRounds) {
        return "<evidence>\nSEARCH BUDGET EXHAUSTED. Answer now with the evidence already gathered; state what you could not confirm.\n</evidence>";
      }
      const remaining = Math.floor(cfg.budgets.turnEvidenceBudget * ctx.scale.value) - spent;
      if (remaining < 300) {
        return "<evidence>\nEVIDENCE BUDGET FOR THIS TURN IS USED UP. Answer now with the evidence already gathered; state what you could not confirm.\n</evidence>";
      }
      const fresh = [...new Set(input.queries.map((q) => q.trim()))]
        .filter((q) => !seen.has(q.toLowerCase()))
        .slice(0, cfg.budgets.maxQueriesPerRound);
      fresh.forEach((q) => seen.add(q.toLowerCase()));
      if (fresh.length === 0) {
        return "<evidence>\nThese queries were already run. Use the evidence you have, or try genuinely different wording.\n</evidence>";
      }

      const started = ctx.rel();
      const out = await runRetrieval(
        {
          search: ctx.search,
          reader: ctx.reader,
          store: ctx.store,
          clock: ctx.clock,
          budgetTokens: Math.min(Math.floor(cfg.budgets.evidenceTokenBudget * ctx.scale.value), remaining),
        },
        {
          queries: fresh,
          depth: input.depth,
          recency: input.recency,
          registry: ctx.registry,
          signal: ctx.signal,
          onStatus: (phase, detail) => ctx.emit({ type: "status", phase, detail }),
          onSource: (source) => ctx.emit({ type: "source", source }),
        },
      );
      spent += out.stats.usedTokens;
      ctx.trace.searches.push({
        queries: fresh,
        depth: input.depth,
        hits: out.stats.hits,
        cached: out.stats.cachedQueries === fresh.length,
      });
      ctx.trace.timings.push({
        stage: "retrieval",
        startMs: started,
        endMs: ctx.rel(),
        detail: `${out.stats.uniqueUrls} urls, ${out.stats.pagesRead}/${out.stats.pagesRequested} pages, ${out.stats.passages} passages`,
      });
      ctx.emit({ type: "status", phase: "thinking" });
      ctx.onEvidence?.(out.text);
      return out.text;
    },
  });
}
