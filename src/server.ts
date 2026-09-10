// Switchboard server (Bun): personal notification patch bay.
// Polls Gmail / Google Calendar / ClickUp, modulates the resulting signals
// through per-channel faders, quiet hours and digest batching, and streams
// the modulated reminders to the dashboard over SSE.

import { Database } from "bun:sqlite";
import {
  openDb, getChannels, getChannel, updateChannel, getSettings, getPublicSettings, setSetting,
  recentNotifications, getNotification, updateNotification,
} from "./db";
import { CHANNEL_DEFS } from "./channels";
import { anytypeChallenge, anytypePair, anytypeProbe } from "./channels";
import { tick, injectTest, type Broadcast } from "./engine";

const PORT = Number(process.env.PORT || 3002);
const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
const DB_PATH = process.env.SWITCHBOARD_DB || new URL("../switchboard.db", import.meta.url).pathname;

const db: Database = openDb(DB_PATH);

// ---------------------------------------------------------------------------
// SSE fan-out
// ---------------------------------------------------------------------------

const clients = new Set<ReadableStreamDefaultController>();

const broadcast: Broadcast = (event) => {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) {
    try {
      c.enqueue(line);
    } catch {
      clients.delete(c);
    }
  }
};

function sseResponse(): Response {
  let ctrl: ReadableStreamDefaultController;
  const stream = new ReadableStream({
    start(c) {
      ctrl = c;
      clients.add(c);
      c.enqueue(`data: ${JSON.stringify({ type: "hello", time: Date.now() })}\n\n`);
    },
    cancel() {
      clients.delete(ctrl);
    },
  });
  const hb = setInterval(() => {
    try {
      ctrl.enqueue(`: ping\n\n`);
    } catch {
      clearInterval(hb);
    }
  }, 25000);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

const MODES = new Set(["instant", "digest", "muted"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;

  if (p === "/api/health") return json({ ok: true, time: new Date().toISOString() });
  if (p === "/api/events") return sseResponse();

  if (p === "/api/channels" && m === "GET") {
    const defs = Object.fromEntries(CHANNEL_DEFS.map((d) => [d.id, { label: d.label }]));
    return json({ channels: getChannels(db).map((c) => ({ ...c, meta: defs[c.id] })) });
  }

  let mm = p.match(/^\/api\/channels\/([\w-]+)$/);
  if (mm && m === "PATCH") {
    const body = await readJson(req);
    const patch: Record<string, unknown> = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
    if (body.mode !== undefined && MODES.has(body.mode)) patch.mode = body.mode;
    if (body.min_priority !== undefined && PRIORITIES.has(body.min_priority)) patch.min_priority = body.min_priority;
    if (body.poll_minutes !== undefined) {
      const n = Math.max(1, Math.min(1440, Number(body.poll_minutes) || 15));
      patch.poll_minutes = n;
    }
    const ch = updateChannel(db, mm[1], patch);
    if (!ch) return json({ error: "unknown channel" }, 404);
    broadcast({ type: "channel", channel: ch });
    return json({ channel: ch });
  }

  mm = p.match(/^\/api\/channels\/([\w-]+)\/poll$/);
  if (mm && m === "POST") {
    const ch = getChannel(db, mm[1]);
    if (!ch) return json({ error: "unknown channel" }, 404);
    updateChannel(db, ch.id, { last_poll_at: 0 });
    tick(db, broadcast).catch(() => {});
    return json({ ok: true });
  }

  mm = p.match(/^\/api\/channels\/([\w-]+)\/snooze$/);
  if (mm && m === "POST") {
    const body = await readJson(req);
    const minutes = Math.max(1, Math.min(1440, Number(body.minutes) || 60));
    const until = body.clear ? 0 : Date.now() + minutes * 60000;
    const ch = updateChannel(db, mm[1], { snoozed_until: until });
    if (!ch) return json({ error: "unknown channel" }, 404);
    broadcast({ type: "channel", channel: ch });
    return json({ channel: ch });
  }

  mm = p.match(/^\/api\/channels\/([\w-]+)\/connect$/);
  if (mm && m === "GET") {
    const def = CHANNEL_DEFS.find((d) => d.id === mm![1]);
    if (!def) return json({ error: "unknown channel" }, 404);
    const connectUrl = await def.connectUrl();
    return json({ connectUrl, pairing: !!def.pairing });
  }

  // Anytype in-app pairing: challenge -> 4-digit code in the desktop app -> API key.
  mm = p.match(/^\/api\/channels\/anytype\/challenge$/);
  if (mm && m === "POST") {
    const r = await anytypeChallenge(db);
    return json(r, r.challenge_id ? 200 : 502);
  }

  mm = p.match(/^\/api\/channels\/anytype\/pair$/);
  if (mm && m === "POST") {
    const body = await readJson(req);
    const r = await anytypePair(db, String(body.challenge_id || ""), String(body.code || ""));
    if (r.ok) {
      const ch = updateChannel(db, "anytype", { last_error: "", last_poll_at: 0 });
      broadcast({ type: "channel", channel: ch });
    }
    return json(r, r.ok ? 200 : 400);
  }

  mm = p.match(/^\/api\/channels\/anytype\/key$/);
  if (mm && m === "POST") {
    const body = await readJson(req);
    const key = String(body.key || "").trim();
    if (!key) return json({ ok: false, error: "empty key" }, 400);
    setSetting(db, "anytype_api_key", key);
    const probe = await anytypeProbe(db);
    if (probe.ok) {
      const ch = updateChannel(db, "anytype", { last_error: "", last_poll_at: 0 });
      broadcast({ type: "channel", channel: ch });
    }
    return json(probe, probe.ok ? 200 : 502);
  }

  if (p === "/api/settings" && m === "GET") return json({ settings: getPublicSettings(db) });

  if (p === "/api/settings" && m === "PATCH") {
    const body = await readJson(req);
    const allowed = new Set([
      "quiet_enabled", "quiet_start", "quiet_end", "digest_minutes", "urgent_breaks_quiet",
    ]);
    for (const [k, v] of Object.entries(body)) {
      if (!allowed.has(k)) continue;
      let val = String(v);
      if (k === "quiet_enabled" || k === "urgent_breaks_quiet") val = v ? "1" : "0";
      if (k === "digest_minutes") val = String(Math.max(5, Math.min(720, Number(v) || 60)));
      if ((k === "quiet_start" || k === "quiet_end") && !/^\d{2}:\d{2}$/.test(val)) continue;
      setSetting(db, k, val);
    }
    const settings = getPublicSettings(db);
    broadcast({ type: "settings", settings });
    return json({ settings });
  }

  if (p === "/api/notifications" && m === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
    return json({ notifications: recentNotifications(db, limit) });
  }

  mm = p.match(/^\/api\/notifications\/(\d+)\/(dismiss|snooze)$/);
  if (mm && m === "POST") {
    const n = getNotification(db, Number(mm[1]));
    if (!n) return json({ error: "unknown notification" }, 404);
    if (mm[2] === "dismiss") {
      updateNotification(db, n.id, { status: "dismissed" });
    } else {
      const body = await readJson(req);
      const minutes = Math.max(1, Math.min(1440, Number(body.minutes) || 30));
      updateNotification(db, n.id, { status: "snoozed", snooze_until: Date.now() + minutes * 60000 });
    }
    const updated = getNotification(db, n.id)!;
    broadcast({ type: "notification", notification: updated });
    return json({ notification: updated });
  }

  if (p === "/api/test" && m === "POST") {
    const body = await readJson(req);
    const priority = PRIORITIES.has(body.priority) ? body.priority : "normal";
    injectTest(db, broadcast, String(body.title || "Test signal"), priority);
    return json({ ok: true });
  }

  return new Response("Not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// static
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(path: string): Promise<Response | null> {
  const rel = path === "/" ? "/index.html" : path;
  if (rel.includes("..")) return null;
  const file = Bun.file(PUBLIC_DIR + rel);
  if (!(await file.exists())) return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(file, {
    headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
  });
}

// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handle(req);
      const s = await serveStatic(url.pathname);
      if (s) return s;
      return new Response("Not found", { status: 404 });
    } catch (e: any) {
      return json({ error: e.message || "internal error" }, 500);
    }
  },
});

console.log(`Switchboard at http://localhost:${server.port}`);

// Modulation tick every minute; first tick shortly after boot.
setTimeout(() => tick(db, broadcast).catch((e) => console.error("tick:", e)), 5000);
setInterval(() => tick(db, broadcast).catch((e) => console.error("tick:", e)), 60000);
