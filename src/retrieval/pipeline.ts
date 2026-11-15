import type { Phase, SourceInfo } from "../agent/events";
import type { MemoryStore } from "../memory/store";
import type { Clock, PageContent, PageReader, Recency, SearchHit, SearchProvider } from "../ports";
import { estimateTokens, tokenize, truncate, withTimeout } from "../util/text";
import type { EvidenceRegistry } from "./evidence";
import { bm25, chunk, jaccard, normalizeUrl, rrf } from "./rank";

export interface PipelineDeps {
  search: SearchProvider;
  reader: PageReader;
  /** Optional: enables the search/page cache. */
  store: MemoryStore | null;
  clock: Clock;
  budgetTokens: number;
  resultsPerQuery?: number;
  readTopK?: number;
}

export interface PipelineInput {
  queries: string[];
  depth: "snippets" | "read";
  recency: Recency;
  registry: EvidenceRegistry;
  signal?: AbortSignal;
  onStatus?: (phase: Phase, detail?: string) => void;
  onSource?: (s: SourceInfo) => void;
}

export interface PipelineStats {
  queries: string[];
  depth: string;
  hits: number;
  uniqueUrls: number;
  pagesRequested: number;
  pagesRead: number;
  passages: number;
  /** Estimated evidence tokens returned to the model. */
  usedTokens: number;
  cachedQueries: number;
  errors: string[];
  ms: number;
}

export interface PipelineOutput {
  /** Evidence formatted for the model. */
  text: string;
  sources: SourceInfo[];
  stats: PipelineStats;
}

/** How long a cached search stays valid, by how fast the topic goes stale. */
export function ttlFor(query: string, recency: Recency): number {
  const MIN = 60_000;
  if (recency === "day") return 15 * MIN;
  if (/\b(price|pricing|cost|plans?|latest|news|today|now|current|score|stock|release[sd]?|version|breaking|weather|launch(ed)?|update[sd]?)\b/i.test(query))
    return 60 * MIN;
  if (/\b(how to|tutorial|docs?|documentation|what is|history|definition|explained?)\b/i.test(query)) return 24 * 60 * MIN;
  return 12 * 60 * MIN;
}

interface Cand {
  hit: SearchHit;
  key: string;
  fused: number;
}

export async function runRetrieval(deps: PipelineDeps, inp: PipelineInput): Promise<PipelineOutput> {
  const t0 = Date.now();
  const perQuery = deps.resultsPerQuery ?? 6;
  const stats: PipelineStats = {
    queries: inp.queries,
    depth: inp.depth,
    hits: 0,
    uniqueUrls: 0,
    pagesRequested: 0,
    pagesRead: 0,
    passages: 0,
    usedTokens: 0,
    cachedQueries: 0,
    errors: [],
    ms: 0,
  };

  // 1 ── Fan-out: all queries in parallel, cache first.
  inp.onStatus?.("searching", inp.queries.length === 1 ? inp.queries[0] : `${inp.queries.length} queries`);
  const nowMs = deps.clock.now().getTime();
  const perQueryHits = await Promise.all(
    inp.queries.map(async (q): Promise<SearchHit[]> => {
      const ck = `s:${deps.search.name}:${inp.depth}:${inp.recency}:${q.trim().toLowerCase()}`;
      const cached = deps.store?.cacheGet<SearchHit[]>(ck, nowMs);
      if (cached) {
        stats.cachedQueries++;
        return cached;
      }
      try {
        const hits = await deps.search.search(q, { maxResults: perQuery, recency: inp.recency, depth: inp.depth, signal: inp.signal });
        if (hits.length) deps.store?.cacheSet(ck, hits, ttlFor(q, inp.recency), nowMs);
        return hits;
      } catch (e) {
        stats.errors.push(`search "${truncate(q, 40)}": ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    }),
  );

  // 2 ── Dedupe + fuse: URL-normalised, near-duplicate titles dropped, RRF across queries.
  const byKey = new Map<string, SearchHit>();
  const lists: string[][] = perQueryHits.map((hits) => {
    const keys: string[] = [];
    for (const h of hits) {
      const k = normalizeUrl(h.url);
      if (!byKey.has(k)) byKey.set(k, h);
      if (!keys.includes(k)) keys.push(k);
    }
    return keys;
  });
  stats.hits = perQueryHits.reduce((n, h) => n + h.length, 0);
  const fused = rrf(lists);
  const ranked: Cand[] = [...byKey.entries()]
    .map(([key, hit]) => ({ key, hit, fused: (fused.get(key) ?? 0) + (hit.score ?? 0) * 0.004 }))
    .sort((a, b) => b.fused - a.fused);

  const kept: Cand[] = [];
  for (const c of ranked) {
    const tt = tokenize(c.hit.title);
    if (kept.some((k) => tt.length >= 4 && jaccard(tt, tokenize(k.hit.title)) >= 0.85)) continue;
    kept.push(c);
  }
  stats.uniqueUrls = kept.length;

  if (kept.length === 0) {
    stats.ms = Date.now() - t0;
    const why = stats.errors.length ? ` (${stats.errors.join("; ")})` : "";
    return {
      text: `<evidence>\nNO RESULTS for: ${inp.queries.map((q) => `"${q}"`).join(", ")}${why}. Try different wording, or say you could not find sources.\n</evidence>`,
      sources: [],
      stats,
    };
  }

  // 3 ── Read: fetch the top pages (max 2 per domain) and extract their text.
  const pages = new Map<string, PageContent>();
  if (inp.depth === "read") {
    const perDomain = new Map<string, number>();
    const toRead: Cand[] = [];
    for (const c of kept) {
      const d = new URL(c.hit.url).hostname;
      if ((perDomain.get(d) ?? 0) >= 2) continue;
      perDomain.set(d, (perDomain.get(d) ?? 0) + 1);
      toRead.push(c);
      if (toRead.length >= (deps.readTopK ?? 4)) break;
    }
    stats.pagesRequested = toRead.length;
    inp.onStatus?.("reading", `${toRead.length} pages`);
    await withTimeout(
      Promise.all(
        toRead.map(async (c) => {
          // Some providers (Exa) return full page text with the search: no second fetch needed.
          if (c.hit.content) {
            pages.set(c.key, { url: c.hit.url, title: c.hit.title, text: c.hit.content, publishedDate: c.hit.publishedDate });
            return;
          }
          const pk = `p:${c.key}`;
          let page = deps.store?.cacheGet<PageContent>(pk, nowMs) ?? null;
          if (!page) {
            page = await deps.reader.read(c.hit.url, inp.signal);
            if (page) deps.store?.cacheSet(pk, page, 6 * 3_600_000, nowMs);
          }
          if (page) pages.set(c.key, page);
        }),
      ),
      7_000,
      undefined,
    );
    stats.pagesRead = pages.size;
  }

  // 4 ── Rank passages (BM25 over every candidate passage) under a token budget.
  interface P {
    key: string;
    text: string;
    pos: number;
    fromPage: boolean;
  }
  const docs: { item: P; text: string }[] = [];
  const srcOf = new Map<string, Cand>();
  for (const c of kept) {
    srcOf.set(c.key, c);
    const page = pages.get(c.key);
    if (page) {
      chunk(page.text).forEach((p, i) => docs.push({ item: { key: c.key, text: p, pos: i, fromPage: true }, text: p }));
    } else if (c.hit.snippet.trim().length > 8) {
      docs.push({ item: { key: c.key, text: c.hit.snippet.trim(), pos: 0, fromPage: false }, text: `${c.hit.title} ${c.hit.snippet}` });
    }
  }
  const maxFused = kept[0]?.fused || 1;
  const scored = bm25(docs, inp.queries.join(" ")).map((s) => ({
    ...s,
    score: s.score * (1 + 0.35 * ((srcOf.get(s.item.key)?.fused ?? 0) / maxFused)),
  }));
  scored.sort((a, b) => b.score - a.score);

  const chosen = new Map<string, P[]>();
  let used = 0;
  for (const s of scored) {
    const list = chosen.get(s.item.key) ?? [];
    const cap = s.item.fromPage ? 3 : 1;
    if (list.length >= cap) continue;
    const cost = estimateTokens(s.item.text) + 12;
    if (used + cost > deps.budgetTokens) continue;
    if (s.score <= 0 && used > 0) continue;
    list.push(s.item);
    chosen.set(s.item.key, list);
    used += cost;
  }
  // If nothing scored above zero (very short queries), fall back to top snippets.
  if (chosen.size === 0) {
    for (const d of docs.slice(0, 4)) {
      chosen.set(d.item.key, [...(chosen.get(d.item.key) ?? []), d.item]);
    }
  }

  // 5 ── Pack: register sources (stable ids), order by relevance, format for the model.
  const order = [...chosen.keys()].sort((a, b) => (srcOf.get(b)?.fused ?? 0) - (srcOf.get(a)?.fused ?? 0));
  const sources: SourceInfo[] = [];
  const blocks: string[] = [];
  for (const key of order) {
    const c = srcOf.get(key)!;
    const page = pages.get(key);
    const { source, isNew } = inp.registry.register(
      c.hit.url,
      c.hit.title || page?.title || "",
      c.hit.publishedDate ?? page?.publishedDate,
    );
    if (isNew) inp.onSource?.(source);
    sources.push(source);
    const ps = (chosen.get(key) ?? []).sort((a, b) => a.pos - b.pos);
    stats.passages += ps.length;
    inp.registry.addExcerpt(source.id, ps.map((p) => sanitize(p.text)).join(" "));
    const head = `[${source.id}] ${source.title} — ${source.domain}${source.publishedDate ? ` (published ${source.publishedDate})` : " (date unknown)"}`;
    blocks.push(`${head}\n${ps.map((p) => `• ${sanitize(p.text)}`).join("\n")}`);
  }

  stats.usedTokens = used;
  stats.ms = Date.now() - t0;
  const errNote = stats.errors.length ? `\n(Some searches failed: ${stats.errors.join("; ")})` : "";
  return {
    text: `<evidence>\n${blocks.join("\n\n")}${errNote}\n</evidence>`,
    sources,
    stats,
  };
}

/** Page text is untrusted data: neutralise anything that could pose as our delimiters. */
function sanitize(s: string): string {
  return s.replace(/<\/?\s*evidence[^>]*>/gi, "").replace(/\s+/g, " ").trim();
}
