# DESIGN: Orbit, a web-search chat agent

**Thesis:** the model decides, the harness guarantees. Models own the judgment calls: whether to search, what to search, when they know enough. Deterministic code owns what must be exact: dates, memory, citation checks, budgets, retries, fallbacks. Every role is a model prompt over **one tool**, `web_search`.

![Orbit architecture: request lifecycle, fast and deep paths, shared infrastructure](docs/architecture.svg)

## How it works

- **Router:** a cheap model classifies each question (about 1 s); keyword rules take over on timeout or bad output. Forced modes skip it.
- **Fast path** (most questions): one model, a bounded search loop, streamed answer. Budgets are code, not prompt: repeated queries are refused, the last step forbids tools, a soft deadline forces an answer, and a tool-free recovery call turns gathered evidence into an answer if a model misbehaves.
- **Deep path** (comparisons, multi-part questions): a planner splits the question into up to 4 sub-questions, shown live; researchers run in parallel on a cheap model; the answer model writes one cited report; a verifier checks each claim against the passages the writer saw and rewrites once without unsupported claims. Any failure before synthesis falls back to the fast path.
- **Retrieval:** parallel queries, cache, reciprocal-rank fusion, optional page reads (SSRF-guarded, address validated at connect time), BM25 over stemmed passages under a token budget, stable source ids. Page text is untrusted data.
- **Runs and recovery:** a turn is a *run*, not a request. It keeps going if the browser disconnects; events are numbered, so a client reconnects with `Last-Event-ID` and is replayed what it missed. Stop is an explicit cancel. Progress is checkpointed after every finished step, so a crash leaves an *interrupted* answer that offers **Resume** (new run, saved plan and research reused; verified live, 12 s with nothing re-researched). A request id makes sends idempotent; a hard timeout frees a stuck run.
- **Memory:** SQLite (FTS5). Dates are SQL keys ("last Tuesday" resolved in the user's timezone), not embeddings. A profile fact is saved only if its numbers and names appear in what the *user* wrote (a real bug: a chat date once became a birthday). Each fact has a model-named **slot** (not a fixed list; the extractor sees the user's existing slots), so a new birthday replaces the old one. Memory is scoped per user inside the store, so a route cannot forget to filter. Edit and regenerate rewind the memory those turns wrote.
- **Accounts and limits:** signed anonymous sessions; token-bucket limits per user and IP, a cap on concurrent answers and a body-size limit. Limits are checked only before a turn starts, never mid-answer.

## Why this shape

- **Speed:** first token waits on one model call plus at most one search round. Memory writes happen after the response. The default answer model is Gemini 3.1 Flash-Lite (benchmarked live: 7/7 cases at a 15-25 s median against Groq `gpt-oss-120b` at about 78 s on the free tier); Groq is the automatic fallback if the primary fails before producing text.
- **Correctness:** mostly retrieval, then grounding; the verifier checks that a citation *supports* the claim, not just that it exists.
- **Scale:** search, models, page reader, store, limiter and sessions sit behind interfaces, so Postgres, Redis or a real identity provider are adapter swaps.
- **Honest limits:** sessions are anonymous; limiter, event log and the startup sweep are single-node; a model call cut off mid-stream is repeated, not continued; resume is a click, so no quota is spent unattended.

## Measured so far

26 live eval cases: 20 / 26 first run, 26 / 26 after fixing causes (citations, stale answers, injection, dates); judge average 4.32 / 5. 221 unit and integration tests run in CI. **Not yet measured:** the 13 newer eval cases, router accuracy, and the verifier's false-positive rate (it flagged most claims in 2 of 3 live runs, so treat the deep path's rewrites with suspicion). Results are browsable at `/benchmark`.

## Considered and rejected

| Option | Why not |
|---|---|
| LangChain / LangGraph | A five-step pipeline in a few hundred readable lines; a graph framework adds moving parts, not capability |
| Always-deep multi-agent | Slower and costlier on easy questions; deep is opt-in via the router |
| Keyword-only router | Missed paraphrase and other languages; kept as the fallback |
| Vector DB as primary memory | Dates are exact keys; FTS5 covers paraphrase |
| Memory as a second tool | Breaks the one-tool rule and adds a round trip |
| Provider-hosted web search | No control over fan-out, page reading, caching, ranking |
| Local model as default | Needs a GPU for a reviewer to run; supported as an option |

## With another week

1. Measure the verifier and router on labelled sets; run the deep-path evals.
2. Real sign-in; Postgres and Redis behind the existing interfaces; a per-provider model gateway.
3. Verifier on the fast path; a cross-encoder reranker; OpenTelemetry traces; an eval gate in CI.

Stack: TypeScript, Hono + SSE, React + Vite + Tailwind, `better-sqlite3`, Vercel AI SDK, Tavily and Exa. Keys: `.env.example`. Decisions: `docs/DECISIONS.md`.
