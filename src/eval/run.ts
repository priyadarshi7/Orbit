/**
 * npm run eval -- [--model groq:id] [--search tavily|exa] [--mode live|record|replay] [--judge] [--judge-model provider:id] [--only id1,id2] [--category c] [--delay ms]
 *
 *   live    real LLM + real search (default)
 *   record  like live, and saves search results/pages to eval-fixtures/ so they can be replayed
 *   replay  real LLM + FROZEN search results: isolates the model from search noise
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config";
import { CASES } from "./cases";
import { markdownTable, runSuite, summarize, type CaseResult, type Mode } from "./suite";

export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const model = typeof args.model === "string" ? args.model : cfg.models.answer;
  const mode = (typeof args.mode === "string" ? args.mode : "live") as Mode;
  if (!["live", "record", "replay"].includes(mode)) throw new Error(`bad --mode ${mode}`);

  let cases = CASES;
  if (typeof args.only === "string") {
    const ids = new Set(args.only.split(","));
    cases = cases.filter((c) => ids.has(c.id));
  }
  if (typeof args.category === "string") cases = cases.filter((c) => c.category === args.category);
  if (!cases.length) throw new Error("no cases selected");

  const search = args.search === "exa" ? "exa" : args.search === "tavily" ? "tavily" : cfg.searchProvider;
  console.log(`\neval: ${cases.length} case(s) · model ${model} · search ${search} · mode ${mode}${args.judge ? " · judge " + (typeof args["judge-model"] === "string" ? args["judge-model"] : cfg.models.judge) : ""}\n`);

  // Save after every case so the /benchmark page can show a run while it is still going.
  mkdirSync("eval-results", { recursive: true });
  const file = `eval-results/${new Date().toISOString().replace(/[:.]/g, "-")}_${model.replace(/[^\w.-]+/g, "_")}.json`;
  const partial: CaseResult[] = [];
  const save = (status: "running" | "complete") =>
    writeFileSync(file, JSON.stringify({ model, mode, status, total: cases.length, summary: summarize(model, partial), results: partial }, null, 1));

  const results = await runSuite(cases, {
    cfg,
    modelSpec: model,
    mode,
    search,
    fixtureDir: "eval-fixtures",
    judge: Boolean(args.judge),
    judgeModelSpec: typeof args["judge-model"] === "string" ? args["judge-model"] : undefined,
    delayMs: typeof args.delay === "string" ? Number(args.delay) : 1500,
    tz: cfg.defaultTz,
    onProgress: (r, i, n) => {
      partial.push(r);
      save("running");
      const t = r.trace;
      const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
      console.log(
        `${r.pass ? "PASS" : "FAIL"} ${String(i + 1).padStart(2)}/${n} ${r.id.padEnd(22)} ` +
          `ttft ${String(t?.firstTokenMs ?? "–").padStart(5)}ms  total ${String(t?.totalMs ?? "–").padStart(6)}ms  ` +
          `searches ${t?.searches.length ?? 0}  cites ${t?.citations.cited.length ?? 0}` +
          (r.judged ? `  judge ${r.judged.score}` : "") +
          (failed.length ? `  ✗ ${failed.join(", ")}` : ""),
      );
    },
  });

  const s = summarize(model, results);
  console.log("\n" + markdownTable([s]) + "\n");

  partial.splice(0, partial.length, ...results);
  save("complete");
  console.log(`saved ${file}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("eval/run.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
