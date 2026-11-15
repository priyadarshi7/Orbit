import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, streamChat, type AgentEvent, type ConversationSummary, type Health, type Mode, type SourceInfo, type TurnTrace } from "@/lib/api";

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

  const send = useCallback(
    async (text: string, convId = conversationId) => {
      const question = text.trim();
      if (!question || busy) return;
      const aid = uid();
      setMessages((ms) => [
        ...ms,
        { id: uid(), role: "user", content: question, sources: [] },
        { id: aid, role: "assistant", content: "", sources: [], streaming: true, phase: "Starting…", startedAt: Date.now() },
      ]);
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;

      let answerText = "";
      const onEvent = (e: AgentEvent) => {
        switch (e.type) {
          case "status":
            patch(aid, (m) => ({ ...m, phase: phaseLabel(e.phase, e.detail) }));
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
            patch(aid, (m) => ({ ...m, streaming: false, phase: undefined, trace: e.trace, serverId: e.messageId }));
            void fetchSuggestions(aid, question, answerText);
            break;
          case "error":
            patch(aid, (m) => ({ ...m, streaming: false, phase: undefined, error: e.message }));
            break;
        }
      };

      try {
        await streamChat({ message: question, conversationId: convId, tz: tz(), mode }, onEvent, ac.signal);
      } catch (err) {
        const aborted = ac.signal.aborted;
        patch(aid, (m) => ({
          ...m,
          streaming: false,
          phase: undefined,
          stopped: aborted,
          error: aborted ? undefined : err instanceof Error ? err.message : "Connection lost.",
        }));
      } finally {
        patch(aid, (m) => (m.streaming ? { ...m, streaming: false, phase: undefined } : m));
        setBusy(false);
        abortRef.current = null;
        refreshList();
      }
    },
    [busy, conversationId, mode, patch, refreshList, fetchSuggestions],
  );

  const open = useCallback(async (id: string) => {
    abortRef.current?.abort();
    const c = await api.conversation(id);
    setConversationId(c.id);
    setMessages(
      c.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        sources: m.meta?.sources ?? [],
        trace: m.meta?.trace,
        route: m.meta?.trace?.path ? { path: m.meta.trace.path, reason: m.meta.trace.routeReason ?? "" } : undefined,
        plan: m.meta?.trace?.plan?.map((s) => ({ ...s, state: "done" as const })),
        stopped: m.meta?.stopped,
      })),
    );
  }, []);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setConversationId(uid());
    setMessages([]);
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
        setMessages((ms) => ms.filter((m) => m.id !== assistantId && m.id !== q.id));
        void send(q.content);
      }
    },
    [messages, send],
  );

  /** Replace a user message with new text and ask again from there. */
  const edit = useCallback(
    (userMessageId: string, text: string) => {
      const i = messages.findIndex((m) => m.id === userMessageId);
      if (i < 0 || !text.trim()) return;
      setMessages((ms) => ms.slice(0, i));
      void send(text);
    },
    [messages, send],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  useEffect(() => {
    refreshList();
    api.health().then(setHealth).catch(() => setHealth(null));
    const c = new URLSearchParams(location.search).get("c"); // deep link: /?c=<conversation id>
    if (c) void open(c).catch(() => undefined);
  }, [open, refreshList]);

  const modelNote = useMemo(() => {
    if (!health) return "API offline";
    if (health.search === "not configured") return "search not configured";
    return health.models.answer;
  }, [health]);

  return { conversationId, messages, list, busy, health, modelNote, mode, setMode, send, open, newChat, remove, retry, edit, stop };
}
