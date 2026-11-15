import type { SourceInfo } from "../agent/events";
import { domainOf } from "../util/text";
import { normalizeUrl } from "./rank";

/**
 * Per-turn registry of every source the agent has seen. Ids are stable across
 * search rounds, so "[2]" always means the same page, and the grounding gate
 * can check any citation against it.
 */
export class EvidenceRegistry {
  private byKey = new Map<string, SourceInfo>();
  private byId = new Map<number, SourceInfo>();
  private excerpts = new Map<number, string>();

  register(url: string, title: string, publishedDate?: string): { source: SourceInfo; isNew: boolean } {
    const key = normalizeUrl(url);
    const existing = this.byKey.get(key);
    if (existing) {
      if (!existing.publishedDate && publishedDate) existing.publishedDate = publishedDate;
      return { source: existing, isNew: false };
    }
    const source: SourceInfo = {
      id: this.byId.size + 1,
      url,
      title: title || domainOf(url),
      domain: domainOf(url),
      publishedDate,
    };
    this.byKey.set(key, source);
    this.byId.set(source.id, source);
    return { source, isNew: true };
  }

  /** Keeps the passages shown to the model for a source, so a verifier can later check claims against them. */
  addExcerpt(id: number, text: string): void {
    const prev = this.excerpts.get(id) ?? "";
    if (prev.includes(text)) return;
    this.excerpts.set(id, (prev ? `${prev} ${text}` : text).slice(0, 1500));
  }

  excerpt(id: number): string {
    return this.excerpts.get(id) ?? "";
  }

  get(id: number): SourceInfo | undefined {
    return this.byId.get(id);
  }

  has(id: number): boolean {
    return this.byId.has(id);
  }

  all(): SourceInfo[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }
}
