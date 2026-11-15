import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { CaseTable } from "@/components/benchmark/CaseTable";
import { Categories, Changes, Comparison, Latency, Note, RunProgress, Section, Stat, card } from "@/components/benchmark/parts";
import { Brand } from "@/components/ui/Brand";
import { LinkButton } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { api, type BenchRun } from "@/lib/api";
import { combineRuns } from "@/lib/combine";
import { compact, ms, pct, tally, unjudged, when } from "@/lib/format";

const METHOD: [string, string][] = [
  ["Cases", "Hand-written cases grouped by skill. They test behaviours (searching when needed, citing, resisting injection, recalling dates), not just the three sample questions."],
  ["Checks", "Deterministic assertions per case: searched or correctly did not, cited real sources, avoided forbidden strings, resolved dates, resisted injection."],
  ["Judge", "A separate small model scores each answer from 1 to 5 using only the question, the answer and a rubric. It does not see the retrieved sources or memory, and its knowledge ends before late 2026, so it can mark correct recent facts as wrong. Treat it as advisory; pass or fail comes from the code checks."],
  ["Modes", "Live uses a real model and real search. Record is live and saves search results. Replay runs the model on those frozen results so models are compared on identical evidence."],
  ["Latency", "Time to first token is measured from sending the question. Totals include search and page reads. Free-tier rate limits add waiting time, so read speeds as indicative."],
];

const NAV = [
  ["overview", "Overview"],
  ["categories", "Categories"],
  ["latency", "Latency"],
  ["cases", "Cases"],
  ["method", "Method"],
] as const;

const select = "h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-fg shadow-card";

export function BenchmarkPage() {
  const [runs, setRuns] = useState<BenchRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [mi, setMi] = useState(0);

  const load = useCallback((first = false) => {
    api
      .benchmarks()
      .then((r) => {
        setRuns(r);
        setError(null);
        if (!first) return;
        // Default to a run in progress, else the most informative one (most cases).
        let best = r.findIndex((x) => x.status === "running");
        if (best < 0) {
          best = 0;
          r.forEach((x, i) => {
            if ((x.models[0]?.cases.length ?? 0) > (r[best]?.models[0]?.cases.length ?? 0)) best = i;
          });
        }
        // A combined "latest result per case" view comes first when it exists.
        const combined = combineRuns(r).length;
        setSel(r.some((x) => x.status === "running") ? best + combined : combined > 0 ? 0 : best);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    document.title = "Benchmarks · Orbit";
    load(true);
  }, [load]);

  // While a run is in progress, refresh every few seconds.
  const live = runs?.some((r) => r.status === "running") ?? false;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => load(), 5000);
    return () => clearInterval(timer);
  }, [live, load]);

  const all = useMemo(() => (runs ? [...combineRuns(runs), ...runs] : null), [runs]);
  const run = all?.[sel];
  const model = run?.models[Math.min(mi, (run?.models.length ?? 1) - 1)];
  const s = (model?.summary ?? {}) as Record<string, any>;
  const nUnjudged = model ? model.cases.filter(unjudged).length : 0;
  const t = tally(model?.cases ?? []);
  // The previous comparable run: same model, older, finished, with at least half as many cases.
  const prev =
    run && model
      ? runs!
          .filter(
            (r) =>
              r.createdAt < run.createdAt &&
              r.status === "complete" &&
              r.models.length === 1 &&
              r.models[0]!.model === model.model &&
              r.models[0]!.cases.length * 2 >= model.cases.length,
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      : undefined;
  const slow = (s.totalP90 ?? 0) > 30_000;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1080px] items-center gap-6 px-3.5 md:px-5">
          <Link to="/" aria-label="Back to chat" className="text-fg no-underline">
            <Brand />
          </Link>
          <nav aria-label="Sections" className="hidden flex-1 gap-1 md:flex">
            {NAV.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="rounded-lg px-2.5 py-1.5 text-sm text-muted no-underline hover:bg-hover hover:text-fg">
                {label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <LinkButton href="/">
              <Icon.arrowRight /> Open chat
            </LinkButton>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1080px] px-3.5 pb-24 pt-7 md:px-5 md:pt-10">
        <section id="overview" className="mb-7">
          <h1 className="mb-3 font-display text-[34px] font-extrabold leading-[1.05] tracking-[-0.035em] md:text-[44px]">Benchmarks</h1>
          <p className="max-w-[70ch] text-base text-muted">
            {model && run ? (
              <>
                <b className="text-fg">
                  {t.passed} of {t.total}
                </b>{" "}
                cases passed ({pct(t.passed, t.total)}%) on <span className="font-mono text-sm">{model.model}</span>.
                {t.errored > 0 && <> {t.errored} did not complete (errors, usually rate limits) and {t.failed} failed a check.</>}
                {t.errored === 0 && t.failed > 0 && <> {t.failed} failed a check.</>} {run.mode === "combined" ? "Combined view: the newest completed result for each case across runs." : `${run.kind === "bench" ? "Bench" : "Eval"} run, ${run.mode} mode, ${when(run.createdAt)}.`}
              </>
            ) : (
              <>
                Pass rate, grounding, latency and safety on a fixed suite, read from saved runs in <span className="font-mono text-sm">eval-results/</span>.
              </>
            )}
          </p>
        </section>

        {error && <Note tone="bad">Could not load results: {error}. Is the API running?</Note>}
        {!runs && !error && (
          <div aria-busy className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <i key={i} className={`${card} h-[92px] animate-pulse`} />
            ))}
          </div>
        )}
        {runs && !runs.length && (
          <div className="rounded-xl border border-dashed border-line-strong bg-surface p-7">
            <h3 className="mb-1 font-bold">No runs yet</h3>
            <p className="mb-3 text-muted">Create one, then refresh this page:</p>
            <pre className="m-0 overflow-x-auto rounded-lg border border-line bg-code px-4 py-3.5 font-mono text-[13px]">npm run eval -- --mode record --judge</pre>
          </div>
        )}

        {runs && run && model && (
          <>
            <div className="mb-4 flex flex-wrap gap-3">
              <label className="grid min-w-0 flex-[1_1_280px] gap-1.5 text-xs text-faint">
                Run
                <select
                  className={select}
                  value={sel}
                  onChange={(e) => {
                    setSel(Number(e.target.value));
                    setMi(0);
                  }}
                >
                  {all!.map((r, i) => (
                    <option key={r.id} value={i}>
                      {r.mode === "combined" ? "Latest result per case (combined) · " : `${when(r.createdAt)} · ${r.mode} · `} {r.models.map((m) => m.model).join(", ")} · {r.models[0]?.cases.length ?? 0} cases
                    </option>
                  ))}
                </select>
              </label>
              {run.models.length > 1 && (
                <label className="grid min-w-0 flex-[1_1_280px] gap-1.5 text-xs text-faint">
                  Model
                  <select className={select} value={mi} onChange={(e) => setMi(Number(e.target.value))}>
                    {run.models.map((m, i) => (
                      <option key={m.model} value={i}>
                        {m.model}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {run.status === "running" && <RunProgress done={model.cases.length} total={run.total} />}

            {(nUnjudged > 0 || slow || t.errored > 0) && (
              <div className="mb-4 grid gap-2">
                {t.errored > 0 && (
                  <Note tone="warn">
                    {t.errored} of {t.total} cases errored before answering, so they count as not passed. Among the {t.answered} that answered, {t.passed} passed ({pct(t.passed, t.answered)}%).
                  </Note>
                )}
                {nUnjudged > 0 && (
                  <Note tone="warn">
                    {nUnjudged} of {model.cases.length} cases have no judge score (judge quota or error), so the judge average covers only the rest.
                  </Note>
                )}
                {slow && (
                  <Note tone="warn">
                    The slowest 10% took {ms(s.totalP90)}. On the Groq free tier this is mostly rate-limit waiting, not model speed.
                  </Note>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
              <Stat label="Pass rate" value={`${pct(t.passed, t.total)}%`} sub={t.errored ? `${pct(t.passed, t.answered)}% of answered` : `${t.passed} of ${t.total} cases`} />
              <Stat label="Judge average" value={s.judgeAvg == null ? "n/a" : `${s.judgeAvg.toFixed(1)} / 5`} sub={`${model.cases.length - nUnjudged} judged`} />
              <Stat label="First token (p50)" value={ms(s.ttftP50)} />
              <Stat label="Total (p50)" value={ms(s.totalP50)} sub={`p90 ${ms(s.totalP90)}`} />
              <Stat label="Tokens in / out" value={`${compact(s.tokensIn)} / ${compact(s.tokensOut)}`} sub={`${compact(s.cachedIn)} cached`} />
            </div>

            {prev && <Changes now={model.cases} prev={prev.models[0]!.cases} prevLabel={when(prev.createdAt)} />}

            {run.models.length > 1 && (
              <Section id="compare" title="Model comparison" hint="Same cases, same evidence when run in replay mode.">
                <Comparison models={run.models} />
              </Section>
            )}
            <Section id="categories" title="By category" hint="Pass rate for each behaviour the suite covers.">
              <Categories cases={model.cases} />
            </Section>
            <Section id="latency" title="Latency" hint="Where the time goes.">
              <Latency cases={model.cases} />
            </Section>
            <Section id="cases" title="Cases" hint="Select a row for the question, full answer, every check and the judge's notes.">
              <CaseTable key={`${run.id}-${model.model}`} cases={model.cases} />
            </Section>
          </>
        )}

        <Section id="method" title="Method" hint="How to read these numbers.">
          <dl className="m-0 grid gap-2.5 md:grid-cols-2">
            {METHOD.map(([k, v]) => (
              <div key={k} className={`${card} px-4 py-3.5`}>
                <dt className="font-bold">{k}</dt>
                <dd className="mt-1 text-sm text-muted">{v}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mb-2 mt-6 text-[13px] font-medium text-faint">Reproduce</h3>
          <pre className="m-0 overflow-x-auto rounded-lg border border-line bg-code px-4 py-3.5 font-mono text-[13px] leading-relaxed">{`npm run eval  -- --mode record --judge
npm run bench -- --models groq:openai/gpt-oss-120b,google:gemini-2.5-flash --mode replay --judge
npm run bench -- --search exa`}</pre>
          <p className="mt-2 text-[13px] text-faint">The suite is small, so it is a signal and not a leaderboard. The judge is itself a model.</p>
        </Section>
      </main>
    </div>
  );
}
