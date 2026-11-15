# DESIGN: Orbit, a web-search chat agent

**Thesis:** the model decides, the harness guarantees. Models own the judgment calls: whether to search, what to search, when they know enough. Deterministic code owns what must be exact: dates, memory, citation checks, budgets, retries, fallbacks. Every role is a model prompt over **one tool**, `web_search`.

## How it works

![Orbit architecture: request lifecycle, fast and deep paths, shared infrastructure](docs/architecture.svg)

**Fast path** (most questions): one model, a bounded search loop, streamed answer. Budgets are code, not prompt: repeated queries are refused, the last step forbids tools, a soft deadline forces an answer, and a tool-free recovery call turns gathered evidence into an answer if a model misbehaves.

**Deep path** (comparisons, multi-part or research questions): a planner splits the question into up to 4 sub-questions, shown live in the UI; researchers run in parallel (3 at a time, 2 rounds each) on a cheap model; the answer model writes one cited report; a verifier checks each cited claim against the passages the writer saw and rewrites the answer once without unsupported claims. Any failure before synthesis degrades to the fast path, so deep can cost time but never the answer.

**Router:** a cheap model classifies each question with the previous exchange (about 1 s). On timeout or bad output keyword rules decide. Forced modes skip it.

**Retrieval:** parallel queries, TTL cache, reciprocal-rank fusion, optional page reads (SSRF-guarded: every redirect re-checked and the address dialled is validated at connect time), BM25 over stemmed passages under a token budget, stable source ids. Page text is untrusted data.

**Runs and recovery:** a turn is a *run*, not a request. A run manager executes it independently of the HTTP connection and keeps its events in a short, numbered log; the client follows with SSE event ids and, if the connection drops, reconnects with `Last-Event-ID` and is replayed exactly what it missed, so a refresh or a network blip loses nothing and wastes no model or search work. Stop is an explicit cancel that ends the run with the answer so far. Each run has a durable row (`done`, `failed`, `stopped`, `interrupted`); on startup any run still marked running is marked `interrupted`, so a crash shows as a question with a clear "interrupted, retry" instead of silence, and a retry is cheap because searches and pages are cached. A client-chosen request id makes a send idempotent (a repeat attaches to the same run, costs no allowance, and cannot save the question twice), and a hard timeout fails a stuck run and frees its slot.

**Memory:** SQLite (FTS5). Dates are SQL keys ("last Tuesday" resolved in the user's timezone), so no embedding fuzz. A profile fact is stored only if its numbers and names appear in what the *user* wrote (a real bug: a chat date was once saved as a birthday), and a fact has a slot, so "my birthday is…" replaces the old birthday instead of sitting beside it. Slots are not a fixed list: the model names them per user, and each extraction is shown that user's existing slots so it reuses a name instead of inventing a second one, while a new kind of fact simply creates a new slot. Retrieval stays per-user because the store itself filters every row. Edit and regenerate rewind the conversation and the memory those turns wrote. "Has it changed?" is a diff against dated claims.

## Why this shape

- **Speed:** first token waits on one model call plus at most one search round on the fast path. Memory writes run after the response. Prompt prefix is byte-stable for provider caching.
- **Correctness:** most of it comes from retrieval, then grounding; the verifier checks that a citation *supports* the claim, not just that it exists.
- **Scale:** every external dependency (search, models, page reader, store) sits behind a port, so Postgres, Redis or a hosted provider are adapter swaps. Per-provider budgets and bounded fan-out stop our own parallelism from tripping rate limits.
- **Accounts and limits:** each browser gets a signed anonymous session; memory, chats and facts are scoped per user in the store itself, so a route cannot forget to filter. Token-bucket rate limits (per user and per IP), a cap on concurrent answers and request-size limits sit in front of the model calls. Both limiter and sessions are interfaces: Redis and a real identity provider are swaps.
- **Honest limits:** sessions are anonymous (no sign-up, no password); the limiter, the run manager's event log and the startup "interrupted" sweep are single-node (several instances need a shared stream such as Redis and a heartbeat instead); a server crash loses the in-flight answer, which is marked interrupted rather than resumed (resuming mid-research would need step-level checkpoints).

## Measured so far (`npm run eval`, LLM judge, live search)

| Run | Result |
|---|---|
| First live run, 26 cases / 10 skills | 20 / 26 |
| After fixing the causes (citation formats, stale answers, injection, date handling) | 26 / 26 (one judge error on a date was overruled by hand) |
| Re-run of 19 cases, judge average | 4.32 / 5 |
| Unit and integration tests (scripted models, no keys) | 212 passing, run in CI |

Latency is poor on Groq's free tier (median about 19 s, p90 about 89 s, mostly rate-limit waits). **Not yet measured:** the 13 newer eval cases, the deep path, router accuracy, verifier false-positive rate (one early run flagged every source), and the model comparison that chooses the default. Reported here rather than claimed. Results are browsable at `/benchmark`.

## Considered and rejected

| Option | Why not |
|---|---|
| LangChain / LangGraph | A five-step pipeline in a few hundred readable lines; a graph framework adds moving parts, not capability |
| Always-deep multi-agent | Slower and costlier on easy questions; deep is opt-in via the router |
| Keyword-only router | Missed paraphrase and other languages; kept only as the fallback |
| Vector DB as primary memory | Dates are exact keys; FTS5 over summaries covers paraphrase |
| Memory as a second tool | Breaks the one-tool rule and adds a round trip |
| Provider-hosted web search | No control over fan-out, page reading, caching, ranking |
| Local model as default | Needs Ollama and a GPU for a reviewer to run; supported as an option |

## With another week

1. Run and publish the numbers above: deep-path cases, a labelled routing set, verifier precision, then choose the default answer model by benchmark.
2. Real sign-in; Postgres and Redis behind the existing interfaces (shared rate limits, shared cache); a per-provider token-bucket model gateway.
3. Verifier on the fast path; a cross-encoder reranker.
4. OpenTelemetry traces from the stage timings already recorded; an eval regression gate in CI.

Stack: TypeScript on Node, Hono + SSE, React + Vite + Tailwind, `better-sqlite3`, Vercel AI SDK, Tavily and Exa. Keys: `.env.example`. Decisions: `docs/DECISIONS.md`.
