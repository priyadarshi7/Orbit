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

export const api = {
  benchmarks: () => publicJson<BenchRun[]>("/api/benchmarks"),
  health: () => publicJson<Health>("/api/health"),
  conversations: () => json<ConversationSummary[]>("/api/conversations"),
  conversation: (id: string) => json<{ id: string; title: string; messages: StoredMessage[] }>(`/api/conversations/${id}`),
  remove: (id: string) => json<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),
  /** Edit or regenerate: remove this message and everything after it (and the memory those turns wrote). */
  rewind: (conversationId: string, fromMessageId: string) =>
    json<{ removed: number }>(`/api/conversations/${conversationId}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromMessageId }),
    }),
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

/** POST /api/chat and parse the SSE frames into typed events. */
export async function streamChat(
  body: { message: string; conversationId: string; tz: string; mode?: "auto" | "fast" | "deep" },
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await authFetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await failure(res);
  if (!res.body) throw new Error("Empty response");
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
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data) as AgentEvent);
    }
  }
}
