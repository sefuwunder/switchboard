// Service channel adapters. Each poll() returns fresh candidate signals.
// All external CLIs are spawned with a hard timeout; failures are reported
// as { ok: false } and never throw.

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

export interface ChannelDef {
  id: string;
  label: string;
  poll: () => Promise<PollResult>;
  connectUrl: () => Promise<string | null>;
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

function tryJson(text: string): any {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
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

function looksDisconnected(out: string, err: string): boolean {
  return /not_connected|not connected|missing.*connect|authentication required|invalid_grant|surrogate/i.test(out + " " + err);
}

async function statusConnectUrl(service: "gmail" | "calendar"): Promise<string | null> {
  try {
    const { out } = await run(["hatch_gws_cli", service, "status"], 20000);
    const j = tryJson(out);
    return j?.connect_url || j?.add_account_url || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gmail: unread inbox mail (excluding promos/social) from the last 2 days
// ---------------------------------------------------------------------------

const GMAIL_QUERY = "in:inbox is:unread newer_than:2d -category:promotions -category:social";
const URGENT_SUBJECT = /urgent|asap|action required|deadline|expir|security alert|payment failed/i;

async function pollGmail(): Promise<PollResult> {
  const { code, out, err } = await run(
    ["hatch_gws_cli", "gmail", "+triage", "--query", GMAIL_QUERY, "--max", "20", "--format", "json"],
    60000
  );
  if (looksDisconnected(out, err)) return { ok: false, signals: [], error: "not_connected" };
  if (code !== 0) return { ok: false, signals: [], error: (err || out).trim().slice(0, 200) || `exit ${code}` };
  const rows = asArray(tryJson(out));
  const signals: SignalInput[] = rows.slice(0, 20).map((m: any, i: number) => {
    const id = String(m.id || m.message_id || m.threadId || m.thread_id || i);
    const subject = m.subject || m.Subject || "(no subject)";
    const from = m.from || m.From || m.sender || "";
    const snippet = m.snippet || "";
    return {
      ext_id: `gmail:${id}`,
      title: subject,
      body: [from, snippet].filter(Boolean).join(" — ").slice(0, 220),
      url: `https://mail.google.com/mail/u/0/#inbox/${id}`,
      priority: URGENT_SUBJECT.test(subject) ? "high" : "normal",
    };
  });
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

async function pollCalendar(): Promise<PollResult> {
  const { code, out, err } = await run(
    ["hatch_gws_cli", "calendar", "+agenda", "--days", "2", "--format", "json"],
    60000
  );
  if (looksDisconnected(out, err)) return { ok: false, signals: [], error: "not_connected" };
  if (code !== 0) return { ok: false, signals: [], error: (err || out).trim().slice(0, 200) || `exit ${code}` };
  const now = Date.now();
  const horizon = now + 36 * 3600 * 1000;
  const signals: SignalInput[] = [];
  for (const ev of asArray(tryJson(out))) {
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

export const CHANNEL_DEFS: ChannelDef[] = [
  { id: "gmail", label: "Gmail", poll: pollGmail, connectUrl: () => statusConnectUrl("gmail") },
  { id: "calendar", label: "Google Calendar", poll: pollCalendar, connectUrl: () => statusConnectUrl("calendar") },
  { id: "clickup", label: "ClickUp", poll: pollClickUp, connectUrl: async () => null },
];
