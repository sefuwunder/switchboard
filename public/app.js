// Switchboard frontend: patch bay, master controls, live line-out feed.
const $ = (id) => document.getElementById(id);
const PRIO = ["low", "normal", "high", "urgent"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- service logos (minimal line marks) ----------
const LOGO_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const LOGOS = {
  gmail: LOGO_OPEN + '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M4.5 8.5 12 13.5l7.5-5"/></svg>',
  calendar: LOGO_OPEN + '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17"/><path d="M8 3v3.5M16 3v3.5"/><text x="12" y="17.5" text-anchor="middle" font-size="7.5" font-weight="600" fill="currentColor" stroke="none">31</text></svg>',
  clickup: LOGO_OPEN + '<path d="M6.5 3.8 19 13.2l-7.4 1.2-3.4 6.1-1.7-16.7z"/></svg>',
  anytype: LOGO_OPEN + '<path d="M12 4.5 19.5 19.5h-15L12 4.5z"/><path d="M12 12.5v7"/></svg>',
};
const LOGO_FALLBACK = LOGO_OPEN + '<path d="M9 7V3.5M15 7V3.5M7 7h10v3.5a5 5 0 0 1-10 0V7zM12 15.5V21"/></svg>';
const logoFor = (id) => LOGOS[id] || LOGO_FALLBACK;

// ---------- fold helpers ----------
function setOpen(section, open) {
  section.setAttribute("data-open", open ? "1" : "0");
  const head = section.querySelector(".ch-head") || section.querySelector(".fold-head");
  if (head) head.setAttribute("aria-expanded", open ? "true" : "false");
}

// ---------- master ----------
function quietBadge() {
  const s = state.settings;
  const on = s.quiet_enabled === "1";
  const b = $("quiet-state");
  b.textContent = on ? `Quiet ${s.quiet_start}\u2013${s.quiet_end}` : "Quiet off";
  b.className = "badge " + (on ? "" : "off");
}

async function patchSettings(patch) {
  const r = await fetch("/api/settings", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const d = await r.json();
  state.settings = d.settings;
  renderMaster();
}

function renderMaster() {
  const s = state.settings;
  $("quiet-toggle").setAttribute("aria-checked", s.quiet_enabled === "1" ? "true" : "false");
  $("quiet-start").value = s.quiet_start || "22:00";
  $("quiet-end").value = s.quiet_end || "07:00";
  $("digest-minutes").value = s.digest_minutes || 60;
  $("urgent-breaks").checked = s.urgent_breaks_quiet !== "0";
  quietBadge();
}

// ---------- patch bay ----------
function chStatus(c) {
  const now = Date.now();
  if (!c.enabled) return ["off", "PATCHED OUT"];
  if (c.mode === "muted") return ["off", "MUTED"];
  if (c.snoozed_until > now) return ["warn", "SNOOZED"];
  if (c.last_error === "not_connected") return ["warn", "NOT CONNECTED"];
  if (c.last_error) return ["err", "ERROR"];
  if (!c.last_poll_at) return ["warn", "QUEUED"];
  return ["live", "LIVE"];
}

function timeAgo(ms) {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

async function patchChannel(id, patch) {
  const r = await fetch(`/api/channels/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const d = await r.json();
  const i = state.channels.findIndex((c) => c.id === id);
  if (i >= 0) state.channels[i] = d.channel;
  renderChannels();
}

function renderChannels() {
  const wrap = $("channels");
  wrap.innerHTML = "";
  for (const c of state.channels) {
    const [cls, label] = chStatus(c);
    const el = document.createElement("div");
    el.className = "channel" + (c.enabled ? "" : " patched-out");
    el.setAttribute("data-open", "0");
    el.innerHTML = `
      <button class="ch-head" aria-expanded="false">
        <span class="ch-logo">${logoFor(c.id)}</span>
        <span class="ch-name">${esc(c.meta?.label || c.id)}</span>
        <span class="ch-status ${cls}">${label}</span>
        <span class="chev" aria-hidden="true">&#8250;</span>
      </button>
      <div class="foldable"><div class="foldable-inner">
        <div class="ch-body">
          <div class="ch-row">
            <button class="mini-btn patch-toggle ${c.enabled ? "active" : ""}">${c.enabled ? "Patched in" : "Patch in"}</button>
            <span class="grow"></span>
            <button class="mini-btn poll-now">Poll now</button>
          </div>
          ${c.last_error === "not_connected" ? `<div class="ch-row connect-row"><button class="mini-btn connect-btn">Connect ${esc(c.meta?.label || c.id)}</button></div>` : ""}
          ${c.last_error && c.last_error !== "not_connected" ? `<div class="error">\u26a0 ${esc(c.last_error)}</div>` : ""}
          <div class="seg" role="group" aria-label="Routing mode">
            ${["instant", "digest", "muted"].map((m) =>
              `<button data-mode="${m}" class="${c.mode === m ? "active" : ""}">${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}
          </div>
          <div class="fader-row">
            <div class="labels"><span>Priority fader</span><span><b>${c.min_priority}</b> and up</span></div>
            <input type="range" class="fader" min="0" max="3" step="1" value="${PRIO.indexOf(c.min_priority)}"
              aria-label="Minimum priority">
            <div class="labels"><span>low</span><span>normal</span><span>high</span><span>urgent</span></div>
          </div>
          <div class="ch-row">
            <span>Poll every</span>
            <input type="number" class="mini-btn poll-input poll-minutes" min="1" max="1440" value="${c.poll_minutes}">
            <span>min</span>
            <span class="grow"></span>
            <span title="Last poll">${timeAgo(c.last_poll_at)}${c.last_count ? ` \u00b7 ${c.last_count} seen` : ""}</span>
          </div>
          <div class="ch-row">
            <span>Snooze channel</span>
            ${[15, 60, 240].map((m) => `<button class="mini-btn snooze" data-min="${m}">${m >= 60 ? m / 60 + "h" : m + "m"}</button>`).join("")}
            ${c.snoozed_until > Date.now() ? `<button class="mini-btn unsnooze">wake</button>` : ""}
          </div>
        </div>
      </div></div>`;

    const head = el.querySelector(".ch-head");
    head.addEventListener("click", () => {
      const open = el.getAttribute("data-open") === "1";
      setOpen(el, !open);
    });
    el.querySelector(".patch-toggle").addEventListener("click", () =>
      patchChannel(c.id, { enabled: !c.enabled }));
    el.querySelector(".poll-now").addEventListener("click", async () => {
      await fetch(`/api/channels/${c.id}/poll`, { method: "POST" });
    });
    el.querySelectorAll(".seg button").forEach((b) =>
      b.addEventListener("click", () => patchChannel(c.id, { mode: b.dataset.mode })));
    el.querySelector(".fader").addEventListener("change", (e) =>
      patchChannel(c.id, { min_priority: PRIO[Number(e.target.value)] }));
    el.querySelector(".poll-minutes").addEventListener("change", (e) =>
      patchChannel(c.id, { poll_minutes: Number(e.target.value) }));
    el.querySelectorAll(".snooze").forEach((b) =>
      b.addEventListener("click", async () => {
        await fetch(`/api/channels/${c.id}/snooze`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ minutes: Number(b.dataset.min) }),
        });
        loadChannels();
      }));
    const un = el.querySelector(".unsnooze");
    if (un) un.addEventListener("click", async () => {
      await fetch(`/api/channels/${c.id}/snooze`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear: true }),
      });
      loadChannels();
    });
    const cb = el.querySelector(".connect-btn");
    if (cb) cb.addEventListener("click", async () => {
      cb.disabled = true;
      cb.textContent = "checking\u2026";
      const r = await fetch(`/api/channels/${c.id}/connect`);
      const d = await r.json();
      setOpen(el, true); // reveal the pairing UI
      if (d.pairing) {
        renderPairing(el, c);
      } else if (d.connectUrl) {
        cb.outerHTML = `<a class="mini-btn" href="${esc(d.connectUrl)}" target="_blank" rel="noopener">Connect ${esc(c.meta?.label || c.id)} \u2192</a>`;
      } else {
        cb.textContent = "no connect link available";
      }
    });
    wrap.appendChild(el);
  }
}

// ---------- Anytype in-app pairing ----------
function pairError(box, msg) {
  const e = box.querySelector(".pair-err");
  e.hidden = false;
  e.textContent = `\u26a0 ${msg}`;
}

async function pairDone(box, c) {
  const hint = box.querySelector(".pair-hint");
  if (hint) hint.textContent = "Paired \u2713 \u2014 polling now\u2026";
  await fetch(`/api/channels/${c.id}/poll`, { method: "POST" });
  loadChannels();
}

function renderPairing(el, c) {
  const row = el.querySelector(".connect-row");
  const box = document.createElement("div");
  box.className = "pair-box";
  box.innerHTML = `
    <div class="muted">Pair with the Anytype desktop app \u2014 it must be running on this machine.</div>
    <div class="ch-row">
      <button class="mini-btn pair-req">1 \u00b7 get pairing code</button>
      <span class="muted pair-hint"></span>
    </div>
    <div class="ch-row pair-code-row" hidden>
      <span>Code shown in Anytype:</span>
      <input class="mini-btn pair-code" inputmode="numeric" maxlength="4" placeholder="\u00b7\u00b7\u00b7\u00b7" aria-label="4-digit pairing code">
      <button class="mini-btn pair-go">2 \u00b7 pair</button>
    </div>
    <div class="ch-row">
      <button class="mini-btn pair-key-toggle">or paste an API key</button>
    </div>
    <div class="ch-row pair-key-row" hidden>
      <input class="mini-btn pair-key" placeholder="API key (Anytype \u2192 Settings \u2192 API Keys)" aria-label="Anytype API key">
      <button class="mini-btn pair-key-go">save</button>
    </div>
    <div class="error pair-err" hidden></div>`;
  row.replaceWith(box);

  let challengeId = "";
  const reqBtn = box.querySelector(".pair-req");
  reqBtn.addEventListener("click", async () => {
    reqBtn.disabled = true;
    const hint = box.querySelector(".pair-hint");
    hint.textContent = "waiting for Anytype\u2026";
    try {
      const r = await fetch(`/api/channels/${c.id}/challenge`, { method: "POST" });
      const d = await r.json();
      if (d.challenge_id) {
        challengeId = d.challenge_id;
        hint.textContent = "enter the 4-digit code shown in Anytype";
        box.querySelector(".pair-code-row").hidden = false;
        box.querySelector(".pair-code").focus();
      } else {
        pairError(box, d.error || "could not reach Anytype");
        reqBtn.disabled = false;
      }
    } catch {
      pairError(box, "could not reach the switchboard");
      reqBtn.disabled = false;
    }
  });

  box.querySelector(".pair-go").addEventListener("click", async () => {
    const code = box.querySelector(".pair-code").value;
    const go = box.querySelector(".pair-go");
    go.disabled = true;
    const r = await fetch(`/api/channels/${c.id}/pair`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge_id: challengeId, code }),
    });
    const d = await r.json();
    if (d.ok) pairDone(box, c);
    else { pairError(box, d.error || "pairing failed"); go.disabled = false; }
  });

  box.querySelector(".pair-key-toggle").addEventListener("click", () => {
    box.querySelector(".pair-key-row").hidden = false;
    box.querySelector(".pair-key").focus();
  });

  box.querySelector(".pair-key-go").addEventListener("click", async () => {
    const key = box.querySelector(".pair-key").value;
    const go = box.querySelector(".pair-key-go");
    go.disabled = true;
    const r = await fetch(`/api/channels/${c.id}/key`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const d = await r.json();
    if (d.ok) pairDone(box, c);
    else { pairError(box, d.error || "key not accepted"); go.disabled = false; }
  });
}

// ---------- line out ----------
function noteHtml(n) {
  const items = n.kind === "digest" ? JSON.parse(n.items || "[]") : [];
  const detail = items.length
    ? `<details><summary>${items.length} items</summary>` +
      items.map((it) => `<div>\u2022 <b>[${esc(it.priority)}]</b> ${esc(it.title)} <span class="muted">(${esc(it.channel_id)})</span></div>`).join("") +
      `</details>` : "";
  return `
    <div class="note-top">
      <span class="note-tag">${n.kind === "digest" ? "digest" : esc(n.channel_id || "line")}</span>
      <span class="note-title">${esc(n.title)}</span>
    </div>
    ${n.body ? `<div class="note-body">${esc(n.body)}</div>` : ""}
    ${detail}
    <div class="note-meta">
      <span>${timeAgo(n.created_at)}</span>
      ${n.status === "snoozed" ? `<span>snoozed</span>` : ""}
      <span class="grow"></span>
      ${n.url ? `<a class="mini-btn" href="${esc(n.url)}" target="_blank" rel="noopener">open</a>` : ""}
      ${n.status !== "dismissed" ? `
        <button class="mini-btn act-snooze" data-id="${n.id}">snooze 30m</button>
        <button class="mini-btn act-dismiss" data-id="${n.id}">dismiss</button>` : ""}
    </div>`;
}

function renderFeed() {
  const feed = $("feed");
  const live = state.feed.filter((n) => n.status !== "dismissed");
  if (!live.length) {
    feed.innerHTML = `<p class="muted">Quiet on the line. Signals will appear here as the board routes them.</p>`;
    return;
  }
  feed.innerHTML = "";
  for (const n of live.slice(0, 50)) {
    const el = document.createElement("div");
    el.className = `note ${n.kind === "digest" ? "digest" : n.priority} ${n.status}`;
    el.innerHTML = noteHtml(n);
    const d = el.querySelector(".act-dismiss");
    if (d) d.addEventListener("click", () => noteAction(n.id, "dismiss"));
    const s = el.querySelector(".act-snooze");
    if (s) s.addEventListener("click", () => noteAction(n.id, "snooze"));
    feed.appendChild(el);
  }
}

async function noteAction(id, action) {
  const body = action === "snooze" ? { minutes: 30 } : {};
  const r = await fetch(`/api/notifications/${id}/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  const i = state.feed.findIndex((n) => n.id === id);
  if (i >= 0) state.feed[i] = d.notification;
  renderFeed();
}

function desktopNotify(n) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (n.status && n.status !== "sent") return;
  const items = n.kind === "digest" ? JSON.parse(n.items || "[]") : [];
  new Notification(n.title, {
    body: (n.body || items.slice(0, 3).map((i) => i.title).join("\n")).slice(0, 200),
    tag: `switchboard-${n.id}`,
  });
}

// ---------- live ----------
function subscribe() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === "notification") {
        const i = state.feed.findIndex((n) => n.id === ev.notification.id);
        if (i >= 0) state.feed[i] = ev.notification;
        else state.feed.unshift(ev.notification);
        renderFeed();
        desktopNotify(ev.notification);
      } else if (ev.type === "channel") {
        const i = state.channels.findIndex((c) => c.id === ev.channel.id);
        if (i >= 0) state.channels[i] = { ...state.channels[i], ...ev.channel };
        renderChannels();
      } else if (ev.type === "settings") {
        state.settings = ev.settings;
        renderMaster();
      }
    } catch { /* keep-alive */ }
  };
  es.onerror = () => setTimeout(() => { es.close(); subscribe(); }, 5000);
}

// ---------- boot ----------
const state = { channels: [], settings: {}, feed: [] };

async function loadChannels() {
  const r = await fetch("/api/channels");
  const d = await r.json();
  state.channels = d.channels;
  renderChannels();
}
async function loadSettings() {
  const r = await fetch("/api/settings");
  const d = await r.json();
  state.settings = d.settings;
  renderMaster();
}
async function loadFeed() {
  const r = await fetch("/api/notifications?limit=50");
  const d = await r.json();
  state.feed = d.notifications;
  renderFeed();
}

$("master-toggle").addEventListener("click", () => {
  const sec = $("master-panel");
  const open = sec.getAttribute("data-open") === "1";
  setOpen(sec, !open);
});

$("theme-btn").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try { localStorage.setItem("sb-theme", dark ? "dark" : "light"); } catch { /* private mode */ }
});

$("quiet-toggle").addEventListener("click", () =>
  patchSettings({ quiet_enabled: state.settings.quiet_enabled !== "1" }));
$("quiet-start").addEventListener("change", (e) => patchSettings({ quiet_start: e.target.value }));
$("quiet-end").addEventListener("change", (e) => patchSettings({ quiet_end: e.target.value }));
$("digest-minutes").addEventListener("change", (e) => patchSettings({ digest_minutes: e.target.value }));
$("urgent-breaks").addEventListener("change", (e) => patchSettings({ urgent_breaks_quiet: e.target.checked }));
$("notify-btn").addEventListener("click", async () => {
  if (!("Notification" in window)) { $("notify-btn").textContent = "not supported"; return; }
  const p = await Notification.requestPermission();
  $("notify-btn").textContent = p === "granted" ? "Notifications on" : "Notifications blocked";
});
$("test-btn").addEventListener("click", async () => {
  await fetch("/api/test", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "\u26a1 Test signal", priority: "normal" }),
  });
});

(async function init() {
  await Promise.all([loadChannels(), loadSettings(), loadFeed()]);
  subscribe();
})();
