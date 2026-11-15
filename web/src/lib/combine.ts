import type { BenchCase, BenchRun } from "@/lib/api";

const pctile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? null;
};

/** Same shape the eval writes, so the page treats a combined view like any other run. */
export function summarizeCases(model: string, cases: BenchCase[]) {
  const judged = cases.map((c) => c.judged?.score).filter((x): x is number => typeof x === "number" && x > 0);
  const num = (f: (c: BenchCase) => number | null) => cases.map(f).filter((x): x is number => typeof x === "number");
  return {
    model,
    cases: cases.length,
    passed: cases.filter((c) => c.pass).length,
    judgeAvg: judged.length ? judged.reduce((a, b) => a + b, 0) / judged.length : null,
    ttftP50: pctile(num((c) => c.ttftMs), 50),
    totalP50: pctile(num((c) => c.totalMs), 50),
    totalP90: pctile(num((c) => c.totalMs), 90),
    tokensIn: cases.reduce((s, c) => s + c.tokensIn, 0),
    tokensOut: cases.reduce((s, c) => s + c.tokensOut, 0),
    cachedIn: cases.reduce((s, c) => s + c.cachedIn, 0),
  };
}

/**
 * For each model with more than one eval run, build a view holding the newest result for every case.
 * A newer run that errored (rate limit, network) does not hide an older run that completed.
 * This lets a partial re-run of failing cases update the picture without repeating the whole suite.
 */
export function combineRuns(runs: BenchRun[]): BenchRun[] {
  const byModel = new Map<string, BenchRun[]>();
  for (const r of runs) {
    if (r.kind !== "eval" || r.models.length !== 1 || !r.models[0]!.cases.length) continue;
    byModel.set(r.models[0]!.model, [...(byModel.get(r.models[0]!.model) ?? []), r]);
  }
  const out: BenchRun[] = [];
  for (const [model, rs] of byModel) {
    if (rs.length < 2) continue;
    const sorted = [...rs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
    const latest = new Map<string, BenchCase>();
    for (const r of sorted) {
      for (const c of r.models[0]!.cases) {
        const cur = latest.get(c.id);
        if (!cur || (cur.error && !c.error)) latest.set(c.id, c);
      }
    }
    // Keep the suite's own order: take it from the run with the most cases.
    const widest = [...rs].sort((a, b) => b.models[0]!.cases.length - a.models[0]!.cases.length)[0]!;
    const order = widest.models[0]!.cases.map((c) => c.id);
    const cases = [...order, ...[...latest.keys()].filter((id) => !order.includes(id))].map((id) => latest.get(id)).filter((c): c is BenchCase => !!c);
    out.push({
      id: `combined:${model}`,
      kind: "eval",
      mode: "combined",
      createdAt: sorted[0]!.createdAt,
      status: "complete",
      total: cases.length,
      models: [{ model, summary: summarizeCases(model, cases), cases }],
    });
  }
  return out;
}
