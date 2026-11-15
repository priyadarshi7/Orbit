import { describe, expect, it } from "vitest";
import { StaticSearch } from "../src/adapters/fixtures";
import type { AgentDeps } from "../src/agent/run";
import { loadConfig } from "../src/config";
import { MapReader, scriptedModel } from "../src/eval/fakes";
import { LEGACY_USER, MemoryStore } from "../src/memory/store";
import { fixedClock } from "../src/ports";
import { Sessions } from "../src/server/auth";
import { buildServer } from "../src/server/build";
import { ConcurrencyGate, TokenBucketLimiter } from "../src/server/ratelimit";

const NOW = "2026-11-14T10:00:00Z";

describe("per-user scoping", () => {
  it("keeps conversations, facts, claims and episodes apart", () => {
    const root = new MemoryStore(":memory:");
    const a = root.forUser("u_a");
    const b = root.forUser("u_b");
    a.createConversation(NOW, "conv-a-0001");
    a.addFacts(["Lives in Canberra"], NOW);
    a.recordClaims(null, [{ subject: "Acme", attribute: "Pro price", value: "$29" }], "2026-11-14", NOW);
    const ep = a.addEpisode({ conversationId: "conv-a-0001", turnKey: "t1", localDate: "2026-11-14", createdAt: NOW, summary: "Asked about Acme pricing", keywords: ["acme"] });

    expect(ep).toBeGreaterThan(0);
    expect(b.listConversations()).toEqual([]);
    expect(b.getConversation("conv-a-0001")).toBeNull();
    expect(b.getMessages("conv-a-0001")).toEqual([]);
    expect(b.facts()).toEqual([]);
    expect(b.recentClaims()).toEqual([]);
    expect(b.recentEpisodes()).toEqual([]);
    expect(b.searchEpisodes('"acme"*')).toEqual([]);
    expect(b.episodesOnDates(["2026-11-14"])).toEqual([]);
    expect(a.facts()).toEqual(["Lives in Canberra"]);
  });

  it("cannot delete another user's fact, claim or conversation", () => {
    const root = new MemoryStore(":memory:");
    const a = root.forUser("u_a");
    const b = root.forUser("u_b");
    a.createConversation(NOW, "conv-a-0001");
    a.addFacts(["Lives in Canberra"], NOW);
    const [fact] = a.factRows();
    expect(b.deleteFact(fact!.id)).toBe(false);
    b.deleteConversation("conv-a-0001");
    expect(a.getConversation("conv-a-0001")).not.toBeNull();
    expect(a.facts()).toHaveLength(1);
  });

  it("gives a fresh conversation when the requested id belongs to someone else", () => {
    const root = new MemoryStore(":memory:");
    root.forUser("u_a").createConversation(NOW, "conv-a-0001");
    const id = root.forUser("u_b").createConversation(NOW, "conv-a-0001");
    expect(id).not.toBe("conv-a-0001");
    expect(root.forUser("u_b").getConversation(id)).not.toBeNull();
  });

  it("migrates a database from before accounts and lets one account adopt it", () => {
    const root = new MemoryStore(":memory:");
    root.createConversation(NOW, "conv-old-0001"); // written as the legacy user
    root.addFacts(["Prefers short answers"], NOW);
    expect(root.userId).toBe(LEGACY_USER);
    expect(root.hasLegacyData()).toBe(true);
    root.adoptLegacyData("u_first");
    expect(root.forUser("u_first").facts()).toEqual(["Prefers short answers"]);
    expect(root.forUser("u_first").getConversation("conv-old-0001")).not.toBeNull();
    expect(root.forUser("u_second").facts()).toEqual([]);
    expect(root.hasLegacyData()).toBe(false);
  });
});

describe("profile fact slots", () => {
  it("replaces a fact in the same slot instead of keeping both (the birthday case)", () => {
    const s = new MemoryStore(":memory:");
    s.addFacts([{ slot: "birthday", fact: "Birthday is 14 November" }], NOW);
    s.addFacts([{ slot: "Birthday", fact: "Birthday is 30 April 2005" }], "2026-11-15T10:00:00Z");
    expect(s.facts()).toEqual(["Birthday is 30 April 2005"]);
    expect(s.factRows()[0]).toMatchObject({ fact: "Birthday is 30 April 2005", previous: "Birthday is 14 November" });
  });
  it("is a no-op when the same value is restated, and keeps different slots apart", () => {
    const s = new MemoryStore(":memory:");
    s.addFacts([{ slot: "city", fact: "Lives in Canberra" }, { slot: "job", fact: "Student" }], NOW);
    s.addFacts([{ slot: "city", fact: "lives in canberra" }], NOW);
    expect(s.facts()).toHaveLength(2);
    expect(s.factRows().find((f) => f.fact === "Lives in Canberra")?.previous).toBeNull();
  });
  it("still stores plain strings without a slot", () => {
    const s = new MemoryStore(":memory:");
    s.addFacts(["Works on a 20-person team"], NOW);
    expect(s.facts()).toEqual(["Works on a 20-person team"]);
  });
});

describe("rewind (edit and regenerate)", () => {
  it("removes the message, everything after it, and the memory those turns wrote", () => {
    const s = new MemoryStore(":memory:");
    s.createConversation(NOW, "conv-rw-0001");
    const u1 = s.appendMessage({ conversationId: "conv-rw-0001", role: "user", content: "first", createdAt: NOW });
    const a1 = s.appendMessage({ conversationId: "conv-rw-0001", role: "assistant", content: "one", createdAt: NOW });
    const u2 = s.appendMessage({ conversationId: "conv-rw-0001", role: "user", content: "second", createdAt: NOW });
    const a2 = s.appendMessage({ conversationId: "conv-rw-0001", role: "assistant", content: "two", createdAt: NOW });
    const ep1 = s.addEpisode({ conversationId: "conv-rw-0001", turnKey: a1, localDate: "2026-11-14", createdAt: NOW, summary: "first turn", keywords: [] });
    const ep2 = s.addEpisode({ conversationId: "conv-rw-0001", turnKey: a2, localDate: "2026-11-14", createdAt: NOW, summary: "second turn about zebras", keywords: ["zebras"] });
    s.recordClaims(ep2, [{ subject: "Zebra", attribute: "Speed", value: "65 km/h" }], "2026-11-14", NOW);

    expect(s.rewindFrom("conv-rw-0001", u2)).toBe(2);
    expect(s.getMessages("conv-rw-0001").map((m) => m.id)).toEqual([u1, a1]);
    expect(s.episodesForConversation("conv-rw-0001").map((e) => e.id)).toEqual([ep1]);
    expect(s.recentClaims()).toEqual([]);
    expect(s.searchEpisodes('"zebras"*')).toEqual([]);
    expect(s.hasMessage(a2)).toBe(false);
  });
  it("refuses another user's conversation", () => {
    const root = new MemoryStore(":memory:");
    const a = root.forUser("u_a");
    a.createConversation(NOW, "conv-rw-0002");
    const m = a.appendMessage({ conversationId: "conv-rw-0002", role: "user", content: "hi", createdAt: NOW });
    expect(root.forUser("u_b").rewindFrom("conv-rw-0002", m)).toBe(0);
    expect(a.getMessages("conv-rw-0002")).toHaveLength(1);
  });
});

describe("sessions", () => {
  it("accepts its own tokens and rejects forged or altered ones", () => {
    const s = new Sessions("secret-one");
    const { userId, token } = s.create();
    expect(s.verify(token)).toBe(userId);
    expect(s.verify(token + "x")).toBeNull();
    expect(s.verify(token.replace(userId, "u_someoneelse"))).toBeNull();
    expect(new Sessions("secret-two").verify(token)).toBeNull();
    expect(s.verify("")).toBeNull();
    expect(s.verify("garbage")).toBeNull();
  });
  it("keeps a generated secret in the database so tokens survive a restart", () => {
    const store = new MemoryStore(":memory:");
    const { token, userId } = Sessions.open(store).create();
    expect(Sessions.open(store).verify(token)).toBe(userId);
  });
});

describe("rate limiting", () => {
  it("allows a burst, then refuses, then recovers as time passes", () => {
    let t = 0;
    const l = new TokenBucketLimiter(() => t);
    for (let i = 0; i < 3; i++) expect(l.take("k", 3).ok).toBe(true);
    const r = l.take("k", 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(l.take("other", 3).ok).toBe(true); // separate allowance per key
    t += 21_000; // one token refills every 20 s at 3/min
    expect(l.take("k", 3).ok).toBe(true);
    expect(l.take("k", 3).ok).toBe(false);
  });
  it("caps concurrent turns per user and frees the slot on release", () => {
    const g = new ConcurrencyGate();
    const r1 = g.acquire("u", 2);
    const r2 = g.acquire("u", 2);
    expect(g.acquire("u", 2)).toBeNull();
    expect(g.acquire("v", 2)).not.toBeNull();
    r1!();
    r1!(); // releasing twice must not free two slots
    expect(g.acquire("u", 2)).not.toBeNull();
    expect(g.acquire("u", 2)).toBeNull();
    r2!();
  });
});

describe("HTTP API", () => {
  function server(env: Record<string, string> = {}, seed?: (s: MemoryStore) => void) {
    const cfg = loadConfig({ DB_PATH: ":memory:", TURN_SOFT_DEADLINE_MS: "30000", ...env } as NodeJS.ProcessEnv);
    const store = new MemoryStore(":memory:");
    seed?.(store);
    const model = scriptedModel([{ text: "Hello there." }]);
    const deps: AgentDeps = {
      cfg,
      store,
      outbox: null,
      clock: fixedClock(NOW),
      search: new StaticSearch({}),
      reader: new MapReader({}),
      answer: { name: "scripted", model },
    };
    const app = { cfg, deps, outbox: null as never, background: model, close: async () => undefined };
    return { app: buildServer(app), store };
  }
  const session = async (s: ReturnType<typeof server>) => (await (await s.app.request("/api/session", { method: "POST" })).json()) as { token: string; userId: string };
  const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const chat = (s: ReturnType<typeof server>, token: string, body: object) =>
    s.app.request("/api/chat", { method: "POST", headers: auth(token), body: JSON.stringify({ mode: "fast", tz: "UTC", ...body }) });
  const startOf = (sse: string) => JSON.parse(sse.match(/event: start\ndata: (.*)/)![1]!) as { conversationId: string; userMessageId: string };

  it("serves health and benchmarks without a session, everything else needs one", async () => {
    const s = server();
    expect((await s.app.request("/api/health")).status).toBe(200);
    expect((await s.app.request("/api/benchmarks")).status).toBe(200);
    expect((await s.app.request("/api/conversations")).status).toBe(401);
    expect((await s.app.request("/api/memory")).status).toBe(401);
    expect((await s.app.request("/api/chat", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await s.app.request("/api/conversations", { headers: auth("u_x.forged") })).status).toBe(401);
  });

  it("isolates two users: lists, reads, writes into a stolen conversation id, memory", async () => {
    const s = server();
    const a = await session(s);
    const b = await session(s);
    const res = await chat(s, a.token, { message: "hello from A" });
    expect(res.status).toBe(200);
    const sse = await res.text();
    const { conversationId } = startOf(sse);

    const list = (await (await s.app.request("/api/conversations", { headers: auth(a.token) })).json()) as unknown[];
    expect(list).toHaveLength(1);
    expect(((await (await s.app.request("/api/conversations", { headers: auth(b.token) })).json()) as unknown[]).length).toBe(0);
    expect((await s.app.request(`/api/conversations/${conversationId}`, { headers: auth(b.token) })).status).toBe(404);

    // B names A's conversation id: it must not be written into.
    const stolen = startOf(await (await chat(s, b.token, { message: "hello from B", conversationId })).text());
    expect(stolen.conversationId).not.toBe(conversationId);
    const aConv = (await (await s.app.request(`/api/conversations/${conversationId}`, { headers: auth(a.token) })).json()) as { messages: { content: string }[] };
    expect(aConv.messages.map((m) => m.content)).not.toContain("hello from B");

    // B cannot rewind or delete A's conversation either.
    const rw = await s.app.request(`/api/conversations/${conversationId}/rewind`, {
      method: "POST",
      headers: auth(b.token),
      body: JSON.stringify({ fromMessageId: startOf(sse).userMessageId }),
    });
    expect(((await rw.json()) as { removed: number }).removed).toBe(0);
    await s.app.request(`/api/conversations/${conversationId}`, { method: "DELETE", headers: auth(b.token) });
    expect((await s.app.request(`/api/conversations/${conversationId}`, { headers: auth(a.token) })).status).toBe(200);
  });

  it("rewinds from an edited message so the old attempt is gone from history", async () => {
    const s = server();
    const a = await session(s);
    const first = startOf(await (await chat(s, a.token, { message: "first question" })).text());
    const second = startOf(await (await chat(s, a.token, { message: "second question", conversationId: first.conversationId })).text());
    await s.app.request(`/api/conversations/${first.conversationId}/rewind`, {
      method: "POST",
      headers: auth(a.token),
      body: JSON.stringify({ fromMessageId: second.userMessageId }),
    });
    const conv = (await (await s.app.request(`/api/conversations/${first.conversationId}`, { headers: auth(a.token) })).json()) as { messages: { content: string }[] };
    expect(conv.messages.map((m) => m.content)).toEqual(["first question", "Hello there."]);
  });

  it("returns 429 with Retry-After once the chat allowance is spent", async () => {
    const s = server({ RATE_LIMIT_CHAT_PER_MIN: "2" });
    const a = await session(s);
    expect((await chat(s, a.token, { message: "one" })).status).toBe(200);
    expect((await chat(s, a.token, { message: "two" })).status).toBe(200);
    const third = await chat(s, a.token, { message: "three" });
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await third.json()) as { error: string }).error).toBe("rate_limited");
    // Another user is not affected.
    const b = await session(s);
    expect((await chat(s, b.token, { message: "hi" })).status).toBe(200);
  });

  it("limits how many sessions one address can mint", async () => {
    const s = server({ RATE_LIMIT_SESSION_PER_MIN: "3" });
    for (let i = 0; i < 3; i++) expect((await s.app.request("/api/session", { method: "POST" })).status).toBe(200);
    expect((await s.app.request("/api/session", { method: "POST" })).status).toBe(429);
  });

  it("hands data from before accounts to the first account only", async () => {
    const s = server({}, (store) => {
      store.createConversation(NOW, "conv-old-0001", "Old chat");
      store.addFacts(["Prefers short answers"], NOW);
    });
    const first = await session(s);
    const second = await session(s);
    const mem = async (t: string) => (await (await s.app.request("/api/memory", { headers: auth(t) })).json()) as { profile: { fact: string }[] };
    expect((await mem(first.token)).profile.map((f) => f.fact)).toEqual(["Prefers short answers"]);
    expect((await mem(second.token)).profile).toEqual([]);
  });

  it("single-user mode (AUTH_REQUIRED=0) needs no token", async () => {
    const s = server({ AUTH_REQUIRED: "0" });
    expect((await s.app.request("/api/conversations")).status).toBe(200);
    const sess = (await (await s.app.request("/api/session", { method: "POST" })).json()) as { authRequired: boolean };
    expect(sess.authRequired).toBe(false);
  });
});

describe("slot vocabulary stays consistent without a fixed list", () => {
  it("shows the extractor this user's existing slots, and nobody else's", async () => {
    const { makeTurnHandler } = await import("../src/memory/writer");
    const root = new MemoryStore(":memory:");
    root.forUser("u_a").addFacts([{ slot: "date of birth", fact: "Born 30 April 2005" }], NOW);
    root.forUser("u_b").addFacts([{ slot: "secret hobby", fact: "Collects stamps" }], NOW);
    const conv = root.forUser("u_a").createConversation(NOW, "conv-slot-0001");
    const turnKey = root.forUser("u_a").appendMessage({ conversationId: conv, role: "assistant", content: "ok", createdAt: NOW });
    const model = scriptedModel([{ text: "" }], {
      generateText: JSON.stringify({ summary: "s", keywords: [], profileFacts: [{ slot: "date of birth", fact: "Born 1 May 2005" }], claims: [] }),
    });
    await makeTurnHandler(root, model)({
      conversationId: conv, turnKey, userMessage: "Actually I was born 1 May 2005", answer: "Noted.", sources: [], createdAt: NOW, tz: "UTC", userId: "u_a",
    });
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain("date of birth");
    expect(prompt).not.toContain("secret hobby");
    // Reusing the slot name replaced the old value instead of adding a second fact.
    expect(root.forUser("u_a").facts()).toEqual(["Born 1 May 2005"]);
  });
});
