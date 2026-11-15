import type { SearchHit, SearchOptions, SearchProvider } from "../ports";

/**
 * Primary first; if it throws or returns nothing, try the secondary.
 *  - either one returns hits -> those hits
 *  - the primary worked but found nothing -> [] (an honest empty result, not an error)
 *  - the primary errored and the secondary found nothing or errored -> the primary's error
 */
export class FailoverSearch implements SearchProvider {
  readonly name: string;
  constructor(
    private readonly primary: SearchProvider,
    private readonly secondary: SearchProvider,
  ) {
    this.name = primary.name; // cache keys stay per primary
  }

  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    let primaryError: unknown;
    let primaryEmpty = false;
    try {
      const hits = await this.primary.search(query, opts);
      if (hits.length) return hits;
      primaryEmpty = true;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      primaryError = e;
    }
    try {
      const hits = await this.secondary.search(query, opts);
      if (hits.length) return hits;
    } catch {
      /* decided below */
    }
    if (primaryEmpty) return [];
    throw primaryError;
  }
}
