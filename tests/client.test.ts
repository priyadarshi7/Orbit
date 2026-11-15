import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent/events";
import { ApiError, streamChat } from "../web/src/lib/api";

afterEach(() => vi.unstubAllGlobals());

const frame = (id: number, ev: object) => `id: ${id}\nevent: ${(ev as { type: string }).type}\ndata: ${JSON.stringify({ ...ev, t: id })}\n\n`;
const sse = (text: string, headers: Record<string, string> = {}) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream", ...headers } },
  );

const body = { message: "hi", conversationId: "conv-client-1", tz: "UTC", requestId: "req-client-0001" };

describe("streamChat reconnects without losing or repeating events", () => {
  it("resumes from the last event id after the connection drops mid-answer", async () => {
    const calls: { lastEventId: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/session") return new Response(JSON.stringify({ token: "" }), { status: 200 });
        calls.push({ lastEventId: new Headers(init?.headers).get("last-event-id") });
        return calls.length === 1
          ? sse(frame(0, { type: "start", conversationId: "c", userMessageId: "m" }) + frame(1, { type: "token", text: "Hel" }) + frame(2, { type: "token", text: "lo" }), { "x-run-id": "run-1" })
          : sse(
              // the server replays from after id 2; a repeated frame (id 2) must be ignored by the client
              frame(2, { type: "token", text: "lo" }) + frame(3, { type: "token", text: " there" }) + frame(4, { type: "done", conversationId: "c", messageId: "a", trace: {} }),
              { "x-run-id": "run-1" },
            );
      }),
    );
    const seen: AgentEvent[] = [];
    const runs: string[] = [];
    await streamChat(body, (e) => seen.push(e), new AbortController().signal, (id) => runs.push(id));

    expect(calls.map((c) => c.lastEventId)).toEqual([null, "2"]); // second call asked to resume after 2
    expect(seen.map((e) => e.type)).toEqual(["start", "token", "token", "token", "done"]);
    expect(seen.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("")).toBe("Hello there");
    expect(runs[0]).toBe("run-1");
  });

  it("does not retry when the server says the run is gone (the caller reloads from the database)", async () => {
    let chats = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/session") return new Response(JSON.stringify({ token: "" }), { status: 200 });
        chats++;
        return new Response(JSON.stringify({ error: "run_gone", status: "done" }), { status: 409, headers: { "content-type": "application/json" } });
      }),
    );
    await expect(streamChat(body, () => undefined, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
    expect(chats).toBe(1);
  });

  it("shows the server's own message for a rate limit instead of a generic error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/session"
          ? new Response(JSON.stringify({ token: "" }), { status: 200 })
          : new Response(JSON.stringify({ error: "rate_limited", message: "You're sending messages too fast. Try again in 8s." }), { status: 429 }),
      ),
    );
    const err = await streamChat(body, () => undefined, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("You're sending messages too fast. Try again in 8s.");
  });
});
