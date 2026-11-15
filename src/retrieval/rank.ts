import { stemmedTokens } from "../util/text";

const TRACKING = /^(utm_|fbclid|gclid|mc_|ref$|ref_src|igshid|yclid|_hs)/i;

/** Canonical form used to dedupe the same page reached by different URLs. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    let p = u.pathname.replace(/\/index\.(html?|php)$/i, "/").replace(/\/+$/, "");
    if (p === "") p = "/";
    return `${u.protocol === "http:" ? "https:" : u.protocol}//${u.hostname}${p}${u.search}`;
  } catch {
    return raw;
  }
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Reciprocal-rank fusion over several ranked lists. A page that several
 * differently-worded queries all surface is more likely to be relevant.
 */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return score;
}

/** Split text into ~`target`-word passages on paragraph boundaries. */
export function chunk(text: string, target = 150, maxPassages = 60): string[] {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  const out: string[] = [];
  let cur: string[] = [];
  let words = 0;
  const flush = () => {
    if (cur.length) out.push(cur.join(" "));
    cur = [];
    words = 0;
  };
  for (const p of paras) {
    const w = p.split(" ").length;
    if (w > target * 1.6) {
      // Very long paragraph: split by sentences.
      flush();
      let buf: string[] = [];
      let bw = 0;
      // Sentences; any single "sentence" still too long (code, tables, no punctuation) is cut by words.
      const sentences = p
        .split(/(?<=[.!?])\s+/)
        .flatMap((s) => {
          const words = s.split(" ");
          if (words.length <= target * 1.6) return [s];
          const parts: string[] = [];
          for (let i = 0; i < words.length; i += target) parts.push(words.slice(i, i + target).join(" "));
          return parts;
        });
      for (const s of sentences) {
        const sw = s.split(" ").length;
        if (bw + sw > target && buf.length) {
          out.push(buf.join(" "));
          buf = [];
          bw = 0;
        }
        buf.push(s);
        bw += sw;
      }
      if (buf.length) out.push(buf.join(" "));
      continue;
    }
    if (words + w > target && cur.length) flush();
    cur.push(p);
    words += w;
  }
  flush();
  return out.filter((p) => p.length > 40).slice(0, maxPassages);
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Okapi BM25 of each document against the query, with IDF over the given set. */
export function bm25<T>(
  docs: { item: T; text: string }[],
  query: string,
  k1 = 1.4,
  b = 0.75,
): Scored<T>[] {
  const q = [...new Set(stemmedTokens(query))];
  const tokenised = docs.map((d) => stemmedTokens(d.text));
  const N = docs.length;
  const avg = tokenised.reduce((s, t) => s + t.length, 0) / Math.max(N, 1) || 1;
  const df = new Map<string, number>();
  for (const toks of tokenised) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  return docs.map((d, i) => {
    const toks = tokenised[i]!;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * toks.length) / avg));
    }
    return { item: d.item, score };
  });
}
