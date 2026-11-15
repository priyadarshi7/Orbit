import { describe, expect, it } from "vitest";
import { StaticSearch } from "../src/adapters/fixtures";
import { providerOptionsFor } from "../src/agent/modelOptions";
import { runTurn, type AgentDeps } from "../src/agent/run";
import { loadConfig } from "../src/config";
import { MapReader, scriptedModel, type ScriptStep } from "../src/eval/fakes";
import { MemoryStore } from "../src/memory/store";
import { fixedClock } from "../src/ports";
import { bm25 } from "../src/retrieval/rank";
import { stem } from "../src/util/text";

describe("providerOptionsFor (per-model reasoning effort)", () => {
  it("is off unless an effort is configured", () => {
    expect(providerOptionsFor("groq:openai/gpt-oss-120b")).toBeUndefined();
  });
  it("maps effort for the model families that support it, and only those", () => {
    expect(providerOptionsFor("groq:openai/gpt-oss-120b", "low")).toEqual({ groq: { reasoningEffort: "low" } });
    expect(providerOptionsFor("google:gemini-2.5-flash", "low")).toEqual({ google: { thinkingConfig: { thinkingBudget: 512 } } });
    expect(providerOptionsFor("google:gemini-2.5-flash", "high")).toEqual({ google: { thinkingConfig: { thinkingBudget: 8192 } } });
    expect(providerOptionsFor("groq:qwen/qwen3-32b", "low")).toBeUndefined();
    expect(providerOptionsFor("google:gemini-3-flash-preview", "low")).toBeUndefined();
    expect(providerOptionsFor("local:llama3", "low")).toBeUndefined();
  });
});

describe("stem + BM25", () => {
  it("puts inflections of a word in one bucket", () => {
    expect(new Set(["release", "releases", "released", "releasing"].map(stem)).size).toBe(1);
    expect(new Set(["price", "prices", "pricing"].map(stem)).size).toBe(1);
    expect(stem("node")).toBe("node");
    expect(stem("3.15")).toBe("3.15");
    expect(stem("class")).toBe("class"); // not "clas"
  });

  it("ranks a passage that only matches by inflection above an unrelated one", () => {
    const docs = [
      { item: "unrelated", text: "A recipe for lemon cake with butter and sugar." },
      { item: "match", text: "Node.js releases a new version every six months." },
    ];
    const ranked = bm25(docs, "node release").sort((a, b) => b.score - a.score);
    expect(ranked[0]!.item).toBe("match");
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });
});

describe("agent loop: reasoning effort and speculative search", () => {
  const base = { DB_PATH: ":memory:", TURN_SOFT_DEADLINE_MS: "30000" };
  const SEARCH = new StaticSearch((q) => [
    { url: "https://nodejs.org/en/blog", title: "Node.js releases", snippet: `Node 26.1 was released on 10 November 2026. (${q})`, publishedDate: "2026-11-10" },
  ]);

  function deps(env: Record<string, string>, script: ScriptStep[]) {
    const cfg = loadConfig({ ...base, ...env } as NodeJS.ProcessEnv);
    const answer = scriptedModel(script);
    const d: AgentDeps = {
      cfg,
      store: new MemoryStore(":memory:"),
      outbox: null,
      clock: fixedClock("2026-11-14T10:00:00Z"),
      search: SEARCH,
      reader: new MapReader({}),
      answer: { name: "groq:openai/gpt-oss-120b", model: answer },
    };
    return { d, answer };
  }
  const collect = async (d: AgentDeps, message: string) => {
    const ev = [];
    for await (const e of runTurn(d, { message, conversationId: "conv-spec-0001", tz: "UTC" })) ev.push(e);
    return ev;
  };

  it("sends the configured reasoning effort to the model, and nothing when unset", async () => {
    const on = deps({ ANSWER_REASONING: "low" }, [{ text: "hello" }]);
    await collect(on.d, "hi");
    expect(on.answer.doStreamCalls[0]?.providerOptions).toEqual({ groq: { reasoningEffort: "low" } });

    const off = deps({}, [{ text: "hello" }]);
    await collect(off.d, "hi");
    expect(off.answer.doStreamCalls[0]?.providerOptions).toBeUndefined();
  });

  it("speculative search: evidence is in the first model call, so a fresh question needs one model call", async () => {
    const { d, answer } = deps({ SPECULATIVE_SEARCH: "1" }, [{ text: "Node 26.1 is the latest [1]." }]);
    const ev = await collect(d, "What is the latest Node.js release?");
    const done = ev.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("no done");
    expect(answer.calls()).toBe(1);
    expect(JSON.stringify(answer.doStreamCalls[0]?.prompt)).toMatch(/already fetched/);
    expect(done.trace.searches).toHaveLength(1);
    const final = ev.find((e) => e.type === "final");
    expect(final && "text" in final && final.text).toBe("Node 26.1 is the latest [1].");
    expect(final && "sources" in final && final.sources).toHaveLength(1);
  });

  it("speculative search stays off for timeless questions and when the flag is unset", async () => {
    const timeless = deps({ SPECULATIVE_SEARCH: "1" }, [{ text: "Light is converted to sugar." }]);
    const ev = await collect(timeless.d, "Explain photosynthesis");
    const done = ev.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("no done");
    expect(done.trace.searches).toHaveLength(0);

    const flagOff = deps({}, [{ text: "Stale." }, { toolCall: { name: "web_search", input: { queries: ["node release"], depth: "snippets", recency: "any" } } }, { text: "Fresh [1]." }]);
    const ev2 = await collect(flagOff.d, "What is the latest Node.js release?");
    expect(JSON.stringify(flagOff.answer.doStreamCalls[0]?.prompt)).not.toMatch(/already fetched/);
    expect(ev2.some((e) => e.type === "done")).toBe(true);
  });
});

import { buildHistory } from "../src/agent/run";
import { estimateTokens } from "../src/util/text";

describe("buildHistory (token-budgeted)", () => {
  function chat(turns: number, size: number) {
    const store = new MemoryStore(":memory:");
    const conv = "conv-hist-0001";
    store.createConversation("2026-11-01T00:00:00Z", conv);
    let t = 0;
    const stamp = () => new Date(Date.UTC(2026, 10, 1, 0, 0, t++)).toISOString();
    for (let i = 0; i < turns; i++) {
      store.appendMessage({ conversationId: conv, role: "user", content: `question ${i} ` + "q".repeat(size), createdAt: stamp() });
      store.appendMessage({ conversationId: conv, role: "assistant", content: `answer ${i} ` + "a".repeat(size), createdAt: stamp() });
    }
    const last = store.appendMessage({ conversationId: conv, role: "user", content: "follow-up", createdAt: stamp() });
    return { store, conv, last };
  }

  it("keeps a long chat inside the budget and always keeps the newest exchange", () => {
    const { store, conv, last } = chat(20, 3000);
    const { messages, earlier } = buildHistory(store, conv, last, 1800);
    const tokens = messages.reduce((s, m) => s + estimateTokens(String(m.content)), 0);
    expect(tokens).toBeLessThan(1800 + 1500 + 800); // budget plus the always-kept newest pair
    expect(String(messages.at(-1)!.content)).toMatch(/^answer 19/); // newest answer survives
    expect(messages[0]!.role).toBe("user"); // transcript opens with the user
    expect(messages.length).toBeLessThan(10);
    expect(earlier).toContain("<earlier_in_this_chat>");
  });

  it("keeps a short chat whole, with no summary block", () => {
    const { store, conv, last } = chat(3, 50);
    const { messages, earlier } = buildHistory(store, conv, last, 1800);
    expect(messages).toHaveLength(6);
    expect(earlier).toBe("");
  });
});

import { estimateCost, parsePrices } from "../src/pricing";

describe("cost estimates are opt-in", () => {
  const usage = { inputTokens: 10_000, outputTokens: 1_000, cachedInputTokens: 4_000 };
  it("shows nothing without a configured price", () => {
    expect(estimateCost({}, "groq:openai/gpt-oss-120b", usage)).toBeUndefined();
    expect(parsePrices(undefined)).toEqual({});
    expect(parsePrices("not json")).toEqual({});
  });
  it("prices fresh, cached and output tokens separately (USD per 1M)", () => {
    const prices = parsePrices('{"m":{"in":1,"out":2,"cachedIn":0.5}}');
    // 6,000 fresh * 1 + 4,000 cached * 0.5 + 1,000 out * 2 = 10,000 -> $0.01
    expect(estimateCost(prices, "m", usage)).toBeCloseTo(0.01, 6);
    expect(estimateCost(prices, "other", usage)).toBeUndefined();
  });
  it("ignores malformed entries", () => {
    expect(parsePrices('{"a":{"in":"x","out":1},"b":{"in":1,"out":2}}')).toEqual({ b: { in: 1, out: 2, cachedIn: undefined } });
  });
});
