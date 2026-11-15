import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { tokenize, truncate } from "../util/text";
import { localYMD } from "../util/time";
import type { MemoryStore } from "./store";

export const TURN_JOB = "summarize_turn";

export interface TurnJobPayload {
  conversationId: string;
  /** The assistant message id; makes the job idempotent. */
  turnKey: string;
  userMessage: string;
  answer: string;
  sources: { url: string; title: string }[];
  createdAt: string;
  tz: string;
  /** Owner of the turn; absent in jobs queued before accounts existed (legacy user). */
  userId?: string;
}

const Extraction = z.object({
  summary: z.string().describe("One or two sentences: what the user wanted and what was concluded. Third person."),
  keywords: z.array(z.string()).describe("3-10 lowercase topic words: products, companies, subjects."),
  profileFacts: z
    .array(
      z.object({
        slot: z
          .string()
          .describe('What the fact is about, 1-3 lowercase words, e.g. "name", "birthday", "city", "job", "team size", "stack". Reuse the same slot for the same kind of fact.'),
        fact: z.string().describe("The fact as a short sentence."),
      }),
    )
    .describe("Durable facts the USER stated about themselves or their situation (team size, stack, location, goals). Not facts about the world."),
  claims: z
    .array(
      z.object({
        subject: z.string().describe("The thing the fact is about, e.g. a product or company."),
        attribute: z.string().describe("What about it, e.g. 'Pro plan price', 'latest version'."),
        value: z.string().describe("The value stated in the answer, with unit."),
        sourceUrl: z.string().nullable().describe("URL the answer cited for it, or null."),
      }),
    )
    .describe("Checkable facts stated in the answer that could change over time: prices, versions, features, availability, rankings."),
});

export type Extraction = z.infer<typeof Extraction>;

const SYSTEM = `You extract memory records from one chat turn. Output only what is explicitly in the text.
- summary: concise, factual, third person ("The user asked about… The answer found…").
- profileFacts: only things the USER stated about themselves in USER MESSAGE. Never take a fact from the ASSISTANT ANSWER, and never from a question. A question about the chat itself ("when did I tell you…", "what did I say about…") yields none. The date a statement was made is not part of the fact (if they said their birthday is 30 April 2005 on 14 November, the fact is the birthday, not 14 November). Give each a slot (what it is about); when EXISTING FACTS lists a slot for the same kind of fact, reuse that exact slot name (a changed value replaces it); otherwise choose a short, natural slot name of your own. Empty if none.
- claims: only specific, checkable facts from the ANSWER that may change later (prices, plan limits, versions, release dates, features). Skip opinions and general knowledge. Use the exact values given. Empty if none.
Never invent values.`;

export async function extractTurn(
  model: LanguageModel,
  p: TurnJobPayload,
  existing: { slot: string; fact: string }[] = [],
): Promise<Extraction> {
  const prompt = [
    existing.length ? `EXISTING FACTS (slot: fact):\n${existing.map((f) => `- ${f.slot}: ${f.fact}`).join("\n")}` : "",
    `USER MESSAGE:\n${truncate(p.userMessage, 1500)}`,
    `ASSISTANT ANSWER:\n${truncate(p.answer, 5000)}`,
    p.sources.length ? `SOURCES CITED:\n${p.sources.slice(0, 12).map((s) => `- ${s.title} ${s.url}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const { output } = await generateText({
    model,
    instructions: SYSTEM,
    prompt,
    output: Output.object({ schema: Extraction }),
    temperature: 0,
    abortSignal: AbortSignal.timeout(30_000),
  });
  return output;
}

const MONTHS = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i;

/**
 * A profile fact must come from what the user wrote. Any number, month or capitalised name in the fact
 * that does not appear in the user's message came from somewhere else (the assistant's answer, the date of
 * the chat), so the fact is dropped. This is deterministic, so it holds even when the extraction prompt is ignored.
 */
export function groundedFacts<T extends string | { fact: string }>(facts: T[], userMessage: string): T[] {
  const said = userMessage.toLowerCase();
  const saidNums = new Set(said.match(/\d+/g) ?? []);
  const saidWords = new Set(said.match(/[\p{L}\p{N}]+/gu) ?? []);
  return facts.filter((item) => {
    const f = typeof item === "string" ? item : item.fact;
    const nums = f.match(/\d+/g) ?? [];
    if (nums.some((n) => !saidNums.has(n))) return false;
    const words = f.match(/[\p{L}][\p{L}'-]*/gu) ?? [];
    return words.every((w, i) => {
      const lw = w.toLowerCase();
      const special = MONTHS.test(w) || (i > 0 && /^\p{Lu}/u.test(w));
      return !special || saidWords.has(lw);
    });
  });
}

/** Persist an extraction. Safe to call twice for the same turn. */
export function applyExtraction(root: MemoryStore, p: TurnJobPayload, x: Extraction): void {
  const store = p.userId ? root.forUser(p.userId) : root;
  const localDate = localYMD(new Date(p.createdAt), p.tz);
  const episodeId = store.addEpisode({
    conversationId: p.conversationId,
    turnKey: p.turnKey,
    localDate,
    createdAt: p.createdAt,
    summary: x.summary.trim() || truncate(p.userMessage, 200),
    keywords: x.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean).slice(0, 12),
  });
  store.addFacts(groundedFacts(x.profileFacts, p.userMessage), p.createdAt);
  store.recordClaims(
    episodeId,
    x.claims.map((c) => ({ subject: c.subject, attribute: c.attribute, value: c.value, sourceUrl: c.sourceUrl })),
    localDate,
    p.createdAt,
  );
}

/**
 * If the model could not produce an extraction, still store a minimal episode
 * so the turn stays findable by date and keyword.
 */
export function applyFallbackEpisode(store: MemoryStore, p: TurnJobPayload): void {
  applyExtraction(store, p, {
    summary: `The user asked: ${truncate(p.userMessage, 200)}`,
    keywords: [...new Set(tokenize(p.userMessage))].slice(0, 8),
    profileFacts: [],
    claims: [],
  });
}

export function makeTurnHandler(store: MemoryStore, model: LanguageModel) {
  return async (p: TurnJobPayload): Promise<void> => {
    // The turn may have been edited or regenerated away while this job waited.
    if (!store.hasMessage(p.turnKey)) return;
    const x = await extractTurn(model, p, (p.userId ? store.forUser(p.userId) : store).factSlots());
    if (!store.hasMessage(p.turnKey)) return;
    applyExtraction(store, p, x);
  };
}
