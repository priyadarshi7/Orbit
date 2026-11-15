import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Rows written before accounts existed belong to this user; with auth off, everyone is this user. */
export const LEGACY_USER = "local";

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

/** A profile fact. `slot` names what it is about ("birthday"), so a new value replaces the old one. */
export interface FactInput {
  slot?: string;
  fact: string;
}

export interface FactRow {
  id: number;
  fact: string;
  /** The value this fact replaced, when the user changed it. */
  previous: string | null;
}

export type RunStatus = "running" | "done" | "failed" | "stopped" | "interrupted";

/** One chat turn's durable record: what it belongs to and how it ended. */
export interface RunRow {
  id: string;
  requestId: string | null;
  conversationId: string | null;
  userMessageId: string | null;
  status: RunStatus;
  error: string | null;
  assistantMessageId: string | null;
  startedAt: string;
  finishedAt: string | null;
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
  user_id TEXT NOT NULL DEFAULT 'local',
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
  user_id TEXT NOT NULL DEFAULT 'local',
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
  user_id TEXT NOT NULL DEFAULT 'local',
  slot TEXT,
  fact TEXT NOT NULL,
  previous_fact TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, fact)
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'local',
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

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_id TEXT,
  conversation_id TEXT,
  user_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  assistant_message_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_runs_conv ON runs(conversation_id, started_at);

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Brings a database created before per-user scoping up to the current shape. Safe to run every start. */
function migrate(db: Database.Database): void {
  const hasCol = (table: string, col: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

  for (const t of ["conversations", "episodes", "claims"]) {
    if (!hasCol(t, "user_id")) db.exec(`ALTER TABLE ${t} ADD COLUMN user_id TEXT NOT NULL DEFAULT '${LEGACY_USER}'`);
  }
  if (!hasCol("profile_facts", "user_id")) {
    // UNIQUE(fact) becomes UNIQUE(user_id, fact), which SQLite can only do by rebuilding the table.
    db.exec(`
      CREATE TABLE profile_facts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL DEFAULT '${LEGACY_USER}',
        slot TEXT,
        fact TEXT NOT NULL,
        previous_fact TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, fact)
      );
      INSERT INTO profile_facts_new (id, fact, created_at) SELECT id, fact, created_at FROM profile_facts;
      DROP TABLE profile_facts;
      ALTER TABLE profile_facts_new RENAME TO profile_facts;
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_episodes_user ON episodes(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_claims_user ON claims(user_id, id);
    CREATE INDEX IF NOT EXISTS idx_facts_user ON profile_facts(user_id, slot);
  `);
}

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

/**
 * All user-owned data (conversations, episodes, profile facts, claims) is scoped to `userId`.
 * `forUser()` returns a view over the same database handle, so every existing call site keeps its
 * signature and cannot reach another user's rows. The default view is the legacy single user.
 */
export class MemoryStore {
  readonly db: Database.Database;
  readonly userId: string;
  private readonly owner: boolean;

  constructor(path: string | Database.Database, userId: string = LEGACY_USER) {
    if (typeof path === "string") {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      this.db = new Database(path);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(SCHEMA);
      migrate(this.db);
      this.owner = true;
    } else {
      this.db = path;
      this.owner = false;
    }
    this.userId = userId;
  }

  forUser(userId: string): MemoryStore {
    return userId === this.userId ? this : new MemoryStore(this.db, userId);
  }

  /** Closes the database; a scoped view never does. */
  close(): void {
    if (this.owner && this.db.open) this.db.close();
  }

  // ── small key/value settings (auth secret, one-time flags) ─────────────
  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)").run(key, value);
  }

  /** True when rows exist that were written before accounts, under the legacy user. */
  hasLegacyData(): boolean {
    return (
      this.db.prepare("SELECT 1 FROM conversations WHERE user_id = ? LIMIT 1").get(LEGACY_USER) !== undefined ||
      this.db.prepare("SELECT 1 FROM profile_facts WHERE user_id = ? LIMIT 1").get(LEGACY_USER) !== undefined
    );
  }

  /** Hands everything owned by the legacy user to `userId` (used once, so an existing database is not orphaned). */
  adoptLegacyData(userId: string): void {
    const tx = this.db.transaction(() => {
      for (const t of ["conversations", "episodes", "profile_facts", "claims"]) {
        this.db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id = ?`).run(userId, LEGACY_USER);
      }
    });
    tx();
  }

  // ── conversations & messages ──────────────────────────────────────────
  /**
   * Creates a conversation owned by this user and returns its id. If `id` is already taken
   * (by anyone), a fresh id is used, so a client can never write into someone else's conversation.
   */
  createConversation(now: string, id: string = randomUUID(), title = "New chat"): string {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run(id, this.userId, title, now, now);
    if (res.changes === 0 && !this.getConversation(id)) return this.createConversation(now, randomUUID(), title);
    return id;
  }

  getConversation(id: string): ConversationRow | null {
    const r = this.db
      .prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?")
      .get(id, this.userId) as { id: string; title: string; created_at: string; updated_at: string } | undefined;
    return r ? { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }

  listConversations(limit = 100): ConversationRow[] {
    const rows = this.db
      .prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(this.userId, limit) as { id: string; title: string; created_at: string; updated_at: string }[];
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  setTitle(id: string, title: string): void {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?").run(title, id, this.userId);
  }

  deleteConversation(id: string): void {
    if (!this.getConversation(id)) return;
    const eps = this.db.prepare("SELECT id FROM episodes WHERE conversation_id = ?").all(id) as { id: number }[];
    const del = this.db.prepare("DELETE FROM episodes_fts WHERE rowid = ?");
    for (const e of eps) del.run(e.id);
    this.db.prepare("DELETE FROM runs WHERE conversation_id = ? AND user_id = ?").run(id, this.userId);
    this.db.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(id, this.userId);
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
        `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, m.meta
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.conversation_id = ? AND c.user_id = ? ORDER BY m.created_at, m.rowid`,
      )
      .all(conversationId, this.userId) as {
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

  /** True while the message still exists (a rewound turn's background job checks this before writing memory). */
  hasMessage(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(id) !== undefined;
  }

  /**
   * Edit and regenerate: removes `messageId` and everything after it, together with the memory
   * (episodes and the claims they recorded) that those turns produced, so a discarded attempt
   * leaves no trace in history or recall. Returns how many messages were removed.
   */
  rewindFrom(conversationId: string, messageId: string): number {
    if (!this.getConversation(conversationId)) return 0;
    const tx = this.db.transaction(() => {
      const at = this.db
        .prepare("SELECT rowid AS r FROM messages WHERE id = ? AND conversation_id = ?")
        .get(messageId, conversationId) as { r: number } | undefined;
      if (!at) return 0;
      const gone = this.db
        .prepare("SELECT id FROM messages WHERE conversation_id = ? AND rowid >= ?")
        .all(conversationId, at.r) as { id: string }[];
      for (const g of gone) {
        const ep = this.db.prepare("SELECT id FROM episodes WHERE turn_key = ?").get(g.id) as { id: number } | undefined;
        if (!ep) continue;
        this.db.prepare("DELETE FROM claims WHERE episode_id = ?").run(ep.id);
        this.db.prepare("DELETE FROM episodes_fts WHERE rowid = ?").run(ep.id);
        this.db.prepare("DELETE FROM episodes WHERE id = ?").run(ep.id);
      }
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ? AND rowid >= ?").run(conversationId, at.r);
      return gone.length;
    });
    return tx();
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
          "INSERT INTO episodes (user_id, conversation_id, turn_key, local_date, created_at, summary, keywords) VALUES (?,?,?,?,?,?,?)",
        )
        .run(this.userId, e.conversationId, e.turnKey, e.localDate, e.createdAt, e.summary, kw);
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
      .prepare(`SELECT * FROM episodes WHERE user_id = ? AND local_date IN (${ph}) ORDER BY created_at LIMIT ?`)
      .all(this.userId, ...localDates, limit) as Parameters<MemoryStore["mapEpisode"]>[0][];
    return rows.map((r) => this.mapEpisode(r));
  }

  searchEpisodes(ftsQuery: string, limit = 4): EpisodeRow[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT e.* FROM episodes_fts f JOIN episodes e ON e.id = f.rowid
           WHERE episodes_fts MATCH ? AND e.user_id = ? ORDER BY bm25(episodes_fts, 3.0, 1.5) LIMIT ?`,
        )
        .all(ftsQuery, this.userId, limit) as Parameters<MemoryStore["mapEpisode"]>[0][];
      return rows.map((r) => this.mapEpisode(r));
    } catch {
      return [];
    }
  }

  recentEpisodes(limit = 8, excludeConversation?: string): EpisodeRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM episodes WHERE user_id = ? AND (? IS NULL OR conversation_id != ?) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(this.userId, excludeConversation ?? null, excludeConversation ?? null, limit) as Parameters<
      MemoryStore["mapEpisode"]
    >[0][];
    return rows.map((r) => this.mapEpisode(r));
  }

  episodesForConversation(conversationId: string): EpisodeRow[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE user_id = ? AND conversation_id = ? ORDER BY created_at")
      .all(this.userId, conversationId) as Parameters<MemoryStore["mapEpisode"]>[0][];
    return rows.map((r) => this.mapEpisode(r));
  }

  /** Distinct episode dates closest to `localDate`, for "no record, nearest are…" replies. */
  nearestEpisodeDates(localDate: string, n = 3): string[] {
    const rows = this.db
      .prepare(
        `SELECT local_date AS d FROM episodes WHERE user_id = ? GROUP BY local_date
         ORDER BY ABS(julianday(local_date) - julianday(?)) LIMIT ?`,
      )
      .all(this.userId, localDate, n) as { d: string }[];
    return rows.map((r) => r.d).sort();
  }

  // ── profile ───────────────────────────────────────────────────────────
  /**
   * Stores what the user said about themselves. A fact with a `slot` ("birthday", "city") replaces the
   * earlier fact in that slot instead of sitting beside it, keeping the old text as `previous`.
   */
  addFacts(facts: (string | FactInput)[], now: string): void {
    const find = this.db.prepare("SELECT id, fact FROM profile_facts WHERE user_id = ? AND slot = ? ORDER BY id DESC LIMIT 1");
    const replace = this.db.prepare("UPDATE profile_facts SET fact = ?, previous_fact = ?, created_at = ? WHERE id = ?");
    const ins = this.db.prepare("INSERT OR IGNORE INTO profile_facts (user_id, slot, fact, created_at) VALUES (?,?,?,?)");
    const tx = this.db.transaction(() => {
      for (const f of facts) {
        const input: FactInput = typeof f === "string" ? { fact: f } : f;
        const text = input.fact.trim();
        if (text.length <= 2 || text.length > 240) continue;
        const slot = input.slot ? norm(input.slot).slice(0, 40) || null : null;
        if (slot) {
          const prior = find.get(this.userId, slot) as { id: number; fact: string } | undefined;
          if (prior) {
            if (norm(prior.fact) !== norm(text)) replace.run(text, prior.fact, now, prior.id);
            continue;
          }
        }
        ins.run(this.userId, slot, text, now);
      }
    });
    tx();
  }

  factRows(limit = 50): FactRow[] {
    return (
      this.db
        .prepare("SELECT id, fact, previous_fact FROM profile_facts WHERE user_id = ? ORDER BY id DESC LIMIT ?")
        .all(this.userId, limit) as { id: number; fact: string; previous_fact: string | null }[]
    ).map((r) => ({ id: r.id, fact: r.fact, previous: r.previous_fact }));
  }

  /** The slots this user already has, newest first, so the extractor can reuse a name instead of inventing a second one. */
  factSlots(limit = 30): { slot: string; fact: string }[] {
    return this.db
      .prepare("SELECT slot, fact FROM profile_facts WHERE user_id = ? AND slot IS NOT NULL ORDER BY id DESC LIMIT ?")
      .all(this.userId, limit) as { slot: string; fact: string }[];
  }

  deleteFact(id: number): boolean {
    return this.db.prepare("DELETE FROM profile_facts WHERE id = ? AND user_id = ?").run(id, this.userId).changes > 0;
  }

  getClaim(id: number): ClaimRow | null {
    const r = this.db.prepare("SELECT * FROM claims WHERE id = ? AND user_id = ?").get(id, this.userId) as
      | Parameters<MemoryStore["mapClaim"]>[0]
      | undefined;
    return r ? this.mapClaim(r) : null;
  }

  /** Deleting a claim leaves any later claim that superseded it intact (the FK sets supersedes_id to null). */
  deleteClaim(id: number): boolean {
    return this.db.prepare("DELETE FROM claims WHERE id = ? AND user_id = ?").run(id, this.userId).changes > 0;
  }

  facts(limit = 20): string[] {
    return (
      this.db
        .prepare("SELECT fact FROM profile_facts WHERE user_id = ? ORDER BY id DESC LIMIT ?")
        .all(this.userId, limit) as { fact: string }[]
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
    const latest = this.db.prepare("SELECT id, value FROM claims WHERE user_id = ? AND key = ? ORDER BY id DESC LIMIT 1");
    const confirm = this.db.prepare("UPDATE claims SET confirmed_at = ? WHERE id = ?");
    const insert = this.db.prepare(
      `INSERT INTO claims (user_id, subject, attribute, key, value, as_of, source_url, episode_id, supersedes_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    const tx = this.db.transaction(() => {
      for (const c of claims) {
        const subject = c.subject.trim();
        const attribute = c.attribute.trim();
        const value = c.value.trim();
        if (!subject || !attribute || !value) continue;
        const key = `${norm(subject)}|${norm(attribute)}`;
        const prior = latest.get(this.userId, key) as { id: number; value: string } | undefined;
        if (prior && norm(prior.value) === norm(value)) {
          confirm.run(now, prior.id);
          continue;
        }
        insert.run(this.userId, subject, attribute, key, value, c.asOf ?? asOfDefault, c.sourceUrl ?? null, episodeId, prior?.id ?? null, now);
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
      .prepare(`SELECT * FROM claims WHERE user_id = ? AND episode_id IN (${ph}) ORDER BY id`)
      .all(this.userId, ...episodeIds) as Parameters<MemoryStore["mapClaim"]>[0][];
    return rows.map((r) => this.mapClaim(r));
  }

  /** Claims whose subject mentions any of the given tokens. */
  claimsBySubject(tokens: string[], limit = 12): ClaimRow[] {
    const t = [...new Set(tokens.map(norm).filter((x) => x.length > 2))].slice(0, 6);
    if (t.length === 0) return [];
    const where = t.map(() => "key LIKE ?").join(" OR ");
    const rows = this.db
      .prepare(`SELECT * FROM claims WHERE user_id = ? AND (${where}) ORDER BY id DESC LIMIT ?`)
      .all(this.userId, ...t.map((x) => `%${x}%`), limit) as Parameters<MemoryStore["mapClaim"]>[0][];
    return rows.map((r) => this.mapClaim(r)).reverse();
  }

  recentClaims(limit = 40): ClaimRow[] {
    const rows = this.db
      .prepare("SELECT * FROM claims WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .all(this.userId, limit) as Parameters<MemoryStore["mapClaim"]>[0][];
    return rows.map((r) => this.mapClaim(r));
  }

  // ── runs (one durable record per chat turn) ──────────────────────────
  private mapRun(r: {
    id: string;
    request_id: string | null;
    conversation_id: string | null;
    user_message_id: string | null;
    status: RunStatus;
    error: string | null;
    assistant_message_id: string | null;
    started_at: string;
    finished_at: string | null;
  }): RunRow {
    return {
      id: r.id,
      requestId: r.request_id,
      conversationId: r.conversation_id,
      userMessageId: r.user_message_id,
      status: r.status,
      error: r.error,
      assistantMessageId: r.assistant_message_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    };
  }

  createRun(r: { id: string; requestId?: string | null; conversationId?: string | null; startedAt: string }): void {
    this.db
      .prepare("INSERT INTO runs (id, user_id, request_id, conversation_id, started_at) VALUES (?,?,?,?,?)")
      .run(r.id, this.userId, r.requestId ?? null, r.conversationId ?? null, r.startedAt);
  }

  /** Once the turn has saved the question, record which conversation and message it is about. */
  setRunTarget(id: string, conversationId: string, userMessageId: string): void {
    this.db
      .prepare("UPDATE runs SET conversation_id = ?, user_message_id = ? WHERE id = ? AND user_id = ?")
      .run(conversationId, userMessageId, id, this.userId);
  }

  finishRun(id: string, status: Exclude<RunStatus, "running">, at: string, extra: { error?: string; assistantMessageId?: string } = {}): void {
    this.db
      .prepare("UPDATE runs SET status = ?, finished_at = ?, error = ?, assistant_message_id = ? WHERE id = ? AND user_id = ? AND status = 'running'")
      .run(status, at, extra.error ?? null, extra.assistantMessageId ?? null, id, this.userId);
  }

  getRun(id: string): RunRow | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ? AND user_id = ?").get(id, this.userId) as Parameters<MemoryStore["mapRun"]>[0] | undefined;
    return r ? this.mapRun(r) : null;
  }

  runByRequest(requestId: string): RunRow | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE request_id = ? AND user_id = ?").get(requestId, this.userId) as
      | Parameters<MemoryStore["mapRun"]>[0]
      | undefined;
    return r ? this.mapRun(r) : null;
  }

  latestRunFor(conversationId: string): RunRow | null {
    const r = this.db
      .prepare("SELECT * FROM runs WHERE conversation_id = ? AND user_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(conversationId, this.userId) as Parameters<MemoryStore["mapRun"]>[0] | undefined;
    return r ? this.mapRun(r) : null;
  }

  /**
   * Startup reconciliation for every user: a turn still marked running when the process starts was cut
   * off by a crash or restart, so it can never finish. Single-node assumption (see DESIGN.md).
   */
  interruptRunningRuns(at: string): number {
    return this.db
      .prepare("UPDATE runs SET status = 'interrupted', finished_at = ?, error = 'The server restarted while this answer was being written.' WHERE status = 'running'")
      .run(at).changes;
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
