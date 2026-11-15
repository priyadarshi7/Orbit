import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { PageContent, PageReader } from "../ports";

/** One scripted model turn. */
export type ScriptStep =
  | { text: string }
  | { toolCall: { name: string; input: unknown } }
  | { error: string };

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

/**
 * A deterministic stand-in for the LLM port. Lets the whole agent loop, trace,
 * gate and outbox run in tests and in `npm run eval -- --fake` with no key.
 * Calls beyond the script repeat its last step.
 */
export function scriptedModel(
  steps: ScriptStep[],
  opts: { generateText?: string | string[] } = {},
): MockLanguageModelV4 & { calls: () => number } {
  let n = 0;
  let g = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(n++, steps.length - 1)]!;
      if ("error" in step) throw new Error(step.error);
      if ("toolCall" in step) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: `call-${n}`,
                toolName: step.toolCall.name,
                input: JSON.stringify(step.toolCall.input),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, logprobs: undefined, usage },
            ],
          }),
        };
      }
      const words = step.text.match(/\S+\s*/g) ?? [step.text];
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            ...words.map((w) => ({ type: "text-delta" as const, id: "t1", delta: w })),
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage },
          ],
        }),
      };
    },
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: Array.isArray(opts.generateText) ? (opts.generateText[Math.min(g++, opts.generateText.length - 1)] ?? "{}") : (opts.generateText ?? "{}") }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage,
      warnings: [],
    }),
  });
  return Object.assign(model, { calls: () => n });
}

/** A page reader backed by a plain map. */
export class MapReader implements PageReader {
  reads: string[] = [];
  constructor(private readonly pages: Record<string, string>) {}
  async read(url: string): Promise<PageContent | null> {
    this.reads.push(url);
    const text = this.pages[url];
    return text ? { url, text } : null;
  }
}
