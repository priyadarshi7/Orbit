import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Reads saved eval/bench output (eval-results/*.json) and normalises it for the /benchmark page. */

export interface BenchCase {
  id: string;
  category: string;
  message: string;
  answer: string;
  error?: string;
  pass: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  judged?: { score: number; correct: boolean; grounded: boolean; notes: string };
  ttftMs: number | null;
  totalMs: number | null;
  searches: number;
  citations: number;
  tokensIn: number;
  tokensOut: number;
  cachedIn: number;
}

export interface BenchModel {
  model: string;
  summary: Record<string, unknown>;
  cases: BenchCase[];
}

export interface BenchRun {
  id: string;
  kind: "eval" | "bench";
  mode: string;
  createdAt: string;
  /** "running" while an eval is still writing partial results. */
  status: "running" | "complete";
  /** Cases planned for the run (equals cases.length once complete). */
  total: number;
  models: BenchModel[];
}

type Raw = Record<string, any>;

function toCase(r: Raw): BenchCase {
  const t = r.trace ?? {};
  return {
    id: String(r.id),
    category: String(r.category ?? ""),
    message: String(r.message ?? ""),
    answer: String(r.answer ?? ""),
    error: r.error ? String(r.error) : undefined,
    pass: Boolean(r.pass),
    checks: Array.isArray(r.checks) ? r.checks : [],
    judged: r.judged,
    ttftMs: typeof t.firstTokenMs === "number" ? t.firstTokenMs : null,
    totalMs: typeof t.totalMs === "number" ? t.totalMs : null,
    searches: Array.isArray(t.searches) ? t.searches.length : 0,
    citations: Array.isArray(t.citations?.cited) ? t.citations.cited.length : 0,
    tokensIn: t.usage?.inputTokens ?? 0,
    tokensOut: t.usage?.outputTokens ?? 0,
    cachedIn: t.usage?.cachedInputTokens ?? 0,
  };
}

export function loadBenchmarks(dir = "eval-results"): BenchRun[] {
  if (!existsSync(dir)) return [];
  const runs: BenchRun[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    try {
      const path = join(dir, f);
      const raw: Raw = JSON.parse(readFileSync(path, "utf8"));
      const createdAt = statSync(path).mtime.toISOString();
      if (Array.isArray(raw.summaries)) {
        runs.push({
          id: f,
          kind: "bench",
          mode: String(raw.mode ?? ""),
          createdAt,
          status: "complete",
          total: Math.max(0, ...raw.summaries.map((x: Raw) => Number(x.cases) || 0)),
          models: raw.summaries.map((s: Raw) => ({
            model: s.model,
            summary: s,
            cases: ((raw.results?.[s.model] as Raw[]) ?? []).map(toCase),
          })),
        });
      } else if (raw.summary && Array.isArray(raw.results)) {
        runs.push({
          id: f,
          kind: "eval",
          mode: String(raw.mode ?? ""),
          createdAt,
          status: raw.status === "running" ? "running" : "complete",
          total: Number(raw.total) || raw.results.length,
          models: [{ model: raw.model, summary: raw.summary, cases: raw.results.map(toCase) }],
        });
      }
    } catch {
      /* skip unreadable file */
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
