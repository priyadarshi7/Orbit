# DESIGN: Orbit, a web-search chat agent

**Thesis:** the model decides, the harness guarantees. The model owns the judgment calls (whether to search, what to search, when it knows enough). Deterministic code owns everything that must be exact: dates, memory lookup, citation checking, budgets, retries. Nothing sits in front of the first token that doesn't have to.

## How it works

![Orbit architecture: request lifecycle](docs/architecture.svg)

**1. Context assembly (no LLM).** Builds the turn: current date and timezone, recent conversation, and a memory block. The block holds the profile, a one-line timeline of recent chats, and any records matching a date the user mentioned ("last Tuesday", "3 November", resolved with chrono-node in their timezone) or, when the user is clearly referring back, an FTS5 keyword match. Exact dates are SQL keys, so there is no embedding fuzz. If a referenced date has no record, the block says `NO RECORD` with the nearest stored dates, and the prompt forbids inventing a past chat.

**2. Agent loop.** One model, one tool, no intent classifier or planner (a router is wrong on exactly the questions nobody anticipated, and costs a round trip before the first token). A greeting costs one call; a multi-hop question runs up to `MAX_SEARCH_ROUNDS` rounds. The caps are enforced in code: the tool refuses repeated queries and rounds beyond the cap, the final step has tool calls forbidden, a soft deadline forces an answer, and if a model ignores that, one tool-free recovery call still turns the gathered evidence into an answer. If a model cites sources it never retrieved, the turn is re-run once with search required.

**T. `web_search` is a retrieval pipeline, not a snippet fetch.** The model sees one tool: `queries[]`, `depth: snippets | read`, `recency`. Inside:
- parallel fan-out across queries, cached with a TTL by how fast the topic goes stale
- dedupe by normalised URL and near-duplicate title; reciprocal-rank fusion, so a page several differently-worded queries surface ranks higher
- for `read`, fetch the top pages (max two per domain), extract the article text and publish date
- chunk into passages, rank with BM25, pack under a token budget; every source gets a stable id

Failures degrade to partial results, never an exception. Page text is wrapped as untrusted data and cannot pose as our delimiters.

**3. Grounding gate (code).** The model cites `[n]` against evidence ids. The gate drops any citation that doesn't resolve to a source actually retrieved, strips echoed internal tags, and lints undated relative-time language. Relative-to-absolute dates, naming conflicting sources and stating gaps are prompt rules, checked by the eval.

**4. Memory writer (async, off the hot path).** After the answer streams, a job in a durable **outbox** (idempotent per turn, retried with backoff, recovered after a crash) has a small model write a summary and keywords, extract durable profile facts, and record **claims**: atomic, dated, sourced facts, each linked to the one it supersedes. "Has that changed since…?" becomes a diff against stored claims. If extraction keeps failing, a minimal episode is stored so the turn stays findable by date.

## Why this shape

- **Latency.** First token waits on one model call plus, at most, one search round. Stage 1 is code. Memory writes run after the response. Queries fan out in a single tool call. The UI streams status so waiting is never silent.
- **Cost.** The system prompt and tool schema are byte-stable (a test asserts it), and the date and memory ride in the user turn, so a timestamp never invalidates provider prefix caching. Search and page caches, an evidence token budget, and a small model for background work. The trace records cached tokens per turn to catch a silent cache miss.
- **Correctness.** Most of the quality comes from retrieval (read pages, rank passages), then grounding. The model reasons over evidence it can cite.
- **Model-agnostic.** The LLM is the Vercel AI SDK's `LanguageModel`, bound by role (`answer`, `background`, `judge`) from config. Groq, Google AI Studio and local OpenAI-compatible servers work today; switching is an env change. The answer model is chosen by benchmark, not taste.
- **One tool, honestly.** Memory is context the harness injects, not a second tool: it saves a round trip and respects the brief. The cost is that the model can't pull a past chat the harness missed. If the eval shows misses, a `recall` tool is the fix.

## Proof, not claims

`npm test`: 48 unit tests, including the whole agent loop on a scripted model (search, citation validation, fallback, round cap, recovery, memory injection, prompt-prefix stability).
`npm run eval`: 26 cases across ten skills (no-search, fresh facts, multi-hop, comparison, ambiguous, context-dependent follow-up, dated recall, change detection, no-record, prompt-injection) so a change that helps one skill and hurts another shows up immediately. Each case records string and behaviour checks (searched or not, citations, regexes), time to first token, total latency, tokens and cached tokens, with an optional LLM judge. `--mode record` freezes search results; `npm run bench -- --models a,b --mode replay` then compares models on identical evidence.

Results: _not yet run. To be filled in from `npm run bench` once the models are benchmarked._

## Considered and rejected

| Option | Why not |
|---|---|
| Intent router / planner LLM before the loop | Round trip before first token; brittle on novel questions |
| Vector DB as primary memory | Dates are exact keys; extra infra for worse recall here. FTS5 over model-written summaries covers paraphrase |
| Memory as a second tool | Breaks the one-tool rule and adds a round trip |
| Provider-hosted web search | One fewer key, but no control over fan-out, page reading, caching or ranking |
| LangChain / multi-agent | Moving parts with nothing in this task to justify them. The loop is one readable file |
| Small-model page summarising before the answer | Saves tokens but can drop the one relevant sentence, and adds a hop. Ranking trims pages for free |
| Transcript-only memory | Prose can't be diffed, so "what changed" becomes guesswork |

## Stack

TypeScript on Node; Hono + SSE; React + Vite; `better-sqlite3` (WAL, FTS5); Vercel AI SDK; Tavily behind a `SearchProvider` port. The agent core (`src/agent`, `src/retrieval`, `src/memory`, `src/grounding`) depends only on ports. Keys: see `.env.example`. Decision log: `docs/DECISIONS.md`.

## With another week

1. Speculative search: start the likely first query while the model is still reasoning; keep it only if the eval shows a win.
2. A cross-encoder reranker for passages instead of lexical ranking, and a second search provider with hedged requests.
3. Embeddings as a second memory index for long-lived users, and a `recall` tool if the eval shows retrieval misses.
4. Per-model provider options (thinking budget, tool-call quirks) in the model config, found by the benchmark.
5. A larger, adversarial eval set with per-category regression gates in CI.
