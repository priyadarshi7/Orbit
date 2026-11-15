import type { ReactNode } from "react";
import type { BenchCase, BenchModel } from "@/lib/api";
import { categoryLabel, compact, ms, pct, toneOf, type Tone } from "@/lib/format";
import { useMemo } from "react";

const TONE_BG: Record<Tone | "fg" | "muted", string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  fg: "bg-fg",
  muted: "bg-faint",
};
const TONE_TEXT: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad" };

export const card = "rounded-xl border border-line bg-surface shadow-card";

export function Bar({ value, max, tone = "fg" }: { value: number; max: number; tone?: Tone | "fg" | "muted" }) {
  return (
    <div aria-hidden className="h-1.5 min-w-[60px] flex-1 overflow-hidden rounded-full bg-surface-2">
      <div className={`h-full rounded-full ${TONE_BG[tone]}`} style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={`${card} min-w-0 p-4`}>
      <div className="text-[12.5px] text-faint">{label}</div>
      <div className="mt-1.5 whitespace-nowrap font-display text-2xl font-extrabold leading-tight tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[12.5px] text-faint">{sub}</div>}
    </div>
  );
}

export function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-14">
      <header className="mb-4">
        <h2 className="font-display text-[22px] font-extrabold leading-tight tracking-tight">{title}</h2>
        {hint && <p className="mt-1 text-[14.5px] text-muted">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

export function Note({ tone, children }: { tone: "warn" | "bad"; children: ReactNode }) {
  const cls = tone === "warn" ? "border-warn/35 bg-warn-bg text-warn" : "border-bad/35 bg-bad-bg text-bad";
  return <div className={`rounded-lg border px-3.5 py-2.5 text-sm ${cls}`}>{children}</div>;
}

export function Categories({ cases }: { cases: BenchCase[] }) {
  const cats = useMemo(() => {
    const by: Record<string, { p: number; t: number }> = {};
    for (const c of cases) {
      const b = (by[c.category] ??= { p: 0, t: 0 });
      b.t++;
      if (c.pass) b.p++;
    }
    return Object.entries(by);
  }, [cases]);
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
      {cats.map(([k, v]) => {
        const tone = toneOf(v.p, v.t);
        return (
          <div key={k} className={`${card} grid min-w-0 content-between gap-2 p-3.5`}>
            <div className="text-[13px] leading-snug text-muted">{categoryLabel(k)}</div>
            <div className={`font-display text-[28px] font-extrabold leading-none tracking-tight ${TONE_TEXT[tone]}`}>
              {v.p}
              <span className="text-base font-bold text-faint">/{v.t}</span>
            </div>
            <Bar value={v.p} max={v.t} tone={tone} />
          </div>
        );
      })}
    </div>
  );
}

export function Latency({ cases }: { cases: BenchCase[] }) {
  const rows = cases.filter((c) => c.totalMs != null).sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0)).slice(0, 8);
  const max = Math.max(1, ...rows.map((r) => r.totalMs ?? 0));
  if (!rows.length) return null;
  return (
    <div className={`${card} grid gap-2.5 px-5 py-[18px]`}>
      {rows.map((r) => (
        <div key={r.id} className="grid grid-cols-[90px_minmax(0,1fr)_56px] items-center gap-3.5 text-[13px] md:grid-cols-[150px_minmax(0,1fr)_70px]">
          <span className="truncate font-mono text-[13px]">{r.id}</span>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="absolute inset-y-0 left-0 rounded-full bg-fg/30" style={{ width: `${((r.totalMs ?? 0) / max) * 100}%` }} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-fg" style={{ width: `${((r.ttftMs ?? 0) / max) * 100}%` }} />
          </div>
          <span className="text-right font-mono text-[13px]">{ms(r.totalMs)}</span>
        </div>
      ))}
      <p className="mt-1 text-[13px] leading-relaxed text-faint">
        The eight slowest cases. The solid segment is time to first token and the lighter one is the rest of the turn. Most of the long waits are
        free-tier rate-limit retries, not model work.
      </p>
    </div>
  );
}

type Summary = Record<string, any>;

export function Comparison({ models }: { models: BenchModel[] }) {
  const sums = models.map((m) => m.summary as Summary);
  const maxT = Math.max(1, ...sums.map((s) => s.ttftP50 ?? 0));
  const maxP = Math.max(1, ...sums.map((s) => s.totalP90 ?? 0));
  const th = "border-b border-line bg-surface-2/50 px-3 py-2.5 text-left text-[12.5px] font-medium text-faint";
  const td = "border-b border-line px-3 py-2.5 last:border-b-0";
  return (
    <div className={`${card} overflow-x-auto`}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className={th}>Model</th>
            <th className={`${th} text-right`}>Pass</th>
            <th className={`${th} text-right`}>Judge</th>
            <th className={th}>First token (p50)</th>
            <th className={th}>Total (p90)</th>
            <th className={`${th} text-right`}>Tokens in / out</th>
          </tr>
        </thead>
        <tbody>
          {sums.map((s) => (
            <tr key={s.model}>
              <td className={`${td} font-mono text-[13px]`}>{s.model}</td>
              <td className={`${td} text-right tabular-nums`}>
                {s.passed}/{s.cases} <span className="text-muted">({pct(s.passed, s.cases)}%)</span>
              </td>
              <td className={`${td} text-right tabular-nums`}>{s.judgeAvg == null ? "n/a" : s.judgeAvg.toFixed(2)}</td>
              <td className={td}>
                <div className="flex min-w-[150px] items-center gap-2.5">
                  <Bar value={s.ttftP50 ?? 0} max={maxT} tone="muted" />
                  <span>{ms(s.ttftP50)}</span>
                </div>
              </td>
              <td className={td}>
                <div className="flex min-w-[150px] items-center gap-2.5">
                  <Bar value={s.totalP90 ?? 0} max={maxP} />
                  <span>{ms(s.totalP90)}</span>
                </div>
              </td>
              <td className={`${td} text-right font-mono text-[13px]`}>
                {compact(s.tokensIn)} / {compact(s.tokensOut)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What flipped between two runs of the same model, on the cases both completed. */
export function Changes({ now, prev, prevLabel }: { now: BenchCase[]; prev: BenchCase[]; prevLabel: string }) {
  const before = new Map(prev.map((c) => [c.id, c]));
  const fixed: string[] = [];
  const broke: string[] = [];
  let compared = 0;
  for (const c of now) {
    const p = before.get(c.id);
    if (!p || c.error || p.error) continue; // an infrastructure error says nothing about the agent
    compared++;
    if (c.pass && !p.pass) fixed.push(c.id);
    if (!c.pass && p.pass) broke.push(c.id);
  }
  if (!compared) return null;
  const list = (ids: string[], cls: string) =>
    ids.length ? (
      ids.map((id) => (
        <span key={id} className={`mr-1.5 rounded-md px-2 py-0.5 font-mono text-xs ${cls}`}>
          {id}
        </span>
      ))
    ) : (
      <span className="text-faint">none</span>
    );
  return (
    <div className={`${card} mt-2.5 grid gap-3 p-4 text-sm md:grid-cols-2`}>
      <div className="text-[12.5px] text-faint md:col-span-2">
        Since the previous run ({prevLabel}), on the {compared} cases that completed in both
      </div>
      <div>
        <div className="mb-1.5 font-medium text-ok">Now passing ({fixed.length})</div>
        <div className="leading-8">{list(fixed, "bg-ok-bg text-ok")}</div>
      </div>
      <div>
        <div className="mb-1.5 font-medium text-bad">Now failing ({broke.length})</div>
        <div className="leading-8">{list(broke, "bg-bad-bg text-bad")}</div>
      </div>
    </div>
  );
}

export function RunProgress({ done, total }: { done: number; total: number }) {
  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 text-sm shadow-card" role="status">
      <i className="size-2 animate-pulse rounded-full bg-accent" />
      <span className="whitespace-nowrap">
        Run in progress: {done} of {total} cases
      </span>
      <Bar value={done} max={total} />
    </div>
  );
}
