import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, attachRun, streamChat, type AgentEvent, type ConversationSummary, type Health, type Mode, type SourceInfo, type TurnTrace } from "@/lib/api";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: SourceInfo[];
  streaming?: boolean;
  phase?: string;
  found?: number;
  startedAt?: number;
  error?: string;
  stopped?: boolean;
  trace?: TurnTrace;
  serverId?: string;
  /** Deep path: the visible research plan and each step's progress. */
  plan?: { id: number; question: string; state: "waiting" | "running" | "done" | "failed"; sources?: number }[];
  route?: { path: "fast" | "deep"; reason: string };
  /** Follow-up questions, fetched after the answer is done (never blocks it). */
  suggestions?: string[];
}

const uid = () => crypto.randomUUID();
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function phaseLabel(phase: string, detail?: string): string {
  switch (phase) {
    case "memory":
      return "Checking memory…";
    case "thinking":
      return "Thinking…";
    case "searching":
      return detail ? `Searching: ${detail}` : "Searching the web…";
    case "reading":
      return `Reading ${detail ?? "sources"}…`;
    case "writing":
      return "Checking citations…";
    case "planning":
      return "Planning the research…";
    case "researching":
      return `Researching ${detail ?? ""}…`;
    case "verifying":
      return "Checking claims against sources…";
    default:
      return "Working…";
  }
}

/** All chat state and side effects. UI components stay presentational. */
export function useChat() {
  const [conversationId, setConversationId] = useState<string>(uid);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [mode, setModeState] = useState<Mode>(() => {
    try {
      const v = localStorage.getItem("orbit.mode");
      return v === "fast" || v === "deep" ? v : "auto";
    } catch {
      return "auto";
    }
  });
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem("orbit.mode", m);
    } catch {
      /* optional */
    }
  }, []);

  const refreshList = useCallback(() => void api.conversations().then(setList).catch(() => undefined), []);

  const patch = useCallback((id: string, fn: (m: UiMessage) => UiMessage) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const fetchSuggestions = useCallback(
    async (aid: string, question: string, answer: string) => {
      if (answer.length < 40) return;
      try {
        const { suggestions } = await api.suggest(question, answer);
        if (suggestions.length) patch(aid, (m) => ({ ...m, suggestions }));
      } catch {
        /* chips are optional */
      }
    },
    [patch],
  );

  const loadRef = useRef<((id: string) => Promise<void>) | null>(null);
  const runIdRef = useRef<string | null>(null);
  const stoppingRef = useRef(false);

  /**
   * Applies one run's events to one assistant message. The same code serves a fresh send and re-attaching to a
   * run that is still going (after a reload), because both are just "a stream of events for this run".
   */
  const drive = useCallback(
    async (
      aid: string,
      userUid: string,
      convId: string,
      question: string,
      stream: (onEvent: (e: AgentEvent) => void, signal: AbortSignal, onRun: (id: string) => void) => Promise<void>,
    ) => {
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;
      runIdRef.current = null;
      stoppingRef.current = false;

      let answerText = "";
      const onEvent = (e: AgentEvent) => {
        switch (e.type) {
          case "status":
            patch(aid, (m) => ({ ...m, phase: phaseLabel(e.phase, e.detail) }));
            break;
          case "start":
            // The server saved the question: remember its id (for edit/regenerate) and the conversation it landed in.
            patch(userUid, (m) => ({ ...m, serverId: e.userMessageId }));
            if (e.runId) runIdRef.current = e.runId;
            if (e.conversationId !== convId) setConversationId(e.conversationId);
            break;
          case "route":
            patch(aid, (m) => ({ ...m, route: { path: e.path, reason: e.reason } }));
            break;
          case "plan":
            patch(aid, (m) => ({ ...m, plan: e.steps.map((s) => ({ ...s, state: "waiting" as const })) }));
            break;
          case "step":
            patch(aid, (m) => ({ ...m, plan: m.plan?.map((s) => (s.id === e.id ? { ...s, state: e.state, sources: e.sources ?? s.sources } : s)) }));
            break;
          case "source":
            patch(aid, (m) => ({ ...m, found: (m.found ?? 0) + 1 }));
            break;
          case "token":
            patch(aid, (m) => ({ ...m, content: m.content + e.text, phase: undefined }));
            break;
          case "reset":
            patch(aid, (m) => ({ ...m, content: "" }));
            break;
          case "final":
            answerText = e.text;
            patch(aid, (m) => ({ ...m, content: e.text, sources: e.sources }));
            break;
          case "done":
            patch(aid, (m) => ({ ...m, streaming: false, phase: undefined, trace: e.trace, serverId: e.messageId, stopped: stoppingRef.current || undefined }));
            void fetchSuggestions(aid, question, answerText);
            break;
          case "error":
            patch(aid, (m) => ({ ...m, streaming: false, phase: undefined, error: e.message }));
            break;
        }
      };

      try {
        await stream(onEvent, ac.signal, (id) => (runIdRef.current = id));
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // The run is over and no longer in server memory (a restart, a long wait): show what was saved.
          await loadRef.current?.(convId).catch(() => undefined);
        } else {
          const aborted = ac.signal.aborted;
          patch(aid, (m) => ({
            ...m,
            streaming: false,
            phase: undefined,
            stopped: aborted,
            error: aborted ? undefined : err instanceof Error ? err.message : "Connection lost.",
          }));
        }
      } finally {
        patch(aid, (m) => (m.streaming ? { ...m, streaming: false, phase: undefined } : m));
        setBusy(false);
        if (abortRef.current === ac) abortRef.current = null;
        refreshList();
      }
    },
    [patch, refreshList, fetchSuggestions],
  );

  const send = useCallback(
    async (text: string, convId = conversationId) => {
      const question = text.trim();
      if (!question || busy) return;
      const aid = uid();
      const userUid = uid();
      const requestId = uid(); // the same id on a reconnect attaches to this run instead of starting another
      setMessages((ms) => [
        ...ms,
        { id: userUid, role: "user", content: question, sources: [] },
        { id: aid, role: "assistant", content: "", sources: [], streaming: true, phase: "Starting…", startedAt: Date.now() },
      ]);
      await drive(aid, userUid, convId, question, (onEvent, signal, onRun) =>
        streamChat({ message: question, conversationId: convId, tz: tz(), mode, requestId }, onEvent, signal, onRun),
      );
    },
    [busy, conversationId, mode, drive],
  );

  const open = useCallback(
    async (id: string) => {
      abortRef.current?.abort(); // only closes this connection: a running answer carries on server-side
      const c = await api.conversation(id);
      setConversationId(c.id);
      const msgs: UiMessage[] = c.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        serverId: m.id,
        sources: m.meta?.sources ?? [],
        trace: m.meta?.trace,
        route: m.meta?.trace?.path ? { path: m.meta.trace.path, reason: m.meta.trace.routeReason ?? "" } : undefined,
        plan: m.meta?.trace?.plan?.map((s) => ({ ...s, state: "done" as const })),
        stopped: m.meta?.stopped,
      }));
      const last = c.messages.at(-1);
      const run = c.run;
      // A question with no answer after it is either still being answered (follow it) or was cut off (say so, offer Retry).
      if (run && last?.role === "user") {
        const aid = uid();
        if (run.status === "running") {
          msgs.push({ id: aid, role: "assistant", content: "", sources: [], streaming: true, phase: "Reconnecting…", startedAt: Date.now() });
          setMessages(msgs);
          void drive(aid, last.id, c.id, last.content, (onEvent, signal, onRun) => attachRun(run.id, onEvent, signal, onRun));
          return;
        }
        if (run.status === "interrupted" || run.status === "failed") {
          msgs.push({ id: aid, role: "assistant", content: "", sources: [], error: run.error ?? "This answer was interrupted." });
        }
      }
      setMessages(msgs);
    },
    [drive],
  );
  loadRef.current = open;

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setConversationId(uid());
    setMessages([]);
    try {
      sessionStorage.removeItem("orbit.conv");
    } catch {
      /* optional */
    }
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await api.remove(id);
      if (id === conversationId) newChat();
      refreshList();
    },
    [conversationId, newChat, refreshList],
  );

  /** Re-ask the question that produced this assistant message. */
  const retry = useCallback(
    (assistantId: string) => {
      const i = messages.findIndex((m) => m.id === assistantId);
      const q = messages[i - 1];
      if (q?.role === "user") {
        void (async () => {
          // Drop the old attempt on the server too, so history and memory do not keep it.
          if (q.serverId) await api.rewind(conversationId, q.serverId).catch(() => undefined);
          setMessages((ms) => ms.filter((m) => m.id !== assistantId && m.id !== q.id));
          void send(q.content);
        })();
      }
    },
    [messages, send, conversationId],
  );

  /** Replace a user message with new text and ask again from there. */
  const edit = useCallback(
    (userMessageId: string, text: string) => {
      const i = messages.findIndex((m) => m.id === userMessageId);
      if (i < 0 || !text.trim()) return;
      const target = messages[i]!;
      void (async () => {
        if (target.serverId) await api.rewind(conversationId, target.serverId).catch(() => undefined);
        setMessages((ms) => ms.slice(0, i));
        void send(text);
      })();
    },
    [messages, send, conversationId],
  );

  /** Stop is a request to the server: it ends the run with the answer so far, which then arrives on this same stream. */
  const stop = useCallback(() => {
    const ac = abortRef.current;
    const id = runIdRef.current;
    stoppingRef.current = true;
    if (!id) {
      ac?.abort(); // the turn has not started on the server yet
      return;
    }
    void api.cancel(id).catch(() => ac?.abort());
    setTimeout(() => ac?.abort(), 4000); // safety net if the closing events never arrive
  }, []);

  useEffect(() => {
    refreshList();
    api.health().then(setHealth).catch(() => setHealth(null));
    // Deep link (/?c=<id>), else the chat this tab had open, so a refresh lands back in it (and re-attaches to a running answer).
    let remembered: string | null = null;
    try {
      remembered = sessionStorage.getItem("orbit.conv");
    } catch {
      /* optional */
    }
    const c = new URLSearchParams(location.search).get("c") ?? remembered;
    if (c) void open(c).catch(() => undefined);
  }, [open, refreshList]);

  useEffect(() => {
    if (messages.length === 0) return;
    try {
      sessionStorage.setItem("orbit.conv", conversationId);
    } catch {
      /* optional */
    }
  }, [conversationId, messages.length]);

  const modelNote = useMemo(() => {
    if (!health) return "API offline";
    if (health.search === "not configured") return "search not configured";
    return health.models.answer;
  }, [health]);

  return { conversationId, messages, list, busy, health, modelNote, mode, setMode, send, open, newChat, remove, retry, edit, stop };
}
