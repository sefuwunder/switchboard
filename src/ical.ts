// Minimal iCalendar (RFC 5545) reader for the Calendar channel.
// Zero dependencies: line unfolding, VEVENT parsing (UID/SUMMARY/DESCRIPTION/
// LOCATION/URL/STATUS/DTSTART/RRULE/EXDATE), UTC + TZID + floating + all-day
// start times, and DAILY/WEEKLY recurrence expansion over the poll window.
// Anything fancier (other FREQ values, RDATE, VTIMEZONE blocks) is ignored.

export interface IcalOccurrence {
  uid: string;
  summary: string;
  description: string;
  location: string;
  url: string;
  startMs: number;
}

interface WallTime { y: number; mo: number; d: number; h: number; mi: number; s: number }

interface DateProp {
  wall: WallTime;
  dateOnly: boolean;
  utc: boolean;
  tzid: string | null; // null = floating (server-local) or UTC
}

interface RRule {
  freq: string;
  interval: number;
  count: number | null;
  until: number | null;
  byday: number[] | null; // Monday-first offsets 0..6
}

interface CalEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  url: string;
  start: DateProp;
  rrule: RRule | null;
  exdates: DateProp[];
}

// ---------------------------------------------------------------------------
// fetching
// ---------------------------------------------------------------------------

export async function fetchIcalText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "switchboard/1.0", Accept: "text/calendar" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`iCal HTTP ${r.status}`);
    const text = await r.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("URL did not return a calendar feed");
    return text;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// low-level parsing
// ---------------------------------------------------------------------------

function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (/^[ \t]/.test(raw) && out.length) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out;
}

interface Prop { name: string; params: Record<string, string>; value: string }

function parseProp(line: string): Prop | null {
  const ci = line.indexOf(":");
  if (ci < 0) return null;
  const head = line.slice(0, ci);
  const parts = head.split(";");
  const name = parts[0].trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) params[p.trim().toUpperCase()] = "";
    else params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { name, params, value: line.slice(ci + 1) };
}

function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

function parseDateValue(value: string, params: Record<string, string>): DateProp | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const wall: WallTime = {
    y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
    h: Number(m[4] || 0), mi: Number(m[5] || 0), s: Number(m[6] || 0),
  };
  return {
    wall,
    dateOnly: (params["VALUE"] || "").toUpperCase() === "DATE" || !m[4],
    utc: m[7] === "Z",
    tzid: params["TZID"] || null,
  };
}

// ---------------------------------------------------------------------------
// timezones (via Intl — no tz database needed)
// ---------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function tzOffsetMs(tzid: string, utcMs: number): number {
  let dtf = dtfCache.get(tzid);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    dtfCache.set(tzid, dtf);
  }
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]),
    Number(parts["hour"]) % 24, Number(parts["minute"]), Number(parts["second"]),
  );
  return asUtc - utcMs;
}

/** Resolve a wall-clock time in a named zone to epoch ms (iterative, DST-safe). */
export function zonedWallToMs(tzid: string, w: WallTime): number {
  const base = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  let guess = base;
  for (let i = 0; i < 3; i++) guess = base - tzOffsetMs(tzid, guess);
  return guess;
}

function datePropToMs(dp: DateProp): number {
  const w = dp.wall;
  if (dp.dateOnly) return Date.UTC(w.y, w.mo - 1, w.d);
  if (dp.utc) return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  if (dp.tzid) {
    try {
      return zonedWallToMs(dp.tzid, w);
    } catch {
      return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s); // unknown zone → UTC
    }
  }
  return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime(); // floating → server-local
}

// ---------------------------------------------------------------------------
// recurrence
// ---------------------------------------------------------------------------

const DAY_INDEX: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

function parseRRule(value: string): RRule | null {
  const kv: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) kv[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  const freq = (kv["FREQ"] || "").toUpperCase();
  if (!freq) return null;
  let until: number | null = null;
  if (kv["UNTIL"]) {
    const dp = parseDateValue(kv["UNTIL"], {});
    if (dp) until = datePropToMs(dp);
  }
  const byday = kv["BYDAY"]
    ? kv["BYDAY"].split(",").map((d) => DAY_INDEX[d.trim().toUpperCase()]).filter((n) => n !== undefined)
    : null;
  return {
    freq,
    interval: Math.max(1, parseInt(kv["INTERVAL"] || "1", 10) || 1),
    count: kv["COUNT"] ? Math.max(1, parseInt(kv["COUNT"], 10) || 1) : null,
    until,
    byday: byday && byday.length ? byday : null,
  };
}

function addDays(w: WallTime, n: number): WallTime {
  const d = new Date(Date.UTC(w.y, w.mo - 1, w.d) + n * 86400000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: w.h, mi: w.mi, s: w.s };
}

/** Monday-first weekday 0..6 for a wall date (timezone-independent). */
function weekdayMon0(w: WallTime): number {
  return (new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay() + 6) % 7;
}

function expandEvent(ev: CalEvent, fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  const excluded = new Set(ev.exdates.map(datePropToMs));
  const baseWall = ev.start.wall;
  const wallToMs = (w: WallTime) => datePropToMs({ ...ev.start, wall: w });
  const push = (ms: number) => {
    if (ms >= fromMs && ms <= toMs && !excluded.has(ms)) out.push(ms);
  };
  const r = ev.rrule;
  if (!r || (r.freq !== "DAILY" && r.freq !== "WEEKLY")) {
    push(datePropToMs(ev.start));
    return out;
  }
  let produced = 0;
  const done = (ms: number): boolean => {
    if (r.until !== null && ms > r.until) return true;
    if (ms > toMs) return true;
    return false;
  };
  if (r.freq === "DAILY") {
    for (let i = 0; i < 2000; i++) {
      if (r.count !== null && produced >= r.count) break;
      const ms = wallToMs(addDays(baseWall, i * r.interval));
      if (done(ms)) break;
      produced++;
      push(ms);
    }
  } else {
    const days = [...(r.byday ?? [weekdayMon0(baseWall)])].sort((a, b) => a - b);
    const baseDow = weekdayMon0(baseWall);
    for (let week = 0; week < 500; week++) {
      let pastHorizon = false;
      for (const d of days) {
        const delta = week * 7 * r.interval + (d - baseDow);
        if (delta < 0) continue;
        if (r.count !== null && produced >= r.count) return out;
        const ms = wallToMs(addDays(baseWall, delta));
        if (done(ms)) { pastHorizon = true; break; }
        produced++;
        push(ms);
      }
      if (pastHorizon) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

function buildEvent(props: Prop[]): CalEvent | null {
  let uid = "", summary = "", description = "", location = "", url = "", status = "";
  let start: DateProp | null = null;
  let rrule: RRule | null = null;
  const exdates: DateProp[] = [];
  let hasRecurrenceId = false;
  for (const p of props) {
    switch (p.name) {
      case "UID": uid = p.value; break;
      case "SUMMARY": summary = unescapeText(p.value); break;
      case "DESCRIPTION": description = unescapeText(p.value); break;
      case "LOCATION": location = unescapeText(p.value); break;
      case "URL": url = p.value; break;
      case "STATUS": status = p.value.toUpperCase(); break;
      case "DTSTART": start = parseDateValue(p.value, p.params); break;
      case "RRULE": rrule = parseRRule(p.value); break;
      case "RECURRENCE-ID": hasRecurrenceId = true; break;
      case "EXDATE": {
        for (const v of p.value.split(",")) {
          const dp = parseDateValue(v.trim(), p.params);
          if (dp) exdates.push(dp);
        }
        break;
      }
    }
  }
  if (!start || status === "CANCELLED" || hasRecurrenceId) return null;
  if (!uid) uid = `${summary}-${datePropToMs(start)}`;
  return { uid, summary, description, location, url, start, rrule, exdates };
}

export function parseIcs(text: string): CalEvent[] {
  const events: CalEvent[] = [];
  let cur: Prop[] | null = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") cur = [];
    else if (line === "END:VEVENT") {
      if (cur) {
        const ev = buildEvent(cur);
        if (ev) events.push(ev);
      }
      cur = null;
    } else if (cur) {
      const p = parseProp(line);
      if (p) cur.push(p);
    }
  }
  return events;
}

/** All occurrences (including recurring) starting within [fromMs, toMs]. */
export function upcomingFromIcs(text: string, fromMs: number, toMs: number): IcalOccurrence[] {
  const out: IcalOccurrence[] = [];
  for (const ev of parseIcs(text)) {
    for (const startMs of expandEvent(ev, fromMs, toMs)) {
      out.push({
        uid: ev.uid,
        summary: ev.summary || "(no title)",
        description: ev.description,
        location: ev.location,
        url: ev.url,
        startMs,
      });
    }
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}
