import type { SearchHit, SearchOptions, SearchProvider } from "../ports";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
}

export class TavilySearch implements SearchProvider {
  readonly name = "tavily";
  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    const body: Record<string, unknown> = {
      query,
      max_results: opts.maxResults,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
    };
    if (opts.recency !== "any") body.time_range = opts.recency;

    const timeout = AbortSignal.timeout(8_000);
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Tavily ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const json = (await res.json()) as { results?: TavilyResult[] };
    const out: SearchHit[] = [];
    for (const r of json.results ?? []) {
      if (!r.url || !r.title) continue;
      out.push({
        url: r.url,
        title: r.title,
        snippet: r.content ?? "",
        publishedDate: r.published_date ? r.published_date.slice(0, 10) : undefined,
        score: r.score,
      });
    }
    return out;
  }
}
