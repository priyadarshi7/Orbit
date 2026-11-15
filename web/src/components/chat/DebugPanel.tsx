import type { TurnTrace } from "@/lib/api";

const STAGE_COLOR: Record<string, string> = {
  context: "var(--faint)",
  "model(tool)": "var(--muted)",
  "model(answer)": "var(--fg)",
  retrieval: "var(--accent)",
};
const colorOf = (stage: string) => STAGE_COLOR[stage] ?? "var(--faint)";

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <span className="block text-[11.5px] text-faint">{k}</span>
      <b className="break-words font-mono text-[13px] font-medium">{v}</b>
    </div>
  );
}

export function DebugPanel({ trace }: { trace: TurnTrace }) {
  const total = Math.max(trace.totalMs, 1);
  const u = trace.usage;
  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-4 text-[13px] shadow-card">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-x-5 gap-y-3">
        <Stat k="Model" v={trace.model + (trace.usedFallbackModel ? " (fallback)" : "")} />
        <Stat k="First token" v={trace.firstTokenMs != null ? `${trace.firstTokenMs} ms` : "—"} />
        <Stat k="Total" v={`${trace.totalMs} ms`} />
        <Stat k="Model calls" v={String(u.steps)} />
        {trace.costUsd != null && <Stat k="Estimated cost" v={`$${trace.costUsd < 0.01 ? trace.costUsd.toFixed(5) : trace.costUsd.toFixed(3)}`} />}
        <Stat k="Tokens in / out" v={`${u.inputTokens} / ${u.outputTokens}`} />
        <Stat k="Cached input" v={u.inputTokens ? `${u.cachedInputTokens} of ${u.inputTokens} (${Math.round((u.cachedInputTokens / u.inputTokens) * 100)}%)` : "0"} />
        <Stat
          k="Memory"
          v={trace.memory.hadRecord === false ? "date referenced, no record" : `${trace.memory.episodes} episodes, ${trace.memory.claims} claims`}
        />
        <Stat k="Citations" v={`${trace.citations.cited.length} kept, ${trace.citations.dropped.length} dropped`} />
      </div>

      <div className="relative mb-3 mt-[18px] h-2 overflow-hidden rounded bg-surface-2" role="img" aria-label="Stage timings">
        {trace.timings.map((t, i) => (
          <div
            key={i}
            title={`${t.stage}: ${t.endMs - t.startMs} ms${t.detail ? ` · ${t.detail}` : ""}`}
            className="absolute inset-y-0 border-r border-surface"
            style={{
              left: `${(t.startMs / total) * 100}%`,
              width: `${Math.max(((t.endMs - t.startMs) / total) * 100, 0.8)}%`,
              background: colorOf(t.stage),
            }}
          />
        ))}
      </div>
      <ul className="m-0 grid list-none gap-1 p-0 text-[12.5px] text-fg-2">
        {trace.timings.map((t, i) => (
          <li key={i} className="flex items-center gap-2">
            <i className="size-2 shrink-0 rounded-[2px]" style={{ background: colorOf(t.stage) }} />
            <b className="font-medium">{t.stage}</b> {t.endMs - t.startMs} ms
            {t.detail && <span className="text-muted"> · {t.detail}</span>}
          </li>
        ))}
      </ul>

      {trace.searches.length > 0 && (
        <div className="mt-3 grid gap-0.5 font-mono text-xs text-muted">
          {trace.searches.map((s, i) => (
            <div key={i}>
              <span className="text-faint">
                search {i + 1} · {s.depth}
                {s.cached ? " · cached" : ""}:
              </span>{" "}
              {s.queries.join(" | ")}
            </div>
          ))}
        </div>
      )}
      {trace.warnings.length > 0 && (
        <ul className="m-0 mt-3 grid list-none gap-1 p-0 text-[12.5px] text-warn">
          {trace.warnings.map((w, i) => (
            <li key={i}>Warning: {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
