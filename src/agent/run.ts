import { isStepCount, streamText, type LanguageModel, type ModelMessage } from "ai";
import type { Config } from "../config";
import { gate, leaksInstructions, WITHHELD_REPLY } from "../grounding/gate";
import { estimateCost } from "../pricing";
import { runDeep } from "./deep";
import { needsFreshSearch } from "./freshness";
import { routeTurn } from "./router";
import { providerOptionsFor } from "./modelOptions";
import { assembleMemory } from "../memory/assemble";
import type { OutboxWorker } from "../memory/outbox";
import type { MemoryStore } from "../memory/store";
import { TURN_JOB, type TurnJobPayload } from "../memory/writer";
import type { Clock, PageReader, SearchProvider } from "../ports";
import { EvidenceRegistry } from "../retrieval/evidence";
import { Channel } from "../util/channel";
import { estimateTokens, truncate } from "../util/text";
import { isValidTz } from "../util/time";
import type { AgentEvent, AgentEventInput, Mode, TurnTrace } from "./events";
import { systemPrompt, userTurn } from "./prompt";
import { createSearchTool } from "./tools";

export interface NamedModel {
  name: string;
  model: LanguageModel;
}

export interface AgentDeps {
  cfg: Config;
  store: MemoryStore;
  outbox: OutboxWorker | null;
  clock: Clock;
  search: SearchProvider;
  reader: PageReader;
  answer: NamedModel;
  fallback?: NamedModel;
  /** Planner, researchers and verifier on the deep path. Defaults to the answer model. */
  research?: NamedModel;
}

export interface TurnRequest {
  conversationId?: string;
  message: string;
  tz?: string;
  /** auto = router decides; fast/deep force a path. */
  mode?: Mode;
  signal?: AbortSignal;
}

const KEEP_VERBATIM = 10;
const TOO_LARGE = /request too large|reduce your message size|maximum context length|context length exceeded|input is too long/i;

/**
 * One chat turn as a stream of typed events. The model decides; this
 * function only assembles context, enforces budgets, validates the answer,
 * and hands durable work to the outbox.
 */
export function runTurn(deps: AgentDeps, req: TurnRequest): AsyncIterable<AgentEvent> {
  const ch = new Channel<AgentEvent>();
  const t0 = Date.now();
  const rel = () => Date.now() - t0;
  const emit = (e: AgentEventInput) => ch.push({ ...e, t: rel() } as AgentEvent);

  void (async () => {
    try {
      await execute(deps, req, emit, rel);
    } catch (e) {
      if (!req.signal?.aborted) emit({ type: "error", message: friendlyError(e) });
    } finally {
      ch.close();
    }
  })();
  return ch;
}

async function execute(
  deps: AgentDeps,
  req: TurnRequest,
  emit: (e: AgentEventInput) => void,
  rel: () => number,
): Promise<void> {
  const { cfg, store, clock } = deps;
  const now = clock.now();
  const nowIso = now.toISOString();
  const tz = req.tz && isValidTz(req.tz) ? req.tz : cfg.defaultTz;
  const question = req.message.trim();

  const trace: TurnTrace = {
    model: deps.answer.name,
    totalMs: 0,
    timings: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, steps: 0 },
    searches: [],
    citations: { cited: [], dropped: [] },
    warnings: [],
    memory: { episodes: 0, claims: 0, hadRecord: null },
    usedFallbackModel: false,
  };

  // ── conversation + user message (persisted first, so a crash keeps it) ──
  const conversationId = req.conversationId ?? store.createConversation(nowIso);
  if (!store.getConversation(conversationId)) store.createConversation(nowIso, conversationId);
  const priorCount = store.getMessages(conversationId).length;
  const userMsgId = store.appendMessage({ conversationId, role: "user", content: question, createdAt: nowIso });
  if (priorCount === 0) store.setTitle(conversationId, truncate(question.replace(/\s+/g, " "), 60));

  // ── 1. context assembly (code, no LLM) ──────────────────────────────────
  emit({ type: "status", phase: "memory" });
  const tMem = rel();
  const memory = assembleMemory(store, { message: question, conversationId, now, tz });
  trace.memory = memory.stats;
  trace.timings.push({
    stage: "context",
    startMs: tMem,
    endMs: rel(),
    detail: `${memory.stats.episodes} episodes, ${memory.stats.claims} claims`,
  });
  const { messages: history, earlier } = buildHistory(store, conversationId, userMsgId, cfg.budgets.historyTokenBudget);
  const messages: ModelMessage[] = [
    ...history,
    { role: "user", content: userTurn({ now, tz, memoryText: memory.text, earlierInChat: earlier, question }) },
  ];

  // ── 2. agent loop ────────────────────────────────────────────────────────
  emit({ type: "status", phase: "thinking" });
  const registry = new EvidenceRegistry();
  const scale = { value: 1 };
  const state: StreamState = { answer: "", streamed: false, firstTokenMs: undefined, lastMessages: undefined };

  // Speculative pre-fetch: for a question that is plainly time-sensitive, the model will search anyway.
  // Doing the first search here puts evidence in its first call and removes one model round trip.
  if (cfg.speculativeSearch && needsFreshSearch(question)) {
    const pre = createSearchTool({ cfg, search: deps.search, reader: deps.reader, store, clock, registry, emit, trace, signal: req.signal, rel, scale });
    try {
      const evidence = await (pre.execute as (i: unknown, o: unknown) => Promise<string>)(
        { queries: [question.slice(0, 200)], depth: "snippets", recency: "any" },
        { toolCallId: "prefetch", messages: [] },
      );
      const last = messages[messages.length - 1]!;
      messages[messages.length - 1] = {
        role: "user",
        content: `${last.content as string}\n\nSearch results already fetched for this question (search again only if they are not enough):\n${evidence}`,
      };
      trace.warnings.push("speculative search ran before the first model call");
    } catch {
      /* the model can still search for itself */
    }
  }

  // ── route: fast (one agent loop) or deep (plan → parallel research → synthesis → verify) ──
  const tRoute = rel();
  const prev = history.slice(-2).map((m) => `${m.role}: ${truncate(String(m.content), 240)}`).join("\n");
  const route = await routeTurn({ model: (deps.research ?? deps.answer).model, question, context: prev, mode: req.mode, signal: req.signal });
  if (route.by !== "user") trace.timings.push({ stage: "route", startMs: tRoute, endMs: rel(), detail: `${route.path} (${route.by})` });
  trace.path = route.path;
  trace.routeReason = route.reason;
  emit({ type: "route", path: route.path, reason: route.reason });

  let current = deps.answer;
  let outcome: StreamOutcome = {};
  let deepDone = false;
  if (route.path === "deep") {
    const d = await runDeep({
      cfg,
      store,
      clock,
      search: deps.search,
      reader: deps.reader,
      answer: deps.answer,
      research: deps.research ?? deps.answer,
      messages,
      registry,
      emit,
      trace,
      signal: req.signal,
      rel,
      sink: state,
    });
    if (d.ok) deepDone = true;
    else {
      trace.warnings.push(`deep research unavailable (${d.reason}); answered on the fast path`);
      trace.path = "fast";
      state.answer = "";
      state.streamed = false;
      state.firstTokenMs = undefined;
      emit({ type: "reset" });
    }
  }

  if (!deepDone) {
    const run = async (m: NamedModel, forceSearch = false) => {
      state.answer = "";
      state.streamed = false;
      const search = createSearchTool({
        cfg,
        search: deps.search,
        reader: deps.reader,
        store,
        clock,
        registry,
        emit,
        trace,
        signal: req.signal,
        rel,
        scale,
      });
      return streamOnce(m, messages, search, cfg, req.signal, rel, emit, trace, state, forceSearch);
    };

    outcome = await run(current);
    // "Request too large" is about OUR prompt, not the model: retry once with half the evidence
    // before giving up on a model that is otherwise fine.
    if (outcome.error && !state.streamed && TOO_LARGE.test(errMsg(outcome.error)) && !req.signal?.aborted) {
      scale.value = 0.5;
      trace.warnings.push(`request too large for ${current.name}; retried with half the evidence`);
      outcome = await run(current);
    }
    if (outcome.error && !state.streamed && deps.fallback && !req.signal?.aborted) {
      trace.usedFallbackModel = true;
      trace.model = deps.fallback.name;
      trace.warnings.push(`primary model failed (${errMsg(outcome.error)}); used fallback`);
      current = deps.fallback;
      outcome = await run(current);
    }

    // A model that cites [n] without ever having searched is answering from memory and
    // inventing sources. That is a certain failure, so make it search and answer again.
    if (!outcome.error && registry.size === 0 && !req.signal?.aborted) {
      const probe = gate(state.answer, () => false, { sourcesRetrieved: 0 });
      if (probe.dropped.length > 0) {
        trace.warnings.push("answer cited sources without searching; re-ran with search required");
        emit({ type: "reset" });
        state.firstTokenMs = undefined;
        outcome = await run(current, true);
      }
    }

    // A time-sensitive question answered without a single search is a stale answer by construction
    // (and shows no sources). Make it search once and answer again.
    if (!outcome.error && registry.size === 0 && trace.searches.length === 0 && needsFreshSearch(question) && !req.signal?.aborted) {
      trace.warnings.push("time-sensitive question answered without searching; re-ran with search required");
      emit({ type: "reset" });
      state.firstTokenMs = undefined;
      outcome = await run(current, true);
    }

    // Last resort: a model that ignores "no more tools" (or dies after searching) must not
    // cost the user the evidence already gathered. Ask once more with no tools at all.
    if (outcome.error && !state.answer && state.lastMessages && registry.size > 0 && !req.signal?.aborted) {
      trace.warnings.push(`answer step failed (${errMsg(outcome.error)}); recovered with a tool-free call`);
      const m = trace.usedFallbackModel && deps.fallback ? deps.fallback : deps.answer;
      outcome = await answerOnly(m, state.lastMessages, cfg, req.signal, emit, state);
    }
  }

  const aborted = req.signal?.aborted === true;
  if (outcome.error && !state.answer && !aborted) {
    emit({ type: "error", message: friendlyError(outcome.error) });
    return;
  }

  // ── 3. grounding gate ────────────────────────────────────────────────────
  emit({ type: "status", phase: "writing" });
  const raw = state.answer.trim() || (aborted ? "" : "I couldn't produce an answer. Please try again.");
  const g = gate(raw, (id) => registry.has(id), { sourcesRetrieved: registry.size });
  if (leaksInstructions(g.text, systemPrompt(cfg.budgets.maxSearchRounds))) {
    // Streamed tokens may already be on screen; the final event replaces them.
    g.text = WITHHELD_REPLY;
    g.cited = [];
    g.warnings.push("blocked a reply that reproduced the system prompt");
  }
  trace.citations = { cited: g.cited, dropped: g.dropped };
  trace.warnings.push(...g.warnings);
  if (outcome.error && state.answer) trace.warnings.push(`stream interrupted: ${errMsg(outcome.error)}`);
  const citedSources = registry.all().filter((s) => g.cited.includes(s.id));
  emit({ type: "final", text: g.text, sources: citedSources });

  // ── persist + background work ───────────────────────────────────────────
  trace.totalMs = rel();
  trace.firstTokenMs = state.firstTokenMs;
  const doneAt = clock.now().toISOString();
  const assistantId = store.appendMessage({
    conversationId,
    role: "assistant",
    content: g.text,
    createdAt: doneAt,
    meta: { sources: citedSources, trace, ...(aborted ? { stopped: true } : {}) },
  });
  if (!aborted && g.text.trim()) {
    const payload: TurnJobPayload = {
      conversationId,
      turnKey: assistantId,
      userMessage: question,
      answer: g.text,
      sources: citedSources.map((s) => ({ url: s.url, title: s.title })),
      createdAt: nowIso,
      tz,
    };
    deps.outbox?.enqueue(TURN_JOB, assistantId, payload, doneAt);
  }
  trace.costUsd = estimateCost(cfg.prices, trace.model, trace.usage);
  emit({ type: "done", conversationId, messageId: assistantId, trace });
}

interface StreamOutcome {
  error?: unknown;
}

interface StreamState {
  answer: string;
  streamed: boolean;
  firstTokenMs: number | undefined;
  /** Messages (incl. tool results) as sent on the latest step; used for recovery. */
  lastMessages: ModelMessage[] | undefined;
}

const FINAL_NOTE =
  "(The search budget is used up. Write the final answer now from the evidence above, and say what you could not verify.)";
const LATE_NOTE =
  "(Time is nearly up. Write the final answer now from the evidence above, and say what you could not verify.)";

/** One plain streamed call with no tools; used only to recover a turn. */
async function answerOnly(
  m: NamedModel,
  messages: ModelMessage[],
  cfg: Config,
  signal: AbortSignal | undefined,
  emit: (e: AgentEventInput) => void,
  state: StreamState,
): Promise<StreamOutcome> {
  const result = streamText({
    model: m.model,
    instructions: systemPrompt(cfg.budgets.maxSearchRounds),
    messages: [...messages, { role: "user", content: FINAL_NOTE }],
    temperature: 0.3,
    maxOutputTokens: cfg.budgets.maxOutputTokens,
    ...(providerOptionsFor(m.name, cfg.answerReasoning) ? { providerOptions: providerOptionsFor(m.name, cfg.answerReasoning) } : {}),
    // Providers say how long to wait when rate-limited (e.g. "try again in 4s"); wait it out.
    maxRetries: 4,
    abortSignal: signal,
    onError: () => undefined,
  });
  let error: unknown;
  try {
    for await (const part of result.fullStream) {
      if (part.type === "text-delta" && part.text) {
        state.answer += part.text;
        state.streamed = true;
        emit({ type: "token", text: part.text });
      } else if (part.type === "error") error = part.error;
    }
  } catch (e) {
    error = e;
  }
  return { error: state.answer ? undefined : error };
}

async function streamOnce(
  m: NamedModel,
  messages: ModelMessage[],
  searchTool: ReturnType<typeof createSearchTool>,
  cfg: Config,
  signal: AbortSignal | undefined,
  rel: () => number,
  emit: (e: AgentEventInput) => void,
  trace: TurnTrace,
  state: StreamState,
  forceSearch = false,
): Promise<StreamOutcome> {
  const maxRounds = cfg.budgets.maxSearchRounds;
  const result = streamText({
    model: m.model,
    instructions: systemPrompt(maxRounds),
    messages,
    tools: { web_search: searchTool },
    // N search rounds + one answer step.
    stopWhen: isStepCount(maxRounds + 1),
    temperature: 0.3,
    maxOutputTokens: cfg.budgets.maxOutputTokens,
    ...(providerOptionsFor(m.name, cfg.answerReasoning) ? { providerOptions: providerOptionsFor(m.name, cfg.answerReasoning) } : {}),
    // Providers say how long to wait when rate-limited (e.g. "try again in 4s"); wait it out.
    maxRetries: 4,
    abortSignal: signal,
    onError: () => undefined, // surfaced through fullStream below
    prepareStep: ({ stepNumber, messages: msgs }) => {
      const lastStep = stepNumber >= maxRounds;
      const late = rel() > cfg.budgets.turnSoftDeadlineMs;
      state.lastMessages = msgs;
      if (forceSearch && stepNumber === 0) return { toolChoice: "required" as const };
      if (!lastStep && !late) return undefined;
      // Keep the tool list (and so the cached prefix) intact; just forbid calling it,
      // and tell the model why with an appended message.
      return {
        toolChoice: "none" as const,
        messages: [...msgs, { role: "user" as const, content: late ? LATE_NOTE : FINAL_NOTE }],
      };
    },
  });

  let stepText = "";
  let stepStreamed = false;
  let error: unknown;
  const stepStart = { t: rel() };

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "start-step":
          stepStart.t = rel();
          break;
        case "text-delta": {
          if (!part.text) break;
          stepText += part.text;
          stepStreamed = true;
          state.streamed = true;
          state.firstTokenMs ??= rel();
          emit({ type: "token", text: part.text });
          break;
        }
        case "finish-step": {
          const u = part.usage;
          trace.usage.steps++;
          trace.usage.inputTokens += u.inputTokens ?? 0;
          trace.usage.outputTokens += u.outputTokens ?? 0;
          trace.usage.cachedInputTokens += u.inputTokenDetails?.cacheReadTokens ?? 0;
          trace.timings.push({
            stage: part.finishReason === "tool-calls" ? "model(tool)" : "model(answer)",
            startMs: stepStart.t,
            endMs: rel(),
            detail: `${u.inputTokens ?? 0} in / ${u.outputTokens ?? 0} out`,
          });
          if (part.finishReason === "tool-calls") {
            // Text before a tool call is a preamble, not the answer.
            if (stepStreamed) emit({ type: "reset" });
            state.firstTokenMs = undefined;
            stepText = "";
            stepStreamed = false;
          } else {
            state.answer = stepText;
            stepText = "";
          }
          break;
        }
        case "error":
          error = part.error;
          break;
        default:
          break;
      }
    }
  } catch (e) {
    error = e;
  }
  if (!state.answer && stepText) state.answer = stepText; // stream cut mid-answer
  return { error };
}

/**
 * Earlier turns, within a token budget. The newest exchange is kept in full; older ones are trimmed harder and
 * dropped (newest first kept) once the budget is spent. Whatever is dropped is represented by short episode
 * summaries, so a long chat costs a bounded number of tokens per turn instead of growing without limit.
 */
export function buildHistory(
  store: MemoryStore,
  conversationId: string,
  excludeId: string,
  budgetTokens = 1800,
): { messages: ModelMessage[]; earlier: string } {
  const all = store.getMessages(conversationId).filter((m) => m.id !== excludeId);
  const kept: { role: "user" | "assistant"; content: string }[] = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]!;
    const newest = all.length - i <= 2;
    const cap = newest ? (m.role === "assistant" ? 3000 : 1500) : m.role === "assistant" ? 600 : 400;
    const text = truncate(m.content, cap);
    const cost = estimateTokens(text) + 4;
    if (!newest && (used + cost > budgetTokens || kept.length >= KEEP_VERBATIM)) break;
    kept.unshift({ role: m.role, content: text });
    used += cost;
  }
  while (kept[0]?.role === "assistant") kept.shift(); // a transcript should open with the user
  const older = all.slice(0, all.length - kept.length);

  let earlier = "";
  if (older.length) {
    const eps = store.episodesForConversation(conversationId);
    const lines = eps.length
      ? eps.map((e) => `- ${e.localDate}: ${truncate(e.summary, 200)}`)
      : older.filter((m) => m.role === "user").map((m) => `- user asked: ${truncate(m.content, 140)}`);
    earlier = `<earlier_in_this_chat>\n${lines.slice(-12).join("\n")}\n</earlier_in_this_chat>`;
  }
  return { messages: kept, earlier };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e)?.slice(0, 200) ?? "unknown error";
}

export function friendlyError(e: unknown): string {
  const raw = errMsg(e);
  if (/429|rate.?limit|quota|too many requests/i.test(raw)) return "The model is rate-limited right now. Please try again in a moment.";
  if (/401|403|api key|unauthor|permission/i.test(raw)) return "The model rejected the API key. Check your .env.";
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|network/i.test(raw)) return "Could not reach the model provider. Check your connection or local server.";
  return `Something went wrong: ${truncate(raw, 200)}`;
}
