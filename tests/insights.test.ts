// Insights: weekly aggregates computed read-only from signals/notifications.
import { test, expect } from "bun:test";
import { openDb, insertSignal, addNotification, updateNotification, getInsights } from "../src/db";

function freshDb() {
  const p = `/tmp/sb-ins-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  return { db: openDb(p), p };
}

function cleanup(db: any, p: string) {
  db.close();
  return Promise.all(
    ["", "-wal", "-shm"].map((s) => Bun.file(p + s).unlink().catch(() => {}))
  );
}

test("getInsights: per-channel counts, outcomes, busiest hours, top senders", async () => {
  const { db, p } = freshDb();
  try {
    insertSignal(db, "ascent", "e1", "A", "", "", "high");
    insertSignal(db, "ascent", "e2", "B", "", "", "normal", false, "shy@example.com");
    insertSignal(db, "github", "e3", "C", "", "", "low", false, "shy@example.com");

    // A signal older than the 7-day window is excluded.
    const oldId = insertSignal(db, "ascent", "e-old", "OLD", "", "", "low")!;
    db.prepare(`UPDATE signals SET detected_at = ? WHERE id = ?`)
      .run(Date.now() - 8 * 86400 * 1000, oldId);

    const n1 = addNotification(db, { kind: "instant", title: "t1" });
    const n2 = addNotification(db, { kind: "digest", title: "t2" });
    addNotification(db, { kind: "instant", title: "t3" });
    updateNotification(db, n2.id, { status: "snoozed" });
    updateNotification(db, n1.id, { status: "dismissed" });

    const ins = getInsights(db);
    expect(ins.window_days).toBe(7);
    expect(ins.total_signals).toBe(3);
    expect(ins.signals_by_channel).toEqual([
      { channel_id: "ascent", count: 2 },
      { channel_id: "github", count: 1 },
    ]);
    expect(ins.outcomes).toEqual({ open: 1, snoozed: 1, handled: 1 });
    expect(ins.busiest_hours.length).toBeGreaterThan(0);
    const hourSum = ins.busiest_hours.reduce((n, h) => n + h.count, 0);
    expect(hourSum).toBe(3); // all three notifications fired this hour
    expect(ins.top_senders).toEqual([{ sender: "shy@example.com", count: 2 }]);
  } finally {
    await cleanup(db, p);
  }
});

test("getInsights: empty database yields a clean zero state", async () => {
  const { db, p } = freshDb();
  try {
    const ins = getInsights(db);
    expect(ins.total_signals).toBe(0);
    expect(ins.signals_by_channel).toEqual([]);
    expect(ins.outcomes).toEqual({ open: 0, snoozed: 0, handled: 0 });
    expect(ins.busiest_hours).toEqual([]);
    expect(ins.top_senders).toEqual([]);
  } finally {
    await cleanup(db, p);
  }
});
