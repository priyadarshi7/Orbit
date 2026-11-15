import { HttpPageReader } from "./adapters/http-reader";
import { ExaSearch } from "./adapters/exa";
import { FailoverSearch } from "./adapters/failover";
import { TavilySearch } from "./adapters/tavily";
import type { AgentDeps } from "./agent/run";
import { loadConfig, type Config } from "./config";
import { OutboxWorker } from "./memory/outbox";
import { MemoryStore } from "./memory/store";
import { applyFallbackEpisode, makeTurnHandler, TURN_JOB, type TurnJobPayload } from "./memory/writer";
import type { LanguageModel } from "ai";
import { providerAvailability, resolveModel } from "./models";
import { systemClock, type SearchHit, type SearchProvider } from "./ports";

/** Used when no search key is configured, so the failure is visible to the user, not silent. */
class MissingSearch implements SearchProvider {
  readonly name = "missing";
  async search(): Promise<SearchHit[]> {
    throw new Error("search is not configured: set TAVILY_API_KEY or EXA_API_KEY in .env");
  }
}

export interface App {
  cfg: Config;
  deps: AgentDeps;
  outbox: OutboxWorker;
  /** The cheap model used for background work (memory writing, follow-up suggestions). */
  background: LanguageModel;
  close(): Promise<void>;
}

/** Composition root: the only place that wires real adapters to ports. */
export function createApp(cfg: Config = loadConfig()): App {
  const store = new MemoryStore(cfg.dbPath);

  const background = resolveModel(cfg.models.background, cfg);
  const outbox = new OutboxWorker(
    store,
    { [TURN_JOB]: makeTurnHandler(store, background) },
    {
      log: (m) => console.log(m),
      onGiveUp: (kind, payload) => {
        if (kind === TURN_JOB) applyFallbackEpisode(store, payload as TurnJobPayload);
      },
    },
  );

  const deps: AgentDeps = {
    cfg,
    store,
    outbox,
    clock: systemClock,
    search: buildSearch(cfg),
    reader: new HttpPageReader(),
    answer: { name: cfg.models.answer, model: resolveModel(cfg.models.answer, cfg) },
    fallback: cfg.models.answerFallback
      ? { name: cfg.models.answerFallback, model: resolveModel(cfg.models.answerFallback, cfg) }
      : undefined,
    research: { name: cfg.models.research, model: resolveModel(cfg.models.research, cfg) },
  };

  return {
    cfg,
    deps,
    outbox,
    background,
    close: async () => {
      await outbox.stop();
      store.close();
    },
  };
}

/** Primary per SEARCH_PROVIDER; the other backend, if it has a key, becomes the failover. */
export function buildSearch(cfg: Config): SearchProvider {
  const tavily = cfg.tavilyKey ? new TavilySearch(cfg.tavilyKey) : null;
  const exa = cfg.exaKey ? new ExaSearch(cfg.exaKey) : null;
  const [primary, secondary] = cfg.searchProvider === "exa" ? [exa, tavily] : [tavily, exa];
  if (primary && secondary) return new FailoverSearch(primary, secondary);
  return primary ?? secondary ?? new MissingSearch();
}

/** One backend alone (no failover): used by benchmarks so providers are compared fairly. */
export function buildSingleSearch(cfg: Config, which: "tavily" | "exa"): SearchProvider {
  if (which === "exa") return cfg.exaKey ? new ExaSearch(cfg.exaKey) : new MissingSearch();
  return cfg.tavilyKey ? new TavilySearch(cfg.tavilyKey) : new MissingSearch();
}

export function searchLabel(cfg: Config): string {
  const p = buildSearch(cfg);
  return p.name === "missing" ? "not configured" : p.name;
}

export function startupReport(cfg: Config): string[] {
  const avail = providerAvailability();
  const lines: string[] = [];
  const check = (role: string, spec: string | undefined) => {
    if (!spec) return;
    const p = spec.split(":")[0] as keyof typeof avail;
    lines.push(`  ${role.padEnd(10)} ${spec}${avail[p] ? "" : "   ⚠ no API key for this provider"}`);
  };
  lines.push("models:");
  check("answer", cfg.models.answer);
  check("fallback", cfg.models.answerFallback);
  check("background", cfg.models.background);
  const s = searchLabel(cfg);
  lines.push(`search:      ${s === "not configured" ? "⚠ no search key set (TAVILY_API_KEY or EXA_API_KEY); search will fail" : s}`);
  return lines;
}
