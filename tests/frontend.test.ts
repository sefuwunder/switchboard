// Frontend: DOM-stubbed render tests for the Ascent settings section,
// the VIP list, the VIP badge, and the Insights panel.
import { test, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";

function makeElement(tag = "div") {
  const listeners: Record<string, Function[]> = {};
  const qsCache: Record<string, any> = {};
  const e: any = {
    tagName: String(tag).toUpperCase(),
    children: [] as any[],
    dataset: {},
    style: {},
    attributes: {} as Record<string, string>,
    _html: "",
    _listeners: listeners,
    textContent: "",
    value: "",
    disabled: false,
    hidden: false,
    checked: false,
    classList: {
      _s: new Set<string>(),
      add(...c: string[]) { c.forEach((x) => (this as any)._s.add(x)); },
      remove(...c: string[]) { c.forEach((x) => (this as any)._s.delete(x)); },
      toggle(c: string, f?: boolean) {
        const on = f ?? !(this as any)._s.has(c);
        on ? (this as any)._s.add(c) : (this as any)._s.delete(c);
        return on;
      },
      contains(c: string) { return (this as any)._s.has(c); },
    },
    set innerHTML(v: string) { this._html = String(v); },
    get innerHTML() { return this._html; },
    set outerHTML(v: string) { this._html = String(v); },
    get outerHTML() { return this._html; },
    appendChild(c: any) {
      this.children.push(c);
      if (c && typeof c._html === "string") this._html += c._html;
      return c;
    },
    addEventListener(t: string, f: Function) { (listeners[t] ||= []).push(f); },
    removeEventListener() {},
    setAttribute(k: string, v: string) { this.attributes[k] = String(v); },
    getAttribute(k: string) { return this.attributes[k] ?? null; },
    querySelector(sel: string) { return (qsCache[sel] ||= makeElement("div")); },
    querySelectorAll() { return []; },
    replaceWith() {},
    focus() {},
    click() {},
  };
  return e;
}

const NOW = Date.now();

const canned: Record<string, any> = {
  "/api/channels": {
    channels: ["calendar", "clickup", "anytype", "github", "ascent"].map((id) => ({
      id,
      label: id === "calendar" ? "Google Calendar" : id[0].toUpperCase() + id.slice(1),
      enabled: 1,
      mode: "digest",
      min_priority: "low",
      poll_minutes: id === "ascent" ? 5 : 15,
      snoozed_until: 0,
      last_poll_at: NOW,
      last_error: id === "ascent" ? "not_connected" : "",
      last_count: 3,
      meta: { label: id === "calendar" ? "Google Calendar" : id[0].toUpperCase() + id.slice(1) },
    })),
  },
  "/api/settings": {
    settings: {
      quiet_enabled: "1",
      quiet_start: "22:00",
      quiet_end: "07:00",
      digest_minutes: "60",
      urgent_breaks_quiet: "1",
      dnd: "0",
      gcal_ical_set: "",
      ascent_base_url: "http://127.0.0.1:3004",
      vip_list: JSON.stringify([{ name: "Shy", matches: ["shy@example.com"] }]),
    },
  },
  "/api/notifications?limit=50": {
    notifications: [
      {
        id: 1, kind: "instant", title: "Call Shy", body: "", url: "",
        priority: "low", channel_id: "clickup", items: "[]", status: "sent",
        created_at: NOW, snooze_until: 0, starred: 0, vip: 1,
      },
    ],
  },
  "/api/notifications?q=&limit=50&offset=0": { notifications: [], total: 0 },
  "/api/notifications?starred=1&limit=100": { notifications: [] },
  "/api/notifications/clear": { cleared: 1 },
  "/api/insights": {
    insights: {
      window_days: 7,
      total_signals: 10,
      signals_by_channel: [
        { channel_id: "ascent", count: 6 },
        { channel_id: "github", count: 4 },
      ],
      outcomes: { open: 5, snoozed: 2, handled: 3 },
      busiest_hours: [{ hour: 9, count: 4 }],
      top_senders: [{ sender: "shy@example.com", count: 3 }],
    },
  },
  "/api/channels/ascent/connect": {
    connectUrl: null,
    error: "Ascent isn't reachable — check the base URL in the Ascent section below and make sure Ascent is running on this machine (default http://127.0.0.1:3004).",
  },
};

async function boot() {
  const ids: Record<string, any> = {};
  const documentStub: any = {
    getElementById: (id: string) => (ids[id] ||= makeElement("div")),
    createElement: (tag: string) => makeElement(tag),
    querySelectorAll: () => [],
  };
  // Save the real globals: bun test shares globalThis across test files,
  // so the DOM/fetch stubs must be removed when each test finishes.
  const saved = {
    document: (globalThis as any).document,
    fetch: (globalThis as any).fetch,
    EventSource: (globalThis as any).EventSource,
  };
  (globalThis as any).__sbRestore = () => {
    for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v;
  };
  (globalThis as any).document = documentStub;
  (globalThis as any).__sbFetches = [];
  (globalThis as any).fetch = async (url: string, _init?: any) => {
    (globalThis as any).__sbFetches.push(String(url));
    const data = canned[String(url)];
    if (!data) throw new Error(`unexpected fetch: ${url}`);
    return { ok: true, json: async () => data };
  };
  (globalThis as any).EventSource = class {
    onmessage: any; onerror: any;
    constructor(_url: string) {}
    close() {}
  };
  const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  eval(appJs);
  await new Promise((r) => setTimeout(r, 500));
  return ids;
}

afterEach(() => {
  const restore = (globalThis as any).__sbRestore;
  if (restore) restore();
});

test("channels render the Ascent section with base URL input and poll interval", async () => {
  const ids = await boot();
  const html: string = ids["channels"].innerHTML;
  expect(html).toContain("Ascent URL");
  expect(html).toContain('class="mini-btn ascent-url"');
  expect(html).toContain('value="http://127.0.0.1:3004"');
  expect(html).toContain("NOT CONNECTED");
  expect(html).toContain("Poll every"); // per-channel poll interval row
});

test("Ascent connect button shows the setup hint when unreachable", async () => {
  const ids = await boot();
  const chan = ids["channels"].children.find((c: any) => c.innerHTML.includes("Ascent URL"));
  expect(chan).toBeTruthy();
  const btn = chan.querySelector(".connect-btn");
  for (const f of btn._listeners["click"] || []) await f();
  await new Promise((r) => setTimeout(r, 100));
  expect(btn.innerHTML).toContain("check the base URL in the Ascent section");
});

test("master panel renders the VIP list from settings", async () => {
  const ids = await boot();
  const html: string = ids["vip-list"].innerHTML;
  expect(html).toContain("badge vip");
  expect(html).toContain("Shy");
  expect(html).toContain("shy@example.com");
  expect(html).toContain("remove");
});

test("feed shows the VIP badge on VIP notifications", async () => {
  const ids = await boot();
  const html: string = ids["feed"].innerHTML;
  expect(html).toContain("Call Shy");
  expect(html).toContain("badge vip");
  expect(html).toContain(">VIP<");
});

test("insights panel renders channel bars, outcomes, busiest hours, senders", async () => {
  const ids = await boot();
  const html: string = ids["insights"].innerHTML;
  expect(html).toContain("Signals by channel");
  expect(html).toContain("Ascent");
  expect(html).toContain("What happened to them");
  expect(html).toContain("open");
  expect(html).toContain("snoozed");
  expect(html).toContain("handled");
  expect(html).toContain("Busiest hours");
  expect(html).toContain("9am");
  expect(html).toContain("Noisiest senders");
  expect(html).toContain("shy@example.com");
  expect(html).toContain("10 signals");
});

test("insights tab lives inside the patch bay; no standalone insights section", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  expect(html).not.toContain('aria-label="Insights"');
  expect(html).toContain('aria-label="Patch bay views"');
  expect(html).toContain('data-tab="services"');
  expect(html).toContain('data-tab="insights"');
  expect(html).toContain('id="tab-insights"');
  expect(html).toContain('id="insights"');
  expect(html).toContain('id="insights-refresh"');
});

test("line out head carries the clear-all broom button", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  expect(html).toContain('id="clear-all"');
  expect(html).toContain('aria-label="Clear all notifications"');
  expect(html).toContain('title="Clear all notifications"');
  expect(html).toContain('class="mini-btn icon-btn"');
  expect(html).toContain('<svg viewBox="0 0 24 24"');
});

test("clear-all: visible on a live feed, first click only arms", async () => {
  const ids = await boot();
  const btn = ids["clear-all"];
  expect(ids["feed"].innerHTML).toContain("Call Shy");
  expect(btn.hidden).toBe(false);
  for (const f of btn._listeners["click"] || []) await f();
  expect((globalThis as any).__sbFetches).not.toContain("/api/notifications/clear");
  expect(btn.dataset.armed).toBe("1");
  expect(btn.classList.contains("active")).toBe(true);
  expect(btn.title).toBe("Click again to confirm");
  expect(btn.getAttribute("aria-label")).toBe("Confirm: clear all notifications");
  expect(ids["feed"].innerHTML).toContain("Call Shy"); // nothing cleared yet
});

test("clear-all: second click within the window clears the feed to its empty state", async () => {
  const ids = await boot();
  const btn = ids["clear-all"];
  for (const f of btn._listeners["click"] || []) await f(); // arm
  for (const f of btn._listeners["click"] || []) await f(); // confirm
  await new Promise((r) => setTimeout(r, 150));
  expect((globalThis as any).__sbFetches).toContain("/api/notifications/clear");
  expect(ids["feed"].innerHTML).toContain("Quiet on the line");
  expect(btn.hidden).toBe(true);
  expect(btn.dataset.armed).toBe(""); // disarmed again
  expect(btn.classList.contains("active")).toBe(false);
  expect(btn.title).toBe("Clear all notifications");
});

test("clear-all: after the arm lapses, a click re-arms instead of clearing", async () => {
  const ids = await boot();
  const btn = ids["clear-all"];
  for (const f of btn._listeners["click"] || []) await f(); // arm
  // simulate the 5s expiry firing (disarmClear):
  btn.dataset.armed = "";
  btn.classList.remove("active");
  btn.title = "Clear all notifications";
  btn.setAttribute("aria-label", "Clear all notifications");
  for (const f of btn._listeners["click"] || []) await f(); // click again: re-arms
  await new Promise((r) => setTimeout(r, 150));
  expect((globalThis as any).__sbFetches).not.toContain("/api/notifications/clear");
  expect(ids["feed"].innerHTML).toContain("Call Shy");
});
