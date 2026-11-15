import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { StaticSearch } from "../src/adapters/fixtures";
import type { AgentDeps } from "../src/agent/run";
import { loadConfig } from "../src/config";
import { MapReader } from "../src/eval/fakes";
import { MemoryStore } from "../src/memory/store";
import { fixedClock } from "../src/ports";
import { buildServer } from "../src/server/build";

const NOW = "2026-11-14T10:00:00Z";
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};
const WORDS = Array.from({ length: 14 }, (_, i) => `word${i} `);
const FULL = WORDS.join("").trim();

/** A model that streams one word every `delay` ms, so a test can drop the connection part-way through. */
const slow = (delay = 30) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: delay,
        chunks: [
          { type: "text-start", id: "t" },
          ...WORDS.map((w) => ({ type: "text-delta" as const, id: "t", delta: w })),
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage },
        ],
      }),
    }),
  });

function setup(env: Record<string, string> = {}, model: MockLanguageModelV4 = slow(), seed?: (s: MemoryStore) => void) {
  const cfg = loadConfig({ DB_PATH: ":memory:", TURN_SOFT_DEADLINE_MS: "30000", RATE_LIMIT_CHAT_PER_MIN: "60", ...env } as NodeJS.ProcessEnv);
  const store = new MemoryStore(":memory:");
  seed?.(store);
  const deps: AgentDeps = {
    cfg,
    store,
    outbox: null,
    clock: fixedClock(NOW),
    search: new StaticSearch({}),
    reader: new MapReader({}),
    answer: { name: "slow", model },
  };
  const app = buildServer({ cfg, deps, outbox: null as never, background: model, close: async () => undefined });
  return { app, store };
}

type App = ReturnType<typeof setup>["app"];
const session = async (app: App) => ((await (await app.request("/api/session", { method: "POST" })).json()) as { token: string }).token;
const h = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, "content-type": "application/json", ...extra });
const chat = (app: App, t: string, body: object, extra: Record<string, string> = {}) =>
  app.request("/api/chat", { method: "POST", headers: h(t, extra), body: JSON.stringify({ mode: "fast", tz: "UTC", ...body }) });
const conv = async (app: App, t: string, id: string) =>
  (await (await app.request(`/api/conversations/${id}`, { headers: h(t) })).json()) as {
    messages: { role: string; content: string; meta: { stopped?: boolean } | null }[];
    run: { id: string; status: string; error: string | null } | null;
  };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Frame {
  id: number;
  event: string;
  data: Record<string, unknown>;
}
function frames(sse: string): Frame[] {
  return sse
    .split("\n\n")
    .map((blk) => {
      const id = blk.match(/^id: (\d+)$/m)?.[1];
      const event = blk.match(/^event: (.+)$/m)?.[1];
      const data = blk.match(/^data: (.+)$/m)?.[1];
      return id !== undefined && event && data ? { id: Number(id), event, data: JSON.parse(data) as Record<string, unknown> } : null;
    })
    .filter((f): f is Frame => f !== null);
}
/** Reads the body until `enough(text)` is true, then drops the connection (the browser going away). */
async function readThenDisconnect(res: Response, enough: (text: string) => boolean): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (!enough(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}
const tokenCount = (text: string) => frames(text).filter((f) => f.event === "token").length;

describe("a dropped connection does not lose the answer", () => {
  it("keeps running on the server and saves the full answer", async () => {
    const { app } = setup();
    const t = await session(app);
    const res = await chat(app, t, { message: "tell me something" });
    const partial = await readThenDisconnect(res, (s) => tokenCount(s) >= 2);
    const start = frames(partial).find((f) => f.event === "start")!.data as { conversationId: string };

    await sleep(700); // long enough for the rest of the answer to be produced with nobody listening
    const c = await conv(app, t, start.conversationId);
    expect(c.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(c.messages[1]!.content).toBe(FULL);
    expect(c.run?.status).toBe("done");
  });

  it("lets the client reconnect and receive exactly what it missed", async () => {
    const { app } = setup();
    const t = await session(app);
    const first = await chat(app, t, { message: "stream me", requestId: "req-resume-0001" });
    const seen = frames(await readThenDisconnect(first, (s) => tokenCount(s) >= 3));
    const lastSeq = seen.at(-1)!.id;

    const resumed = frames(await (await chat(app, t, { message: "stream me", requestId: "req-resume-0001" }, { "last-event-id": String(lastSeq) })).text());
    expect(resumed[0]!.id).toBe(lastSeq + 1); // no gap, no repeat
    expect(resumed.at(-1)!.event).toBe("done");

    const all = [...seen, ...resumed];
    expect(all.map((f) => f.id)).toEqual(all.map((_, i) => i)); // one contiguous sequence
    const streamed = all.filter((f) => f.event === "token").map((f) => f.data.text as string).join("");
    expect(streamed.trim()).toBe(FULL);
  });

  it("reattaches by run id (a page reload) and replays from the start", async () => {
    const { app } = setup();
    const t = await session(app);
    const first = await chat(app, t, { message: "reload me" });
    const runId = first.headers.get("x-run-id")!;
    expect(runId).toBeTruthy();
    await readThenDisconnect(first, (s) => tokenCount(s) >= 1);
    const replay = frames(await (await app.request(`/api/runs/${runId}/events`, { headers: h(t) })).text());
    expect(replay[0]!.event).toBe("start");
    expect(replay.at(-1)!.event).toBe("done");
    expect(replay.find((f) => f.event === "start")!.data.runId).toBe(runId);
  });
});

describe("a repeated request is the same run", () => {
  it("never saves the question twice and does not spend more allowance", async () => {
    const { app } = setup({ RATE_LIMIT_CHAT_PER_MIN: "1" });
    const t = await session(app);
    const a = chat(app, t, { message: "only once please", requestId: "req-dup-000001" });
    const b = chat(app, t, { message: "only once please", requestId: "req-dup-000001" });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200); // the allowance of 1 was spent by the first; the duplicate attaches for free
    const fa = frames(await ra.text());
    const fb = frames(await rb.text());
    expect(fa.at(-1)!.event).toBe("done");
    expect(fb.at(-1)!.event).toBe("done");
    const { conversationId } = fa.find((f) => f.event === "start")!.data as { conversationId: string };
    const c = await conv(app, t, conversationId);
    expect(c.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(c.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});

describe("stop is an explicit cancel", () => {
  it("ends the run as stopped and keeps the partial answer", async () => {
    const { app } = setup();
    const t = await session(app);
    const res = await chat(app, t, { message: "stop me part-way" });
    const runId = res.headers.get("x-run-id")!;
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (tokenCount(text) < 3) text += dec.decode((await reader.read()).value, { stream: true });

    const cancelled = (await (await app.request(`/api/runs/${runId}/cancel`, { method: "POST", headers: h(t) })).json()) as { ok: boolean };
    expect(cancelled.ok).toBe(true);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(frames(text).at(-1)!.event).toBe("done");
    const { conversationId } = frames(text).find((f) => f.event === "start")!.data as { conversationId: string };
    const c = await conv(app, t, conversationId);
    expect(c.run?.status).toBe("stopped");
    expect(c.messages[1]!.meta?.stopped).toBe(true);
    expect(c.messages[1]!.content.length).toBeLessThan(FULL.length);
    // A second cancel on a finished run is a harmless no-op.
    expect(((await (await app.request(`/api/runs/${runId}/cancel`, { method: "POST", headers: h(t) })).json()) as { ok: boolean }).ok).toBe(false);
  });

  it("cannot be cancelled or followed by another user", async () => {
    const { app } = setup();
    const a = await session(app);
    const b = await session(app);
    const res = await chat(app, a, { message: "private run" });
    const runId = res.headers.get("x-run-id")!;
    expect(((await (await app.request(`/api/runs/${runId}/cancel`, { method: "POST", headers: h(b) })).json()) as { ok: boolean }).ok).toBe(false);
    expect((await app.request(`/api/runs/${runId}/events`, { headers: h(b) })).status).toBe(404);
    await readThenDisconnect(res, (s) => tokenCount(s) >= 1);
  });
});

describe("a stuck or crashed turn is visible, not silent", () => {
  it("tells the listener and records a failure when the hard timeout fires", async () => {
    const hung = new MockLanguageModelV4({ doStream: async () => new Promise(() => undefined) });
    const { app } = setup({ TURN_HARD_TIMEOUT_MS: "150" }, hung);
    const t = await session(app);
    const res = await chat(app, t, { message: "this will hang" });
    const sse = frames(await res.text()); // the stream ends because the run was given up on
    expect(sse.at(-1)!.event).toBe("error");
    expect(String(sse.at(-1)!.data.message)).toMatch(/too long/);
    const { conversationId } = sse.find((f) => f.event === "start")!.data as { conversationId: string };
    const c = await conv(app, t, conversationId);
    expect(c.run?.status).toBe("failed");
    expect(c.run?.error).toMatch(/too long/);
  });

  it("marks turns left running by a crash as interrupted, and the conversation says so", async () => {
    const { app, store } = setup({ AUTH_REQUIRED: "0" });
    // What a crashed process leaves behind: a saved question and a run still marked running.
    store.createConversation(NOW, "conv-crash-0001", "Crashed chat");
    const userMsg = store.appendMessage({ conversationId: "conv-crash-0001", role: "user", content: "what happened?", createdAt: NOW });
    store.createRun({ id: "run-crash-0001", requestId: "req-crash-0001", conversationId: "conv-crash-0001", startedAt: NOW });
    store.setRunTarget("run-crash-0001", "conv-crash-0001", userMsg);

    expect(store.interruptRunningRuns("2026-11-14T10:05:00Z")).toBe(1); // what createApp does at startup
    const c = (await (await app.request("/api/conversations/conv-crash-0001")).json()) as { messages: { role: string }[]; run: { status: string; error: string } };
    expect(c.messages.map((m) => m.role)).toEqual(["user"]); // a question with no answer...
    expect(c.run.status).toBe("interrupted"); // ...which the client can now explain and offer to retry
    expect(c.run.error).toMatch(/restarted/);

    // Retrying with the old request id does not pretend the run can be resumed.
    const again = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "what happened?", requestId: "req-crash-0001", mode: "fast" }),
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string; status: string })).toMatchObject({ error: "run_gone", status: "interrupted" });
  });

  it("only reconciles runs that were still running", () => {
    const store = new MemoryStore(":memory:");
    store.createRun({ id: "r1", startedAt: NOW });
    store.createRun({ id: "r2", startedAt: NOW });
    store.finishRun("r2", "done", NOW);
    expect(store.interruptRunningRuns(NOW)).toBe(1);
    expect(store.getRun("r1")?.status).toBe("interrupted");
    expect(store.getRun("r2")?.status).toBe("done");
  });
});
