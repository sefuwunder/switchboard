// Switchboard persistence (bun:sqlite).
import { Database } from "bun:sqlite";

export interface Channel {
  id: string;
  label: string;
  enabled: number;
  mode: "instant" | "digest" | "muted";
  min_priority: "low" | "normal" | "high" | "urgent";
  poll_minutes: number;
  snoozed_until: number;
  last_poll_at: number;
  last_error: string;
  last_count: number;
}

export interface Signal {
  id: number;
  channel_id: string;
  ext_id: string;
  title: string;
  body: string;
  url: string;
  priority: string;
  digest_only: number;
  detected_at: number;
  processed: number;
  /** Sender/author identity for VIP matching and analytics (may be ""). */
  sender: string;
}

export interface Notification {
  id: number;
  kind: string;
  title: string;
  body: string;
  url: string;
  priority: string;
  channel_id: string;
  items: string;
  status: string;
  created_at: number;
  snooze_until: number;
  starred: number;
  /** 1 when the signal's sender matched a VIP contact. */
  vip: number;
}

const DEFAULT_SETTINGS: Record<string, string> = {
  quiet_enabled: "1",
  quiet_start: "22:00",
  quiet_end: "07:00",
  digest_minutes: "60",
  urgent_breaks_quiet: "1",
  dnd: "0",
  last_digest_at: "0",
  gcal_ical_url: "",
  ascent_base_url: "http://127.0.0.1:3004",
  vip_list: "[]",
};

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'digest',
      min_priority TEXT NOT NULL DEFAULT 'normal',
      poll_minutes INTEGER NOT NULL DEFAULT 15,
      snoozed_until INTEGER NOT NULL DEFAULT 0,
      last_poll_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      last_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      ext_id TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal',
      digest_only INTEGER NOT NULL DEFAULT 0,
      detected_at INTEGER NOT NULL,
      processed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(channel_id, ext_id)
    );
    CREATE TABLE IF NOT EXISTS digest_queue (
      signal_id INTEGER PRIMARY KEY,
      queued_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal',
      channel_id TEXT NOT NULL DEFAULT '',
      items TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'sent',
      created_at INTEGER NOT NULL,
      snooze_until INTEGER NOT NULL DEFAULT 0
    );
  `);

  const seedChannel = db.prepare(
    `INSERT OR IGNORE INTO channels (id, label, mode, min_priority, poll_minutes)
     VALUES (?, ?, ?, ?, ?)`
  );
  seedChannel.run("calendar", "Google Calendar", "instant", "normal", 15);
  seedChannel.run("clickup", "ClickUp", "digest", "low", 30);
  seedChannel.run("anytype", "Anytype", "digest", "low", 30);
  seedChannel.run("github", "GitHub", "digest", "normal", 15);
  seedChannel.run("ascent", "Ascent", "digest", "low", 5);

  const seedSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seedSetting.run(k, v);

  // Migration: starred column for notifications (older databases predate it).
  const cols = (db.query(`PRAGMA table_info(notifications)`).all() as { name: string }[])
    .map((c) => c.name);
  if (!cols.includes("starred")) {
    db.exec(`ALTER TABLE notifications ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`);
  }
  // Migration: digest_only column for signals (older databases predate it).
  const sigCols = (db.query(`PRAGMA table_info(signals)`).all() as { name: string }[])
    .map((c) => c.name);
  if (!sigCols.includes("digest_only")) {
    db.exec(`ALTER TABLE signals ADD COLUMN digest_only INTEGER NOT NULL DEFAULT 0`);
  }
  // Migration: sender column for signals (VIP matching + analytics).
  if (!sigCols.includes("sender")) {
    db.exec(`ALTER TABLE signals ADD COLUMN sender TEXT NOT NULL DEFAULT ''`);
  }
  // Migration: vip flag for notifications (VIP override badge).
  const notifCols = (db.query(`PRAGMA table_info(notifications)`).all() as { name: string }[])
    .map((c) => c.name);
  if (!notifCols.includes("vip")) {
    db.exec(`ALTER TABLE notifications ADD COLUMN vip INTEGER NOT NULL DEFAULT 0`);
  }
  return db;
}

export function getChannels(db: Database): Channel[] {
  return db.query(`SELECT * FROM channels ORDER BY id`).all() as Channel[];
}

export function getChannel(db: Database, id: string): Channel | null {
  return db.query(`SELECT * FROM channels WHERE id = ?`).get(id) as Channel | null;
}

const CHANNEL_FIELDS = new Set([
  "enabled", "mode", "min_priority", "poll_minutes", "snoozed_until",
  "last_poll_at", "last_error", "last_count",
]);

export function updateChannel(db: Database, id: string, patch: Record<string, unknown>): Channel | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!CHANNEL_FIELDS.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return getChannel(db, id);
  vals.push(id);
  db.prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getChannel(db, id);
}

export function getSetting(db: Database, key: string): string {
  const row = db.query(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | null;
  return row ? row.value : "";
}

export function setSetting(db: Database, key: string, value: string): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function getSettings(db: Database): Record<string, string> {
  const rows = db.query(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Settings that must never leave the server (API keys, tokens). */
const SECRET_SETTINGS = new Set([
  "anytype_api_key",
  "gcal_ical_url",
]);

/** Settings safe to expose to the frontend; secrets are stripped. */
export function getPublicSettings(db: Database): Record<string, string> {
  const all = getSettings(db);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!SECRET_SETTINGS.has(k)) out[k] = v;
  }
  out["gcal_ical_set"] = all["gcal_ical_url"] ? "1" : "";
  return out;
}

/** Insert a signal; returns the row id, or null if it was a duplicate. */
export function insertSignal(
  db: Database,
  channel_id: string,
  ext_id: string,
  title: string,
  body: string,
  url: string,
  priority: string,
  digestOnly = false,
  sender = ""
): number | null {
  const row = db
    .prepare(
      `INSERT OR IGNORE INTO signals
       (channel_id, ext_id, title, body, url, priority, digest_only, sender, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(channel_id, ext_id, title, body || "", url || "", priority, digestOnly ? 1 : 0, sender || "", Date.now()) as { id: number } | null;
  return row ? row.id : null;
}

export function unprocessedSignals(db: Database): Signal[] {
  return db
    .query(`SELECT * FROM signals WHERE processed = 0 ORDER BY detected_at ASC LIMIT 200`)
    .all() as Signal[];
}

export function markProcessed(db: Database, id: number): void {
  db.prepare(`UPDATE signals SET processed = 1 WHERE id = ?`).run(id);
}

export function enqueueDigest(db: Database, signalId: number): void {
  db.prepare(`INSERT OR IGNORE INTO digest_queue (signal_id, queued_at) VALUES (?, ?)`)
    .run(signalId, Date.now());
}

export function digestQueue(db: Database): Signal[] {
  return db
    .query(`SELECT s.* FROM digest_queue q JOIN signals s ON s.id = q.signal_id ORDER BY q.queued_at ASC`)
    .all() as Signal[];
}

export function clearDigestQueue(db: Database): void {
  db.exec(`DELETE FROM digest_queue`);
}

export function addNotification(
  db: Database,
  n: { kind: string; title: string; body?: string; url?: string; priority?: string; channel_id?: string; items?: unknown[]; vip?: boolean }
): Notification {
  const row = db
    .prepare(
      `INSERT INTO notifications
       (kind, title, body, url, priority, channel_id, items, vip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(
      n.kind, n.title, n.body || "", n.url || "", n.priority || "normal",
      n.channel_id || "", JSON.stringify(n.items || []), n.vip ? 1 : 0, Date.now()
    ) as Notification;
  return row;
}

export function recentNotifications(db: Database, limit = 50): Notification[] {
  return db
    .query(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Notification[];
}

/** Searchable archive: full-text-ish match on title/body, newest first. */
export function searchNotifications(
  db: Database, q: string, limit = 50, offset = 0, starredOnly = false
): { notifications: Notification[]; total: number } {
  const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const conds: string[] = [];
  const args: unknown[] = [];
  if (starredOnly) conds.push(`starred = 1`);
  if (q) {
    conds.push(`(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`);
    args.push(like, like);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const total = (db.query(`SELECT COUNT(*) AS c FROM notifications ${where}`).get(...args) as { c: number }).c;
  const notifications = db
    .query(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as Notification[];
  return { notifications, total };
}

export function getNotification(db: Database, id: number): Notification | null {
  return db.query(`SELECT * FROM notifications WHERE id = ?`).get(id) as Notification | null;
}

/** Dismiss every live notification at once ("Clear all" on the line-out feed).
 *  Dismissed ones stay dismissed; starred ones keep their star in Saved. */
export function dismissAllNotifications(db: Database): number {
  const r = db.prepare(`UPDATE notifications SET status = 'dismissed' WHERE status != 'dismissed'`).run();
  return Number((r as any).changes ?? 0);
}

export function updateNotification(db: Database, id: number, patch: { status?: string; snooze_until?: number; starred?: number }): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.status !== undefined) { sets.push("status = ?"); vals.push(patch.status); }
  if (patch.snooze_until !== undefined) { sets.push("snooze_until = ?"); vals.push(patch.snooze_until); }
  if (patch.starred !== undefined) { sets.push("starred = ?"); vals.push(patch.starred); }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE notifications SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function dueSnoozes(db: Database, now: number): Notification[] {
  return db
    .query(`SELECT * FROM notifications WHERE status = 'snoozed' AND snooze_until <= ?`)
    .all(now) as Notification[];
}

export function prune(db: Database): void {
  const week = Date.now() - 7 * 86400 * 1000;
  const month = Date.now() - 30 * 86400 * 1000;
  db.prepare(`DELETE FROM signals WHERE processed = 1 AND detected_at < ?`).run(week);
  db.prepare(`DELETE FROM notifications WHERE created_at < ? AND status != 'snoozed'`).run(month);
}

export interface Insights {
  window_days: number;
  total_signals: number;
  signals_by_channel: { channel_id: string; count: number }[];
  /** Notification routing outcomes: open (sent, never handled), snoozed, handled (dismissed). */
  outcomes: { open: number; snoozed: number; handled: number };
  busiest_hours: { hour: number; count: number }[];
  top_senders: { sender: string; count: number }[];
}

/**
 * Weekly signal analytics, computed read-only from the existing
 * signals/notifications tables — no storage changes. The window is the
 * last 7 days, matching how long processed signals are kept by prune().
 */
export function getInsights(db: Database, windowDays = 7): Insights {
  const since = Date.now() - windowDays * 86400 * 1000;
  const byChannel = db
    .query(`SELECT channel_id, COUNT(*) AS c FROM signals WHERE detected_at >= ? GROUP BY channel_id ORDER BY c DESC`)
    .all(since) as { channel_id: string; c: number }[];
  const total = byChannel.reduce((n, r) => n + r.c, 0);
  const outcomes = { open: 0, snoozed: 0, handled: 0 };
  for (const r of db
    .query(`SELECT status, COUNT(*) AS c FROM notifications WHERE created_at >= ? GROUP BY status`)
    .all(since) as { status: string; c: number }[]) {
    if (r.status === "snoozed") outcomes.snoozed += r.c;
    else if (r.status === "dismissed") outcomes.handled += r.c;
    else outcomes.open += r.c; // 'sent' and anything else: still on the line
  }
  const hours = db
    .query(`SELECT CAST(strftime('%H', created_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h, COUNT(*) AS c
            FROM notifications WHERE created_at >= ? GROUP BY h ORDER BY c DESC LIMIT 6`)
    .all(since) as { h: number; c: number }[];
  const senders = db
    .query(`SELECT sender, COUNT(*) AS c FROM signals WHERE detected_at >= ? AND sender != '' GROUP BY sender ORDER BY c DESC LIMIT 10`)
    .all(since) as { sender: string; c: number }[];
  return {
    window_days: windowDays,
    total_signals: total,
    signals_by_channel: byChannel.map((r) => ({ channel_id: r.channel_id, count: r.c })),
    outcomes,
    busiest_hours: hours.map((r) => ({ hour: r.h, count: r.c })),
    top_senders: senders.map((r) => ({ sender: r.sender, count: r.c })),
  };
}
