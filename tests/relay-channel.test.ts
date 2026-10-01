// Relay channel: due commitments + upcoming appointments.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { CHANNEL_DEFS, relaySignalsFromPayload } from "../src/channels";

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const BASE = "http://127.0.0.1:3006";

const commitments = [
  { id: "k1", text: "send the Q3 report", status: "open", due_date: "2026-10-02", due_time: "17:00" },
  { id: "k2", text: "old done thing", status: "done", due_date: "", due_time: "" },
];
const convAppts = [
  {
    id: "c1", title: "Shy",
    appointments: [
      { id: "a1", uid: "u1", title: "Lunch", starts_at: iso(now + 30 * 60000), ends_at: iso(now + 90 * 60000), location: "Cafe", status: "accepted" },
      { id: "a2", uid: "u2", title: "Dentist", starts_at: iso(now + 26 * 3600000), ends_at: iso(now + 27 * 3600000), location: "", status: "planned" },
      { id: "a3", uid: "u3", title: "Declined thing", starts_at: iso(now + 30 * 60000), ends_at: iso(now + 60 * 60000), location: "", status: "declined" },
      { id: "a4", uid: "u4", title: "Old thing", starts_at: iso(now - 2 * 3600000), ends_at: iso(now - 3600000), location: "", status: "accepted" },
    ],
  },
];

describe("relay channel def", () => {
  test("is registered", () => {
    const def = CHANNEL_DEFS.find((d) => d.id === "relay");
    expect(def).toBeDefined();
    expect(def!.label).toBe("Relay");
  });
});

describe("relaySignalsFromPayload", () => {
  test("due commitments become high-priority signals", () => {
    const sigs = relaySignalsFromPayload(commitments, [], now, BASE);
    const c = sigs.find((s) => s.ext_id === "relay:commitment:k1");
    expect(c).toBeDefined();
    expect(c!.priority).toBe("high");
    expect(c!.title).toContain("send the Q3 report");
    expect(c!.body).toContain("2026-10-02");
    expect(c!.url).toBe(`${BASE}/#/commitments`);
    expect(sigs.some((s) => s.ext_id === "relay:commitment:k2")).toBe(false);
  });

  test("upcoming appointments get escalation bands", () => {
    const sigs = relaySignalsFromPayload([], convAppts, now, BASE);
    const soon = sigs.find((s) => s.ext_id.startsWith("relay:appt:u1:"));
    expect(soon).toBeDefined();
    expect(soon!.priority).toBe("high");
    expect(soon!.ext_id.endsWith(":high")).toBe(true);
    expect(soon!.body).toContain("Shy");
    expect(soon!.body).toContain("Cafe");
    expect(soon!.url).toBe(`${BASE}/#/conversations/c1`);
    const later = sigs.find((s) => s.ext_id.startsWith("relay:appt:u2:"));
    expect(later).toBeDefined();
    expect(later!.priority).toBe("normal");
    expect(sigs.some((s) => s.ext_id.startsWith("relay:appt:u3:"))).toBe(false);
    expect(sigs.some((s) => s.ext_id.startsWith("relay:appt:u4:"))).toBe(false);
  });

  test("most pressing first", () => {
    const sigs = relaySignalsFromPayload(commitments, convAppts, now, BASE);
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
    for (let i = 1; i < sigs.length; i++)
      expect(rank[sigs[i].priority] >= rank[sigs[i - 1].priority]).toBe(true);
  });
});

describe("pollRelay", () => {
  const def = CHANNEL_DEFS.find((d) => d.id === "relay")!;
  const stub = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/commitments/due") return Response.json({ commitments });
      if (u.pathname === "/api/conversations")
        return Response.json({ conversations: [{ id: "c1", title: "Shy" }] });
      if (u.pathname === "/api/conversations/c1/appointments")
        return Response.json({ appointments: convAppts[0].appointments });
      return new Response("nf", { status: 404 });
    },
  });
  afterAll(() => stub.stop(true));

  // relayBaseUrl(db) reads the relay_base_url setting via
  // db.query("SELECT value ...").get(key) — fake just enough of it.
  const dbWithBase = (base: string) => ({
    query: () => ({ get: (key: string) => (key === "relay_base_url" ? { value: base } : undefined) }),
  });

  test("fetches and builds signals end to end", async () => {
    const r = await def.poll({ db: dbWithBase(`http://127.0.0.1:${stub.port}`) } as any);
    expect(r.ok).toBe(true);
    expect(r.signals.some((s) => s.ext_id === "relay:commitment:k1")).toBe(true);
    expect(r.signals.some((s) => s.ext_id.startsWith("relay:appt:u1:"))).toBe(true);
  });

  test("unreachable relay reports not_connected", async () => {
    const r = await def.poll({ db: dbWithBase("http://127.0.0.1:1") } as any);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_connected");
  });
});
