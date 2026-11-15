import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface MessageRow {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  meta: Record<string, unknown> | null;
}

export interface ConversationRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface EpisodeRow {
  id: number;
  conversationId: string;
  localDate: string;
  createdAt: string;
  summary: string;
  keywords: string;
}

export interface ClaimRow {
  id: number;
  subject: string;
  attribute: string;
  value: string;
  asOf: string;
  sourceUrl: string | null;
  episodeId: number | null;
  supersedesId: number | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface ClaimInput {
  subject: string;
  attribute: string;
  value: string;
  asOf?: string;
  sourceUrl?: string | null;
}

export interface OutboxJob {
  id: number;
  kind: string;
  payload: unknown;
  attempts: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_key TEXT NOT NULL UNIQUE,
  local_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  keywords TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_date ON episodes(local_date);
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  summary, keywords, tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS profile_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  attribute TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  as_of TEXT NOT NULL,
  source_url TEXT,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  supersedes_id INTEGER REFERENCES claims(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_key ON claims(key, id);
CREATE INDEX IF NOT EXISTS idx_claims_episode ON claims(episode_id);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after INTEGER NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, run_after);

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Sanitise free text into a safe FTS5 MATCH expression (OR of quoted prefix terms). */
export function toFtsQuery(tokens: string[]): string | null {
  const safe = [...new Set(tokens)]
    .map((t) => t.replace(/[^a-z0-9]/gi, ""))
    .filter((t) => t.length > 1);
  if (safe.length === 0) return null;
  return safe.map((t) => `"${t}"*`).join(" OR ");
}

export class MemoryStore {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── conversations & messages ──────────────────────────────────────────
  createConversation(now: string, id: string = randomUUID(), title = "New chat"): string {
    this.db
      .prepare("INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?,?,?,?)")
      .run(id, title, now, now);
    return id;
  }

  getConversation(id: string): ConversationRow | null {
    const r = this.db
      .prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?")
      .get(id) as { id: string; title: string; created_at: string; updated_at: string } | undefined;
    return r ? { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }

  listConversations(limit = 100): ConversationRow[] {
    const rows = this.db
      .prepare("SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as { id: string; title: string; created_at: string; updated_at: string }[];
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  setTitle(id: string, title: string): void {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
  }

  deleteConversation(id: string): void {
    const eps = this.db.prepare("SELECT id FROM episodes WHERE conversation_id = ?").all(id) as { id: number }[];
    const del = this.db.prepare("DELETE FROM episodes_fts WHERE rowid = ?");
    for (const e of eps) del.run(e.id);
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  }

  appendMessage(m: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
    meta?: Record<string, unknown>;
    id?: string;
  }): string {
    const id = m.id ?? randomUUID();
    this.db
      .prepare("INSERT INTO messages (id, conversation_id, role, content, created_at, meta) VALUES (?,?,?,?,?,?)")
      .run(id, m.conversationId, m.role, m.content, m.createdAt, m.meta ? JSON.stringify(m.meta) : null);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(m.createdAt, m.conversationId);
    return id;
  }

  getMessages(conversationId: string): MessageRow[] {
    const rows = this.db
      .prepare(
        "SELECT id, conversation_id, role, content, created_at, meta FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid",
      )
      .all(conversationId) as {
      id: string;
      conversation_id: string;
      role: "user" | "assistant";
      content: string;
      created_at: string;
      meta: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
    }));
  }

  // ── episodes ──────────────────────────────────────────────────────────
  /** Idempotent per turnKey. Returns the episode id. */
  addEpisode(e: {
    conversationId: string;
    turnKey: string;
    localDate: string;
    createdAt: string;
    summary: string;
    keywords: string[];
  }): number {
    const existing = this.db.prepare("SELECT id FROM episodes WHERE turn_key = ?").get(e.turnKey) as
      | { id: number }
      | undefined;
    if (existing) return existing.id;
    const kw = e.keywords.join(" ");
    const tx = this.db.transaction(() => {
      const res = this.db
        .prepare(
          "INSERT INTO episodes (conversation_id, turn_key, local_date, created_at, summary, keywords) VALUES (?,?,?,?,?,?)",
        )
        .run(e.conversationId, e.turnKey, e.localDate, e.createdAt, e.summary, kw);
      const id = Number(res.lastInsertRowid);
      this.db.prepare("INSERT INTO episodes_fts (rowid, summary, keywords) VALUES (?,?,?)").run(id, e.summary, kw);
      return id;
    });
    return tx();
  }

  private mapEpisode(r: {
    id: number;
    conversation_id: string;
    local_date: string;
    created_at: string;
    summary: string;
    keywords: string;
  }): EpisodeRow {
    return {
      id: r.id,
      conversationId: r.conversation_id,
      localDate: r.local_date,
      createdAt: r.created_at,
      summary: r.summary,
      keywords: r.keywords,
    };
  }

  episodesOnDates(localDates: string[], limit = 8): EpisodeRow[] {
    if (localDates.length === 0) return [];
    const ph = localDates.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM episodes WHERE local_date IN (${ph}) ORDER BY created_at LIMIT ?`)
      .all(...localDates, limit) as Parameters<MemoryStore["mapEpisode"]>[0][];
    return rows.map((r) => this.mapEpisode(r));
  }

  searchEpisodes(ftsQuery: string, limit = 4): EpisodeRow[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT e.* FROM episodes_fts f JOIN episodes e ON e.id = f.rowid
           WHERE episodes_fts MATCH ? ORDER BY bm25(episodes_fts, 3.0, 1.5) LIMIT ?`,
        )
        .all(ftsQuery, limit) as Parameters<MemoryStore["mapEpisode"]>[0][];
      return rows.map((r) => this.mapEpisode(r));
    } catch {
      return [];
    }
  }

  recentEpisodes(limit = 8, excludeConversation?: string): EpisodeRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM episodes WHERE (? IS NULL OR conversation_id != ?) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(excludeConversation ?? null, excludeConversation ?? null, limit) as Parameters<
      MemoryStore["mapEpisode"]
    >[0][];
    return rows.map((r) => this.mapEpisode(r));
  }

  episodesForConversation(conversationId: string): EpisodeRow[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE conversation_id = ? ORDER BY created_at")
      .all(conversationId) as Parameters<MemoryStore["mapEpisode"]>[0][];
    return rows.map((r) => this.mapEpisode(r));
  }

  /** Distinct episode dates closest to `localDate`, for "no record, nearest are…" replies. */
  nearestEpisodeDates(localDate: string, n = 3): string[] {
    const rows = this.db
      .prepare(
        `SELECT local_date AS d FROM episodes GROUP BY local_date
         ORDER BY ABS(julianday(local_date) - julianday(?)) LIMIT ?`,
      )
      .all(localDate, n) as { d: string }[];
    return rows.map((r) => r.d).sort();
  }

  // ── profile ───────────────────────────────────────────────────────────
  addFacts(facts: string[], now: string): void {
    const ins = this.db.prepare("INSERT OR IGNORE INTO profile_facts (fact, created_at) VALUES (?,?)");
    for (const f of facts) {
      const t = f.trim();
      if (t.length > 2 && t.length <= 240) ins.run(t, now);
    }
  }

  factRows(limit = 50): { id: number; fact: string }[] {
    return this.db.prepare("SELECT id, fact FROM profile_facts ORDER BY id DESC LIMIT ?").all(limit) as { id: number; fact: string }[];
  }

  deleteFact(id: number): boolean {
    return this.db.prepare("DELETE FROM profile_facts WHERE id = ?").run(id).changes > 0;
  }

  getClaim(id: number): ClaimRow | null {
    const r = this.db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as Parameters<MemoryStore["mapClaim"]>[0] | undefined;
    return r ? this.mapClaim(r) : null;
  }

  /** Deleting a claim leaves any later claim that superseded it intact (the FK sets supersedes_id to null). */
  deleteClaim(id: number): boolean {
    return this.db.prepare("DELETE FROM claims WHERE id = ?").run(id).changes > 0;
  }

  facts(limit = 20): string[] {
    return (
      this.db.prepare("SELECT fact FROM profile_facts ORDER BY id DESC LIMIT ?").all(limit) as { fact: string }[]
    )
      .map((r) => r.fact)
      .reverse();
  }

  // ── claims ────────────────────────────────────────────────────────────
  private mapClaim(r: {
    id: number;
    subject: string;
    attribute: string;
    value: string;
    as_of: string;
    source_url: string | null;
    episode_id: number | null;
    supersedes_id: number | null;
    created_at: string;
    confirmed_at: string | null;
  }): ClaimRow {
    return {
      id: r.id,
      subject: r.subject,
      attribute: r.attribute,
      value: r.value,
      asOf: r.as_of,
      sourceUrl: r.source_url,
      episodeId: r.episode_id,
      supersedesId: r.supersedes_id,
      createdAt: r.created_at,
      confirmedAt: r.confirmed_at,
    };
  }

  /**
   * Record claims. A claim with the same subject+attribute as an earlier one:
   *  - same value  -> the earlier claim is re-confirmed (no duplicate row)
   *  - new value   -> inserted, linked to the one it supersedes
   */
  recordClaims(episodeId: number | null, claims: ClaimInput[], asOfDefault: string, now: string): number {
    let inserted = 0;
    const latest = this.db.prepare("SELECT id, value FROM claims WHERE key = ? ORDER BY id DESC LIMIT 1");
    const confirm = this.db.prepare("UPDATE claims SET confirmed_at = ? WHERE id = ?");
    const insert = this.db.prepare(
      `INSERT INTO claims (subject, attribute, key, value, as_of, source_url, episode_id, supersedes_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    const tx = this.db.transaction(() => {
      for (const c of claims) {
        const subject = c.subject.trim();
        const attribute = c.attribute.trim();
        const value = c.value.trim();
        if (!subject || !attribute || !value) continue;
        const key = `${norm(subject)}|${norm(attribute)}`;
        const prior = latest.get(key) as { id: number; value: string } | undefined;
        if (prior && norm(prior.value) === norm(value)) {
          confirm.run(now, prior.id);
          continue;
        }
        insert.run(subject, attribute, key, value, c.asOf ?? asOfDefault, c.sourceUrl ?? null, episodeId, prior?.id ?? null, now);
        inserted++;
      }
    });
    tx();
    return inserted;
  }

  claimsForEpisodes(episodeIds: number[]): ClaimRow[] {
    if (episodeIds.length === 0) return [];
    const ph = episodeIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM claims WHERE episode_id IN (${ph}) ORDER BY id`)
      .all(...episodeIds) as Parameters<MemoryStore["mapClaim"]>[0][];
    return rows.map((r) => this.mapClaim(r));
  }

  /** Claims whose subject mentions any of the given tokens. */
  claimsBySubject(tokens: string[], limit = 12): ClaimRow[] {
    const t = [...new Set(tokens.map(norm).filter((x) => x.length > 2))].slice(0, 6);
    if (t.length === 0) return [];
    const where = t.map(() => "key LIKE ?").join(" OR ");
    const rows = this.db
      .prepare(`SELECT * FROM claims WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(...t.map((x) => `%${x}%`), limit) as Parameters<MemoryStore["mapClaim"]>[0][];
    return rows.map((r) => this.mapClaim(r)).reverse();
  }

  recentClaims(limit = 40): ClaimRow[] {
    const rows = this.db
      .prepare("SELECT * FROM claims ORDER BY id DESC LIMIT ?")
      .all(limit) as Parameters<MemoryStore["mapClaim"]>[0][];
    return rows.map((r) => this.mapClaim(r));
  }

  // ── outbox ────────────────────────────────────────────────────────────
  /** Idempotent: a second enqueue with the same dedupeKey is ignored. */
  enqueue(kind: string, dedupeKey: string, payload: unknown, nowMs: number, createdAt: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox (kind, dedupe_key, payload, run_after, created_at) VALUES (?,?,?,?,?)",
      )
      .run(kind, dedupeKey, JSON.stringify(payload), nowMs, createdAt);
  }

  /** After a crash, jobs left 'running' go back to pending. */
  recoverOutbox(): number {
    return this.db.prepare("UPDATE outbox SET status = 'pending' WHERE status = 'running'").run().changes;
  }

  claimNextJob(nowMs: number): OutboxJob | null {
    const tx = this.db.transaction((): OutboxJob | null => {
      const r = this.db
        .prepare("SELECT id, kind, payload, attempts FROM outbox WHERE status = 'pending' AND run_after <= ? ORDER BY id LIMIT 1")
        .get(nowMs) as { id: number; kind: string; payload: string; attempts: number } | undefined;
      if (!r) return null;
      this.db.prepare("UPDATE outbox SET status = 'running', attempts = attempts + 1 WHERE id = ?").run(r.id);
      return { id: r.id, kind: r.kind, payload: JSON.parse(r.payload) as unknown, attempts: r.attempts + 1 };
    });
    return tx();
  }

  completeJob(id: number): void {
    this.db.prepare("UPDATE outbox SET status = 'done' WHERE id = ?").run(id);
  }

  failJob(id: number, error: string, retryAtMs: number | null): void {
    if (retryAtMs === null) {
      this.db.prepare("UPDATE outbox SET status = 'failed', last_error = ? WHERE id = ?").run(error, id);
    } else {
      this.db
        .prepare("UPDATE outbox SET status = 'pending', last_error = ?, run_after = ? WHERE id = ?")
        .run(error, retryAtMs, id);
    }
  }

  outboxStats(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status").all() as {
      status: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  // ── cache (search results, fetched pages) ─────────────────────────────
  cacheGet<T>(key: string, nowMs: number): T | null {
    const r = this.db.prepare("SELECT value, expires_at FROM cache WHERE key = ?").get(key) as
      | { value: string; expires_at: number }
      | undefined;
    if (!r || r.expires_at < nowMs) return null;
    return JSON.parse(r.value) as T;
  }

  cacheSet(key: string, value: unknown, ttlMs: number, nowMs: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?,?,?)")
      .run(key, JSON.stringify(value), nowMs + ttlMs);
  }

  cachePurge(nowMs: number): void {
    this.db.prepare("DELETE FROM cache WHERE expires_at < ?").run(nowMs);
  }
}
