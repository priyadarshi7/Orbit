/**
 * The single typed event stream for a turn. It drives the SSE UI, the debug
 * drawer and the eval runner, so a benchmark number is the number the UI shows.
 */

export type Phase = "memory" | "thinking" | "searching" | "reading" | "writing" | "planning" | "researching" | "verifying";

export type Path = "fast" | "deep";
export type Mode = "auto" | "fast" | "deep";

export interface PlanStep {
  id: number;
  question: string;
}

export interface SourceInfo {
  id: number;
  url: string;
  title: string;
  domain: string;
  publishedDate?: string;
}

export interface StageTiming {
  stage: string;
  startMs: number;
  endMs: number;
  detail?: string;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  steps: number;
}

export interface TurnTrace {
  model: string;
  totalMs: number;
  /** ms from turn start to the first answer token (undefined if none). */
  firstTokenMs?: number;
  timings: StageTiming[];
  usage: UsageInfo;
  searches: { queries: string[]; depth: string; hits: number; cached: boolean }[];
  citations: { cited: number[]; dropped: number[] };
  warnings: string[];
  memory: { episodes: number; claims: number; hadRecord: boolean | null };
  usedFallbackModel: boolean;
  /** Estimated USD for the turn; present only when MODEL_PRICES has an entry for the model. */
  costUsd?: number;
  /** Which path answered: the single agent loop, or plan → parallel research → synthesis → verification. */
  path?: Path;
  routeReason?: string;
  plan?: PlanStep[];
  /** Claim check against the retrieved passages (deep path). */
  verification?: { checked: number; unsupported: number; revised: boolean; issues?: string[] };
}

export type AgentEvent =
  | { type: "status"; phase: Phase; detail?: string; t: number }
  /** The turn is accepted: the conversation it belongs to and the id of the user message that was saved. */
  | { type: "start"; conversationId: string; userMessageId: string; t: number }
  | { type: "route"; path: Path; reason: string; t: number }
  | { type: "plan"; steps: PlanStep[]; t: number }
  | { type: "step"; id: number; state: "running" | "done" | "failed"; sources?: number; t: number }
  | { type: "source"; source: SourceInfo; t: number }
  | { type: "token"; text: string; t: number }
  /** The text streamed so far was a pre-tool-call preamble; discard it. */
  | { type: "reset"; t: number }
  /** Final, gate-validated answer. Replaces streamed tokens if they differ. */
  | { type: "final"; text: string; sources: SourceInfo[]; t: number }
  | { type: "done"; conversationId: string; messageId: string; trace: TurnTrace; t: number }
  | { type: "error"; message: string; t: number };

export type AgentEventInput = AgentEvent extends infer E
  ? E extends { t: number }
    ? Omit<E, "t">
    : never
  : never;
