import { Fragment, useMemo, useState } from "react";
import type { BenchCase } from "@/lib/api";
import { caseStatus, categoryLabel, ms, tally, unjudged } from "@/lib/format";
import { Icon } from "@/components/ui/Icon";
import { card } from "./parts";

type Status = "all" | "pass" | "fail" | "error";

const DOT = { pass: "bg-ok", fail: "bg-bad", error: "bg-warn" } as const;
const DOT_TITLE = { pass: "Passed", fail: "Failed a check", error: "Did not complete (error)" } as const;
const field = "h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-fg shadow-card";
const th = "border-b border-line bg-surface-2/50 px-3 py-2.5 text-left text-[12.5px] font-medium whitespace-nowrap text-faint";
const num = "px-3 py-2.5 text-right tabular-nums";

export function CaseTable({ cases }: { cases: BenchCase[] }) {
  const [status, setStatus] = useState<Status>("all");
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const cats = useMemo(() => [...new Set(cases.map((c) => c.category))], [cases]);
  const t = tally(cases);
  const needle = q.trim().toLowerCase();
  const rows = cases.filter(
    (c) =>
      (status === "all" || caseStatus(c) === status) &&
      (cat === "all" || c.category === cat) &&
      (!needle || `${c.id} ${c.message}`.toLowerCase().includes(needle)),
  );
  const tabs: [Status, string][] = [
    ["all", `All ${cases.length}`],
    ["pass", `Passed ${t.passed}`],
    ["fail", `Failed ${t.failed}`],
    ["error", `Errored ${t.errored}`],
  ];

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2.5">
        <div role="tablist" className="inline-flex overflow-hidden rounded-lg border border-line-strong bg-surface shadow-card">
          {tabs.map(([k, label], i) => (
            <button
              key={k}
              role="tab"
              aria-selected={status === k}
              onClick={() => setStatus(k)}
              className={`h-[34px] px-3.5 text-[13.5px] ${i > 0 ? "border-l border-line" : ""} ${status === k ? "bg-active font-medium text-fg" : "text-muted"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category" className={field}>
          <option value="all">All categories</option>
          {cats.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
        <label className={`${field} flex min-w-[180px] flex-1 items-center gap-2 text-faint`}>
          <Icon.search />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search cases"
            aria-label="Search cases"
            className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-faint"
          />
        </label>
      </div>

      <div className={`${card} overflow-x-auto`}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className={`${th} w-9`} aria-label="Expand" />
              <th className={th}>Case</th>
              <th className={th}>Category</th>
              <th className={`${th} text-right`}>First token</th>
              <th className={`${th} text-right`}>Total</th>
              <th className={`${th} text-right`}>Searches</th>
              <th className={`${th} text-right`}>Cites</th>
              <th className={`${th} text-right`}>Judge</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const isOpen = open === c.id;
              const toggle = () => setOpen(isOpen ? null : c.id);
              return (
                <Fragment key={c.id}>
                  <tr onClick={toggle} className={`cursor-pointer border-b border-line hover:bg-hover ${isOpen ? "bg-hover" : ""}`}>
                    <td className="py-1 pl-2 pr-1">
                      <button
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Collapse" : "Expand"} ${c.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle();
                        }}
                        className="grid size-[26px] place-items-center rounded-md text-muted hover:bg-hover"
                      >
                        <Icon.chevron className={`size-4 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span title={DOT_TITLE[caseStatus(c)]} className={`mr-2.5 inline-block size-2 rounded-full ${DOT[caseStatus(c)]}`} />
                      <span className="font-mono text-[13px]">{c.id}</span>
                    </td>
                    <td className="px-3 py-2.5 text-muted">{categoryLabel(c.category)}</td>
                    <td className={num}>{ms(c.ttftMs)}</td>
                    <td className={num}>{ms(c.totalMs)}</td>
                    <td className={num}>{c.searches}</td>
                    <td className={num}>{c.citations}</td>
                    <td className={num}>{unjudged(c) ? <span className="text-muted" title="The judge did not score this case">n/a</span> : c.judged!.score.toFixed(0)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-line bg-canvas">
                      <td colSpan={8} className="px-5 pb-5 pt-[18px]">
                        <div className="grid gap-7 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                          <div>
                            <Label>Question</Label>
                            <p className="mb-4">{c.message}</p>
                            {c.error && (
                              <p className="mb-4 rounded-lg border border-warn/35 bg-warn-bg px-3 py-2 text-[13px] text-warn">
                                The turn did not complete, so this says nothing about answer quality: {c.error}
                              </p>
                            )}
                            <Label>Answer</Label>
                            <pre className="m-0 max-h-[340px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3.5 py-3 font-sans text-[13.5px] leading-relaxed">
                              {c.answer || "(empty)"}
                            </pre>
                          </div>
                          <div>
                            <Label>Checks</Label>
                            <ul className="m-0 mb-4 grid list-none gap-1.5 p-0 text-[13px]">
                              {c.checks.map((k) => (
                                <li key={k.name} className={`flex items-start gap-2 ${k.ok ? "" : "text-bad"}`}>
                                  {k.ok ? <Icon.check className="mt-[3px] size-3.5 text-ok" /> : <Icon.x className="mt-[3px] size-3.5" />}
                                  <span>
                                    {k.name}
                                    {k.detail ? <em className="not-italic text-faint"> · {k.detail}</em> : null}
                                  </span>
                                </li>
                              ))}
                            </ul>
                            {c.judged && !unjudged(c) && (
                              <>
                                <Label>Judge · {c.judged.score}/5</Label>
                                <p className="text-muted">{c.judged.notes}</p>
                              </>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-8 text-center text-muted">
                  No cases match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-1.5 text-xs font-medium text-faint">{children}</h4>;
}
