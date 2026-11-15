/**
 * `npm run seed` — loads a small, dated demo history so memory features are
 * visible within a minute of cloning. Dates are relative to "now".
 *
 * ILLUSTRATIVE DATA: the prices below are demo values, not a statement of what
 * those products cost. The agent will (correctly) report them as CHANGED when
 * live pages disagree. Idempotent: running it twice adds nothing.
 */
import { loadConfig } from "../config";
import { localYMD } from "../util/time";
import { MemoryStore } from "./store";

interface SeedChat {
  id: string;
  daysAgo: number;
  user: string;
  assistant: string;
  sources: { id: number; url: string; title: string; domain: string }[];
  summary: string;
  keywords: string[];
  facts?: string[];
  claims: { subject: string; attribute: string; value: string; sourceUrl: string }[];
}

const CHATS: SeedChat[] = [
  {
    id: "seed-crm-shortlist",
    daysAgo: 6,
    user: "We're a 20-person sales team. Shortlist 5 CRM tools and give me per-seat pricing.",
    assistant:
      "Shortlist for a 20-person sales team *(demo data, not live pricing)*:\n\n| Tool | Entry plan | Per seat / month |\n|---|---|---|\n| HubSpot Sales Hub | Starter | $20 [1] |\n| Pipedrive | Essential | $14 [2] |\n| Zoho CRM | Standard | $14 [3] |\n| Salesforce Starter Suite | Starter | $25 [4] |\n| Freshsales | Growth | $11 [5] |\n\nAll prices assume annual billing. For 20 seats the cheapest is Freshsales at about $220/month and the most expensive is Salesforce at about $500/month.",
    sources: [
      { id: 1, url: "https://www.hubspot.com/pricing/sales", title: "HubSpot Sales Hub pricing", domain: "hubspot.com" },
      { id: 2, url: "https://www.pipedrive.com/en/pricing", title: "Pipedrive pricing", domain: "pipedrive.com" },
      { id: 3, url: "https://www.zoho.com/crm/zohocrm-pricing.html", title: "Zoho CRM pricing", domain: "zoho.com" },
      { id: 4, url: "https://www.salesforce.com/sales/pricing/", title: "Salesforce Sales pricing", domain: "salesforce.com" },
      { id: 5, url: "https://www.freshworks.com/crm/pricing/", title: "Freshsales pricing", domain: "freshworks.com" },
    ],
    summary:
      "The user, on a 20-person sales team, asked for a shortlist of 5 CRM tools with per-seat pricing. The answer shortlisted HubSpot, Pipedrive, Zoho CRM, Salesforce and Freshsales and recorded their entry-plan prices. (demo data)",
    keywords: ["crm", "sales", "shortlist", "pricing", "hubspot", "pipedrive", "zoho", "salesforce", "freshsales", "seat"],
    facts: ["Works with a 20-person sales team"],
    claims: [
      { subject: "HubSpot Sales Hub", attribute: "Starter plan price", value: "$20 per seat per month (annual billing)", sourceUrl: "https://www.hubspot.com/pricing/sales" },
      { subject: "Pipedrive", attribute: "Essential plan price", value: "$14 per seat per month (annual billing)", sourceUrl: "https://www.pipedrive.com/en/pricing" },
      { subject: "Zoho CRM", attribute: "Standard plan price", value: "$14 per seat per month (annual billing)", sourceUrl: "https://www.zoho.com/crm/zohocrm-pricing.html" },
      { subject: "Salesforce Starter Suite", attribute: "plan price", value: "$25 per seat per month (annual billing)", sourceUrl: "https://www.salesforce.com/sales/pricing/" },
      { subject: "Freshsales", attribute: "Growth plan price", value: "$11 per seat per month (annual billing)", sourceUrl: "https://www.freshworks.com/crm/pricing/" },
    ],
  },
  {
    id: "seed-postgres-hosting",
    daysAgo: 11,
    user: "What does managed Postgres hosting cost for a small SaaS? Compare Neon, Supabase and Render.",
    assistant:
      "Managed Postgres for a small SaaS *(demo data, not live pricing)*: Neon Launch from about $19/month, usage-based [1]; Supabase Pro from $25/month per project [2]; Render Postgres Basic from about $6/month [3].",
    sources: [
      { id: 1, url: "https://neon.com/pricing", title: "Neon pricing", domain: "neon.com" },
      { id: 2, url: "https://supabase.com/pricing", title: "Supabase pricing", domain: "supabase.com" },
      { id: 3, url: "https://render.com/pricing", title: "Render pricing", domain: "render.com" },
    ],
    summary:
      "The user asked what managed Postgres hosting costs for a small SaaS and wanted Neon, Supabase and Render compared. The answer recorded entry paid-plan prices for each. (demo data)",
    keywords: ["postgres", "hosting", "managed", "pricing", "neon", "supabase", "render", "saas"],
    facts: ["Building a small SaaS product"],
    claims: [
      { subject: "Neon", attribute: "Launch plan price", value: "$19 per month (usage-based)", sourceUrl: "https://neon.com/pricing" },
      { subject: "Supabase", attribute: "Pro plan price", value: "$25 per month per project", sourceUrl: "https://supabase.com/pricing" },
      { subject: "Render Postgres", attribute: "Basic plan price", value: "$6 per month", sourceUrl: "https://render.com/pricing" },
    ],
  },
];

export function seed(store: MemoryStore, tz: string, now = new Date()): number {
  let added = 0;
  for (const c of CHATS) {
    if (store.getConversation(c.id)) continue;
    const at = new Date(now.getTime() - c.daysAgo * 86_400_000);
    const iso = at.toISOString();
    store.createConversation(iso, c.id, c.user.slice(0, 60));
    store.appendMessage({ conversationId: c.id, role: "user", content: c.user, createdAt: iso });
    const aId = store.appendMessage({
      conversationId: c.id,
      role: "assistant",
      content: c.assistant,
      createdAt: new Date(at.getTime() + 20_000).toISOString(),
      meta: { sources: c.sources },
    });
    const ep = store.addEpisode({
      conversationId: c.id,
      turnKey: aId,
      localDate: localYMD(at, tz),
      createdAt: iso,
      summary: c.summary,
      keywords: c.keywords,
    });
    if (c.facts) store.addFacts(c.facts, iso);
    store.recordClaims(ep, c.claims, localYMD(at, tz), iso);
    added++;
  }
  return added;
}

if (process.argv[1] && /seed\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  const cfg = loadConfig();
  const store = new MemoryStore(cfg.dbPath);
  const n = seed(store, cfg.defaultTz);
  console.log(n ? `Seeded ${n} demo chat(s) into ${cfg.dbPath}.` : "Demo history already present; nothing to do.");
  store.close();
}
