import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { StaticSearch } from "../src/adapters/fixtures";
import type { Checkpoint } from "../src/agent/checkpoint";
import type { AgentEvent } from "../src/agent/events";
import { runTurn, type AgentDeps } from "../src/agent/run";
import { loadConfig } from "../src/config";
import { MapReader, scriptedModel, type ScriptStep } from "../src/eval/fakes";
import { MemoryStore } from "../src/memory/store";
import { fixedClock } from "../src/ports";
import { EvidenceRegistry } from "../src/retrieval/evidence";
import { buildServer } from "../src/server/build";

const NOW = "2026-11-14T10:00:00.000Z"; // same format the server writes, so message order by time is unambiguous
const cfg = loadConfig({ DB_PATH: ":memory:", DEEP_CONCURRENCY: "1", TURN_SOFT_DEADLINE_MS: "30000", RATE_LIMIT_CHAT_PER_MIN: "60" } as NodeJS.ProcessEnv);
const SEARCH = new StaticSearch({
  "node release": [{ url: "https://nodejs.org/en/blog", title: "Node.js releases", snippet: "Node 26.1 was released on 10 November 2026 with a new test runner.", publishedDate: "2026-11-10" }],
});
const tool: ScriptStep = { toolCall: { name: "web_search", input: { queries: ["node release"], depth: "snippets", recency: "any" } } };

describe("EvidenceRegistry snapshot and restore", () => {
  it("keeps every source's number so earlier citations stay valid", () => {
    const a = new EvidenceRegistry();
    a.register("https://one.example/a", "One", "2026-11-01");
    a.register("https://two.example/b", "Two");
    a.addExcerpt(2, "two says something");
    const b = new EvidenceRegistry();
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.get(1)?.title).toBe("One");
    expect(b.get(2)?.url).toBe("https://two.example/b");
    expect(b.excerpt(2)).toBe("two says something");
    // A page seen before keeps its number; a new page gets the next one.
    expect(b.register("https://two.example/b", "Two").source.id).toBe(2);
    expect(b.register("https://three.example/c", "Three").source.id).toBe(3);
  });
});

describe("runs keep checkpoints", () => {
  it("saves, reads back, and clears a checkpoint when the run finishes cleanly", () => {
    const s = new MemoryStore(":memory:");
    s.createRun({ id: "r1", startedAt: NOW });
    s.saveCheckpoint("r1", JSON.stringify({ v: 1, plan: [] }));
    expect(JSON.parse(s.getCheckpoint("r1")!)).toMatchObject({ v: 1 });
    s.finishRun("r1", "done", NOW);
    expect(s.getCheckpoint("r1")).toBeNull();

    s.createRun({ id: "r2", startedAt: NOW });
    s.saveCheckpoint("r2", JSON.stringify({ v: 1 }));
    s.interruptRunningRuns(NOW);
    expect(s.getCheckpoint("r2")).not.toBeNull(); // an interrupted run keeps its progress
  });
});

function deps(over: { answer: MockLanguageModelV4; research?: MockLanguageModelV4 }): AgentDeps {
  return {
    cfg,
    store: new MemoryStore(":memory:"),
    outbox: null,
    clock: fixedClock(NOW),
    search: SEARCH,
    reader: new MapReader({}),
    answer: { name: "scripted-answer", model: over.answer },
    research: over.research ? { name: "scripted-research", model: over.research } : undefined,
  };
}
async function collect(d: AgentDeps, req: Parameters<typeof runTurn>[1]) {
  const ev: AgentEvent[] = [];
  for await (const e of runTurn(d, req)) ev.push(e);
  return ev;
}
const last = <T extends AgentEvent["type"]>(ev: AgentEvent[], type: T) => ev.filter((e) => e.type === type).at(-1) as Extract<AgentEvent, { type: T }> | undefined;

describe("fast path resume", () => {
  it("answers from the evidence already gathered, without a second question or a new search", async () => {
    const answer = scriptedModel([{ text: "Node 26.1 shipped on 10 November 2026 [1]." }]);
    const d = deps({ answer });
    const convId = d.store.createConversation(NOW, "conv-resume-fast");
    const userMsg = d.store.appendMessage({ conversationId: convId, role: "user", content: "What is the latest Node release?", createdAt: NOW });
    const saved: Checkpoint = {
      v: 1,
      route: { path: "fast", reason: "one focused question" },
      sources: [{ id: 1, url: "https://nodejs.org/en/blog", title: "Node.js releases", domain: "nodejs.org", publishedDate: "2026-11-10", excerpt: "Node 26.1 was released on 10 November 2026" }],
      evidence: ["<evidence>\n[1] Node.js releases, nodejs.org (published 2026-11-10)\n• Node 26.1 was released on 10 November 2026\n</evidence>"],
    };
    const writes: Partial<Checkpoint>[] = [];
    const ev = await collect(d, {
      message: "What is the latest Node release?",
      conversationId: convId,
      resume: { conversationId: convId, userMessageId: userMsg },
      checkpoint: { resume: saved, save: (p) => writes.push(p) },
    });

    expect(last(ev, "start")).toMatchObject({ resumed: true, conversationId: convId, userMessageId: userMsg });
    // Nothing was added after the question except the answer.
    expect(d.store.getMessages(convId).map((m) => m.role)).toEqual(["user", "assistant"]);
    // The model was handed the saved evidence, and its citation resolves against the restored source number.
    expect(JSON.stringify(answer.doStreamCalls[0]!.prompt)).toContain("Node 26.1 was released on 10 November 2026");
    const fin = last(ev, "final")!;
    expect(fin.text).toMatch(/\[1\]/);
    expect(fin.sources.map((s) => s.id)).toEqual([1]);
    const done = last(ev, "done")!;
    expect(done.trace.warnings.join()).toMatch(/resumed after an interruption: reused 1 sources/);
    expect(done.trace.path).toBe("fast");
    expect(answer.calls()).toBe(1);
  });

  it("refuses to resume when the conversation has moved on", async () => {
    const d = deps({ answer: scriptedModel([{ text: "x" }]) });
    const convId = d.store.createConversation(NOW, "conv-resume-moved");
    const userMsg = d.store.appendMessage({ conversationId: convId, role: "user", content: "old question", createdAt: NOW });
    d.store.appendMessage({ conversationId: convId, role: "assistant", content: "an answer", createdAt: NOW });
    const ev = await collect(d, { message: "old question", resume: { conversationId: convId, userMessageId: userMsg } });
    expect(last(ev, "error")?.message).toMatch(/moved on/);
    expect(d.store.getMessages(convId)).toHaveLength(2);
  });

  it("saves a checkpoint after each search round while running", async () => {
    const answer = scriptedModel([tool, { text: "Node 26.1 is current [1]." }]);
    const d = deps({ answer });
    const saves: Partial<Checkpoint>[] = [];
    await collect(d, { message: "What is the latest Node release?", mode: "fast", checkpoint: { save: (p) => saves.push(p) } });
    expect(saves.some((p) => p.route?.path === "fast")).toBe(true);
    const withEvidence = saves.find((p) => p.evidence?.length);
    expect(withEvidence?.sources?.[0]?.url).toBe("https://nodejs.org/en/blog");
    expect(withEvidence?.evidence?.[0]).toContain("Node 26.1");
  });
});

describe("deep path resume", () => {
  const PLAN = [
    { id: 1, question: "What is the newest Node.js release?" },
    { id: 2, question: "What changed in the newest Node.js release?" },
    { id: 3, question: "When was the newest Node.js release published?" },
  ];

  it("skips the planner and the researchers that already finished, and runs only the rest", async () => {
    const research = scriptedModel([tool, { text: "- Published 10 November 2026 [3]" }], { generateText: JSON.stringify({ unsupported: [] }) });
    const answer = scriptedModel([{ text: "Node 26.1 is newest [1], it adds a test runner [2], published 10 November 2026 [3]." }]);
    const d = deps({ answer, research });
    const convId = d.store.createConversation(NOW, "conv-resume-deep");
    const userMsg = d.store.appendMessage({ conversationId: convId, role: "user", content: "Research the latest Node release in depth", createdAt: NOW });
    const saved: Checkpoint = {
      v: 1,
      route: { path: "deep", reason: "asks for research" },
      plan: PLAN,
      notes: { "1": "- Newest is 26.1 [1]", "2": "- Adds a new test runner [2]" },
      sources: [
        { id: 1, url: "https://one.example/a", title: "One", domain: "one.example", excerpt: "Newest is 26.1" },
        { id: 2, url: "https://two.example/b", title: "Two", domain: "two.example", excerpt: "Adds a new test runner" },
      ],
    };
    const writes: Partial<Checkpoint>[] = [];
    const ev = await collect(d, {
      message: "Research the latest Node release in depth",
      conversationId: convId,
      resume: { conversationId: convId, userMessageId: userMsg },
      checkpoint: { resume: saved, save: (p) => writes.push(p) },
    });

    expect(last(ev, "plan")?.steps).toEqual(PLAN); // reused, not regenerated
    const stepDone = ev.filter((e) => e.type === "step" && e.state === "done").map((e) => (e as { id: number }).id);
    expect(stepDone).toEqual(expect.arrayContaining([1, 2, 3]));
    // One researcher ran (tool call + answer = 2 stream calls) instead of three; the planner never ran;
    // the only generate call was the verifier.
    expect(research.calls()).toBe(2);
    expect(research.doGenerateCalls).toHaveLength(1);

    const fin = last(ev, "final")!;
    expect(fin.sources.map((s) => s.id)).toEqual([1, 2, 3]); // restored numbers kept, the new source got the next one
    expect(fin.sources[2]!.url).toBe("https://nodejs.org/en/blog");
    expect(d.store.getMessages(convId).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(writes.at(-1)?.notes).toMatchObject({ "1": expect.any(String), "2": expect.any(String), "3": expect.stringContaining("10 November") });
    expect(last(ev, "done")!.trace.path).toBe("deep");
  });

  it("saves the plan and each researcher's notes as they finish", async () => {
    const research = scriptedModel([tool, { text: "- a fact [1]" }, tool, { text: "- another fact [1]" }], {
      generateText: [JSON.stringify({ steps: [{ question: "What is the newest Node release?" }, { question: "What changed in the newest release?" }] }), JSON.stringify({ unsupported: [] })],
    });
    const answer = scriptedModel([{ text: "Node 26.1 [1]." }]);
    const saves: Partial<Checkpoint>[] = [];
    await collect(deps({ answer, research }), { message: "Research Node", mode: "deep", checkpoint: { save: (p) => saves.push(p) } });
    expect(saves.find((p) => p.plan)?.plan).toHaveLength(2);
    const lastNotes = [...saves].reverse().find((p) => p.notes)?.notes ?? {};
    expect(Object.keys(lastNotes).sort()).toEqual(["1", "2"]);
  });
});

describe("crash and resume through the server", () => {
  const usable = (answer: MockLanguageModelV4, research: MockLanguageModelV4, store: MemoryStore) => {
    const d: AgentDeps = {
      cfg,
      store,
      outbox: null,
      clock: fixedClock(NOW),
      search: SEARCH,
      reader: new MapReader({}),
      answer: { name: "answer", model: answer },
      research: { name: "research", model: research },
    };
    return buildServer({ cfg, deps: d, outbox: null as never, background: research, close: async () => undefined });
  };
  const h = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
  const PLAN_JSON = JSON.stringify({ steps: [{ question: "What is the newest Node release?" }, { question: "What changed in the newest release?" }, { question: "When was it published?" }] });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a process that dies during synthesis resumes in a new process without redoing the plan or the research", async () => {
    const store = new MemoryStore(":memory:");

    // Process 1: the plan and all three researchers finish, then the writer never answers (the process "dies").
    const research1 = scriptedModel([tool, { text: "- fact one [1]" }, tool, { text: "- fact two [1]" }, tool, { text: "- fact three [1]" }], { generateText: PLAN_JSON });
    const hung = new MockLanguageModelV4({ doStream: async () => new Promise(() => undefined) });
    const app1 = usable(hung, research1, store);
    const token = ((await (await app1.request("/api/session", { method: "POST" })).json()) as { token: string }).token;
    const first = await app1.request("/api/chat", {
      method: "POST",
      headers: h(token),
      body: JSON.stringify({ message: "Research the latest Node release in depth", mode: "deep", tz: "UTC", requestId: "req-crash-resume-1" }),
    });
    const runId = first.headers.get("x-run-id")!;
    for (let i = 0; i < 100; i++) {
      const any = (store.db.prepare("SELECT checkpoint FROM runs WHERE id = ?").get(runId) as { checkpoint: string | null }).checkpoint;
      if (any && Object.keys((JSON.parse(any) as Checkpoint).notes ?? {}).length === 3) break;
      await sleep(20);
    }
    const before = JSON.parse((store.db.prepare("SELECT checkpoint FROM runs WHERE id = ?").get(runId) as { checkpoint: string }).checkpoint) as Checkpoint;
    expect(Object.keys(before.notes ?? {})).toHaveLength(3);
    expect(before.plan).toHaveLength(3);
    void first.body?.cancel().catch(() => undefined);

    // "Restart": a new process on the same database sweeps the run it finds still running.
    expect(store.interruptRunningRuns("2026-11-14T10:05:00Z")).toBe(1);
    const research2 = scriptedModel([{ text: "unused" }], { generateText: JSON.stringify({ unsupported: [] }) });
    const answer2 = scriptedModel([{ text: "Node 26.1 is newest [1], and it is documented [1]." }]);
    const app2 = usable(answer2, research2, store);

    const conv = async (id: string) =>
      (await (await app2.request(`/api/conversations/${id}`, { headers: h(token) })).json()) as { messages: { role: string }[]; run: { id: string; status: string; resumable: boolean } };
    const convId = (store.db.prepare("SELECT conversation_id AS c FROM runs WHERE id = ?").get(runId) as { c: string }).c;
    const interrupted = await conv(convId);
    expect(interrupted.run).toMatchObject({ id: runId, status: "interrupted", resumable: true });
    expect(interrupted.messages.map((m) => m.role)).toEqual(["user"]);

    // Resume.
    const res = await app2.request(`/api/runs/${runId}/resume`, { method: "POST", headers: h(token), body: JSON.stringify({ tz: "UTC" }) });
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).toContain("event: done");
    expect(sse).not.toContain("event: error");
    expect(sse).toMatch(/"resumed":true/);
    expect(research2.calls()).toBe(0); // no researcher ran again
    expect(research2.doGenerateCalls).toHaveLength(1); // only the verifier; the planner was not asked again
    expect((sse.match(/"type":"step","id":\d,"state":"done"/g) ?? []).length).toBe(3);

    const after = await conv(convId);
    expect(after.messages.map((m) => m.role)).toEqual(["user", "assistant"]); // one question, one answer
    expect(after.run).toMatchObject({ status: "done", resumable: false });

    // Resuming again attaches to the same run instead of starting a third.
    const again = await app2.request(`/api/runs/${runId}/resume`, { method: "POST", headers: h(token), body: JSON.stringify({}) });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("event: done");
    expect((await conv(convId)).messages).toHaveLength(2);
  });

  it("will not resume an answer that has finished, a conversation that moved on, or someone else's run", async () => {
    const store = new MemoryStore(":memory:");
    const app = usable(scriptedModel([{ text: "ok" }]), scriptedModel([{ text: "x" }]), store);
    const a = ((await (await app.request("/api/session", { method: "POST" })).json()) as { token: string }).token;
    const b = ((await (await app.request("/api/session", { method: "POST" })).json()) as { token: string }).token;
    const res = await app.request("/api/chat", { method: "POST", headers: h(a), body: JSON.stringify({ message: "a quick one", mode: "fast", tz: "UTC" }) });
    const runId = res.headers.get("x-run-id")!;
    await res.text();
    const done = await app.request(`/api/runs/${runId}/resume`, { method: "POST", headers: h(a), body: "{}" });
    expect(done.status).toBe(409);
    expect(((await done.json()) as { error: string }).error).toBe("not_resumable");
    expect((await app.request(`/api/runs/${runId}/resume`, { method: "POST", headers: h(b), body: "{}" })).status).toBe(404);
  });
});
