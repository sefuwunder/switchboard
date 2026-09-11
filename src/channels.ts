// Service channel adapters. Each poll() returns fresh candidate signals.
// All external CLIs are spawned with a hard timeout; failures are reported
// as { ok: false } and never throw.

import type { Database } from "bun:sqlite";
import { getSetting, setSetting } from "./db";
import { fetchIcalText, upcomingFromIcs } from "./ical";

export interface SignalInput {
  ext_id: string;
  title: string;
  body: string;
  url: string;
  priority: "low" | "normal" | "high" | "urgent";
  /** When true, the signal only ever goes to the digest, never instant. */
  digestOnly?: boolean;
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
// Calendar: events starting in the next 36 hours, via iCal feed
// ---------------------------------------------------------------------------

function relTime(ms: number): string {
  const mins = Math.round((ms - Date.now()) / 60000);
  if (mins < 0) return "now";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `in ${h}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

async function pollCalendar({ db }: ChannelCtx): Promise<PollResult> {
  const url = (getSetting(db, "gcal_ical_url") || "").trim();
  if (!url) return { ok: false, signals: [], error: "not_connected" };
  const now = Date.now();
  const horizon = now + 36 * 3600 * 1000;
  let text: string;
  try {
    text = await fetchIcalText(url);
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "iCal feed timed out" : String(e?.message || e);
    return { ok: false, signals: [], error: msg.slice(0, 200) };
  }
  const signals: SignalInput[] = [];
  for (const occ of upcomingFromIcs(text, now - 5 * 60000, horizon)) {
    const where = occ.location ? ` @ ${occ.location}` : "";
    signals.push({
      ext_id: `cal:${occ.uid}:${occ.startMs}`,
      title: occ.summary,
      body: `Starts ${relTime(occ.startMs)}${where}`.slice(0, 220),
      url: occ.url,
      priority: occ.startMs - now < 3600 * 1000 ? "high" : "normal",
    });
    if (signals.length >= 20) break;
  }
  return { ok: true, signals };
}

// ---------------------------------------------------------------------------
// ClickUp: tiered nag mode. Re-notify cadence follows the due date
// (calendar days): due today/overdue -> hourly, due tomorrow -> every
// 12h, due in 2-3 days -> daily, due 4+ days out -> digest only.
// Tasks with no due date nag daily. Done tasks never nag.
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
  const pad = (n: number) => String(n).padStart(2, "0");
  const dayStr = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = dayStr(now);
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
    // Nag bucket: a finer-grained ext_id re-notifies more often.
    let bucket = today;
    let digestOnly = false;
    if (dueMs) {
      const days = Math.round((startOfDay(dueMs) - startOfDay(now)) / 86400000);
      when = days < 0 ? `overdue by ${-days}d` : days === 0 ? "due today" : `due in ${days}d`;
      priority = days < 0 ? "high" : days <= 2 ? "normal" : "low";
      if (days <= 0) {
        bucket = `${today}-${pad(new Date(now).getHours())}`; // hourly
      } else if (days === 1) {
        bucket = `${today}-${new Date(now).getHours() < 12 ? "am" : "pm"}`; // every 12h
      } else if (days >= 4) {
        digestOnly = true; // far out: digest only, never instant
      }
    }
    signals.push({
      ext_id: `clickup:${id}:${bucket}`,
      title: t.name || "(untitled task)",
      body: `${status}${when ? ` · ${when}` : ""}`.slice(0, 220),
      url: `https://app.clickup.com/t/${id}`,
      priority,
      digestOnly,
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

/** Tag names from a tag-like property value (multi/single select). */
function propTags(value: any): string[] {
  const v = unwrap(value);
  const arr = Array.isArray(v) ? v : [v];
  const tags: string[] = [];
  for (const item of arr) {
    const u = unwrap(item);
    if (typeof u === "string") tags.push(u);
    else if (u && typeof u === "object") {
      const name = (u as any).name ?? (u as any).title ?? (u as any).text;
      if (typeof name === "string") tags.push(name);
    }
  }
  return tags;
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
      props.some((p) => /^status$/i.test(p.key) && /done|complete|closed/i.test(String(unwrap(p.value) ?? ""))) ||
      props.some(
        (p) =>
          (/tag/i.test(p.key) || /tag/i.test(p.name)) &&
          propTags(p.value).some((t) => /^done$/i.test(t.trim()))
      );
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
// GitHub: unread notifications (mentions, review requests, CI…) plus repo
// activity (pushes, issues, PRs, releases, stars) via the REST API.
// Needs a personal access token in GITHUB_TOKEN with the
// "Notifications: read-only" scope (see README).
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

/** GET a GitHub API path; throws on transport or HTTP error (err.status set). */
async function ghGet(path: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Authorization: `Bearer ${githubToken()}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "switchboard/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const e: any = new Error(`GitHub HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return await res.json().catch(() => []);
  } finally {
    clearTimeout(t);
  }
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

/** Map one repo event to a signal, or null for event types we don't route. */
function repoEventSignal(ev: any): SignalInput | null {
  const id = String(ev.id || "");
  const type = String(ev.type || "");
  const repo: string = ev.repo?.name || "";
  const actor: string = ev.actor?.login || "";
  const p = ev.payload || {};
  if (!id || !repo) return null;
  const base = `https://github.com/${repo}`;
  let title = "", body = "", url = base, priority = "normal";
  switch (type) {
    case "PushEvent": {
      const commits = Array.isArray(p.commits) ? p.commits : [];
      const n = Number(p.size) || commits.length || 1; // size is authoritative; commits may be truncated
      const branch = String(p.ref || "").replace(/^refs\/heads\//, "");
      const firstLines = commits.slice(0, 3)
        .map((c) => String(c?.message || "").split("\n")[0].trim())
        .filter(Boolean);
      const perMsg = firstLines.length > 1 ? 60 : 140;
      const shown = firstLines.map(
        (m) => `"${m.length > perMsg ? m.slice(0, perMsg - 1) + "…" : m}"`);
      const rest = n - firstLines.length;
      if (firstLines.length > 0 && rest > 0) shown.push(`(+${rest} more)`);
      title = `⬆ ${n} commit${n === 1 ? "" : "s"} → ${repo}${branch ? `:${branch}` : ""}`;
      body = [actor && `by ${actor}`, shown.join(" · ")]
        .filter(Boolean).join(" — ").slice(0, 280);
      url = `${base}/commits${branch ? `/${branch}` : ""}`;
      break;
    }
    case "IssuesEvent": {
      const action = String(p.action || "");
      if (!["opened", "closed", "reopened"].includes(action)) return null;
      const num = p.issue?.number ?? "";
      title = `Issue #${num} ${action} — ${repo}`;
      body = [p.issue?.title, actor && `by ${actor}`].filter(Boolean).join(" — ").slice(0, 220);
      url = `${base}/issues/${num}`;
      break;
    }
    case "PullRequestEvent": {
      const action = String(p.action || "");
      const merged = action === "closed" && p.pull_request?.merged;
      if (!["opened", "closed", "reopened"].includes(action)) return null;
      const num = p.pull_request?.number ?? "";
      title = `PR #${num} ${merged ? "merged" : action} — ${repo}`;
      body = [p.pull_request?.title, actor && `by ${actor}`].filter(Boolean).join(" — ").slice(0, 220);
      url = `${base}/pull/${num}`;
      break;
    }
    case "ReleaseEvent": {
      if (String(p.action || "") !== "published") return null;
      const tag = p.release?.tag_name || "";
      title = `🚀 ${tag || "Release"} published — ${repo}`;
      body = [p.release?.name, actor && `by ${actor}`].filter(Boolean).join(" — ").slice(0, 220);
      url = tag ? `${base}/releases/tag/${tag}` : `${base}/releases`;
      priority = "high";
      break;
    }
    case "WatchEvent":
      if (String(p.action || "") !== "started") return null;
      title = `⭐ ${actor} starred ${repo}`;
      priority = "low";
      break;
    case "ForkEvent":
      title = `🍴 ${actor} forked ${repo}`;
      body = p.forkee?.full_name || "";
      priority = "low";
      break;
    default:
      return null; // CreateEvent, DeleteEvent, comments… stay in the inbox feed
  }
  return { ext_id: `github-event:${id}`, title, body, url, priority };
}

async function pollGitHub(): Promise<PollResult> {
  if (!githubConfigured()) return { ok: false, signals: [], error: "not_connected" };
  let items: any[];
  try {
    items = await ghGet("/notifications?per_page=20");
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403)
      return { ok: false, signals: [], error: "not_connected" };
    const msg = e?.name === "AbortError" ? "GitHub request timed out" : String(e?.message || e);
    return { ok: false, signals: [], error: msg.slice(0, 200) };
  }
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
  // Repo activity: the notification inbox never shows pushes, issues, PRs or
  // releases, so also watch the user's most recently pushed repos (cap 10).
  // Best-effort — a failure here must not flip the channel to ERROR.
  try {
    const repos = await ghGet("/user/repos?per_page=100&sort=pushed&direction=desc");
    const names = (Array.isArray(repos) ? repos : [])
      .map((r) => r?.full_name).filter(Boolean).slice(0, 10);
    const settled = await Promise.allSettled(
      names.map((full) => ghGet(`/repos/${full}/events?per_page=10`)));
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      for (const ev of (Array.isArray(r.value) ? r.value : []).slice(0, 10)) {
        const s = repoEventSignal(ev);
        if (s) signals.push(s);
        if (signals.length >= 40) break;
      }
      if (signals.length >= 40) break;
    }
  } catch { /* best effort */ }
  return { ok: true, signals };
}

// ---------------------------------------------------------------------------

export const CHANNEL_DEFS: ChannelDef[] = [
  { id: "calendar", label: "Google Calendar", poll: pollCalendar, connectUrl: async () => null },
  { id: "clickup", label: "ClickUp", poll: pollClickUp, connectUrl: async () => null },
  { id: "anytype", label: "Anytype", poll: pollAnytype, connectUrl: async () => null, pairing: true },
  {
    id: "github", label: "GitHub", poll: pollGitHub,
    connectUrl: async () => (githubConfigured() ? githubSetupUrl() : null),
  },
];
