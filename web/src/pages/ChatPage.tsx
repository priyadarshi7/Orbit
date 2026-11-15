import { useCallback, useEffect, useRef, useState } from "react";
import { COMPOSER_ID, Composer } from "@/components/chat/Composer";
import { MemoryModal } from "@/components/chat/MemoryModal";
import { MessageView } from "@/components/chat/MessageView";
import { Sidebar } from "@/components/chat/Sidebar";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { useChat } from "@/hooks/useChat";

const EXAMPLES = [
  "What changed in the latest Node.js LTS release?",
  "Compare managed Postgres hosting for a small SaaS",
  "What did I ask you last Tuesday?",
  "Explain how HTTP/3 differs from HTTP/2",
];

const focusComposer = () => document.getElementById(COMPOSER_ID)?.focus();

export function ChatPage() {
  const chat = useChat();
  const { messages, busy, health, send, newChat } = chat;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Keep pinned to the bottom while streaming, unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const startNew = useCallback(() => {
    newChat();
    setSidebarOpen(false);
    setTimeout(focusComposer, 0);
  }, [newChat]);

  const submit = useCallback(
    (text: string) => {
      stickRef.current = true;
      void send(text);
    },
    [send],
  );

  // Shortcuts: "/" focuses the composer, Ctrl/Cmd+K starts a new chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        startNew();
      } else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        focusComposer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startNew]);

  const searchMissing = health?.search === "not configured";

  return (
    <div className="grid h-screen md:grid-cols-[264px_minmax(0,1fr)]">
      <Sidebar
        open={sidebarOpen}
        list={chat.list}
        activeId={chat.conversationId}
        onNew={startNew}
        onOpen={(id) => {
          void chat.open(id);
          setSidebarOpen(false);
        }}
        onDelete={(id) => void chat.remove(id)}
        onMemory={() => setShowMemory(true)}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="relative flex min-h-0 min-w-0 flex-col">
        <header className="flex h-[52px] items-center gap-2 border-b border-line px-4">
          <IconButton label="Open sidebar" className="md:hidden" onClick={() => setSidebarOpen(true)}>
            <Icon.menu />
          </IconButton>
          <span className="flex-1" />
          <span
            title="Answer model"
            className={`inline-flex max-w-[46vw] items-center gap-[7px] truncate rounded-full border border-line px-2.5 py-[3px] font-mono text-xs ${health ? "text-muted" : "text-bad"}`}
          >
            <i className={`size-1.5 shrink-0 rounded-full ${health ? "bg-ok" : "bg-bad"}`} />
            {chat.modelNote}
          </span>
          <ThemeToggle />
        </header>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
            stickRef.current = gap < 80;
            setShowJump(gap > 240);
          }}
        >
          {messages.length === 0 ? (
            <div className="mx-auto max-w-[640px] px-5 pt-[14vh]">
              <h1 className="mb-3 font-display text-3xl font-extrabold leading-[1.1] tracking-tight md:text-[38px]">What do you want to look into?</h1>
              <p className="mb-8 max-w-[52ch] text-base text-muted">Orbit searches the web when it needs to, cites what it finds, and remembers earlier chats.</p>
              <div className="grid gap-2">
                {EXAMPLES.map((q) => (
                  <button
                    key={q}
                    onClick={() => submit(q)}
                    disabled={busy}
                    className="group flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-[13px] text-left text-[14.5px] text-fg-2 shadow-card transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-fg"
                  >
                    <span>{q}</span>
                    <Icon.arrowRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
                  </button>
                ))}
              </div>
              {searchMissing && <p className="mt-6 text-sm text-warn">Web search is not configured. Set TAVILY_API_KEY (or EXA_API_KEY) in .env and restart the API.</p>}
            </div>
          ) : (
            <div className="mx-auto flex max-w-[760px] flex-col gap-7 px-3.5 pb-4 pt-7 md:px-5">
              {messages.map((m, i) => (
                <MessageView
                  key={m.id}
                  m={m}
                  onRetry={() => chat.retry(m.id)}
                  onResume={() => chat.resume(m.id)}
                  onEdit={(text) => chat.edit(m.id, text)}
                  onAsk={submit}
                  canEdit={!busy && m.role === "user" && i === messages.length - 2}
                  canRegenerate={!busy && i === messages.length - 1 && m.role === "assistant"}
                />
              ))}
            </div>
          )}
        </div>

        {showJump && (
          <button
            aria-label="Jump to latest"
            onClick={() => {
              stickRef.current = true;
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
            }}
            className="absolute bottom-[140px] left-1/2 z-[5] grid size-[34px] -translate-x-1/2 place-items-center rounded-full border border-line-strong bg-surface text-fg shadow-pop hover:bg-surface-2 md:bottom-32"
          >
            <Icon.arrowDown />
          </button>
        )}

        <Composer busy={busy} onSend={submit} onStop={chat.stop} mode={chat.mode} onMode={chat.setMode} />
      </main>

      {showMemory && <MemoryModal onClose={() => setShowMemory(false)} />}
    </div>
  );
}
