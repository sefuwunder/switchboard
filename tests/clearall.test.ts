// Clear all: dismiss every live notification at once.
import { test, expect } from "bun:test";
import { openDb, addNotification, updateNotification, dismissAllNotifications, recentNotifications } from "../src/db";

function freshDb() {
  const p = `/tmp/sb-clr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  return { db: openDb(p), p };
}

async function cleanup(db: any, p: string) {
  db.close();
  return Promise.all(
    ["", "-wal", "-shm"].map((s) => Bun.file(p + s).unlink().catch(() => {}))
  );
}

test("dismissAllNotifications: clears live ones, keeps already-dismissed, stars kept", async () => {
  const { db, p } = freshDb();
  try {
    const n1 = addNotification(db, { kind: "instant", title: "t1" });
    const n2 = addNotification(db, { kind: "instant", title: "t2" });
    const n3 = addNotification(db, { kind: "instant", title: "t3" });
    updateNotification(db, n2.id, { starred: 1 });
    updateNotification(db, n3.id, { status: "dismissed" });

    const cleared = dismissAllNotifications(db);
    expect(cleared).toBe(2); // t1 + t2; t3 was already dismissed

    for (const n of recentNotifications(db, 10)) {
      expect(n.status).toBe("dismissed");
    }
    const starred = db.query(`SELECT * FROM notifications WHERE id = ?`).get(n2.id) as any;
    expect(starred.starred).toBe(1); // clear-all does not unstar

    expect(dismissAllNotifications(db)).toBe(0); // idempotent
  } finally {
    await cleanup(db, p);
  }
});
