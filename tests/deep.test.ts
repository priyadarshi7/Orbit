import { describe, expect, it } from "vitest";
import { StaticSearch } from "../src/adapters/fixtures";
import { routeTurn, ruleRoute } from "../src/agent/router";
import { runTurn, type AgentDeps } from "../src/agent/run";
import type { AgentEvent } from "../src/agent/events";
import { loadConfig } from "../src/config";
import { MapReader, scriptedModel, type ScriptStep } from "../src/eval/fakes";
import { MemoryStore } from "../src/memory/store";
import { fixedClock } from "../src/ports";

describe("router rules (fallback)", () => {
  it.each(["hi", "What is the latest version of Node.js?", "Compare React and Vue for a large team"])("sends %s to the fast path", (q) =>
    expect(ruleRoute(q).path).toBe("fast"),
  );
  it.each([
    "Do a deep research on the state of the art in solid-state batteries and who is closest to production",
    "Compare Postgres vs MySQL for analytics? Which is better for a 5 person team? Why?",
  ])("sends %s to the deep path", (q) => expect(ruleRoute(q).path).toBe("deep"));
});

describe("router (model classifier)", () => {
  const q = "Weighing a heat pump against a gas boiler for an old house in Minnesota: what should I think about?";
  const model = (out: string) => scriptedModel([{ text: "" }], { generateText: out });

  it("uses the model's verdict, including for wording the rules would miss", async () => {
    const r = await routeTurn({ model: model(JSON.stringify({ path: "deep", reason: "weighs options on several criteria" })), question: q });
    expect(r).toMatchObject({ path: "deep", by: "model", reason: "weighs options on several criteria" });
    expect(ruleRoute(q).path).toBe("fast");
  });
  it("lets the model send a keyword-heavy question to fast", async () => {
    const r = await routeTurn({ model: model(JSON.stringify({ path: "fast", reason: "one fact" })), question: "Research says what year was the Eiffel Tower finished?" });
    expect(r).toMatchObject({ path: "fast", by: "model" });
  });
  it("falls back to the rules when the model returns garbage", async () => {
    const r = await routeTurn({ model: model("nope"), question: "Do a deep research on solid-state batteries and who is closest to production" });
    expect(r).toMatchObject({ path: "deep", by: "rules" });
  });
  it("skips the model for tiny messages and obeys forced modes", async () => {
    const m = model(JSON.stringify({ path: "deep", reason: "x" }));
    expect((await routeTurn({ model: m, question: "thanks!" })).by).toBe("rules");
    expect(await routeTurn({ model: m, question: "anything at all here", mode: "deep" })).toMatchObject({ path: "deep", by: "user" });
    expect(await routeTurn({ model: m, question: "Research everything in depth about whales", mode: "fast" })).toMatchObject({ path: "fast", by: "user" });
  });
});

describe("deep path", () => {
  const cfg = loadConfig({ DB_PATH: ":memory:", DEEP_CONCURRENCY: "1", TURN_SOFT_DEADLINE_MS: "30000" } as NodeJS.ProcessEnv);
  const SEARCH = new StaticSearch({
    "node release": [{ url: "https://nodejs.org/en/blog", title: "Node.js releases", snippet: "Node 26.1 was released on 10 November 2026 with a new test runner.", publishedDate: "2026-11-10" }],
  });
  const tool: ScriptStep = { toolCall: { name: "web_search", input: { queries: ["node release"], depth: "snippets", recency: "any" } } };
  const PLAN = JSON.stringify({ steps: [{ question: "What is the newest Node.js release?" }, { question: "What changed in the newest Node.js release?" }] });

  function setup(opts: { research: ScriptStep[]; researchGen: string[]; answer: ScriptStep[]; answerGen?: string }) {
    const research = scriptedModel(opts.research, { generateText: opts.researchGen });
    const answer = scriptedModel(opts.answer, { generateText: opts.answerGen });
    const d: AgentDeps = {
      cfg,
      store: new MemoryStore(":memory:"),
      outbox: null,
      clock: fixedClock("2026-11-14T10:00:00Z"),
      search: SEARCH,
      reader: new MapReader({}),
      answer: { name: "scripted-answer", model: answer },
      research: { name: "scripted-research", model: research },
    };
    return { d, research, answer };
  }
  async function run(d: AgentDeps, mode: "deep" | "fast" | "auto" = "deep") {
    const ev: AgentEvent[] = [];
    for await (const e of runTurn(d, { message: "Research the latest Node.js release and what changed", conversationId: "conv-deep-0001", tz: "UTC", mode })) ev.push(e);
    const done = ev.find((e) => e.type === "done");
    const final = ev.find((e) => e.type === "final");
    if (done?.type !== "done" || final?.type !== "final") throw new Error("no done/final: " + JSON.stringify(ev.filter((e) => e.type === "error")));
    return { ev, trace: done.trace, text: final.text, sources: final.sources };
  }

  const researcher: ScriptStep[] = [tool, { text: "- Node 26.1 shipped on 10 November 2026 [1]" }, tool, { text: "- It adds a new test runner [1]" }];

  it("plans, researches in parallel roles, synthesises and verifies", async () => {
    const { d } = setup({
      research: researcher,
      researchGen: [PLAN, JSON.stringify({ unsupported: [] })],
      answer: [{ text: "Node 26.1 is the newest release, shipped 10 November 2026 [1]. It adds a new test runner [1]." }],
    });
    const { ev, trace, text, sources } = await run(d);
    expect(ev.find((e) => e.type === "route")).toMatchObject({ path: "deep" });
    const plan = ev.find((e) => e.type === "plan");
    expect(plan && "steps" in plan && plan.steps).toHaveLength(2);
    expect(ev.filter((e) => e.type === "step" && e.state === "done")).toHaveLength(2);
    expect(trace.path).toBe("deep");
    expect(trace.plan).toHaveLength(2);
    expect(trace.verification).toMatchObject({ checked: 1, unsupported: 0, revised: false });
    expect(text).toMatch(/Node 26\.1/);
    expect(sources.map((s) => s.id)).toEqual([1]);
    expect(trace.timings.map((t) => t.stage)).toEqual(expect.arrayContaining(["plan", "research", "synthesis", "verify"]));
  });

  it("rewrites the answer when the verifier finds an unsupported claim", async () => {
    const { d } = setup({
      research: researcher,
      researchGen: [PLAN, JSON.stringify({ unsupported: [{ claim: "It adds a new test runner", reason: "not in the source" }] })],
      answer: [{ text: "Node 26.1 shipped 10 November 2026 [1]. It adds a new test runner [1]." }],
      answerGen: "Node 26.1 shipped 10 November 2026 [1].",
    });
    const { trace, text } = await run(d);
    expect(text).toBe("Node 26.1 shipped 10 November 2026 [1].");
    expect(trace.verification).toMatchObject({ checked: 1, unsupported: 1, revised: true });
    expect(trace.warnings.join()).toMatch(/verifier removed/);
  });

  it("falls back to the fast path when the planner fails", async () => {
    const { d } = setup({
      research: [{ text: "x" }],
      researchGen: ["not json"],
      answer: [tool, { text: "Node 26.1 is current [1]." }],
    });
    const { trace, text } = await run(d);
    expect(trace.path).toBe("fast");
    expect(trace.warnings.join()).toMatch(/deep research unavailable/);
    expect(text).toBe("Node 26.1 is current [1].");
  });

  it("keeps a verification failure from costing the answer", async () => {
    const { d } = setup({
      research: researcher,
      researchGen: [PLAN, "garbage"],
      answer: [{ text: "Node 26.1 is the newest release [1]." }],
    });
    const { trace, text } = await run(d);
    expect(text).toBe("Node 26.1 is the newest release [1].");
    expect(trace.warnings.join()).toMatch(/verification skipped/);
  });

  it("stays on the fast path when asked", async () => {
    const { d, research } = setup({ research: researcher, researchGen: [PLAN], answer: [tool, { text: "Node 26.1 [1]." }] });
    const { trace } = await run(d, "fast");
    expect(trace.path).toBe("fast");
    expect(research.calls()).toBe(0);
  });
});
