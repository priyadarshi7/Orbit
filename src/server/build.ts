import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runTurn } from "../agent/run";
import { searchLabel, type createApp } from "../app";
import { providerAvailability } from "../models";
import { suggestFollowUps } from "../agent/suggest";
import { LEGACY_USER } from "../memory/store";
import { bearer, Sessions } from "./auth";
import { loadBenchmarks } from "./benchmarks";
import { ConcurrencyGate, TokenBucketLimiter, type RateLimiter } from "./ratelimit";
import type { Checkpoint } from "../agent/checkpoint";
import { RunManager, type ActiveRun } from "./runs";

const ChatBody = z.object({
  message: z.string().trim().min(1).max(8000),
  conversationId: z.string().min(8).max(64).optional(),
  tz: z.string().max(64).optional(),
  mode: z.enum(["auto", "fast", "deep"]).optional(),
  /** Client-chosen id for this send. Repeating it attaches to the same run instead of starting another. */
  requestId: z.string().min(8).max(64).optional(),
});

type Env = { Variables: { userId: string } };

export interface ServerOptions {
  limiter?: RateLimiter;
  gate?: ConcurrencyGate;
}

export function buildServer(app: ReturnType<typeof createApp>, opts: ServerOptions = {}) {
  const { cfg, deps } = app;
  const limits = cfg.rateLimit;
  const limiter = opts.limiter ?? new TokenBucketLimiter();
  const gate = opts.gate ?? new ConcurrencyGate();
  const runs = new RunManager(deps, { hardTimeoutMs: cfg.budgets.turnHardTimeoutMs });
  const sessions = Sessions.open(deps.store, cfg.auth.secret);
  const api = new Hono<Env>();

  const clientIp = (c: Context): string => {
    if (limits.trustProxy) {
      const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (fwd) return fwd;
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown"; // not behind a real socket (tests)
    }
  };

  const tooMany = (c: Context, retryAfterMs: number, what: string) => {
    const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
    c.header("Retry-After", String(secs));
    return c.json({ error: "rate_limited", message: `${what} Try again in ${secs}s.`, retryAfterSeconds: secs }, 429);
  };

  // ── public ──────────────────────────────────────────────────────────────
  api.get("/health", (c) =>
    c.json({
      ok: true,
      models: { answer: cfg.models.answer, fallback: cfg.models.answerFallback ?? null, background: cfg.models.background },
      providers: providerAvailability(),
      search: searchLabel(cfg),
      auth: cfg.auth.required,
      outbox: deps.store.outboxStats(),
    }),
  );

  api.get("/benchmarks", (c) => c.json(loadBenchmarks()));

  // Creates an anonymous account. Limited per IP so accounts cannot be minted to dodge per-user limits.
  api.post("/session", (c) => {
    if (!cfg.auth.required) return c.json({ authRequired: false, userId: LEGACY_USER, token: "" });
    const r = limiter.take(`session:${clientIp(c)}`, limits.sessionPerMin);
    if (!r.ok) return tooMany(c, r.retryAfterMs, "Too many new sessions from this address.");
    const s = sessions.create();
    // First account on an existing database inherits the data from before accounts existed (once).
    if (!deps.store.getMeta("legacy_adopted")) {
      if (deps.store.hasLegacyData()) deps.store.adoptLegacyData(s.userId);
      deps.store.setMeta("legacy_adopted", s.userId);
    }
    return c.json({ authRequired: true, ...s });
  });

  // ── authenticated ───────────────────────────────────────────────────────
  const authed = new Hono<Env>();
  authed.use(
    "*",
    createMiddleware<Env>(async (c, next) => {
      let userId = LEGACY_USER;
      if (cfg.auth.required) {
        const verified = sessions.verify(bearer(c.req.header("authorization")));
        if (!verified) return c.json({ error: "unauthorized", message: "Missing or invalid session. Reload the page." }, 401);
        userId = verified;
      }
      c.set("userId", userId);
      const r = limiter.take(`api:${userId}`, limits.apiPerMin);
      if (!r.ok) return tooMany(c, r.retryAfterMs, "Too many requests.");
      await next();
    }),
  );
  const store = (c: Context<Env>) => deps.store.forUser(c.get("userId"));

  authed.get("/conversations", (c) => c.json(store(c).listConversations()));

  authed.get("/conversations/:id", (c) => {
    const s = store(c);
    const conv = s.getConversation(c.req.param("id"));
    if (!conv) return c.json({ error: "not found" }, 404);
    const run = s.latestRunFor(conv.id);
    return c.json({
      ...conv,
      messages: s.getMessages(conv.id),
      run: run
        ? {
            id: run.id,
            status: run.status,
            error: run.error,
            // Can continue from where it stopped: it was cut off, and nothing has been added after the question.
            resumable:
              (run.status === "interrupted" || run.status === "failed") &&
              run.userMessageId !== null &&
              s.getMessages(conv.id).at(-1)?.id === run.userMessageId,
          }
        : null,
    });
  });

  authed.delete("/conversations/:id", (c) => {
    store(c).deleteConversation(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Edit / regenerate: drop a message and everything after it (and the memory those turns wrote).
  authed.post("/conversations/:id/rewind", async (c) => {
    const body = z.object({ fromMessageId: z.string().min(8).max(64) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    return c.json({ removed: store(c).rewindFrom(c.req.param("id"), body.data.fromMessageId) });
  });

  // What the agent remembers: shown in the UI so memory is inspectable, not magic.
  authed.get("/memory", (c) => {
    const s = store(c);
    return c.json({
      profile: s.factRows(50),
      recent: s.recentEpisodes(20),
      // previous = the value this claim replaced, so a change reads as "was X, now Y".
      claims: s.recentClaims(40).map((cl) => ({
        ...cl,
        previous: cl.supersedesId ? (s.getClaim(cl.supersedesId) ?? null) : null,
      })),
    });
  });
  authed.delete("/memory/facts/:id", (c) => c.json({ ok: store(c).deleteFact(Number(c.req.param("id"))) }));
  authed.delete("/memory/claims/:id", (c) => c.json({ ok: store(c).deleteClaim(Number(c.req.param("id"))) }));

  // Follow-up chips. Separate from /chat so they never delay the answer; failures just mean no chips.
  authed.post("/suggest", bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ suggestions: [] }, 413) }), async (c) => {
    const body = z.object({ question: z.string().max(8000), answer: z.string().max(20000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ suggestions: [] });
    const r = limiter.take(`suggest:${c.get("userId")}`, limits.chatPerMin * 2);
    if (!r.ok) return c.json({ suggestions: [] });
    try {
      const suggestions = await suggestFollowUps(app.background, body.data.question, body.data.answer, AbortSignal.timeout(12_000));
      return c.json({ suggestions });
    } catch {
      return c.json({ suggestions: [] });
    }
  });

  /** Streams a run's events to this connection: replay after `after`, then live. Closing the connection never stops the run. */
  const attach = (c: Context<Env>, run: ActiveRun, after: number) => {
    c.header("X-Run-Id", run.id);
    return streamSSE(c, async (stream) => {
      const gone = new AbortController();
      stream.onAbort(() => gone.abort());
      try {
        for await (const { seq, event } of runs.stream(run, after, gone.signal)) {
          await stream.writeSSE({ id: String(seq), event: event.type, data: JSON.stringify(event) });
        }
      } catch {
        /* the client went away; the run carries on */
      }
    });
  };
  const resumeAfter = (c: Context<Env>): number => {
    const n = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? -1);
    return Number.isFinite(n) ? n : -1;
  };
  // The run is over and its events are no longer in memory (for example after a restart): the client reloads from the database.
  const runGone = (c: Context<Env>, userId: string, requestId?: string, runId?: string) => {
    const past = requestId ? deps.store.forUser(userId).runByRequest(requestId) : runId ? deps.store.forUser(userId).getRun(runId) : null;
    return past ? c.json({ error: "run_gone", status: past.status, conversationId: past.conversationId }, 409) : c.json({ error: "not found" }, 404);
  };

  /** A turn can fan out into many model and search calls, so cap how fast and how many at once. Returns the slot's release, or the refusal. */
  const admit = (c: Context<Env>, userId: string): (() => void) | Response => {
    const byUser = limiter.take(`chat:${userId}`, limits.chatPerMin);
    if (!byUser.ok) return tooMany(c, byUser.retryAfterMs, "You're sending messages too fast.");
    const byIp = limiter.take(`chat-ip:${clientIp(c)}`, limits.chatPerMin * 3);
    if (!byIp.ok) return tooMany(c, byIp.retryAfterMs, "Too many requests from this address.");
    const release = gate.acquire(userId, limits.maxConcurrentTurns);
    if (!release) {
      c.header("Retry-After", "5");
      return c.json({ error: "busy", message: "You already have answers in progress. Wait for one to finish or stop it first.", retryAfterSeconds: 5 }, 429);
    }
    return release;
  };

  authed.post("/chat", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "too_large", message: "That message is too large." }, 413) }), async (c) => {
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues.slice(0, 3) }, 400);
    const body = parsed.data;
    const userId = c.get("userId");

    // Same request id again (a retry, a reconnect): follow the run that already exists. Costs no allowance.
    if (body.requestId) {
      const live = runs.byRequest(userId, body.requestId);
      if (live) return attach(c, live, resumeAfter(c));
      if (deps.store.forUser(userId).runByRequest(body.requestId)) return runGone(c, userId, body.requestId);
    }

    const release = admit(c, userId);
    if (typeof release !== "function") return release;

    let run: ActiveRun;
    try {
      run = runs.start(userId, body, release);
    } catch {
      release(); // lost a race on the same request id
      return runGone(c, userId, body.requestId);
    }
    return attach(c, run, -1);
  });

  // Reattach to a run (page reload, dropped connection): replays from `after` / Last-Event-ID, then follows live.
  authed.get("/runs/:id/events", (c) => {
    const run = runs.get(c.get("userId"), c.req.param("id"));
    return run ? attach(c, run, resumeAfter(c)) : runGone(c, c.get("userId"), undefined, c.req.param("id"));
  });

  // Continue an interrupted answer from its last checkpoint: the question is already saved, so none is added.
  // Same request id on a repeat, so a double-click or a reconnect attaches to the one resumed run.
  authed.post("/runs/:id/resume", async (c) => {
    const userId = c.get("userId");
    const s = store(c);
    const old = s.getRun(c.req.param("id"));
    if (!old) return c.json({ error: "not found" }, 404);
    const requestId = `resume:${old.id}`;
    const live = runs.byRequest(userId, requestId);
    if (live) return attach(c, live, resumeAfter(c));
    if (s.runByRequest(requestId)) return runGone(c, userId, requestId);

    const last = old.conversationId ? s.getMessages(old.conversationId).at(-1) : undefined;
    if ((old.status !== "interrupted" && old.status !== "failed") || !old.conversationId || !old.userMessageId || last?.id !== old.userMessageId || last.role !== "user") {
      return c.json({ error: "not_resumable", message: "That answer can't be resumed (it finished, or the conversation has moved on)." }, 409);
    }
    const body = z.object({ tz: z.string().max(64).optional() }).safeParse(await c.req.json().catch(() => ({})));
    let saved: Checkpoint | undefined;
    try {
      const raw = s.getCheckpoint(old.id);
      saved = raw ? (JSON.parse(raw) as Checkpoint) : undefined;
    } catch {
      saved = undefined; // an unreadable checkpoint means starting this turn over, not failing
    }

    const release = admit(c, userId);
    if (typeof release !== "function") return release;
    let run: ActiveRun;
    try {
      run = runs.start(
        userId,
        {
          message: last.content,
          tz: body.success ? body.data.tz : undefined,
          requestId,
          resumedFrom: old.id,
          resume: { conversationId: old.conversationId, userMessageId: old.userMessageId },
          saved,
        },
        release,
      );
    } catch {
      release();
      return runGone(c, userId, requestId);
    }
    return attach(c, run, -1);
  });

  // The Stop button: an explicit cancel, since a closed connection no longer stops a run.
  authed.post("/runs/:id/cancel", (c) => c.json({ ok: runs.cancel(c.get("userId"), c.req.param("id")) }));

  api.route("/", authed);

  // The API is API-only: the UI is a separate Vite app (dev :5173, preview :4173).
  const root = new Hono();
  root.use("/api/*", cors({ origin: cfg.webOrigins, allowHeaders: ["authorization", "content-type"], exposeHeaders: ["retry-after"] }));
  root.route("/api", api);
  root.get("/", (c) => c.json({ name: "orbit-api", docs: "GET /api/health" }));
  return root;
}
