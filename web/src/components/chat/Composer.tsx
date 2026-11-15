import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import type { Mode } from "@/lib/api";

export const COMPOSER_ID = "composer-input";

interface Props {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  mode: Mode;
  onMode: (m: Mode) => void;
}

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Orbit picks: quick answers for most questions, deep research for big ones" },
  { id: "fast", label: "Fast", hint: "One focused search-and-answer pass" },
  { id: "deep", label: "Deep", hint: "Plan, research sub-questions in parallel, write a report, check the claims. Slower" },
];

export function Composer({ busy, onSend, onStop, mode, onMode }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    if (!text.trim() || busy) return;
    onSend(text);
    setText("");
  };

  return (
    <div className="mx-auto w-full max-w-[760px] px-3.5 pb-3.5 pt-2 md:px-5">
      <div className="flex items-end gap-2 rounded-[14px] border border-line-strong bg-surface py-2 pl-4 pr-2 shadow-pop transition-colors focus-within:border-fg-2">
        <textarea
          id={COMPOSER_ID}
          ref={ref}
          value={text}
          rows={1}
          autoFocus
          placeholder="Ask a question…"
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-[200px] flex-1 resize-none bg-transparent py-[5px] text-fg outline-none placeholder:text-faint"
        />
        {busy ? (
          <button onClick={onStop} aria-label="Stop" className="grid size-[34px] place-items-center rounded-[9px] border border-line-strong bg-surface-2 text-fg">
            <Icon.stop />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim()}
            aria-label="Send"
            className="grid size-[34px] place-items-center rounded-[9px] bg-primary text-primary-fg transition-opacity hover:opacity-90 disabled:opacity-25"
          >
            <Icon.arrowUp />
          </button>
        )}
      </div>
      <div role="radiogroup" aria-label="Answer mode" className="mt-2 flex items-center justify-center gap-1">
        {MODES.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={mode === o.id}
            title={o.hint}
            onClick={() => onMode(o.id)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${mode === o.id ? "bg-hover font-medium text-fg" : "text-faint hover:text-fg"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-center text-xs text-faint">
        Enter to send · Shift+Enter for a new line · <Kbd>/</Kbd> to focus · <Kbd>Ctrl K</Kbd> new chat
      </p>
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded-[5px] border border-b-2 border-line-strong bg-surface px-1.5 py-px font-mono text-[11px] text-muted">{children}</kbd>;
}
