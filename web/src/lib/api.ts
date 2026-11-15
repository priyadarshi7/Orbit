import type { AgentEvent, SourceInfo, TurnTrace } from "../../../src/agent/events";

export type { AgentEvent, SourceInfo, TurnTrace };
export type { Mode, Path } from "../../../src/agent/events";

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  meta: { sources?: SourceInfo[]; trace?: TurnTrace; stopped?: boolean } | null;
}

export interface MemoryView {
  profile: { id: number; fact: string; previous: string | null }[];
  recent: { id: number; localDate: string; summary: string }[];
  claims: { id: number; subject: string; attribute: string; value: string; asOf: string; sourceUrl: string | null; supersedesId: number | null; previous: { value: string; asOf: string } | null }[];
}

export interface Health {
  ok: boolean;
  models: { answer: string; fallback: string | null; background: string };
  providers: Record<string, boolean>;
  search: string;
  auth?: boolean;
}

/** An API failure with the server's own wording (rate limits explain themselves). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function failure(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  try {
    const j = (await res.clone().json()) as { message?: string; error?: string };
    message = j.message ?? j.error ?? message;
  } catch {
    /* not JSON */
  }
  return new ApiError(message, res.status);
}

// ── anonymous session ─────────────────────────────────────────────────────
// The server issues a signed token on first use; it is what scopes memory and chats to this browser.
const TOKEN_KEY = "orbit.token";
let session: Promise<string> | null = null;

const stored = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
const keep = (t: string | null) => {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the session lasts until reload */
  }
};

async function createSession(): Promise<string> {
  const res = await fetch("/api/session", { method: "POST" });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { token: string };
  keep(j.token || null);
  return j.token;
}

const token = (): Promise<string> => (session ??= stored() !== null ? Promise.resolve(stored()!) : createSession());

/** fetch with the session token; if the server no longer accepts it (new secret, cleared database), start a new session once. */
async function authFetch(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const t = await token().catch((e) => {
    session = null;
    throw e;
  });
  const headers = new Headers(init.headers);
  if (t) headers.set("authorization", `Bearer ${t}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 && !retried) {
    keep(null);
    session = null;
    return authFetch(url, init, true);
  }
  return res;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

async function publicJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

export type { BenchRun, BenchModel, BenchCase } from "../../../src/server/benchmarks";
import type { BenchRun } from "../../../src/server/benchmarks";

export type RunInfo = { id: string; status: "running" | "done" | "failed" | "stopped" | "interrupted"; error: string | null };

export const api = {
  benchmarks: () => publicJson<BenchRun[]>("/api/benchmarks"),
  health: () => publicJson<Health>("/api/health"),
  conversations: () => json<ConversationSummary[]>("/api/conversations"),
  conversation: (id: string) => json<{ id: string; title: string; messages: StoredMessage[]; run: RunInfo | null }>(`/api/conversations/${id}`),
  remove: (id: string) => json<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),
  /** Edit or regenerate: remove this message and everything after it (and the memory those turns wrote). */
  rewind: (conversationId: string, fromMessageId: string) =>
    json<{ removed: number }>(`/api/conversations/${conversationId}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromMessageId }),
    }),
  /** Stop a run. The server finishes it with the partial answer, so the stream is left open to deliver that. */
  cancel: (runId: string) => json<{ ok: boolean }>(`/api/runs/${runId}/cancel`, { method: "POST" }),
  memory: () => json<MemoryView>("/api/memory"),
  deleteFact: (id: number) => json<{ ok: boolean }>(`/api/memory/facts/${id}`, { method: "DELETE" }),
  deleteClaim: (id: number) => json<{ ok: boolean }>(`/api/memory/claims/${id}`, { method: "DELETE" }),
  suggest: (question: string, answer: string) =>
    json<{ suggestions: string[] }>("/api/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, answer }),
    }),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RECONNECTS = 6;

/**
 * Follows one run's event stream and survives a dropped connection. Every frame carries a sequence id; after a
 * break the stream is reopened from the last id seen, so nothing is missed or repeated, and the server run
 * is never restarted. Gives up (throws) only after repeated failures or when the user aborts.
 */
async function follow(
  open: (lastSeq: number) => Promise<Response>,
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal,
  onRun?: (runId: string) => void,
): Promise<void> {
  let last = -1;
  let finished = false;
  let failures = 0;
  while (true) {
    try {
      const res = await open(last);
      if (!res.ok) throw await failure(res); // a 409 "run_gone" or a rate limit is final, not retried
      if (!res.body) throw new Error("Empty response");
      const runId = res.headers.get("x-run-id");
      if (runId) onRun?.(runId);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = frame.match(/^id: (\d+)$/m)?.[1];
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          if (id !== undefined) {
            if (Number(id) <= last) continue;
            last = Number(id);
          }
          failures = 0;
          const ev = JSON.parse(data) as AgentEvent;
          onEvent(ev);
          if (ev.type === "done" || ev.type === "error") finished = true;
        }
      }
      if (finished) return;
    } catch (e) {
      if (signal.aborted || e instanceof ApiError || finished) throw e;
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (++failures > MAX_RECONNECTS) throw new Error("Connection lost. Reload to see the answer when it finishes.");
    await sleep(Math.min(500 * 2 ** (failures - 1), 4000));
  }
}

/** Start (or, with the same requestId, re-attach to) a chat turn. */
export function streamChat(
  body: { message: string; conversationId: string; tz: string; mode?: "auto" | "fast" | "deep"; requestId: string },
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal,
  onRun?: (runId: string) => void,
): Promise<void> {
  return follow(
    (last) =>
      authFetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", ...(last >= 0 ? { "last-event-id": String(last) } : {}) },
        body: JSON.stringify(body),
        signal,
      }),
    onEvent,
    signal,
    onRun,
  );
}

/** Follow a run that is already going (after a page reload or opening a chat whose answer is still being written). */
export function attachRun(runId: string, onEvent: (e: AgentEvent) => void, signal: AbortSignal, onRun?: (runId: string) => void): Promise<void> {
  return follow((last) => authFetch(`/api/runs/${runId}/events${last >= 0 ? `?after=${last}` : ""}`, { signal }), onEvent, signal, onRun);
}
