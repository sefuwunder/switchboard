// Service channel adapters. Each poll() returns fresh candidate signals.
// All external CLIs are spawned with a hard timeout; failures are reported
// as { ok: false } and never throw.

import type { Database } from "bun:sqlite";
import { getSetting, setSetting } from "./db";
import { googleConfigured, googleAuthUrl, googleGet } from "./google";

export interface SignalInput {
  ext_id: string;
  title: string;
  body: string;
  url: string;
  priority: "low" | "normal" | "high" | "urgent";
}

export interface PollResult {
  ok: boolean;
  signals: SignalInput[];
  error?: string; // 'not_connected' when the service needs (re)connecting
}

export interface ChannelCtx {
  db: Database;
}

export interface ChannelDef {
  id: string;
  label: string;
  poll: (ctx: ChannelCtx) => Promise<PollResult>;
  connectUrl: () => Promise<string | null>;
  pairing?: boolean; // in-app pairing flow instead of an external connect URL
}

async function run(cmd: string[], timeoutMs = 45000): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    for (const k of ["messages", "results", "items", "events", "tasks"]) {
      if (Array.isArray(v[k])) return v[k];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Gmail: unread mail matching the user's filter, via the Gmail REST API
// ---------------------------------------------------------------------------

const GMAIL_QUERY = "in:inbox is:unread newer_than:2d -category:promotions -category:social";
const URGENT_SUBJECT = /urgent|asap|action required|deadline|expir|security alert|payment failed/i;

async function pollGmail({ db }: ChannelCtx): Promise<PollResult> {
  // User-configurable via the Gmail card; falls back to the default query.
  if (!googleConfigured()) {
    return { ok: false, signals: [], error: "Google OAuth not configured — see README" };
  }
  const query = getSetting(db, "gmail_query").trim() || GMAIL_QUERY;
  let list: any;
  try {
    list = await googleGet(db, "/gmail/v1/users/me/messages", { q: query, maxResults: "20" });
  } catch (e: any) {
    return { ok: false, signals: [], error: String(e.message || e).slice(0, 200) };
  }
  if (list?.__disconnected) return { ok: false, signals: [], error: "not_connected" };
  const signals: SignalInput[] = [];
  for (const m of asArray(list).slice(0, 20)) {
    const id = String(m.id || "");
    if (!id) continue;
    let full: any = null;
    try {
      full = await googleGet(
        db,
        `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`
      );
    } catch {
      continue;
    }
    if (!full || full.__disconnected) continue;
    const headers: any[] = full?.payload?.headers || [];
    const header = (n: string) => headers.find((h: any) => String(h.name).toLowerCase() === n)?.value || "";
    const subject = header("subject") || "(no subject)";
    const from = header("from");
    signals.push({
      ext_id: `gmail:${id}`,
      title: subject,
      body: [from, full.snippet || ""].filter(Boolean).join(" — ").slice(0, 220),
      url: `https://mail.google.com/mail/u/0/#inbox/${id}`,
      priority: URGENT_SUBJECT.test(subject) ? "high" : "normal",
    });
  }
  return { ok: true, signals };
}

// ---------------------------------------------------------------------------
// Google Calendar: events starting in the next 36 hours
// ---------------------------------------------------------------------------

function eventStartMs(ev: any): number {
  const s = ev.start;
  const raw = typeof s === "string" ? s : s?.dateTime || s?.date;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function relTime(ms: number): string {
  const mins = Math.round((ms - Date.now()) / 60000);
  if (mins < 0) return "now";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `in ${h}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

async function pollCalendar({ db }: ChannelCtx): Promise<PollResult> {
  if (!googleConfigured()) {
    return { ok: false, signals: [], error: "Google OAuth not configured — see README" };
  }
  const now = Date.now();
  const horizon = now + 36 * 3600 * 1000;
  let j: any;
  try {
    j = await googleGet(db, "/calendar/v3/calendars/primary/events", {
      timeMin: new Date(now - 5 * 60000).toISOString(),
      timeMax: new Date(horizon).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    });
  } catch (e: any) {
    return { ok: false, signals: [], error: String(e.message || e).slice(0, 200) };
  }
  if (j?.__disconnected) return { ok: false, signals: [], error: "not_connected" };
  const signals: SignalInput[] = [];
  for (const ev of asArray(j)) {
    const start = eventStartMs(ev);
    if (!start || start < now - 5 * 60000 || start > horizon) continue;
    const id = String(ev.id || ev.eventId || `${ev.summary}-${start}`);
    const summary = ev.summary || ev.title || "(no title)";
    const where = ev.location ? ` @ ${ev.location}` : "";
    signals.push({
      ext_id: `cal:${id}:${start}`,
      title: summary,
      body: `Starts ${relTime(start)}${where}`.slice(0, 220),
      url: ev.htmlLink || ev.link || "",
      priority: start - now < 3600 * 1000 ? "high" : "normal",
    });
    if (signals.length >= 20) break;
  }
  return { ok: true, signals };
}

// ---------------------------------------------------------------------------
// ClickUp: overdue + due-soon tasks on the watched list
// ---------------------------------------------------------------------------

const CLICKUP_LIST = process.env.CLICKUP_LIST_ID || "901418249044";

async function fetchClickUpDirect(token: string): Promise<any[]> {
  const tasks: any[] = [];
  let page = 0;
  for (;;) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(
        `https://api.clickup.com/api/v2/list/${CLICKUP_LIST}/task?archived=false&page=${page}`,
        { headers: { Authorization: token, "User-Agent": "switchboard/1.0" }, signal: ctrl.signal }
      );
      if (!r.ok) throw new Error(`ClickUp HTTP ${r.status}`);
      const body: any = await r.json();
      tasks.push(...(body.tasks || []));
      if (body.last_page !== false) break;
    } finally {
      clearTimeout(t);
    }
    if (++page > 10) break;
  }
  return tasks;
}

async function fetchClickUpViaSkill(): Promise<any[]> {
  const cli = `${process.env.HOME}/workspace/skills/clickup/bin/clickup_tasks.py`;
  if (!(await Bun.file(cli).exists())) throw new Error("no ClickUp credential available");
  const outFile = `/tmp/switchboard-clickup-${Date.now()}.json`;
  const { code, err } = await run(["python3", cli, "--list", CLICKUP_LIST, "--out", outFile], 60000);
  if (code !== 0) throw new Error(err.trim().slice(0, 200) || "ClickUp skill failed");
  try {
    const data = await Bun.file(outFile).json();
    return data.tasks || [];
  } finally {
    await Bun.file(outFile).unlink().catch(() => {});
  }
}

const DONE_RE = /complete|done|closed/i;

async function pollClickUp(): Promise<PollResult> {
  let raw: any[];
  try {
    const token = process.env.CLICKUP_TOKEN || "";
    raw = token ? await fetchClickUpDirect(token) : await fetchClickUpViaSkill();
  } catch (e: any) {
    const msg = e.message || "ClickUp fetch failed";
    if (/401|403/.test(msg)) return { ok: false, signals: [], error: "not_connected" };
    return { ok: false, signals: [], error: msg.slice(0, 200) };
  }
  const now = Date.now();
  const signals: SignalInput[] = [];
  for (const t of raw) {
    const status = String((t.status && t.status.status) || t.status || "");
    if (DONE_RE.test(status)) continue;
    const id = String(t.id || t.task_id || t.name);
    const rawDue = t.due_date || t.due_iso;
    let dueMs = 0;
    if (rawDue) {
      dueMs = /^\d+$/.test(String(rawDue)) ? Number(rawDue) : Date.parse(rawDue);
      if (Number.isNaN(dueMs)) dueMs = 0;
    }
    let priority: SignalInput["priority"] = "low";
    let when = "no due date";
    if (dueMs) {
      const days = Math.ceil((dueMs - now) / 86400000);
      when = days < 0 ? `overdue by ${-days}d` : days === 0 ? "due today" : `due in ${days}d`;
      priority = days < 0 ? "high" : days <= 2 ? "normal" : "low";
    }
    signals.push({
      ext_id: `clickup:${id}`,
      title: t.name || "(untitled task)",
      body: `${status}${when ? ` · ${when}` : ""}`.slice(0, 220),
      url: `https://app.clickup.com/t/${id}`,
      priority,
    });
    if (signals.length >= 30) break;
  }
  // Most pressing first so the digest leads with what matters.
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
  signals.sort((a, b) => rank[a.priority] - rank[b.priority]);
  return { ok: true, signals };
}

// ---------------------------------------------------------------------------
// Anytype: open tasks from the local desktop app's HTTP API
// (https://developers.anytype.io). The desktop app serves the API on
// 127.0.0.1:31009 by default; auth is a per-app API key sent as a Bearer
// token with an Anytype-Version header.
// ---------------------------------------------------------------------------

const ANYTYPE_BASE = (process.env.ANYTYPE_BASE_URL || "http://127.0.0.1:31009").replace(/\/+$/, "");
const ANYTYPE_VERSION = "2025-11-08";

function anytypeKey(db: Database): string {
  return process.env.ANYTYPE_API_KEY || getSetting(db, "anytype_api_key") || "";
}

async function anytypeFetch(db: Database, path: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    return await fetch(`${ANYTYPE_BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${anytypeKey(db)}`,
        "Anytype-Version": ANYTYPE_VERSION,
        ...(init?.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

const ANYTYPE_UNREACHABLE = "Anytype app not reachable — is it running?";

/** Light auth check: GET /v1/spaces. */
export async function anytypeProbe(db: Database): Promise<{ ok: boolean; error?: string }> {
  if (!anytypeKey(db)) return { ok: false, error: "not_connected" };
  try {
    const r = await anytypeFetch(db, "/v1/spaces");
    if (r.status === 401 || r.status === 403) return { ok: false, error: "not_connected" };
    if (!r.ok) return { ok: false, error: `Anytype HTTP ${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: ANYTYPE_UNREACHABLE };
  }
}

/** Start pairing: the desktop app shows a 4-digit code for this challenge. */
export async function anytypeChallenge(db: Database): Promise<{ challenge_id?: string; error?: string }> {
  try {
    const r = await anytypeFetch(db, "/v1/auth/challenges", {
      method: "POST",
      body: JSON.stringify({ app_name: "switchboard" }), // required by the official spec
    });
    if (!r.ok) return { error: `Anytype HTTP ${r.status}` };
    const j: any = await r.json().catch(() => ({}));
    const cid = j.challenge_id || j.challengeId || j.id;
    return cid ? { challenge_id: String(cid) } : { error: "unexpected challenge response" };
  } catch {
    return { error: ANYTYPE_UNREACHABLE };
  }
}

/** Complete pairing: exchange the 4-digit code for an API key and store it. */
export async function anytypePair(
  db: Database, challengeId: string, code: string
): Promise<{ ok: boolean; error?: string }> {
  if (!challengeId || !/^\d{4}$/.test(code.trim())) {
    return { ok: false, error: "enter the 4-digit code shown in Anytype" };
  }
  try {
    const r = await anytypeFetch(db, "/v1/auth/api_keys", {
      method: "POST",
      body: JSON.stringify({ challenge_id: challengeId, code: code.trim() }),
    });
    if (!r.ok) {
      return {
        ok: false,
        error: r.status === 400 || r.status === 401 || r.status === 404
          ? "code not accepted — request a fresh code and try again"
          : `Anytype HTTP ${r.status}`,
      };
    }
    const j: any = await r.json().catch(() => ({}));
    const key = j.api_key || j.apiKey || j.key;
    if (!key) return { ok: false, error: "unexpected pair response" };
    setSetting(db, "anytype_api_key", String(key));
    return { ok: true };
  } catch {
    return { ok: false, error: ANYTYPE_UNREACHABLE };
  }
}

// --- defensive response parsing: the API returns objects with metadata and
// a properties list whose exact shape varies, so unwrap common wrappers. ---

function anyObjects(j: any): any[] {
  if (Array.isArray(j)) return j;
  if (j && typeof j === "object") {
    for (const k of ["data", "objects", "results", "items"]) {
      if (Array.isArray(j[k])) return j[k];
    }
  }
  return [];
}

interface AnyProp { key: string; name: string; value: any }

function anyProps(obj: any): AnyProp[] {
  const p = obj.properties ?? obj.props ?? obj.details ?? obj.relations;
  if (Array.isArray(p)) {
    return p.map((x: any) => ({
      key: String(x.key || x.id || x.name || ""),
      name: String(x.name || x.key || x.id || ""),
      value: x.value ?? x.checkbox ?? x.date ?? x.text ?? x.number ?? x.select ?? x.status ?? x,
    }));
  }
  if (p && typeof p === "object") {
    return Object.entries(p).map(([k, v]) => ({ key: k, name: k, value: v }));
  }
  return [];
}

const WRAP_KEYS = new Set(["checkbox", "date", "number", "text", "select", "status", "timestamp", "value"]);

function unwrap(v: any): any {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && WRAP_KEYS.has(keys[0])) {
      const inner = v[keys[0]];
      if (inner && typeof inner === "object" && "name" in inner) return (inner as any).name;
      return inner;
    }
    if (typeof (v as any).timestamp === "number") return (v as any).timestamp;
  }
  return v;
}

function asBool(v: any): boolean {
  v = unwrap(v);
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return /^(true|1|yes|done|checked)$/i.test(v.trim());
  return false;
}

function asMs(v: any): number {
  v = unwrap(v);
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return 0;
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      return n > 1e12 ? n : n * 1000;
    }
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

const DONE_PROP = /done|complete|finished|checked/i;
const DUE_PROP = /due|deadline/i;
const ARCHIVE_PROP = /archiv|trash|delet/i;

async function pollAnytype({ db }: ChannelCtx): Promise<PollResult> {
  if (!anytypeKey(db)) return { ok: false, signals: [], error: "not_connected" };
  let res: Response;
  try {
    res = await anytypeFetch(db, "/v1/search?limit=100", {
      method: "POST",
      body: JSON.stringify({ query: "", types: ["task"] }),
    });
  } catch {
    return { ok: false, signals: [], error: ANYTYPE_UNREACHABLE };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, signals: [], error: "not_connected" };
  if (!res.ok) return { ok: false, signals: [], error: `Anytype HTTP ${res.status}` };
  const objs = anyObjects(await res.json().catch(() => null));
  const now = Date.now();
  const signals: SignalInput[] = [];
  for (const o of objs) {
    const props = anyProps(o);
    if (
      asBool(o.is_archived) || asBool(o.archived) ||
      props.some((p) => ARCHIVE_PROP.test(p.key) && asBool(p.value))
    ) continue;
    const done =
      props.some((p) => DONE_PROP.test(p.key) && asBool(p.value)) ||
      props.some((p) => /^status$/i.test(p.key) && /done|complete|closed/i.test(String(unwrap(p.value) ?? "")));
    if (done) continue;
    const dueP = props.find((p) => DUE_PROP.test(p.key));
    const dueMs = dueP ? asMs(dueP.value) : 0;
    let priority: SignalInput["priority"] = "low";
    let when = "no due date";
    let due = false;
    if (dueMs) {
      const days = Math.ceil((dueMs - now) / 86400000);
      when = days < 0 ? `overdue by ${-days}d` : days === 0 ? "due today" : `due in ${days}d`;
      due = days <= 0; // overdue or due today: this task is an alert
      priority = due ? "urgent" : days <= 2 ? "normal" : "low";
    }
    const name = o.name || o.title || "(untitled task)";
    // The due-state is part of the identity so a task that *becomes* due
    // fires a fresh alert; a task that stays due doesn't re-alert.
    signals.push({
      ext_id: `anytype:${o.id || name}:${due ? "due" : "open"}`,
      title: name,
      body: `Anytype task · ${when}`.slice(0, 220),
      url: "",
      priority,
    });
    if (signals.length >= 30) break;
  }
  // Most pressing first so the digest leads with what matters.
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
  signals.sort((a, b) => rank[a.priority] - rank[b.priority]);
  return { ok: true, signals };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GitHub: unread notifications (mentions, review requests, CI, releases…)
// via the REST API. Needs a personal access token in GITHUB_TOKEN with
// the "Notifications: read-only" scope (see README).
// ---------------------------------------------------------------------------

const GITHUB_API = process.env.GITHUB_API_BASE || "https://api.github.com";

function githubToken(): string {
  return process.env.GITHUB_TOKEN || "";
}

export function githubConfigured(): boolean {
  return !!githubToken();
}

export function githubSetupUrl(): string {
  return "https://github.com/settings/personal-access-tokens/new";
}

/** Turn a notification's API URL into the human URL on github.com. */
function githubHtmlUrl(n: any): string {
  const api: string = n?.subject?.url || "";
  const repo: string = n?.repository?.full_name || "";
  const m = api.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(issues|pulls|commits|releases)\/(.+)$/);
  if (m) {
    const [, r, kind, id] = m;
    if (kind === "issues") return `https://github.com/${r}/issues/${id}`;
    if (kind === "pulls") return `https://github.com/${r}/pull/${id}`;
    if (kind === "commits") return `https://github.com/${r}/commit/${id}`;
    if (kind === "releases") return `https://github.com/${r}/releases/${id}`;
  }
  return repo ? `https://github.com/${repo}` : "";
}

const GITHUB_HIGH_REASON = /^(mention|review_requested|assign|security_alert)$/;

async function pollGitHub(): Promise<PollResult> {
  if (!githubConfigured()) return { ok: false, signals: [], error: "not_connected" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/notifications?per_page=20`, {
      headers: {
        Authorization: `Bearer ${githubToken()}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "switchboard/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(t);
    return { ok: false, signals: [], error: "GitHub request failed" };
  } finally {
    clearTimeout(t);
  }
  if (res.status === 401 || res.status === 403) return { ok: false, signals: [], error: "not_connected" };
  if (!res.ok) return { ok: false, signals: [], error: `GitHub HTTP ${res.status}` };
  const items: any[] = await res.json().catch(() => []);
  const signals: SignalInput[] = [];
  for (const n of (Array.isArray(items) ? items : []).slice(0, 20)) {
    const id = String(n.id || "");
    if (!id) continue;
    const subject = n.subject || {};
    const repo = n.repository?.full_name || "";
    const reason = String(n.reason || "").replace(/_/g, " ");
    signals.push({
      ext_id: `github:${id}`,
      title: subject.title || "(no title)",
      body: [repo, reason].filter(Boolean).join(" · ").slice(0, 220),
      url: githubHtmlUrl(n),
      priority: GITHUB_HIGH_REASON.test(String(n.reason || "")) ? "high" : "normal",
    });
  }
  return { ok: true, signals };
}

// ---------------------------------------------------------------------------

export const CHANNEL_DEFS: ChannelDef[] = [
  { id: "gmail", label: "Gmail", poll: pollGmail, connectUrl: async () => googleAuthUrl() },
  { id: "calendar", label: "Google Calendar", poll: pollCalendar, connectUrl: async () => googleAuthUrl() },
  { id: "clickup", label: "ClickUp", poll: pollClickUp, connectUrl: async () => null },
  { id: "anytype", label: "Anytype", poll: pollAnytype, connectUrl: async () => null, pairing: true },
  {
    id: "github", label: "GitHub", poll: pollGitHub,
    connectUrl: async () => (githubConfigured() ? githubSetupUrl() : null),
  },
];
