import type { Recency, SearchHit, SearchOptions, SearchProvider } from "../ports";

interface ExaResult {
  title?: string | null;
  url?: string;
  publishedDate?: string | null;
  highlights?: string[];
  text?: string;
}

const DAYS: Record<Exclude<Recency, "any">, number> = { day: 1, week: 7, month: 30, year: 365 };

/**
 * Exa search. One call can return query-relevant highlights (cheap, good for snippets) and,
 * for depth "read", the page text itself, so the pipeline needs no second fetch.
 * Docs: https://exa.ai/docs/reference/search
 */
export class ExaSearch implements SearchProvider {
  readonly name = "exa";
  constructor(
    private readonly apiKey: string,
    private readonly type: "auto" | "lite" = "auto",
    private readonly now: () => Date = () => new Date(),
  ) {}

  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    const contents: Record<string, unknown> = { highlights: { maxCharacters: 1500 } };
    if (opts.depth === "read") contents.text = { maxCharacters: 8000 };

    const body: Record<string, unknown> = { query, type: this.type, numResults: opts.maxResults, contents };
    if (opts.recency !== "any") {
      body.startPublishedDate = new Date(this.now().getTime() - DAYS[opts.recency] * 86_400_000).toISOString();
    }

    const timeout = AbortSignal.timeout(10_000);
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Exa ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const json = (await res.json()) as { results?: ExaResult[] };
    const out: SearchHit[] = [];
    for (const r of json.results ?? []) {
      if (!r.url) continue;
      const highlights = (r.highlights ?? []).map((h) => h.trim()).filter(Boolean);
      const text = r.text?.trim();
      out.push({
        url: r.url,
        title: r.title?.trim() || r.url,
        snippet: highlights.length ? highlights.join(" … ") : (text ?? "").slice(0, 500),
        publishedDate: r.publishedDate ? r.publishedDate.slice(0, 10) : undefined,
        content: text && text.length > 200 ? text : undefined,
      });
    }
    return out;
  }
}
