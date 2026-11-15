import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UiMessage } from "@/hooks/useChat";
import type { SourceInfo } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { DebugPanel } from "./DebugPanel";

/** Turn "[1]" / "[1, 2]" into links the renderer shows as citation chips (code spans untouched). */
function linkCitations(text: string, known: Set<number>): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g, (m, list: string) => {
            const ids = list.split(",").map((s) => Number(s.trim()));
            if (!ids.every((id) => known.has(id))) return m;
            return ids.map((id) => `[${id}](cite:${id})`).join("");
          }),
    )
    .join("");
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono text-xs text-faint">{((now - since) / 1000).toFixed(1)}s</span>;
}

/** A citation chip that opens a small card (title, domain, date) on hover or keyboard focus. */
function Cite({ s, children }: { s: SourceInfo; children: ReactNode }) {
  return (
    <span className="group/cite relative inline-block">
      <a
        href={s.url}
        target="_blank"
        rel="noreferrer noopener"
        className="mx-px inline-grid h-[18px] min-w-[18px] place-items-center rounded-[5px] border border-line bg-surface-2 px-1 align-[1px] font-mono text-[11px] font-medium !text-muted !no-underline transition-colors hover:border-accent hover:bg-accent-bg hover:!text-fg focus-visible:border-accent"
      >
        {children}
      </a>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-0 z-20 mb-2 w-64 rounded-lg border border-line-strong bg-surface p-3 text-left text-[13px] leading-snug opacity-0 shadow-pop transition-opacity group-focus-within/cite:visible group-focus-within/cite:opacity-100 group-hover/cite:visible group-hover/cite:opacity-100"
      >
        <span className="block font-medium text-fg">{s.title || s.domain}</span>
        <span className="mt-1 block font-mono text-[11.5px] text-faint">
          {s.domain}
          {s.publishedDate ? ` · ${s.publishedDate}` : ""}
        </span>
      </span>
    </span>
  );
}

/** Fenced code with a copy button. */
function CodeBlock(props: ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [done, setDone] = useState(false);
  return (
    <div className="group/code relative">
      <pre ref={ref} {...props} />
      <button
        aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard?.writeText(ref.current?.innerText ?? "").then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
        className="absolute right-2 top-2 grid size-7 place-items-center rounded-md border border-line bg-surface text-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/code:opacity-100"
      >
        {done ? <Icon.check /> : <Icon.copy />}
      </button>
    </div>
  );
}

interface Props {
  m: UiMessage;
  onRetry: () => void;
  onEdit: (text: string) => void;
  onAsk: (text: string) => void;
  canRegenerate?: boolean;
  canEdit?: boolean;
}

export function MessageView({ m, onRetry, onEdit, onAsk, canRegenerate, canEdit }: Props) {
  const [debug, setDebug] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);

  if (m.role === "user") {
    if (editing) {
      return (
        <div className="ml-auto w-full max-w-[82%] animate-fade">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                setEditing(false);
                onEdit(draft);
              }
              if (e.key === "Escape") setEditing(false);
            }}
            rows={Math.min(8, Math.max(2, draft.split("\n").length))}
            className="w-full resize-none rounded-xl border border-fg-2 bg-surface px-3.5 py-[9px] text-fg outline-none"
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => { setEditing(false); onEdit(draft); }} disabled={!draft.trim()}>
              Send
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="group/user flex animate-fade items-start justify-end gap-1.5">
        {canEdit && (
          <button
            aria-label="Edit message"
            title="Edit message"
            onClick={() => {
              setDraft(m.content);
              setEditing(true);
            }}
            className="mt-1.5 grid size-7 place-items-center rounded-md text-faint opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/user:opacity-100"
          >
            <Icon.pencil />
          </button>
        )}
        <div className="max-w-[92%] whitespace-pre-wrap break-words rounded-xl border border-line bg-surface-2 px-3.5 py-[9px] md:max-w-[82%]">{m.content}</div>
      </div>
    );
  }

  const byId = new Map(m.sources.map((s) => [s.id, s]));
  const body = linkCitations(m.content, new Set(byId.keys()));
  const copy = () => {
    void navigator.clipboard?.writeText(m.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="min-w-0 animate-fade">
      {m.streaming && (m.phase || !m.content) && (
        <div className="flex flex-wrap items-center gap-2.5 pb-2 pt-0.5 text-sm">
          <span className="animate-sheen bg-[linear-gradient(90deg,var(--faint)_0%,var(--fg)_50%,var(--faint)_100%)] bg-[length:200%_100%] bg-clip-text text-transparent">
            {m.phase ?? "Thinking…"}
          </span>
          {m.found ? <span className="font-mono text-xs text-faint">{m.found} sources</span> : null}
          {m.startedAt ? <Elapsed since={m.startedAt} /> : null}
        </div>
      )}

      {m.plan && m.plan.length > 0 && <PlanView m={m} />}

      {m.content && (
        <div className="prose-chat">
          <Markdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(u) => u}
            components={{
              pre: CodeBlock,
              table: ({ children }) => (
                <div className="table-wrap" tabIndex={0} role="region" aria-label="Table">
                  <table>{children}</table>
                </div>
              ),
              a: ({ href, children }) => {
                if (href?.startsWith("cite:")) {
                  const s = byId.get(Number(href.slice(5)));
                  return s ? <Cite s={s}>{children}</Cite> : <>{children}</>;
                }
                return (
                  <a href={href} target="_blank" rel="noreferrer noopener">
                    {children}
                  </a>
                );
              },
            }}
          >
            {body}
          </Markdown>
          {m.streaming && <span aria-hidden className="ml-0.5 inline-block h-[1.05em] w-[7px] animate-blink rounded-[1px] bg-accent align-text-bottom" />}
        </div>
      )}

      {m.error && (
        <div className="mt-2 flex items-center justify-between gap-3.5 rounded-xl border border-bad/30 bg-bad-bg px-3.5 py-[9px] text-sm text-bad">
          {m.error}
          <Button variant="ghost" onClick={onRetry}>
            <Icon.refresh /> Try again
          </Button>
        </div>
      )}
      {m.stopped && <div className="text-sm text-muted">Stopped.</div>}

      {m.sources.length > 0 && !m.streaming && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5" aria-label="Sources">
          <span className="mr-1 text-xs font-medium text-faint">Sources · {m.sources.length}</span>
          {m.sources.map((s) => (
            <a
              key={s.id}
              href={s.url}
              target="_blank"
              rel="noreferrer noopener"
              title={s.title}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface py-1 pl-[5px] pr-2.5 text-[12.5px] text-fg-2 no-underline shadow-card transition-colors hover:border-line-strong hover:bg-surface-2"
            >
              <b className="grid size-[19px] place-items-center rounded-[5px] border border-line bg-surface-2 font-mono text-[11px] font-medium text-muted">{s.id}</b>
              <span className="truncate">{s.domain}</span>
              {s.publishedDate && <span className="font-mono text-[11px] text-faint">{s.publishedDate}</span>}
            </a>
          ))}
        </div>
      )}

      {!m.streaming && m.content && (
        <div className="-ml-1.5 mt-2.5 flex items-center gap-1">
          <Button variant="ghost" onClick={copy} aria-label="Copy answer">
            {copied ? <Icon.check /> : <Icon.copy />} {copied ? "Copied" : "Copy"}
          </Button>
          {canRegenerate && (
            <Button variant="ghost" onClick={onRetry}>
              <Icon.refresh /> Regenerate
            </Button>
          )}
          {m.trace && (
            <Button variant="ghost" onClick={() => setDebug((d) => !d)} aria-expanded={debug}>
              {debug ? "Hide details" : `Details · ${(m.trace.totalMs / 1000).toFixed(1)}s`}
            </Button>
          )}
        </div>
      )}
      {debug && m.trace && !m.streaming && <DebugPanel trace={m.trace} />}

      {canRegenerate && m.suggestions && m.suggestions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggested follow-ups">
          {m.suggestions.map((s) => (
            <button
              key={s}
              onClick={() => onAsk(s)}
              className="rounded-full border border-line-strong bg-surface px-3 py-1.5 text-left text-[13.5px] text-fg-2 shadow-card transition-colors hover:bg-surface-2 hover:text-fg"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The deep path's visible work: which sub-questions were researched, and how each went. */
function PlanView({ m }: { m: UiMessage }) {
  const plan = m.plan ?? [];
  const v = m.trace?.verification;
  return (
    <div className="mb-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-sm">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
        <span className="font-medium text-fg">Deep research</span>
        {m.route?.reason ? <span className="truncate">{m.route.reason}</span> : null}
      </div>
      <ol className="space-y-1.5">
        {plan.map((s) => (
          <li key={s.id} className="flex items-start gap-2">
            <span
              aria-hidden
              className={`mt-[5px] size-2 shrink-0 rounded-full ${s.state === "done" ? "bg-ok" : s.state === "failed" ? "bg-bad" : s.state === "running" ? "animate-pulse bg-accent" : "bg-line-strong"}`}
            />
            <span className={s.state === "waiting" ? "text-faint" : "text-fg"}>
              {s.question}
              {s.state === "done" && s.sources ? <span className="ml-1.5 font-mono text-xs text-faint">{s.sources} new sources</span> : null}
              {s.state === "failed" ? <span className="ml-1.5 text-xs text-bad">failed</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {v && (
        <p className="mt-2 border-t border-line pt-2 text-xs text-muted">
          {v.unsupported === 0 ? `Checked ${v.checked} cited sources: every claim matched.` : `Checked ${v.checked} cited sources: ${v.unsupported} unsupported claim${v.unsupported > 1 ? "s" : ""} ${v.revised ? "removed or softened" : "found"}.`}
        </p>
      )}
    </div>
  );
}
