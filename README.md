# Orbit

A web-search chat agent. One tool (`web_search`), a retrieval pipeline behind it, citations checked in code, and memory of earlier chats. Architecture: [DESIGN.md](DESIGN.md). Every decision and its reason: [docs/DECISIONS.md](docs/DECISIONS.md).

## Run it

```bash
npm install
cp .env.example .env      # then add your keys (see below)
npm run dev               # UI on http://localhost:5173, API on http://localhost:8000
```

Needs Node 22.12 or newer (the AI SDK, better-sqlite3 and the test runner all require it).

### Keys (`.env`)

| Key | Needed for |
|---|---|
| `TAVILY_API_KEY` | web search (free tier is enough) |
| `GROQ_API_KEY` and/or `GOOGLE_GENERATIVE_AI_API_KEY` | the LLM. Or run a local OpenAI-compatible server (Ollama, LM Studio) and set `LOCAL_BASE_URL` |

Pick models with `ANSWER_MODEL`, `ANSWER_MODEL_FALLBACK`, `BACKGROUND_MODEL`, `JUDGE_MODEL` as `provider:model-id` (`groq`, `google`, `local`). `npm run models` lists the ids your keys can use. The defaults are starting points; the answer model is meant to be chosen by `npm run bench`.

### Try the memory features

```bash
npm run seed              # loads a small dated demo history (illustrative data, not real prices)
```

Then ask things like "What did I ask you on <a date 11 days ago>?" or "Has anything changed since we looked at CRM pricing?". Open **What Orbit remembers** in the sidebar to see what is stored. Click **Details** under any answer to see stage timings, tokens, cached tokens, searches and gate warnings.

## Scripts

| | |
|---|---|
| `npm run dev` | API (watch mode) and UI together |
| `npm start` | API only, on :8000 |
| `npm run start:web` | Build the UI and serve it on :4173 (proxies `/api` to :8000) |
| `npm test` | unit and agent-loop tests (no keys needed) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run seed` | demo history |
| `npm run models` | list model ids available to your keys |
| `npm run eval -- [--model groq:id] [--mode live\|record\|replay] [--judge] [--category c] [--only id,id]` | run the 26-case suite on one model |
| `npm run bench -- --models a,b,c [--mode replay] [--judge]` | compare models on the same cases |

### Benchmarking models fairly

```bash
npm run eval  -- --mode record --model groq:<id>          # once: freezes search results into eval-fixtures/
npm run bench -- --models groq:<id>,google:<id> --mode replay --judge
```

Replay gives every model identical evidence, so differences come from the model. Free tiers rate-limit; use `--delay 4000` if you hit 429s. Results are written to `eval-results/` (a markdown table you can paste into DESIGN.md).

## Layout

```
src/
  agent/       loop, prompt, tool, typed event stream
  retrieval/   fan-out, dedupe, rank, pack, evidence registry
  memory/      SQLite store, context assembly, writer, outbox, seed
  grounding/   citation gate
  adapters/    Tavily, HTTP page reader, fixtures (record/replay)
  server/      Hono + SSE
  eval/        cases, suite, run, bench, fakes
web/           React UI
tests/         vitest
```
