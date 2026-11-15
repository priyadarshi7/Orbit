import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runTurn } from "../agent/run";
import { searchLabel, type createApp } from "../app";
import { providerAvailability } from "../models";
import { suggestFollowUps } from "../agent/suggest";
import { loadBenchmarks } from "./benchmarks";

const ChatBody = z.object({
  message: z.string().trim().min(1).max(8000),
  conversationId: z.string().min(8).max(64).optional(),
  tz: z.string().max(64).optional(),
  mode: z.enum(["auto", "fast", "deep"]).optional(),
});

export function buildServer(app: ReturnType<typeof createApp>) {
  const { cfg, deps } = app;
  const api = new Hono();

  api.get("/health", (c) =>
    c.json({
      ok: true,
      models: { answer: cfg.models.answer, fallback: cfg.models.answerFallback ?? null, background: cfg.models.background },
      providers: providerAvailability(),
      search: searchLabel(cfg),
      outbox: deps.store.outboxStats(),
    }),
  );

  api.get("/benchmarks", (c) => c.json(loadBenchmarks()));

  api.get("/conversations", (c) => c.json(deps.store.listConversations()));

  api.get("/conversations/:id", (c) => {
    const conv = deps.store.getConversation(c.req.param("id"));
    if (!conv) return c.json({ error: "not found" }, 404);
    return c.json({ ...conv, messages: deps.store.getMessages(conv.id) });
  });

  api.delete("/conversations/:id", (c) => {
    deps.store.deleteConversation(c.req.param("id"));
    return c.json({ ok: true });
  });

  // What the agent remembers: shown in the UI so memory is inspectable, not magic.
  api.get("/memory", (c) =>
    c.json({
      profile: deps.store.factRows(50),
      recent: deps.store.recentEpisodes(20),
      // previous = the value this claim replaced, so a change reads as "was X, now Y".
      claims: deps.store.recentClaims(40).map((cl) => ({
        ...cl,
        previous: cl.supersedesId ? (deps.store.getClaim(cl.supersedesId) ?? null) : null,
      })),
    }),
  );
  api.delete("/memory/facts/:id", (c) => c.json({ ok: deps.store.deleteFact(Number(c.req.param("id"))) }));
  api.delete("/memory/claims/:id", (c) => c.json({ ok: deps.store.deleteClaim(Number(c.req.param("id"))) }));

  // Follow-up chips. Separate from /chat so they never delay the answer; failures just mean no chips.
  api.post("/suggest", async (c) => {
    const body = z.object({ question: z.string().max(8000), answer: z.string().max(20000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ suggestions: [] });
    try {
      const suggestions = await suggestFollowUps(app.background, body.data.question, body.data.answer, AbortSignal.timeout(12_000));
      return c.json({ suggestions });
    } catch {
      return c.json({ suggestions: [] });
    }
  });

  api.post("/chat", async (c) => {
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues.slice(0, 3) }, 400);
    const body = parsed.data;

    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      try {
        for await (const ev of runTurn(deps, { ...body, signal: ac.signal })) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        }
      } catch {
        ac.abort();
      }
    });
  });

  // The API is API-only: the UI is a separate Vite app (dev :5173, preview :4173).
  const root = new Hono();
  root.use("/api/*", cors({ origin: cfg.webOrigins }));
  root.route("/api", api);
  root.get("/", (c) => c.json({ name: "orbit-api", docs: "GET /api/health" }));
  return root;
}

