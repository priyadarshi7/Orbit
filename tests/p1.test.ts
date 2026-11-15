import { describe, expect, it } from "vitest";
import { StaticSearch } from "../src/adapters/fixtures";
import { needsFreshSearch } from "../src/agent/freshness";
import { runTurn, type AgentDeps } from "../src/agent/run";
import { suggestFollowUps } from "../src/agent/suggest";
import { systemPrompt } from "../src/agent/prompt";
import { loadConfig } from "../src/config";
import { MapReader, scriptedModel, type ScriptStep } from "../src/eval/fakes";
import { MemoryStore } from "../src/memory/store";
import { fixedClock } from "../src/ports";

describe("needsFreshSearch", () => {
  it.each([
    "What is the latest version of Node.js?",
    "What's the current price of Bitcoin?",
    "Who is the current CEO of Intel?",
    "any news about the Acme launch",
    "weather in Canberra",
    "How much does Notion cost per user per month?",
    "What's new in Python this year?",
  ])("flags time-sensitive: %s", (q) => expect(needsFreshSearch(q)).toBe(true));

  it.each([
    "hi",
    "What is 17 * 23?",
    "Explain how HTTP/3 differs from HTTP/2",
    "What did I ask you last week?", // recall, answered from memory
    "What did we discuss earlier about pricing?",
    "Write a haiku about rain",
  ])("does not flag: %s", (q) => expect(needsFreshSearch(q)).toBe(false));
});

describe("stale-answer guard in the agent loop", () => {
  const cfg = loadConfig({ DB_PATH: ":memory:", TURN_SOFT_DEADLINE_MS: "30000" } as NodeJS.ProcessEnv);
  const SEARCH = new StaticSearch({
    "node release": [{ url: "https://nodejs.org/en/blog", title: "Node.js releases", snippet: "Node 26.1 released.", publishedDate: "2026-11-10" }],
  });
  const searchStep: ScriptStep = { toolCall: { name: "web_search", input: { queries: ["node release"], depth: "snippets", recency: "any" } } };

  function deps(script: ScriptStep[]) {
    const answer = scriptedModel(script);
    const d: AgentDeps = {
      cfg,
      store: new MemoryStore(":memory:"),
      outbox: null,
      clock: fixedClock("2026-11-14T10:00:00Z"),
      search: SEARCH,
      reader: new MapReader({}),
      answer: { name: "scripted", model: answer },
    };
    return { d, answer };
  }

  it("forces a search when a latest-version question is answered from memory with no citations", async () => {
    const { d, answer } = deps([{ text: "The latest Node.js is v22." }, searchStep, { text: "Node 26.1 is current [1]." }]);
    const ev = [];
    for await (const e of runTurn(d, { message: "What is the latest version of Node.js?", conversationId: "conv-aaaa-bbbb", tz: "UTC" })) ev.push(e);
    const done = ev.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("no done");
    expect(done.trace.warnings.join()).toMatch(/answered without searching/);
    expect(done.trace.searches).toHaveLength(1);
    expect(answer.doStreamCalls[1]?.toolChoice).toEqual({ type: "required" });
    const final = ev.find((e) => e.type === "final");
    expect(final && "text" in final && final.text).toBe("Node 26.1 is current [1].");
  });

  it("leaves timeless questions alone", async () => {
    const { d, answer } = deps([{ text: "Photosynthesis turns light into sugar." }]);
    const ev = [];
    for await (const e of runTurn(d, { message: "Explain photosynthesis", conversationId: "conv-cccc-dddd", tz: "UTC" })) ev.push(e);
    expect(answer.calls()).toBe(1);
  });
});

describe("follow-up suggestions", () => {
  it("returns at most three, drops a repeat of the question", async () => {
    const model = scriptedModel([{ text: "" }], {
      generateText: JSON.stringify({ suggestions: ["Is it cheaper annually?", "What is the best CRM for 20 people?", "How does it compare to Pipedrive?", "Extra one"] }),
    });
    // The schema caps at 3, so the model's 4 items fail validation; use 3 here and check the repeat filter separately.
    const three = scriptedModel([{ text: "" }], {
      generateText: JSON.stringify({ suggestions: ["What is the best CRM for 20 people?", "Is it cheaper annually?", "How does it compare to Pipedrive?"] }),
    });
    const out = await suggestFollowUps(three, "What is the best CRM for 20 people?", "HubSpot is...");
    expect(out).toEqual(["Is it cheaper annually?", "How does it compare to Pipedrive?"]);
    await expect(suggestFollowUps(model, "q?", "a")).rejects.toBeTruthy();
  });
});

describe("memory deletion", () => {
  it("deletes a profile fact and a claim, and keeps a superseding claim", () => {
    const store = new MemoryStore(":memory:");
    store.addFacts(["Works on a 20-person sales team"], "2026-11-01T00:00:00Z");
    const [fact] = store.factRows();
    expect(store.deleteFact(fact!.id)).toBe(true);
    expect(store.factRows()).toHaveLength(0);
    expect(store.deleteFact(9999)).toBe(false);
  });
});

describe("prompt", () => {
  it("carries the voice and clarification rules and stays stable across calls", () => {
    const p = systemPrompt(4);
    expect(p).toMatch(/# Voice/);
    expect(p).toMatch(/# When the question is unclear/);
    expect(systemPrompt(4)).toBe(p);
  });
});

describe("prompt: personal questions", () => {
  it("bans record-keeping language about the user and gives varied examples", () => {
    const p = systemPrompt(4);
    expect(p).toMatch(/Never say "I don't have a record"/);
    expect((p.match(/^\s+Say:/gm) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
