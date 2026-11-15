import type { BenchCase } from "@/lib/api";

export const ms = (n: number | null | undefined) =>
  n == null ? "–" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;

export const compact = (n: number) =>
  n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString();

export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A case the judge did not score (quota or error leaves score 0). */
export const unjudged = (c: BenchCase) => !c.judged || c.judged.score <= 0;

/** error = the turn did not complete (rate limit, network); fail = it answered but missed a check. */
export type CaseStatus = "pass" | "fail" | "error";
export const caseStatus = (c: BenchCase): CaseStatus => (c.error ? "error" : c.pass ? "pass" : "fail");

export function tally(cases: BenchCase[]) {
  const errored = cases.filter((c) => c.error).length;
  const passed = cases.filter((c) => c.pass).length;
  return { total: cases.length, passed, errored, failed: cases.length - passed - errored, answered: cases.length - errored };
}

export type Tone = "ok" | "warn" | "bad";
export const toneOf = (passed: number, total: number): Tone => (passed === total ? "ok" : passed === 0 ? "bad" : "warn");

export const CATEGORY_LABEL: Record<string, string> = {
  no_search: "No search needed",
  fresh_fact: "Fresh facts",
  multi_hop: "Multi-hop",
  comparison: "Comparison",
  ambiguous: "Ambiguity",
  followup: "Follow-ups",
  dated_recall: "Date recall",
  change_detection: "Change detection",
  no_record: "No record",
  injection: "Security & injection",
  conversation: "Conversation",
  freshness: "Freshness guard",
  multilingual: "Multilingual",
};
export const categoryLabel = (c: string) => CATEGORY_LABEL[c] ?? c;
