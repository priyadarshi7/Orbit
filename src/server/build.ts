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

const ChatBody = z.object({
  message: z.string().trim().min(1).max(8000),
  conversationId: z.string().min(8).max(64).optional(),
  tz: z.string().max(64).optional(),
  mode: z.enum(["auto", "fast", "deep"]).optional(),
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
    return c.json({ ...conv, messages: s.getMessages(conv.id) });
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

  authed.post("/chat", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "too_large", message: "That message is too large." }, 413) }), async (c) => {
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues.slice(0, 3) }, 400);
    const body = parsed.data;
    const userId = c.get("userId");

    // A turn can fan out into many model and search calls, so cap how fast and how many at once.
    const byUser = limiter.take(`chat:${userId}`, limits.chatPerMin);
    if (!byUser.ok) return tooMany(c, byUser.retryAfterMs, "You're sending messages too fast.");
    const byIp = limiter.take(`chat-ip:${clientIp(c)}`, limits.chatPerMin * 3);
    if (!byIp.ok) return tooMany(c, byIp.retryAfterMs, "Too many requests from this address.");
    const release = gate.acquire(userId, limits.maxConcurrentTurns);
    if (!release) {
      c.header("Retry-After", "5");
      return c.json({ error: "busy", message: "You already have answers in progress. Wait for one to finish or stop it first.", retryAfterSeconds: 5 }, 429);
    }

    const turnDeps = { ...deps, store: deps.store.forUser(userId) };
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      // Backstop only: the agent has its own soft deadline, so this fires for a turn that is genuinely stuck
      // (a provider that never answers). It frees the user's slot so they are never locked out by a hung turn.
      const backstop = setTimeout(() => {
        ac.abort();
        release();
      }, cfg.budgets.turnHardTimeoutMs);
      try {
        for await (const ev of runTurn(turnDeps, { ...body, signal: ac.signal })) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        }
      } catch {
        ac.abort();
      } finally {
        clearTimeout(backstop);
        release();
      }
    });
  });

  api.route("/", authed);

  // The API is API-only: the UI is a separate Vite app (dev :5173, preview :4173).
  const root = new Hono();
  root.use("/api/*", cors({ origin: cfg.webOrigins, allowHeaders: ["authorization", "content-type"], exposeHeaders: ["retry-after"] }));
  root.route("/api", api);
  root.get("/", (c) => c.json({ name: "orbit-api", docs: "GET /api/health" }));
  return root;
}
