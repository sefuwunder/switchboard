// VIP overrides: matching, quiet-hours bypass at low priority, badge flag.
import { test, expect } from "bun:test";
import { openDb, setSetting, getSettings, insertSignal } from "../src/db";
import { routeSignals, getVips, matchVip } from "../src/engine";

function freshDb() {
  const p = `/tmp/sb-vip-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const db = openDb(p);
  // Full-day quiet hours: deterministic, independent of wall-clock time.
  setSetting(db, "quiet_enabled", "1");
  setSetting(db, "quiet_start", "00:00");
  setSetting(db, "quiet_end", "23:59");
  setSetting(db, "dnd", "0");
  setSetting(db, "vip_list", JSON.stringify([{ name: "Shy", matches: ["shy@example.com", "shy"] }]));
  return { db, p };
}

function cleanup(db: any, p: string) {
  db.close();
  return Promise.all(
    ["", "-wal", "-shm"].map((s) => Bun.file(p + s).unlink().catch(() => {}))
  );
}

test("getVips/matchVip: parsing, case-insensitive substring match", () => {
  const vips = getVips({ vip_list: JSON.stringify([{ name: "Shy", matches: ["Shy@Example.com"] }]) });
  expect(vips).toEqual([{ name: "Shy", matches: ["shy@example.com"] }]);
  expect(matchVip("Shy <shy@example.com>", vips)).toBe("Shy");
  expect(matchVip("SHY@EXAMPLE.COM", vips)).toBe("Shy");
  expect(matchVip("someone else", vips)).toBeNull();
  expect(matchVip("", vips)).toBeNull();
  expect(getVips({ vip_list: "not json" })).toEqual([]);
  expect(getVips({})).toEqual([]);
});

test("VIP signal breaks quiet hours at low priority with the badge; non-VIP is held", async () => {
  const { db, p } = freshDb();
  try {
    insertSignal(db, "clickup", "t1", "Call Shy", "", "", "normal", false, "Shy <shy@example.com>");
    insertSignal(db, "clickup", "t2", "Random task", "", "", "normal", false, "bot@corp.com");
    const events: any[] = [];
    routeSignals(db, getSettings(db), (e) => events.push(e), Date.now());

    const notifs = db.query(`SELECT * FROM notifications`).all() as any[];
    expect(notifs.length).toBe(1); // the VIP one went out instantly
    expect(notifs[0].title).toBe("Call Shy");
    expect(notifs[0].priority).toBe("low"); // forced low, not its original normal
    expect(notifs[0].vip).toBe(1); // badge flag
    expect(events.length).toBe(1);
    expect(events[0].notification.vip).toBe(1);

    // The non-VIP signal was held for the digest, not dropped.
    const q = db.query(`SELECT * FROM digest_queue`).all();
    expect(q.length).toBe(1);
  } finally {
    await cleanup(db, p);
  }
});

test("non-quiet hours: VIP routes normally but keeps its priority, still badged", async () => {
  const { db, p } = freshDb();
  try {
    setSetting(db, "quiet_enabled", "0");
    db.prepare(`UPDATE channels SET mode = 'instant' WHERE id = 'clickup'`).run();
    insertSignal(db, "clickup", "t1", "Call Shy", "", "", "high", false, "shy@example.com");
    routeSignals(db, getSettings(db), () => {}, Date.now());
    const notifs = db.query(`SELECT * FROM notifications`).all() as any[];
    expect(notifs.length).toBe(1);
    expect(notifs[0].priority).toBe("high"); // priority preserved when no bypass needed
    expect(notifs[0].vip).toBe(1);
  } finally {
    await cleanup(db, p);
  }
});

test("DND still holds VIP signals; fader still drops below-minimum VIP signals", async () => {
  const { db, p } = freshDb();
  try {
    setSetting(db, "dnd", "1");
    insertSignal(db, "clickup", "t1", "Call Shy", "", "", "normal", false, "shy@example.com");
    routeSignals(db, getSettings(db), () => {}, Date.now());
    expect((db.query(`SELECT * FROM notifications`).all() as any[]).length).toBe(0);

    setSetting(db, "dnd", "0");
    db.prepare(`UPDATE channels SET min_priority = 'high' WHERE id = 'clickup'`).run();
    insertSignal(db, "clickup", "t2", "Low VIP ping", "", "", "low", false, "shy@example.com");
    routeSignals(db, getSettings(db), () => {}, Date.now());
    // low < high fader: dropped even though VIP.
    expect((db.query(`SELECT * FROM notifications`).all() as any[]).length).toBe(0);
    expect((db.query(`SELECT * FROM digest_queue`).all() as any[]).length).toBe(0);
  } finally {
    await cleanup(db, p);
  }
});
