// Modulation engine: polls channels, dedupes signals, and routes them
// through the user's board settings (mode, priority fader, quiet hours,
// DND, digest batching, snooze) into notifications.

import type { Database } from "bun:sqlite";
import {
  getChannels, getChannel, updateChannel, getSettings, setSetting,
  insertSignal, unprocessedSignals, markProcessed, enqueueDigest, digestQueue,
  clearDigestQueue, addNotification, dueSnoozes, updateNotification, prune,
  type Channel, type Signal,
} from "./db";
import { CHANNEL_DEFS, type SignalInput } from "./channels";

export type Broadcast = (event: Record<string, unknown>) => void;

const RANK: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/**
 * Double-trigger filter: if an identical notification (same kind, channel,
 * title and body) already went out within the last 10 minutes, the second
 * one is dropped. The window is deliberately short — intentional re-nags
 * (hourly, 12-hourly, daily) are far apart, while a true double send lands
 * seconds apart. Near-identical reminders with different text (e.g. the
 * calendar "in 2h" heads-up vs the "in 45m" final call) are NOT identical,
 * so both still go through.
 */
const DOUBLE_TRIGGER_WINDOW_MS = 10 * 60 * 1000;

function isDoubleTrigger(
  db: Database,
  n: { kind: string; title: string; body?: string; channel_id?: string }
): boolean {
  const since = Date.now() - DOUBLE_TRIGGER_WINDOW_MS;
  const dup = db
    .query(
      `SELECT 1 FROM notifications
       WHERE kind = ? AND channel_id = ? AND title = ? AND body = ?
         AND created_at >= ? LIMIT 1`
    )
    .get(n.kind, n.channel_id || "", n.title, n.body || "", since);
  return !!dup;
}

function inQuietHours(s: Record<string, string>, now: Date): boolean {
  if (s.quiet_enabled !== "1") return false;
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const cur = fmt(now);
  const { quiet_start: a, quiet_end: b } = s;
  if (!a || !b || a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b; // overnight wrap
}

// ---------------------------------------------------------------------------
// VIP overrides: contacts whose mentions break quiet hours at low priority.
// ---------------------------------------------------------------------------

export interface VipContact {
  name: string;
  matches: string[];
}

/** Parse the vip_list setting (JSON array of {name, matches[]}); never throws. */
export function getVips(s: Record<string, string>): VipContact[] {
  let arr: unknown;
  try {
    arr = JSON.parse(s.vip_list || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: VipContact[] = [];
  for (const v of arr.slice(0, 50)) {
    if (!v || typeof v !== "object") continue;
    const name = String((v as any).name || "").trim();
    const matches = Array.isArray((v as any).matches)
      ? (v as any).matches.map((x: unknown) => String(x || "").trim().toLowerCase()).filter(Boolean)
      : [];
    if (name && matches.length) out.push({ name, matches });
  }
  return out;
}

/**
 * Does the sender string identify a VIP? Case-insensitive substring match
 * against any of the contact's match strings. Returns the contact name.
 */
export function matchVip(sender: string, vips: VipContact[]): string | null {
  const s = (sender || "").toLowerCase();
  if (!s) return null;
  for (const v of vips) {
    if (v.matches.some((m) => s.includes(m))) return v.name;
  }
  return null;
}

async function pollChannel(db: Database, ch: Channel, broadcast: Broadcast): Promise<void> {
  const def = CHANNEL_DEFS.find((d) => d.id === ch.id);
  if (!def) return;
  const now = Date.now();
  try {
    const res = await def.poll({ db });
    if (!res.ok) {
      updateChannel(db, ch.id, { last_poll_at: now, last_error: res.error || "poll failed", last_count: 0 });
      broadcast({ type: "channel", channel: getChannel(db, ch.id) });
      return;
    }
    let fresh = 0;
    for (const s of res.signals) {
      if (insertSignal(db, ch.id, s.ext_id, s.title, s.body, s.url, s.priority, s.digestOnly) !== null) fresh++;
    }
    updateChannel(db, ch.id, { last_poll_at: now, last_error: "", last_count: res.signals.length });
    if (fresh) broadcast({ type: "channel", channel: getChannel(db, ch.id) });
  } catch (e: any) {
    updateChannel(db, ch.id, { last_poll_at: now, last_error: String(e.message || e).slice(0, 200), last_count: 0 });
    broadcast({ type: "channel", channel: getChannel(db, ch.id) });
  }
}

function emitInstant(db: Database, s: Signal, broadcast: Broadcast, vip = false): void {
  const fields = {
    kind: "instant",
    title: s.title,
    body: s.body,
    url: s.url,
    priority: s.priority,
    channel_id: s.channel_id,
    vip,
  };
  const n = isDoubleTrigger(db, fields) ? null : addNotification(db, fields);
  if (n) broadcast({ type: "notification", notification: n });
}

export function routeSignals(db: Database, s: Record<string, string>, broadcast: Broadcast, now: number): void {
  const dnd = s.dnd === "1";
  const quiet = inQuietHours(s, new Date(now));
  const urgentBreaks = s.urgent_breaks_quiet === "1";
  const vips = getVips(s);
  for (const sig of unprocessedSignals(db)) {
    if (dnd) continue; // DND: hold everything for later; do NOT mark processed
    const ch = getChannel(db, sig.channel_id);
    if (!ch || !ch.enabled || ch.mode === "muted") {
      markProcessed(db, sig.id); // dropped: patch pulled or channel muted
      continue;
    }
    if (ch.snoozed_until > now) {
      continue; // hold for later; do NOT mark processed
    }
    if ((RANK[sig.priority] ?? 1) < (RANK[ch.min_priority] ?? 1)) {
      markProcessed(db, sig.id); // below the channel's priority fader
      continue;
    }
    const breaksQuiet = sig.priority === "urgent" && urgentBreaks;
    const vipName = matchVip(sig.sender, vips);
    // VIP override: a matched sender is never silenced by quiet hours. It
    // goes out instantly at low priority with a VIP badge, the quiet-hours
    // equivalent of urgent breaking through — but quieter. DND still holds
    // everything (it is an explicit, manual silence).
    const vipBypass = !!vipName && !sig.digest_only && quiet && !breaksQuiet;
    const priority = vipBypass ? "low" : sig.priority;
    if (!sig.digest_only && (ch.mode === "instant" || sig.priority === "urgent" || vipBypass) &&
        (!quiet || breaksQuiet || vipBypass)) {
      emitInstant(db, { ...sig, priority }, broadcast, !!vipName);
    } else {
      enqueueDigest(db, sig.id);
    }
    markProcessed(db, sig.id);
  }
}

function maybeDigest(db: Database, s: Record<string, string>, broadcast: Broadcast, now: number, force = false): void {
  const interval = Math.max(5, Number(s.digest_minutes) || 60) * 60000;
  const last = Number(s.last_digest_at) || 0;
  if (!force && now - last < interval) return;
  const queued = digestQueue(db);
  if (!queued.length) return; // empty line: leave last_digest_at alone so queued signals don't wait a full extra interval
  setSetting(db, "last_digest_at", String(now));
  const top = [...queued].sort((a, b) => (RANK[b.priority] ?? 0) - (RANK[a.priority] ?? 0));
  const prio = top[0].priority;
  const lines = top.slice(0, 8).map((x) => `• ${x.title}`);
  if (top.length > 8) lines.push(`…and ${top.length - 8} more`);
  const fields = {
    kind: "digest",
    title: `📦 Digest — ${queued.length} update${queued.length === 1 ? "" : "s"}`,
    body: lines.join("\n"),
    priority: prio,
    items: top.map((x) => ({
      signal_id: x.id, title: x.title, channel_id: x.channel_id,
      priority: x.priority, url: x.url, body: x.body,
    })),
  };
  const n = isDoubleTrigger(db, fields) ? null : addNotification(db, fields);
  clearDigestQueue(db);
  if (n) broadcast({ type: "notification", notification: n });
}

function unsnooze(db: Database, broadcast: Broadcast, now: number): void {
  for (const n of dueSnoozes(db, now)) {
    updateNotification(db, n.id, { status: "sent", snooze_until: 0 });
    broadcast({ type: "notification", notification: { ...n, status: "sent", snooze_until: 0 } });
  }
  for (const ch of getChannels(db)) {
    if (ch.snoozed_until && ch.snoozed_until <= now) {
      updateChannel(db, ch.id, { snoozed_until: 0, last_poll_at: 0 });
      broadcast({ type: "channel", channel: getChannel(db, ch.id) });
    }
  }
}

const inflight = new Set<string>();

export async function tick(db: Database, broadcast: Broadcast): Promise<void> {
  const now = Date.now();
  // Fire polls in the background (never awaited): a slow channel must not
  // delay routing, digests, or faster channels. inflight prevents overlap.
  const due = getChannels(db).filter(
    (ch) => ch.enabled && ch.mode !== "muted" && ch.snoozed_until <= now && !inflight.has(ch.id) &&
      now - ch.last_poll_at >= Math.max(1, ch.poll_minutes) * 60000
  );
  for (const ch of due) {
    inflight.add(ch.id);
    pollChannel(db, ch, broadcast).finally(() => inflight.delete(ch.id));
  }
  const settings = getSettings(db);
  routeSignals(db, settings, broadcast, now);
  maybeDigest(db, settings, broadcast, now);
  unsnooze(db, broadcast, now);
  prune(db);
}

/** Push a hand-made signal straight through the router (for the Test button). */
export function injectTest(db: Database, broadcast: Broadcast, title: string, priority: string): void {
  const id = insertSignal(
    db, "clickup", `test:${Date.now()}`, title || "Test signal",
    "Fired from the switchboard test button", "", priority
  );
  if (id === null) return;
  routeSignals(db, getSettings(db), broadcast, Date.now());
}

/**
 * Poll one channel right now (awaited), route its signals, and flush the
 * pending digest so the user sees what's outstanding immediately.
 * Used by the Poll-now button. Returns false for an unknown channel.
 */
export async function pollNow(db: Database, broadcast: Broadcast, channelId: string): Promise<boolean> {
  const ch = getChannel(db, channelId);
  if (!ch) return false;
  updateChannel(db, ch.id, { last_poll_at: 0 });
  await pollChannel(db, ch, broadcast);
  const s = getSettings(db);
  const now = Date.now();
  routeSignals(db, s, broadcast, now);
  if (s.dnd !== "1") maybeDigest(db, s, broadcast, now, true);
  return true;
}
