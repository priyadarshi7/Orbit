/** `npm run models` — list the model ids each configured provider will accept. Prints ids only, never keys. */
import { loadConfig } from "./config";
import { providerAvailability } from "./models";

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const cfg = loadConfig();
  const avail = providerAvailability();

  const jobs: [string, () => Promise<string[]>][] = [];
  if (avail.groq)
    jobs.push([
      "groq",
      async () => {
        const j = await getJson("https://api.groq.com/openai/v1/models", { authorization: `Bearer ${process.env.GROQ_API_KEY}` });
        return (j.data as { id: string }[]).map((m) => m.id);
      },
    ]);
  if (avail.google)
    jobs.push([
      "google",
      async () => {
        const j = await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
          "x-goog-api-key": process.env.GOOGLE_GENERATIVE_AI_API_KEY!,
        });
        return (j.models as { name: string; supportedGenerationMethods?: string[] }[])
          .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
          .map((m) => m.name.replace(/^models\//, ""));
      },
    ]);
  jobs.push([
    "local",
    async () => {
      const j = await getJson(`${cfg.local.baseUrl.replace(/\/$/, "")}/models`, { authorization: `Bearer ${cfg.local.apiKey}` });
      return (j.data as { id: string }[]).map((m) => m.id);
    },
  ]);

  for (const [name, fn] of jobs) {
    try {
      const ids = (await fn()).sort();
      console.log(`\n${name} (${ids.length})`);
      for (const id of ids) console.log(`  ${name}:${id}`);
    } catch (e) {
      console.log(`\n${name}: unavailable (${e instanceof Error ? e.message : e})`);
    }
  }
  if (!avail.groq) console.log("\ngroq: no GROQ_API_KEY set");
  if (!avail.google) console.log("google: no GOOGLE_GENERATIVE_AI_API_KEY set");
  console.log("\nConfigured roles:", JSON.stringify(cfg.models, null, 2));
}

void main();
