/**
 * Questions whose answer goes stale: prices, versions, "latest", who holds a role now, scores, weather.
 * If the model answered one of these without searching, the harness makes it search (see run.ts).
 * Deliberately conservative: a false positive costs one extra search, a false negative ships a stale answer.
 */
const FRESH = [
  /\b(latest|newest|most recent|current(ly)?|right now|at the moment|up[- ]to[- ]date|as of (now|today))\b/i,
  /\b(price|pricing|cost|costs|how much)\b.*\b(now|today|currently|per (month|year|seat|user))\b/i,
  /\b(price|pricing)\b/i,
  /\b(stock|share price|exchange rate|weather|forecast|score|standings|odds)\b/i,
  /\b(news|headlines|breaking|trending|released?|launch(ed)?|announced?|changelog|release notes)\b/i,
  /\bwho (is|are) the (current )?(ceo|cto|president|prime minister|chair|head|leader|owner|mayor)\b/i,
  /\bwhat'?s new\b/i,
  /\b(this|last) (week|month|year|quarter)\b/i,
  /\b(today'?s|tonight'?s|tomorrow'?s)\b/i,
];

/** Questions about earlier chats are answered from memory, not the web. */
const RECALL = /\b(did (i|we)|we (talked|discussed|looked|shortlisted)|i (asked|said|told)|earlier|last time|remember|our (chat|conversation))\b/i;

export function needsFreshSearch(question: string): boolean {
  const q = question.trim();
  if (q.length < 6 || RECALL.test(q)) return false;
  return FRESH.some((re) => re.test(q));
}
