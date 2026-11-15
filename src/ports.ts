/**
 * Ports: the only things the agent core knows about the outside world.
 * Real adapters live in src/adapters; fakes live in src/eval and tests.
 * (The LLM port is the AI SDK's own `LanguageModel`; see src/models.ts.)
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock & { set(iso: string): void } {
  let t = new Date(iso);
  return { now: () => new Date(t), set: (v) => void (t = new Date(v)) };
}

export type Recency = "day" | "week" | "month" | "year" | "any";

export interface SearchHit {
  url: string;
  title: string;
  /** Provider-supplied excerpt. */
  snippet: string;
  publishedDate?: string;
  /** Provider relevance in [0,1] when available. */
  score?: number;
  /** Full page text when the provider returns it (lets the pipeline skip fetching the page). */
  content?: string;
}

export interface SearchOptions {
  maxResults: number;
  recency: Recency;
  /** "read" asks providers that can to return full page text, not just excerpts. */
  depth?: "snippets" | "read";
  signal?: AbortSignal;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts: SearchOptions): Promise<SearchHit[]>;
}

export interface PageContent {
  url: string;
  title?: string;
  text: string;
  /** YYYY-MM-DD, from page metadata when present. */
  publishedDate?: string;
}

export interface PageReader {
  read(url: string, signal?: AbortSignal): Promise<PageContent | null>;
}
