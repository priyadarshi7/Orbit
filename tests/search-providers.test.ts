import { afterEach, describe, expect, it, vi } from "vitest";
import { ExaSearch } from "../src/adapters/exa";
import { FailoverSearch } from "../src/adapters/failover";
import { StaticSearch } from "../src/adapters/fixtures";
import { MapReader } from "../src/eval/fakes";
import { MemoryStore } from "../src/memory/store";
import { fixedClock, type SearchHit, type SearchProvider } from "../src/ports";
import { EvidenceRegistry } from "../src/retrieval/evidence";
import { runRetrieval } from "../src/retrieval/pipeline";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(json: unknown, status = 200) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(json), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const NOW = () => new Date("2026-11-14T10:00:00Z");

describe("ExaSearch", () => {
  const long = "Acme Pro costs $29 per user per month when billed annually. ".repeat(10);

  it("sends the documented request shape (key header, type, numResults, highlights; text only for depth read)", async () => {
    const fetchFn = stubFetch({ results: [] });
    const exa = new ExaSearch("k-123", "auto", NOW);

    await exa.search("acme pricing", { maxResults: 6, recency: "week", depth: "snippets" });
    let [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.exa.ai/search");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("k-123");
    let body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ query: "acme pricing", type: "auto", numResults: 6 });
    expect(body.contents.highlights).toBeTruthy();
    expect(body.contents.text).toBeUndefined();
    expect(body.startPublishedDate).toBe("2026-11-07T10:00:00.000Z"); // one week before the injected clock

    await exa.search("acme pricing", { maxResults: 6, recency: "any", depth: "read" });
    [, init] = fetchFn.mock.calls[1]!;
    body = JSON.parse(init!.body as string);
    expect(body.contents.text).toBeTruthy();
    expect(body.startPublishedDate).toBeUndefined();
  });

  it("maps results: highlights become the snippet, long text becomes page content, dates are trimmed", async () => {
    stubFetch({
      results: [
        { url: "https://acme.com/pricing", title: "Acme Pricing", publishedDate: "2026-11-01T08:00:00.000Z", highlights: ["Pro is $29", "Free up to 3 users"], text: long },
        { url: "https://x.example/a", title: null, highlights: [] },
        { title: "no url, dropped" },
      ],
    });
    const hits = await new ExaSearch("k", "auto", NOW).search("q", { maxResults: 5, recency: "any", depth: "read" });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ url: "https://acme.com/pricing", title: "Acme Pricing", publishedDate: "2026-11-01", snippet: "Pro is $29 … Free up to 3 users" });
    expect(hits[0]!.content).toContain("Acme Pro costs");
    expect(hits[1]!.title).toBe("https://x.example/a");
    expect(hits[1]!.content).toBeUndefined();
  });

  it("throws a readable error on a non-2xx response", async () => {
    stubFetch({ error: "invalid api key" }, 401);
    await expect(new ExaSearch("bad").search("q", { maxResults: 3, recency: "any" })).rejects.toThrow(/Exa 401/);
  });
});

describe("pipeline with a provider that returns page text", () => {
  it("skips the page fetch entirely when search results already carry content", async () => {
    const content = "The Pro plan costs $29 per seat per month, billed annually, and includes unlimited projects and priority support for every member of the team.";
    const search = new StaticSearch({ "acme pricing": [{ url: "https://acme.com/pricing", title: "Acme Pricing", snippet: "Pro $29", content }] });
    const reader = new MapReader({});
    const out = await runRetrieval(
      { search, reader, store: new MemoryStore(":memory:"), clock: fixedClock("2026-11-14T10:00:00Z"), budgetTokens: 1500 },
      { queries: ["acme pricing"], depth: "read", recency: "any", registry: new EvidenceRegistry() },
    );
    expect(reader.reads).toEqual([]); // no second HTTP fetch
    expect(out.stats.pagesRead).toBe(1);
    expect(out.text).toContain("unlimited projects");
  });
});

describe("FailoverSearch", () => {
  const hit: SearchHit = { url: "https://a.example", title: "A", snippet: "s" };
  const ok = (name: string, hits: SearchHit[] = [hit]): SearchProvider & { calls: number } => {
    const p = { name, calls: 0, search: async () => (p.calls++, hits) };
    return p;
  };
  const boom = (name: string, msg = "down"): SearchProvider => ({ name, search: async () => { throw new Error(msg); } });
  const opts = { maxResults: 3, recency: "any" as const };

  it("uses the primary when it works and never touches the secondary", async () => {
    const [a, b] = [ok("a"), ok("b")];
    expect(await new FailoverSearch(a, b).search("q", opts)).toEqual([hit]);
    expect(b.calls).toBe(0);
  });

  it("falls over on an error and on an empty result", async () => {
    expect(await new FailoverSearch(boom("a"), ok("b")).search("q", opts)).toEqual([hit]);
    expect(await new FailoverSearch(ok("a", []), ok("b")).search("q", opts)).toEqual([hit]);
  });

  it("returns an empty result (not an error) when the primary is empty and the secondary also fails", async () => {
    expect(await new FailoverSearch(ok("a", []), boom("b")).search("q", opts)).toEqual([]);
  });

  it("surfaces the primary's error when both fail", async () => {
    await expect(new FailoverSearch(boom("a", "first"), boom("b", "second")).search("q", opts)).rejects.toThrow("first");
  });
});
