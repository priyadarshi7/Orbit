import { describe, expect, it } from "vitest";
import { assembleMemory, resolveDates } from "../src/memory/assemble";
import { OutboxWorker } from "../src/memory/outbox";
import { seed } from "../src/memory/seed";
import { MemoryStore, toFtsQuery } from "../src/memory/store";
import { applyExtraction, applyFallbackEpisode, type TurnJobPayload } from "../src/memory/writer";

// Saturday 14 Nov 2026, 10:00 UTC.
const NOW = new Date("2026-11-14T10:00:00Z");

describe("resolveDates", () => {
  it("resolves relative weekdays and explicit dates to past calendar days", () => {
    expect(resolveDates("what did I ask you last Tuesday?", NOW, "UTC")).toEqual(["2026-11-10"]);
    expect(resolveDates("What did I ask you on 3 November?", NOW, "UTC")).toEqual(["2026-11-03"]);
    expect(resolveDates("On Monday we shortlisted 5 tools", NOW, "UTC")).toEqual(["2026-11-09"]);
  });

  it("ignores future and same-day references", () => {
    expect(resolveDates("what is the weather tomorrow", NOW, "UTC")).toEqual([]);
    expect(resolveDates("what happened today", NOW, "UTC")).toEqual([]);
  });

  it("treats a year-less date later in the year as last year's", () => {
    expect(resolveDates("what did I ask on 20 December?", NOW, "UTC")).toEqual(["2025-12-20"]);
  });

  it("respects the user's timezone for 'yesterday'", () => {
    // 23:30 UTC on the 13th is already the 14th in Kolkata (UTC+5:30).
    const late = new Date("2026-11-13T23:30:00Z");
    expect(resolveDates("what did we discuss yesterday", late, "Asia/Kolkata")).toEqual(["2026-11-13"]);
    expect(resolveDates("what did we discuss yesterday", late, "UTC")).toEqual(["2026-11-12"]);
  });
});

describe("claims", () => {
  it("links a changed value to the claim it supersedes and re-confirms an unchanged one", () => {
    const s = new MemoryStore(":memory:");
    s.recordClaims(null, [{ subject: "Acme", attribute: "Pro price", value: "$20/mo" }], "2026-11-01", "2026-11-01T00:00:00Z");
    expect(s.recordClaims(null, [{ subject: "ACME", attribute: "pro price", value: "$20/mo" }], "2026-11-05", "2026-11-05T00:00:00Z")).toBe(0);
    expect(s.recordClaims(null, [{ subject: "Acme", attribute: "Pro price", value: "$25/mo" }], "2026-11-09", "2026-11-09T00:00:00Z")).toBe(1);
    const all = s.recentClaims(10).reverse();
    expect(all).toHaveLength(2);
    expect(all[1]!.supersedesId).toBe(all[0]!.id);
    expect(all[0]!.confirmedAt).toBe("2026-11-05T00:00:00Z");
  });
});

describe("assembleMemory", () => {
  const tz = "UTC";

  it("injects stored records and claims for a referenced date", () => {
    const s = new MemoryStore(":memory:");
    seed(s, tz, NOW); // CRM chat 6 days ago = 2026-11-08, Postgres chat 11 days ago = 2026-11-03
    const m = assembleMemory(s, { message: "What did I ask you on 3 November? Is it still correct?", conversationId: "c", now: NOW, tz });
    expect(m.stats.hadRecord).toBe(true);
    expect(m.text).toContain("Postgres");
    expect(m.text).toContain("Neon");
    expect(m.referencedDates).toEqual(["2026-11-03"]);
  });

  it("says NO RECORD, with nearest dates, when the day has no chat", () => {
    const s = new MemoryStore(":memory:");
    seed(s, tz, NOW);
    const m = assembleMemory(s, { message: "What did I ask you on 5 November?", conversationId: "c", now: NOW, tz });
    expect(m.stats.hadRecord).toBe(false);
    expect(m.text).toContain("NO RECORD");
    expect(m.text).toContain("2026-11-03");
  });

  it("stays quiet on an unrelated question (no recall noise)", () => {
    const s = new MemoryStore(":memory:");
    seed(s, tz, NOW);
    const m = assembleMemory(s, { message: "How do I reverse a linked list in Rust?", conversationId: "c", now: NOW, tz });
    expect(m.stats.hadRecord).toBeNull();
    expect(m.stats.episodes).toBe(0);
    // No recalled records or claims are injected; only the always-on profile + one-line timeline remain.
    expect(m.text).not.toContain("Stored records");
    expect(m.text).not.toContain("Claims recorded");
    expect(m.text).not.toContain("NO RECORD");
  });

  it("does not treat a date in a statement as a recall request (birth date, deadline…)", () => {
    const s = new MemoryStore(":memory:");
    seed(s, tz, NOW);
    const m = assembleMemory(s, {
      message: "Hello I am Sam. I was born on 30th April 2005. I want the latest news about NVIDIA.",
      conversationId: "c",
      now: NOW,
      tz,
    });
    expect(m.stats.hadRecord).toBeNull();
    expect(m.referencedDates).toEqual([]);
    expect(m.text).not.toContain("NO RECORD");
  });

  it("still recalls by date for natural phrasings", () => {
    const s = new MemoryStore(":memory:");
    seed(s, tz, NOW);
    for (const q of ["What did we discuss on 3 November?", "Remind me what we talked about on 3 November", "On 3 November, what did I ask you?"]) {
      expect(assembleMemory(s, { message: q, conversationId: "c", now: NOW, tz }).stats.hadRecord, q).toBe(true);
    }
  });

  it("finds a past topic by keyword when the user refers back", () => {
    const s = new MemoryStore(":memory:");
    seed(s, tz, NOW);
    const m = assembleMemory(s, { message: "Has anything changed since we looked at CRM pricing?", conversationId: "c", now: NOW, tz });
    expect(m.text).toContain("HubSpot");
  });

  it("is idempotent to seed twice", () => {
    const s = new MemoryStore(":memory:");
    expect(seed(s, tz, NOW)).toBe(2);
    expect(seed(s, tz, NOW)).toBe(0);
  });
});

describe("toFtsQuery", () => {
  it("never produces syntax the FTS parser would reject", () => {
    const q = toFtsQuery(['"drop', "table;", "a", "c++"]);
    expect(q).not.toMatch(/[;+]/);
    const s = new MemoryStore(":memory:");
    expect(() => s.searchEpisodes(q!)).not.toThrow();
  });
});

describe("writer", () => {
  const payload = (over: Partial<TurnJobPayload> = {}): TurnJobPayload => ({
    conversationId: "c1",
    turnKey: "t1",
    userMessage: "I run a 5-person startup. What does Acme cost?",
    answer: "Acme Pro costs $29/mo [1].",
    sources: [{ url: "https://acme.com/pricing", title: "Acme" }],
    createdAt: "2026-11-14T10:00:00Z",
    tz: "UTC",
    ...over,
  });

  it("stores an episode, profile facts and claims, idempotently", () => {
    const s = new MemoryStore(":memory:");
    s.createConversation("2026-11-14T10:00:00Z", "c1");
    const x = {
      summary: "User asked about Acme pricing.",
      keywords: ["acme", "pricing"],
      profileFacts: [{ slot: "team size", fact: "Runs a 5-person startup" }],
      claims: [{ subject: "Acme", attribute: "Pro price", value: "$29/mo", sourceUrl: "https://acme.com/pricing" }],
    };
    applyExtraction(s, payload(), x);
    applyExtraction(s, payload(), x);
    expect(s.episodesForConversation("c1")).toHaveLength(1);
    expect(s.facts()).toEqual(["Runs a 5-person startup"]);
    expect(s.recentClaims()).toHaveLength(1);
  });

  it("falls back to a minimal episode so the turn stays findable", () => {
    const s = new MemoryStore(":memory:");
    s.createConversation("2026-11-14T10:00:00Z", "c1");
    applyFallbackEpisode(s, payload());
    const [e] = s.episodesOnDates(["2026-11-14"]);
    expect(e?.summary).toContain("Acme");
    expect(s.searchEpisodes(toFtsQuery(["acme"])!)).toHaveLength(1);
  });
});

describe("outbox", () => {
  it("retries with backoff, then gives up and calls the fallback", async () => {
    const s = new MemoryStore(":memory:");
    let t = 1_000;
    const gaveUp: string[] = [];
    let calls = 0;
    const w = new OutboxWorker(
      s,
      { boom: async () => { calls++; throw new Error("nope"); } },
      { maxAttempts: 3, nowMs: () => t, onGiveUp: (k) => gaveUp.push(k) },
    );
    w.enqueue("boom", "k1", { a: 1 }, "2026-11-14T10:00:00Z");
    await w.drain();
    expect(calls).toBe(1);
    t += 60_000;
    await w.drain();
    t += 60_000;
    await w.drain();
    expect(calls).toBe(3);
    expect(gaveUp).toEqual(["boom"]);
    expect(s.outboxStats()).toEqual({ failed: 1 });
    w.stop();
  });

  it("is idempotent per dedupe key and recovers interrupted jobs", async () => {
    const s = new MemoryStore(":memory:");
    const seen: unknown[] = [];
    const w = new OutboxWorker(s, { ok: async (p) => void seen.push(p) }, { nowMs: () => 5 });
    s.enqueue("ok", "same", { n: 1 }, 5, "x");
    s.enqueue("ok", "same", { n: 2 }, 5, "x");
    s.claimNextJob(10); // simulate a crash mid-run: left 'running'
    expect(s.outboxStats()).toEqual({ running: 1 });
    w.start();
    await w.drain();
    expect(seen).toEqual([{ n: 1 }]);
  });
});
