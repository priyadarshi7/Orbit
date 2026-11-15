import { generateText, Output } from "ai";
import { z } from "zod";
import { FixtureStore, RecordingReader, RecordingSearch, ReplayReader, ReplaySearch, StaticSearch } from "../adapters/fixtures";
import { HttpPageReader } from "../adapters/http-reader";
import type { AgentEvent, TurnTrace } from "../agent/events";
import { runTurn, type AgentDeps } from "../agent/run";
import { buildSingleSearch } from "../app";
import type { Config } from "../config";
import { seed } from "../memory/seed";
import { MemoryStore } from "../memory/store";
import { resolveModel } from "../models";
import { systemClock, type PageReader, type SearchProvider } from "../ports";
import { MapReader } from "./fakes";
import type { Case, Category } from "./cases";

export type Mode = "live" | "record" | "replay";

export interface Judged {
  score: number;
  correct: boolean;
  grounded: boolean;
  notes: string;
}

export interface CaseResult {
  id: string;
  category: Category;
  model: string;
  message: string;
  answer: string;
  error?: string;
  checks: { name: string; ok: boolean; detail?: string }[];
  pass: boolean;
  trace?: TurnTrace;
  judged?: Judged;
}

export interface SuiteOptions {
  cfg: Config;
  modelSpec: string;
  mode: Mode;
  /** Search backend under test; its fixtures are kept in their own file. */
  search: "tavily" | "exa";
  fixtureDir: string;
  judge: boolean;
  /** Overrides cfg.models.judge (e.g. when the default judge hits a free-tier quota). */
  judgeModelSpec?: string;
  delayMs: number;
  tz: string;
  onProgress?: (r: CaseResult, i: number, n: number) => void;
}

const JudgeSchema = z.object({
  score: z.number().min(1).max(5).describe("1 = bad, 5 = excellent, against the rubric"),
  correct: z.boolean().describe("Is the answer substantively right and responsive?"),
  grounded: z.boolean().describe("Are factual claims supported by cited sources, with nothing invented?"),
  notes: z.string().describe("One or two sentences on the biggest strength or flaw."),
});

async function collect(deps: AgentDeps, message: string, conversationId?: string) {
  const events: AgentEvent[] = [];
  for await (const e of runTurn(deps, { message, conversationId, tz: "UTC" })) events.push(e);
  return events;
}

const isRateLimit = (m: string) => /rate-limited|429|quota/i.test(m);

export async function runSuite(cases: Case[], o: SuiteOptions): Promise<CaseResult[]> {
  const fx = new FixtureStore(`${o.fixtureDir}/search-${o.search}.json`);
  const realSearch = buildSingleSearch(o.cfg, o.search);
  const results: CaseResult[] = [];

  const cfg: Config = { ...o.cfg, models: { ...o.cfg.models, answer: o.modelSpec, answerFallback: undefined } };
  const model = resolveModel(o.modelSpec, cfg);
  const judgeModel = o.judge ? resolveModel(o.judgeModelSpec ?? cfg.models.judge, cfg) : null;

  for (const [i, c] of cases.entries()) {
    let search: SearchProvider;
    let reader: PageReader;
    if (c.fixture) {
      const hits = c.fixture.hits;
      search = new StaticSearch(() => hits);
      reader = new MapReader(c.fixture.pages ?? {});
    } else if (o.mode === "replay") {
      search = new ReplaySearch(fx);
      reader = new ReplayReader(fx);
    } else {
      // A missing key fails only if a case actually searches, so no-search cases run without one.
      search = o.mode === "record" ? new RecordingSearch(realSearch, fx) : realSearch;
      reader = o.mode === "record" ? new RecordingReader(new HttpPageReader(), fx) : new HttpPageReader();
    }

    const store = new MemoryStore(":memory:");
    const now = new Date();
    if (c.seed) seed(store, o.tz, now);
    const deps: AgentDeps = { cfg, store, outbox: null, clock: systemClock, search, reader, answer: { name: o.modelSpec, model } };

    const message = typeof c.message === "function" ? c.message(now) : c.message;
    let result: CaseResult = { id: c.id, category: c.category, model: o.modelSpec, message, answer: "", checks: [], pass: false };

    try {
      let convId: string | undefined;
      for (const prior of c.priorTurns ?? []) {
        const ev = await withRetry(() => collect(deps, prior, convId), o.delayMs);
        const done = ev.find((e) => e.type === "done");
        if (done?.type === "done") convId = done.conversationId;
        else throw new Error(`prior turn failed: ${ev.find((e) => e.type === "error")?.type === "error" ? (ev.find((e) => e.type === "error") as { message: string }).message : "unknown"}`);
        await sleep(o.delayMs);
      }
      const events = await withRetry(() => collect(deps, message, convId), o.delayMs);
      const final = events.find((e) => e.type === "final");
      const done = events.find((e) => e.type === "done");
      const err = events.find((e) => e.type === "error");
      result.answer = final?.type === "final" ? final.text : "";
      if (done?.type === "done") result.trace = done.trace;
      if (err?.type === "error") result.error = err.message;
      result.checks = check(c, result);

      if (judgeModel && result.answer) {
        result.judged = await judge(judgeModel, c, message, result).catch((e) => ({
          score: 0,
          correct: false,
          grounded: false,
          notes: `judge failed: ${e instanceof Error ? e.message : e}`,
        }));
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      result.checks = [{ name: "completed", ok: false, detail: result.error }];
    }
    result.pass = !result.error && result.checks.every((x) => x.ok);
    results.push(result);
    o.onProgress?.(result, i, cases.length);
    if (o.mode === "record") fx.save();
    await sleep(o.delayMs);
  }
  return results;
}

function check(c: Case, r: CaseResult): CaseResult["checks"] {
  const out: CaseResult["checks"] = [];
  const text = r.answer;
  out.push({ name: "answered", ok: text.trim().length > 0 && !r.error, detail: r.error });
  const searched = (r.trace?.searches.length ?? 0) > 0;
  if (c.expect.search !== undefined) {
    out.push({
      name: c.expect.search ? "searched" : "did not search",
      ok: searched === c.expect.search,
      detail: `searches=${r.trace?.searches.length ?? 0}`,
    });
  }
  for (const re of c.expect.mustMatch ?? []) out.push({ name: `matches /${re}/`, ok: new RegExp(re, "i").test(text) });
  for (const re of c.expect.mustNotMatch ?? []) out.push({ name: `avoids /${re}/`, ok: !new RegExp(re, "i").test(text) });
  if (c.expect.minCitations !== undefined) {
    const n = r.trace?.citations.cited.length ?? 0;
    out.push({ name: `>=${c.expect.minCitations} citation(s)`, ok: n >= c.expect.minCitations, detail: `cited=${n}` });
  }
  return out;
}

async function judge(model: ReturnType<typeof resolveModel>, c: Case, message: string, r: CaseResult): Promise<Judged> {
  const { output } = await generateText({
    model,
    temperature: 0,
    instructions:
      "You grade an AI assistant's answer against a rubric. Be strict and concise. You cannot browse; judge behaviour, grounding, honesty and responsiveness, not trivia you cannot verify.",
    prompt: `TODAY (real date of this run, so dates up to today are NOT in the future): ${new Date().toISOString().slice(0, 10)}

QUESTION:\n${message}\n\nRUBRIC (what a good answer does):\n${c.rubric}\n\nANSWER:\n${r.answer}\n\nSEARCHES RUN: ${r.trace?.searches.length ?? 0}; CITATIONS KEPT: ${r.trace?.citations.cited.length ?? 0}; WARNINGS: ${r.trace?.warnings.join("; ") || "none"}`,
    output: Output.object({ schema: JudgeSchema }),
  });
  return output;
}

async function withRetry<T extends AgentEvent[]>(fn: () => Promise<T>, delayMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const ev = await fn();
    const err = ev.find((e) => e.type === "error");
    if (err?.type === "error" && isRateLimit(err.message) && attempt < 3) {
      await sleep(Math.max(15_000, delayMs) * (attempt + 1));
      continue;
    }
    return ev;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── reporting ────────────────────────────────────────────────────────────

export interface Summary {
  model: string;
  cases: number;
  passed: number;
  judgeAvg: number | null;
  ttftP50: number | null;
  totalP50: number | null;
  totalP90: number | null;
  tokensIn: number;
  tokensOut: number;
  cachedIn: number;
  byCategory: Record<string, { passed: number; total: number }>;
}

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

export function summarize(model: string, rs: CaseResult[]): Summary {
  const ttft = rs.map((r) => r.trace?.firstTokenMs).filter((x): x is number => typeof x === "number");
  const total = rs.map((r) => r.trace?.totalMs).filter((x): x is number => typeof x === "number");
  const judged = rs.map((r) => r.judged?.score).filter((x): x is number => typeof x === "number" && x > 0);
  const byCategory: Summary["byCategory"] = {};
  for (const r of rs) {
    const b = (byCategory[r.category] ??= { passed: 0, total: 0 });
    b.total++;
    if (r.pass) b.passed++;
  }
  return {
    model,
    cases: rs.length,
    passed: rs.filter((r) => r.pass).length,
    judgeAvg: judged.length ? judged.reduce((a, b) => a + b, 0) / judged.length : null,
    ttftP50: pct(ttft, 50),
    totalP50: pct(total, 50),
    totalP90: pct(total, 90),
    tokensIn: rs.reduce((s, r) => s + (r.trace?.usage.inputTokens ?? 0), 0),
    tokensOut: rs.reduce((s, r) => s + (r.trace?.usage.outputTokens ?? 0), 0),
    cachedIn: rs.reduce((s, r) => s + (r.trace?.usage.cachedInputTokens ?? 0), 0),
    byCategory,
  };
}

export function markdownTable(summaries: Summary[]): string {
  const cats = [...new Set(summaries.flatMap((s) => Object.keys(s.byCategory)))];
  const ms = (n: number | null) => (n == null ? "–" : `${Math.round(n)}`);
  const head = ["model", "pass", "judge", "ttft p50 ms", "total p50 ms", "total p90 ms", "tokens in/out", "cached in", ...cats];
  const rows = summaries.map((s) => [
    s.model,
    `${s.passed}/${s.cases}`,
    s.judgeAvg == null ? "–" : s.judgeAvg.toFixed(2),
    ms(s.ttftP50),
    ms(s.totalP50),
    ms(s.totalP90),
    `${s.tokensIn}/${s.tokensOut}`,
    String(s.cachedIn),
    ...cats.map((c) => (s.byCategory[c] ? `${s.byCategory[c]!.passed}/${s.byCategory[c]!.total}` : "–")),
  ]);
  return [head, head.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
}
