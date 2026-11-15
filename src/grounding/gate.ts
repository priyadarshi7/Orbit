/**
 * Grounding gate (code, not prompt). Runs on the finished answer:
 *  - every [n] citation must resolve to a source the agent actually retrieved;
 *    unresolved ones are removed (never shown as if they were real)
 *  - echoed internal tags are stripped
 *  - lints for undated relative-time language and for uncited answers
 */

export interface GateResult {
  text: string;
  cited: number[];
  dropped: number[];
  warnings: string[];
}

const CITE = /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\](?!\()/g;
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/g;
const TAGS = /<\/?\s*(evidence|memory|context)\b[^>]*>/gi;
const RELATIVE =
  /\b(recently|currently|nowadays|at the moment|this (?:week|month|year)|last (?:week|month|year)|yesterday|today)\b/i;
const ABSOLUTE =
  /\b(19|20)\d{2}\b|\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

/**
 * Models emit citation and spacing variants the UI and checks do not expect:
 * gpt-oss writes 【5】 or 【1†L1-L4】, and several models insert narrow no-break
 * spaces or non-breaking hyphens. Canonicalise before anything else looks at the text.
 */
export function normalizeModelText(s: string): string {
  return s
    .replace(/【\s*(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\s*(?:†[^】]*)?】/g, "[$1]")
    .replace(/\[(\d{1,3})\s*†[^\]]*\]/g, "[$1]")
    .replace(/[    ]/g, " ")
    .replace(/[‐‑]/g, "-");
}

export function gate(
  raw: string,
  isValid: (id: number) => boolean,
  ctx: { sourcesRetrieved: number },
): GateResult {
  const cited = new Set<number>();
  const dropped = new Set<number>();

  // Only touch prose; leave code spans alone (arr[0] is not a citation).
  const parts = normalizeModelText(raw).replace(TAGS, "").split(CODE);
  const fixed = parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // code
      return part.replace(CITE, (_m, list: string) => {
        const ids = list.split(/[,;]/).map((s) => Number.parseInt(s, 10));
        const ok = ids.filter((id) => isValid(id));
        ids.forEach((id) => (isValid(id) ? cited.add(id) : dropped.add(id)));
        return ok.length ? `[${[...new Set(ok)].join(", ")}]` : "";
      });
    })
    .join("")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();

  const warnings: string[] = [];
  if (dropped.size) warnings.push(`dropped ${dropped.size} unresolved citation(s): ${[...dropped].join(", ")}`);
  if (ctx.sourcesRetrieved > 0 && cited.size === 0) warnings.push("searched but cited nothing");
  const undated = fixed
    .split(/(?<=[.!?])\s+/)
    .filter((s) => RELATIVE.test(s) && !ABSOLUTE.test(s)).length;
  if (undated) warnings.push(`${undated} sentence(s) use relative time without an absolute date`);

  return { text: fixed, cited: [...cited].sort((a, b) => a - b), dropped: [...dropped].sort((a, b) => a - b), warnings };
}

// ── instruction-leak guard ─────────────────────────────────────────────────

export const WITHHELD_REPLY =
  "I can't share my internal instructions or configuration. I can search the web, read and cite sources, answer questions, and remember our earlier chats. What would you like to look into?";

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];

function shingles(ws: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(" "));
  return out;
}

/**
 * True when the reply reproduces the system prompt: it shares at least two distinct
 * 5-word runs with it. Deterministic, so it holds even when a prompt rule is talked around.
 * The opening identity line is excluded, so "I'm Orbit, a research assistant…" is fine.
 */
export function leaksInstructions(reply: string, systemPrompt: string): boolean {
  // Drop the identity line, and indented "Say:" / "Instead of:" example lines: the model is meant to
  // use that wording, so reproducing it is correct behaviour, not a leak.
  const body = systemPrompt
    .split("\n")
    .slice(1)
    .filter((l) => !/^\s+(Say|Instead of):/.test(l))
    .join("\n");
  const secret = shingles(words(body), 5);
  let hits = 0;
  for (const s of shingles(words(reply), 5)) if (secret.has(s) && ++hits >= 2) return true;
  return false;
}
