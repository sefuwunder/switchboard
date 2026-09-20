// Ascent channel: identity-key stability, priority mapping, NOT CONNECTED.
import { test, expect } from "bun:test";
import { CHANNEL_DEFS, ascentSignalsFromMyDay } from "../src/channels";
import { openDb, setSetting, insertSignal } from "../src/db";

const DAY = 86400000;
function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

test("ascentSignalsFromMyDay: overdue->high, due-today->normal, undated skipped", () => {
  const nowMs = new Date(2026, 8, 20, 12, 0, 0).getTime(); // local noon
  const j = {
    overdue: [{ id: "a1", title: "Late report", dueMs: dayStart(nowMs) - 2 * DAY, project_name: "Acme" }],
    today: [{ id: "a2", title: "Call bank", dueMs: dayStart(nowMs) + 3600_000, project_name: "Acme" }],
    in_progress: [{ id: "a3", title: "No due date", status: "in_progress" }],
  };
  const s = ascentSignalsFromMyDay(j, nowMs, "http://127.0.0.1:3004");
  expect(s.length).toBe(2); // in_progress (no due date) stays quiet

  const late = s.find((x) => x.ext_id.startsWith("ascent:a1:"))!;
  expect(late.priority).toBe("high");
  expect(late.ext_id).toBe(`ascent:a1:${dayStart(nowMs) - 2 * DAY}:overdue`);
  expect(late.body).toContain("overdue by 2d");
  expect(late.body).toContain("Acme");

  const today = s.find((x) => x.ext_id.startsWith("ascent:a2:"))!;
  expect(today.priority).toBe("normal");
  expect(today.ext_id).toBe(`ascent:a2:${dayStart(nowMs)}:due`);
  expect(today.body).toContain("due today");
  expect(today.url).toBe("http://127.0.0.1:3004/#/myday");

  expect(s[0].priority).toBe("high"); // most pressing first
});

test("ascent identity: band is part of the key so escalation re-fires", () => {
  const nowMs = new Date(2026, 8, 20, 12, 0, 0).getTime();
  const dueMs = dayStart(nowMs) + 3600_000;
  const asDue = ascentSignalsFromMyDay({ overdue: [], today: [{ id: "a9", title: "X", dueMs }], in_progress: [] }, nowMs, "http://x");
  // Next day the same task is overdue: the key must differ so dedupe re-fires it.
  const nextDay = nowMs + DAY;
  const asOverdue = ascentSignalsFromMyDay({ overdue: [{ id: "a9", title: "X", dueMs }], today: [], in_progress: [] }, nextDay, "http://x");
  expect(asDue[0].ext_id).not.toBe(asOverdue[0].ext_id);
  expect(asOverdue[0].priority).toBe("high");
});

test("pollAscent: live poll, identity stable across polls, NOT CONNECTED on dead host", async () => {
  const now = Date.now();
  const payload = {
    overdue: [{ id: "x1", title: "Old thing", dueMs: dayStart(now) - DAY, project_name: "P" }],
    today: [{ id: "x2", title: "New thing", dueMs: dayStart(now) + 7200_000, project_name: "P" }],
    in_progress: [],
  };
  const stub = Bun.serve({ port: 0, fetch: () => Response.json(payload) });
  const dbPath = `/tmp/sb-ascent-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const db = openDb(dbPath);
  try {
    setSetting(db, "ascent_base_url", `http://127.0.0.1:${stub.port}`);
    const def = CHANNEL_DEFS.find((d) => d.id === "ascent")!;
    expect(def.label).toBe("Ascent");

    const r1 = await def.poll({ db });
    expect(r1.ok).toBe(true);
    expect(r1.signals.length).toBe(2);
    expect(r1.signals[0].ext_id).toMatch(/^ascent:x1:\d+:overdue$/);

    // Simulate the engine inserting them, then poll again: zero fresh signals.
    for (const s of r1.signals) {
      insertSignal(db, "ascent", s.ext_id, s.title, s.body, s.url, s.priority, s.digestOnly, s.sender);
    }
    const r2 = await def.poll({ db });
    let fresh = 0;
    for (const s of r2.signals) {
      if (insertSignal(db, "ascent", s.ext_id, s.title, s.body, s.url, s.priority, s.digestOnly, s.sender) !== null) fresh++;
    }
    expect(fresh).toBe(0);

    // Dead host -> NOT CONNECTED (channel shows the setup hint).
    setSetting(db, "ascent_base_url", "http://127.0.0.1:1");
    const r3 = await def.poll({ db });
    expect(r3.ok).toBe(false);
    expect(r3.error).toBe("not_connected");
  } finally {
    stub.stop();
    db.close();
    await Bun.file(dbPath).unlink().catch(() => {});
    await Bun.file(dbPath + "-wal").unlink().catch(() => {});
    await Bun.file(dbPath + "-shm").unlink().catch(() => {});
  }
});
