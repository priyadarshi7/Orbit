import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import type { Mode, Path } from "./events";

export interface Route {
  path: Path;
  reason: string;
  /** How it was decided: the user, the classifier model, or the rules (when the model was unavailable). */
  by: "user" | "model" | "rules";
}

const RESEARCH = /\b(deep[- ]?dive|deep research|research|investigate|in[- ]depth|comprehensive|thorough(?:ly)?|literature review|state of the art|landscape|full (?:report|analysis|comparison)|analy[sz]e|write (?:a )?report)\b/i;
const COMPARE = /\b(compare|comparison|versus|vs\.?|pros and cons|trade-?offs?|differences? between|which is better|alternatives to)\b/i;

/**
 * Rule-based prior. Used when the classifier is unavailable (rate limit, timeout, bad output), so the
 * agent still routes sensibly offline. Weak signals go "fast": a wrong "fast" costs a thinner answer
 * the user can escalate with one click, a wrong "deep" costs a minute.
 */
export function ruleRoute(question: string): Omit<Route, "by"> {
  const q = question.trim();
  if (q.length < 30) return { path: "fast", reason: "short question" };
  let score = 0;
  const why: string[] = [];
  if (RESEARCH.test(q)) (score += 2), why.push("asks for research");
  if (COMPARE.test(q)) (score += 1), why.push("compares options");
  if ((q.match(/\?/g) ?? []).length >= 2) (score += 1), why.push("several questions in one");
  if (q.length > 280) (score += 1), why.push("long, detailed request");
  return score >= 2 ? { path: "deep", reason: why.join(", ") } : { path: "fast", reason: "one focused question" };
}

const Verdict = z.object({
  path: z.enum(["fast", "deep"]),
  reason: z.string().max(120).describe("Under 12 words, plain language, shown to the user"),
});

const CLASSIFIER = `You route a question for a web-research assistant to one of two paths.
fast: one focused lookup or answer. Chit-chat, thanks, questions about the user or earlier chat, a single fact, a definition, a current price/version/score/weather, a how-to, a quick recommendation, writing or maths that needs no research. Most questions.
deep: the answer needs several angles researched and combined. Comparing or choosing between multiple options on several criteria, explaining a complex or contested topic, a market or technology overview, "research/investigate/analyse X", a question with several distinct parts, or anything where a single search would give a thin or one-sided answer.
Judge by what the question needs, in any language, not by its wording. When it is borderline, choose fast.`;

/**
 * Decides the path for a turn. A forced mode wins; otherwise a cheap model classifies the question
 * (with the previous exchange, so "and what about Exa?" is read in context). If the classifier fails
 * or takes more than `timeoutMs`, the rules decide, so routing never blocks or breaks a turn.
 */
export async function routeTurn(opts: {
  model: LanguageModel | undefined;
  question: string;
  /** The previous exchange, for follow-ups. */
  context?: string;
  mode?: Mode;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Route> {
  const { mode = "auto", question } = opts;
  if (mode === "fast" || mode === "deep") return { path: mode, reason: "chosen by you", by: "user" };
  const fallback = (): Route => ({ ...ruleRoute(question), by: "rules" });
  if (!opts.model) return fallback();
  // A greeting or one-word reply never needs a model to say it is fast.
  if (question.trim().length < 12) return { path: "fast", reason: "short message", by: "rules" };

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 4000);
  try {
    const { output } = await generateText({
      model: opts.model,
      instructions: CLASSIFIER,
      prompt: `${opts.context ? `PREVIOUS EXCHANGE:\n${opts.context.slice(0, 500)}\n\n` : ""}QUESTION:\n${question.slice(0, 1200)}`,
      temperature: 0,
      maxOutputTokens: 80,
      maxRetries: 0,
      abortSignal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      output: Output.object({ schema: Verdict }),
    });
    return { path: output.path, reason: output.reason.trim() || (output.path === "deep" ? "needs several angles" : "one focused question"), by: "model" };
  } catch {
    return fallback();
  }
}
