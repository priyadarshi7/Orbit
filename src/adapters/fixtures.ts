import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PageContent, PageReader, SearchHit, SearchOptions, SearchProvider } from "../ports";

/**
 * Record/replay for retrieval. Replay mode freezes the evidence so every model
 * in a benchmark sees identical search results and page text.
 */
export interface FixtureFile {
  search: Record<string, SearchHit[]>;
  pages: Record<string, PageContent | null>;
}

const qkey = (q: string, recency: string) => `${recency}::${q.trim().toLowerCase()}`;

export class FixtureStore {
  data: FixtureFile = { search: {}, pages: {} };
  constructor(readonly path: string) {
    if (existsSync(path)) this.data = JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
  }
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 1));
  }
}

export class RecordingSearch implements SearchProvider {
  readonly name: string;
  constructor(
    private readonly inner: SearchProvider,
    private readonly fx: FixtureStore,
  ) {
    this.name = `record(${inner.name})`;
  }
  async search(q: string, o: SearchOptions): Promise<SearchHit[]> {
    const hits = await this.inner.search(q, o);
    this.fx.data.search[qkey(q, o.recency)] = hits;
    return hits;
  }
}

export class ReplaySearch implements SearchProvider {
  readonly name = "replay";
  constructor(private readonly fx: FixtureStore) {}
  async search(q: string, o: SearchOptions): Promise<SearchHit[]> {
    return this.fx.data.search[qkey(q, o.recency)] ?? [];
  }
}

export class RecordingReader implements PageReader {
  constructor(
    private readonly inner: PageReader,
    private readonly fx: FixtureStore,
  ) {}
  async read(url: string, signal?: AbortSignal): Promise<PageContent | null> {
    const p = await this.inner.read(url, signal);
    this.fx.data.pages[url] = p;
    return p;
  }
}

export class ReplayReader implements PageReader {
  constructor(private readonly fx: FixtureStore) {}
  async read(url: string): Promise<PageContent | null> {
    return this.fx.data.pages[url] ?? null;
  }
}

/** Deterministic in-memory search for unit tests. */
export class StaticSearch implements SearchProvider {
  readonly name = "static";
  calls: string[] = [];
  constructor(private readonly table: Record<string, SearchHit[]> | ((q: string) => SearchHit[])) {}
  async search(q: string): Promise<SearchHit[]> {
    this.calls.push(q);
    return typeof this.table === "function" ? this.table(q) : (this.table[q] ?? []);
  }
}
