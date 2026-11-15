import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

const Schema = z.object({
  suggestions: z.array(z.string().min(4).max(90)).max(3).describe("Short follow-up questions, written as the user would type them"),
});

const SYSTEM = `You suggest what a user might ask next in a chat with a research assistant.
Return 0 to 3 short follow-up questions, in the user's voice, each a different direction (go deeper, compare, apply it to their situation, check what changed).
Return none when the exchange was small talk, a refusal, an error, or a clarifying question. Never repeat the user's question. No numbering, no quotes.`;

export async function suggestFollowUps(model: LanguageModel, question: string, answer: string, signal?: AbortSignal): Promise<string[]> {
  const { output } = await generateText({
    model,
    temperature: 0.5,
    maxRetries: 1,
    abortSignal: signal,
    instructions: SYSTEM,
    prompt: `QUESTION:\n${question.slice(0, 600)}\n\nANSWER:\n${answer.slice(0, 1800)}`,
    output: Output.object({ schema: Schema }),
  });
  const q = question.trim().toLowerCase();
  return output.suggestions.map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== q).slice(0, 3);
}
