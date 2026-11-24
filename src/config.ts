import "dotenv/config";

import { parsePrices, type PriceTable } from "./pricing";

export interface Config {
  port: number;
  /** Browser origins allowed to call the API directly (CORS). The dev UI proxies, so this is for separate deploys. */
  webOrigins: string[];
  dbPath: string;
  defaultTz: string;
  tavilyKey: string | undefined;
  exaKey: string | undefined;
  /** Reasoning effort for the answer model (unset = provider default). */
  answerReasoning: "low" | "medium" | "high" | undefined;
  /** Run one search for time-sensitive questions before the first model call. */
  speculativeSearch: boolean;
  /** Optional USD-per-1M-token prices by model spec (see pricing.ts). */
  prices: PriceTable;
  auth: {
    /** When false every request is the single legacy user (local tools, offline use). */
    required: boolean;
    /** HMAC key for session tokens; generated and stored in the database when unset. */
    secret: string | undefined;
  };
  rateLimit: {
    chatPerMin: number;
    apiPerMin: number;
    /** Anonymous sessions created per IP per minute. */
    sessionPerMin: number;
    maxConcurrentTurns: number;
    /** Read the client IP from X-Forwarded-For (only behind a proxy you control). */
    trustProxy: boolean;
  };
  /** Which search backend is primary; the other (if keyed) is the failover. */
  searchProvider: "tavily" | "exa";
  models: {
    answer: string;
    answerFallback: string | undefined;
    background: string;
    /** Planner, researchers and verifier on the deep path (many short calls, so a fast, cheap model). */
    research: string;
    judge: string;
  };
  deep: {
    maxSubQuestions: number;
    /** Researchers running at once; bounded so a free-tier rate limit is not hit by our own fan-out. */
    concurrency: number;
    researcherRounds: number;
    researcherTimeoutMs: number;
  };
  local: { baseUrl: string; apiKey: string };
  budgets: {
    maxSearchRounds: number;
    maxQueriesPerRound: number;
    /** Evidence tokens added per search call. */
    evidenceTokenBudget: number;
    /** Evidence tokens across ALL search calls in one turn (bounds the final prompt size). */
    turnEvidenceBudget: number;
    /** Tokens of earlier chat sent verbatim; older turns fall back to summaries. */
    historyTokenBudget: number;
    maxOutputTokens: number;
    turnSoftDeadlineMs: number;
    /** Server-side backstop: a turn still running after this is aborted and its concurrency slot freed. */
    turnHardTimeoutMs: number;
  };
}

const int = (v: string | undefined, d: number): number => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const str = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 8000),
    webOrigins: (str(env.WEB_ORIGIN) ?? "http://localhost:5173,http://localhost:4173").split(",").map((s) => s.trim()).filter(Boolean),
    dbPath: str(env.DB_PATH) ?? "data/orbit.db",
    defaultTz: str(env.DEFAULT_TZ) ?? "UTC",
    tavilyKey: str(env.TAVILY_API_KEY),
    exaKey: str(env.EXA_API_KEY),
    prices: parsePrices(str(env.MODEL_PRICES)),
    auth: { required: !["0", "false", "off"].includes(str(env.AUTH_REQUIRED)?.toLowerCase() ?? ""), secret: str(env.AUTH_SECRET) },
    rateLimit: {
      chatPerMin: int(env.RATE_LIMIT_CHAT_PER_MIN, 12),
      apiPerMin: int(env.RATE_LIMIT_API_PER_MIN, 240),
      sessionPerMin: int(env.RATE_LIMIT_SESSION_PER_MIN, 20),
      maxConcurrentTurns: int(env.MAX_CONCURRENT_TURNS, 2),
      trustProxy: ["1", "true", "on"].includes(str(env.TRUST_PROXY)?.toLowerCase() ?? ""),
    },
    answerReasoning: (["low", "medium", "high"] as const).find((x) => x === str(env.ANSWER_REASONING)?.toLowerCase()),
    speculativeSearch: ["1", "true", "on"].includes(str(env.SPECULATIVE_SEARCH)?.toLowerCase() ?? ""),
    searchProvider: str(env.SEARCH_PROVIDER)?.toLowerCase() === "exa" ? "exa" : "tavily",
    models: {
      answer: str(env.ANSWER_MODEL) ?? "google:gemini-3.1-flash-lite",
      answerFallback: str(env.ANSWER_MODEL_FALLBACK) ?? "google:gemini-2.5-flash",
      background: str(env.BACKGROUND_MODEL) ?? "google:gemini-2.5-flash",
      research: str(env.RESEARCH_MODEL) ?? str(env.BACKGROUND_MODEL) ?? "google:gemini-2.5-flash",
      judge: str(env.JUDGE_MODEL) ?? "google:gemini-2.5-flash",
    },
    local: {
      baseUrl: str(env.LOCAL_BASE_URL) ?? "http://localhost:11434/v1",
      apiKey: str(env.LOCAL_API_KEY) ?? "local",
    },
    deep: {
      maxSubQuestions: int(env.DEEP_MAX_SUBQUESTIONS, 4),
      concurrency: int(env.DEEP_CONCURRENCY, 3),
      researcherRounds: int(env.DEEP_RESEARCHER_ROUNDS, 2),
      researcherTimeoutMs: int(env.DEEP_RESEARCHER_TIMEOUT_MS, 45_000),
    },
    budgets: {
      maxSearchRounds: int(env.MAX_SEARCH_ROUNDS, 4),
      maxQueriesPerRound: int(env.MAX_QUERIES_PER_ROUND, 4),
      evidenceTokenBudget: int(env.EVIDENCE_TOKEN_BUDGET, 2000),
      turnEvidenceBudget: int(env.TURN_EVIDENCE_BUDGET, 3500),
      historyTokenBudget: int(env.HISTORY_TOKEN_BUDGET, 1800),
      maxOutputTokens: int(env.MAX_OUTPUT_TOKENS, 1500),
      turnSoftDeadlineMs: int(env.TURN_SOFT_DEADLINE_MS, 40_000),
      turnHardTimeoutMs: int(env.TURN_HARD_TIMEOUT_MS, 180_000),
    },
  };
}
