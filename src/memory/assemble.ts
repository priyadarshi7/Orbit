import * as chrono from "chrono-node";
import { tokenize, truncate } from "../util/text";
import { daysBetween, formatLongDate, localYMD, tzOffsetMinutes } from "../util/time";
import { MemoryStore, toFtsQuery, type ClaimRow, type EpisodeRow } from "./store";

export interface MemoryContext {
  /** Text block placed in the user turn. Empty string when there is nothing to say. */
  text: string;
  stats: {
    episodes: number;
    claims: number;
    /** null = the message referenced no past date; false = it did, and nothing is stored. */
    hadRecord: boolean | null;
  };
  referencedDates: string[];
}

/**
 * Does the message refer back to an earlier conversation? A date alone is not enough:
 * "I was born on 30 April 2005" mentions a date but asks nothing about past chats.
 */
const RECALL_CUES =
  /\b(earlier|before|previous(ly)?|last (time|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|again|asked|ask(ed)? you|told|said|remember|recall|since|changed?|still|shortlist(ed)?|discuss(ed)?|talk(ed)?|mentioned|covered|conversation|chat(ted)?|(what|when|how) (did|have|had) (i|we)|did (i|we)|we (had|were|looked|chose|picked)|you (said|told|recommended|suggested|gave))\b/i;

/**
 * Resolve date expressions in the user's message ("last Tuesday", "3 November",
 * "on Monday") to local calendar dates in the past. Pure code, no LLM.
 */
export function resolveDates(message: string, now: Date, tz: string): string[] {
  const today = localYMD(now, tz);
  const results = chrono.parse(message, { instant: now, timezone: tzOffsetMinutes(now, tz) }, { forwardDate: false });
  const out = new Set<string>();
  for (const r of results) {
    const start = r.start;
    if (!start.isCertain("day") && !start.isCertain("weekday")) continue;
    const addDay = (d: Date, explicitYear: boolean) => {
      let ymd = localYMD(d, tz);
      // A date in the future almost always means "the most recent one" when recalling.
      if (ymd > today) {
        const prev = new Date(d);
        if (!explicitYear && start.isCertain("month")) prev.setUTCFullYear(prev.getUTCFullYear() - 1);
        else if (!start.isCertain("month") && start.isCertain("weekday")) prev.setUTCDate(prev.getUTCDate() - 7);
        ymd = localYMD(prev, tz);
      }
      if (ymd < today) out.add(ymd);
    };
    const s = start.date();
    const e = r.end?.date();
    addDay(s, start.isCertain("year"));
    if (e) {
      // Ranges ("last week"): include each day, capped.
      const days = Math.min(7, Math.max(0, daysBetween(localYMD(s, tz), localYMD(e, tz))));
      for (let i = 1; i <= days; i++) addDay(new Date(s.getTime() + i * 86_400_000), start.isCertain("year"));
    }
  }
  return [...out].sort().slice(-4);
}

const claimLine = (c: ClaimRow): string =>
  `  - ${c.subject} · ${c.attribute}: ${c.value} (recorded ${c.asOf}${c.sourceUrl ? `, ${c.sourceUrl}` : ""})`;

function episodeBlock(e: EpisodeRow, claims: ClaimRow[]): string {
  const mine = claims.filter((c) => c.episodeId === e.id).slice(0, 10);
  return [`• ${e.localDate}: ${truncate(e.summary, 300)}`, ...(mine.length ? [`  Claims recorded then:`, ...mine.map(claimLine)] : [])].join("\n");
}

export function assembleMemory(
  store: MemoryStore,
  opts: { message: string; conversationId: string; now: Date; tz: string },
): MemoryContext {
  const { message, conversationId, now, tz } = opts;
  const lines: string[] = [];
  const stats = { episodes: 0, claims: 0, hadRecord: null as boolean | null };

  const facts = store.facts(15);
  if (facts.length) lines.push("What the user has told you about themselves:", ...facts.map((f) => `- ${f}`), "");

  const cued = RECALL_CUES.test(message);
  // Dates only count as "recalling a past chat" when the message is actually about one.
  const dates = cued ? resolveDates(message, now, tz) : [];
  const shown = new Map<number, EpisodeRow>();

  // 1. Exact date keys (SQL, no fuzz).
  if (dates.length) {
    const eps = store.episodesOnDates(dates, 8);
    eps.forEach((e) => shown.set(e.id, e));
    stats.hadRecord = eps.length > 0;
  }

  // 2. Topic recall via FTS5 over model-written summaries; only when the user is clearly referring back.
  if (cued || dates.length) {
    const q = toFtsQuery(tokenize(message).filter((t) => !/^\d+$/.test(t)));
    if (q) for (const e of store.searchEpisodes(q, 3)) if (!shown.has(e.id)) shown.set(e.id, e);
  }

  const episodes = [...shown.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const claims = [
    ...store.claimsForEpisodes(episodes.map((e) => e.id)),
    ...(cued || dates.length ? store.claimsBySubject(tokenize(message), 8) : []),
  ];
  const uniqueClaims = [...new Map(claims.map((c) => [c.id, c])).values()];
  stats.episodes = episodes.length;
  stats.claims = uniqueClaims.length;

  if (episodes.length) {
    lines.push("Stored records from earlier chats that may be relevant:");
    lines.push(...episodes.map((e) => episodeBlock(e, uniqueClaims)));
    const orphan = uniqueClaims.filter((c) => !episodes.some((e) => e.id === c.episodeId)).slice(0, 8);
    if (orphan.length) lines.push("Other related claims on file:", ...orphan.map(claimLine));
    lines.push("");
  }

  if (dates.length && stats.hadRecord === false) {
    const near = store.nearestEpisodeDates(dates[0]!, 3);
    lines.push(
      `NO RECORD: nothing is stored for ${dates.map((d) => `${d} (${formatLongDate(new Date(d + "T12:00:00Z"), "UTC")})`).join(", ")}.` +
        (near.length ? ` Nearest stored dates: ${near.join(", ")}.` : " No earlier chats are stored at all."),
      "Say so plainly. Do not invent what was discussed.",
      "",
    );
  }

  const recent = store.recentEpisodes(6, conversationId);
  if (recent.length) {
    lines.push(
      "Recent chats (date · topic):",
      ...recent
        .slice()
        .reverse()
        .map((e) => `- ${e.localDate} · ${truncate(e.summary, 90)}`),
    );
  }

  const body = lines.join("\n").trim();
  return {
    text: body ? `<memory>\n${body}\n</memory>` : "",
    stats,
    referencedDates: dates,
  };
}
