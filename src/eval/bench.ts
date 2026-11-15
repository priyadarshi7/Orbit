/**
 * npm run bench -- --models groq:a,google:b,local:c [--search tavily|exa] [--mode replay|live|record] [--judge] [--category c] [--delay ms]
 *
 * Runs the same cases against each model and prints one comparison table.
 * For a fair model comparison: `npm run eval -- --mode record` once, then `bench --mode replay`
 * so every model sees identical evidence.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config";
import { CASES } from "./cases";
import { parseArgs } from "./run";
import { markdownTable, runSuite, summarize, type Mode } from "./suite";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const models = typeof args.models === "string" ? args.models.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (!models.length) throw new Error("pass --models provider:id,provider:id");
  const mode = (typeof args.mode === "string" ? args.mode : "replay") as Mode;
  const search = args.search === "exa" ? "exa" : args.search === "tavily" ? "tavily" : cfg.searchProvider;

  let cases = CASES;
  if (typeof args.category === "string") cases = cases.filter((c) => c.category === args.category);

  const summaries = [];
  const all: Record<string, unknown> = {};
  for (const m of models) {
    console.log(`\n── ${m} (${cases.length} cases, ${mode}) ──`);
    const results = await runSuite(cases, {
      cfg,
      modelSpec: m,
      mode,
      search,
      fixtureDir: "eval-fixtures",
      judge: Boolean(args.judge),
      judgeModelSpec: typeof args["judge-model"] === "string" ? args["judge-model"] : undefined,
      delayMs: typeof args.delay === "string" ? Number(args.delay) : 2000,
      tz: cfg.defaultTz,
      onProgress: (r, i, n) => console.log(`${r.pass ? "PASS" : "FAIL"} ${i + 1}/${n} ${r.id}${r.error ? "  ! " + r.error : ""}`),
    });
    summaries.push(summarize(m, results));
    all[m] = results;
  }

  const table = markdownTable(summaries);
  console.log("\n" + table + "\n");
  mkdirSync("eval-results", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(`eval-results/bench-${stamp}.md`, `# Bench ${stamp} (${mode})\n\n${table}\n`);
  writeFileSync(`eval-results/bench-${stamp}.json`, JSON.stringify({ mode, summaries, results: all }, null, 1));
  console.log(`saved eval-results/bench-${stamp}.{md,json}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
