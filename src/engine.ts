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

function inQuietHours(s: Record<string, string>, now: Date): boolean {
  if (s.quiet_enabled !== "1") return false;
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const cur = fmt(now);
  const { quiet_start: a, quiet_end: b } = s;
  if (!a || !b || a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b; // overnight wrap
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
      if (insertSignal(db, ch.id, s.ext_id, s.title, s.body, s.url, s.priority) !== null) fresh++;
    }
    updateChannel(db, ch.id, { last_poll_at: now, last_error: "", last_count: res.signals.length });
    if (fresh) broadcast({ type: "channel", channel: getChannel(db, ch.id) });
  } catch (e: any) {
    updateChannel(db, ch.id, { last_poll_at: now, last_error: String(e.message || e).slice(0, 200), last_count: 0 });
    broadcast({ type: "channel", channel: getChannel(db, ch.id) });
  }
}

function emitInstant(db: Database, s: Signal, broadcast: Broadcast): void {
  const n = addNotification(db, {
    kind: "instant",
    title: s.title,
    body: s.body,
    url: s.url,
    priority: s.priority,
    channel_id: s.channel_id,
  });
  broadcast({ type: "notification", notification: n });
}

function routeSignals(db: Database, s: Record<string, string>, broadcast: Broadcast, now: number): void {
  const dnd = s.dnd === "1";
  const quiet = inQuietHours(s, new Date(now));
  const urgentBreaks = s.urgent_breaks_quiet === "1";
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
    // Urgent is an alert: it always goes out instantly, even in digest mode —
    // the same way it can break quiet hours.
    if ((ch.mode === "instant" || sig.priority === "urgent") && (!quiet || breaksQuiet)) {
      emitInstant(db, sig, broadcast);
    } else {
      enqueueDigest(db, sig.id);
    }
    markProcessed(db, sig.id);
  }
}

function maybeDigest(db: Database, s: Record<string, string>, broadcast: Broadcast, now: number): void {
  const interval = Math.max(5, Number(s.digest_minutes) || 60) * 60000;
  const last = Number(s.last_digest_at) || 0;
  if (now - last < interval) return;
  const queued = digestQueue(db);
  if (!queued.length) return; // empty line: leave last_digest_at alone so queued signals don't wait a full extra interval
  setSetting(db, "last_digest_at", String(now));
  const top = [...queued].sort((a, b) => (RANK[b.priority] ?? 0) - (RANK[a.priority] ?? 0));
  const prio = top[0].priority;
  const lines = top.slice(0, 8).map((x) => `• ${x.title}`);
  if (top.length > 8) lines.push(`…and ${top.length - 8} more`);
  const n = addNotification(db, {
    kind: "digest",
    title: `📦 Digest — ${queued.length} update${queued.length === 1 ? "" : "s"}`,
    body: lines.join("\n"),
    priority: prio,
    items: top.map((x) => ({
      signal_id: x.id, title: x.title, channel_id: x.channel_id,
      priority: x.priority, url: x.url, body: x.body,
    })),
  });
  clearDigestQueue(db);
  broadcast({ type: "notification", notification: n });
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
