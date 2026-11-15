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
  profile: { id: number; fact: string }[];
  recent: { id: number; localDate: string; summary: string }[];
  claims: { id: number; subject: string; attribute: string; value: string; asOf: string; sourceUrl: string | null; supersedesId: number | null; previous: { value: string; asOf: string } | null }[];
}

export interface Health {
  ok: boolean;
  models: { answer: string; fallback: string | null; background: string };
  providers: Record<string, boolean>;
  search: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export type { BenchRun, BenchModel, BenchCase } from "../../../src/server/benchmarks";
import type { BenchRun } from "../../../src/server/benchmarks";

export const api = {
  benchmarks: () => json<BenchRun[]>("/api/benchmarks"),
  health: () => json<Health>("/api/health"),
  conversations: () => json<ConversationSummary[]>("/api/conversations"),
  conversation: (id: string) => json<{ id: string; title: string; messages: StoredMessage[] }>(`/api/conversations/${id}`),
  remove: (id: string) => json<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),
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
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
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
