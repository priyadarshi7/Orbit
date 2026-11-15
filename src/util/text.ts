/** Rough token estimate (~4 chars/token). Good enough for budgeting. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export const STOPWORDS = new Set(
  (
    "a an and are as at be but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so than that the their them then there these they this to up us was we were what " +
    "when where which who whom why will with would you your about again also any been before being between " +
    "both each few more most other over same some such too very just now tell please give show ask asked " +
    "said say last since still yet one two three"
  ).split(" "),
);

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

/**
 * Very light suffix stripping so "release", "releases", "released" and "releasing" (or "price", "prices",
 * "pricing") meet in the same bucket. Not linguistics: it only has to be consistent on both sides of a match.
 */
export function stem(t: string): string {
  if (t.length <= 4 || /\d/.test(t)) return t;
  let w = t;
  if (/ies$/.test(w) && w.length > 5) w = w.slice(0, -3) + "y";
  else if (/(ing|ed)$/.test(w) && w.length - (w.endsWith("ing") ? 3 : 2) >= 4) w = w.replace(/(ing|ed)$/, "");
  else if (/s$/.test(w) && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (/e$/.test(w) && w.length > 4) w = w.slice(0, -1);
  return w;
}

export const stemmedTokens = (s: string): string[] => tokenize(s).map(stem);

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

/** Race a promise against a timeout; resolves to `fallback` on timeout. */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
