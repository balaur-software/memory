import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";

let dir: string;
let store: Store;
let tick = 0;
const T0 = Date.parse("2026-07-05T12:00:00.000Z");
const now = () => new Date(T0 + ++tick);
const days = (n: number) => {
  tick += n * 86_400_000;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-doctor-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "memory", bornStatus: "proposed" });
  store.registerType({ name: "note", bornStatus: "active" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const activeMem = (title: string, importance = 3) => {
  const p = store.propose({ type: "memory", title, body: "", importance, origin: "t" });
  return store.decide(p.node.id, { kind: "approve" });
};

describe("doctor: counts and rates", () => {
  test("active excludes day plumbing; pending spans proposals and edits; acceptRate from decisions", () => {
    activeMem("Kept one"); // approve
    const rejected = store.propose({ type: "memory", title: "Refused", body: "", origin: "t" });
    store.decide(rejected.node.id, { kind: "reject" });
    store.propose({ type: "memory", title: "Waiting", body: "", origin: "t" });
    const edited = activeMem("Editable");
    store.proposeEdit(edited.id, { fields: { body: "new" }, origin: "t" });

    const r = store.doctor();
    expect(r.activeCount).toBe(2); // Kept one + Editable — day nodes excluded
    expect(r.pendingCount).toBe(2); // one proposal + one parked edit
    expect(r.acceptRate30d).toBeCloseTo(2 / 3); // approve, reject, approve
    expect(r.queueOldestDays).toBe(0); // everything is fresh
  });

  test("acceptRate windows at 30 days and goes null with no decisions", () => {
    expect(store.doctor().acceptRate30d).toBeNull();
    const p = store.propose({ type: "memory", title: "Old decision", body: "", origin: "t" });
    store.decide(p.node.id, { kind: "reject" });
    days(45); // the rejection falls out of the window
    expect(store.doctor().acceptRate30d).toBeNull();
  });
});

describe("doctor: candidates — review lists, never actions", () => {
  test("dead weight = active, never recalled, aged; touch clears it", () => {
    const dormant = activeMem("Dormant fact");
    const used = activeMem("Used fact");
    days(120);
    store.touch(used.id);
    const r = store.doctor();
    expect(r.deadWeightCandidates).toContain(dormant.id);
    expect(r.deadWeightCandidates).not.toContain(used.id);
    // and nothing changed any status — reports never act:
    expect(store.getNode(dormant.id).status).toBe("active");
  });

  test("stale = always-on knowledge gone unused, plus quarantine past its review date", () => {
    const important = activeMem("Core constraint", 5);
    const casual = activeMem("Casual note", 1);
    const hidden = activeMem("Painful thing");
    store.quarantine(hidden.id, new Date(T0 + tick + 10 * 86_400_000).toISOString());
    days(120); // importance-5 unused 120d; review date long passed
    const r = store.doctor();
    expect(r.staleCandidates).toContain(important.id);
    expect(r.staleCandidates).not.toContain(casual.id); // low importance: dead-weight lens, not stale
    expect(r.staleCandidates).toContain(hidden.id); // review due
  });

  test("duplicates the gate could not stop: owner-path same-type normalized titles", () => {
    const a = activeMem("Trains for the marathon");
    const b = store.createNode({ type: "memory", title: "  trains FOR the marathon ", origin: "owner" });
    store.createNode({ type: "note", title: "Trains for the marathon", origin: "owner" }); // other type: not a pair
    const r = store.doctor();
    expect(r.duplicateCandidates).toHaveLength(1);
    const pair = r.duplicateCandidates[0];
    expect([pair?.[0], pair?.[1]].sort()).toEqual([a.id, b.id].sort());
  });

  test("queueOldestDays tracks the oldest waiting item", () => {
    store.propose({ type: "memory", title: "Ancient proposal", body: "", origin: "t" });
    days(14);
    store.propose({ type: "memory", title: "Fresh proposal", body: "", origin: "t" });
    expect(store.doctor().queueOldestDays).toBe(14);
  });
});

describe("doctor: deadlineCandidates — the blessed props.due convention (task-arc plan 018)", () => {
  test("past props.due surfaces oldest-first, capped; never/archived/future/malformed excluded", () => {
    const overdueB = store.createNode({
      type: "note",
      title: "B",
      props: { due: "2026-07-03T00:00:00.000Z" },
      origin: "o",
    });
    const overdueA = store.createNode({
      type: "note",
      title: "A",
      props: { due: "2026-07-01T00:00:00.000Z" },
      origin: "o",
    });
    store.createNode({
      type: "note",
      title: "Future",
      props: { due: "2026-09-01T00:00:00.000Z" },
      origin: "o",
    });
    const hidden = store.createNode({
      type: "note",
      title: "Hidden due",
      props: { due: "2026-07-02T00:00:00.000Z" },
      surfacing: "never",
      origin: "o",
    });
    const done = store.createNode({
      type: "note",
      title: "Done",
      props: { due: "2026-07-02T00:00:00.000Z" },
      origin: "o",
    });
    store.transition(done.id, "archived");
    const malformed = store.createNode({
      type: "note",
      title: "Malformed due",
      props: { due: "next week" },
      origin: "o",
    });

    const due = store.doctor().deadlineCandidates;
    expect(due).toEqual([overdueA.id, overdueB.id]); // oldest-due first
    expect(due).not.toContain(hidden.id);
    expect(due).not.toContain(malformed.id); // the documented cost of the convention

    for (let i = 0; i < 25; i++)
      store.createNode({
        type: "note",
        title: `O${i}`,
        props: { due: "2026-06-01T00:00:00.000Z" },
        origin: "o",
      });
    expect(store.doctor().deadlineCandidates).toHaveLength(20); // the lens cap
  });

  test("deadlineCandidates and dueCandidates are parallel, independent axes on the same node", () => {
    const both = store.createNode({
      type: "note",
      title: "Do Saturday, due the 15th",
      when: "2026-07-09T00:00:00.000Z", // the do-date: not yet passed
      props: { due: "2026-07-01T00:00:00.000Z" }, // the deadline: already passed
      origin: "o",
    });
    const r = store.doctor();
    expect(r.dueCandidates).not.toContain(both.id); // when_at hasn't passed
    expect(r.deadlineCandidates).toContain(both.id); // props.due has
  });
});

describe("doctor: the announced revision — pendingByKind, historyRows, reproposedAfterForget30d", () => {
  test("pendingByKind breaks pendingCount down by proposal / edit / identity", () => {
    store.propose({ type: "memory", title: "Awaiting verdict", body: "", origin: "t" });
    const editable = activeMem("Editable target");
    store.proposeEdit(editable.id, { fields: { body: "new" }, origin: "t" });
    activeMem("Identity twin");
    store.createNode({ type: "memory", title: "identity TWIN", origin: "owner" });
    store.suggestIdentities("memory");

    const r = store.doctor();
    expect(r.pendingByKind).toEqual({ proposals: 1, edits: 1, identities: 1 });
    expect(r.pendingByKind.proposals + r.pendingByKind.edits + r.pendingByKind.identities).toBe(
      r.pendingCount,
    );
  });

  test("historyRows counts memory_history snapshots after edits", () => {
    const node = store.createNode({ type: "note", title: "Tracked", body: "v1", origin: "owner" });
    expect(store.doctor().historyRows).toBe(0);
    store.updateNode(node.id, { body: "v2" });
    store.updateNode(node.id, { body: "v3" });
    expect(store.doctor().historyRows).toBe(2);
  });

  test("reproposedAfterForget30d: salted-hash match, unrelated titles excluded, window-bound", () => {
    const node = activeMem("Allergy note");
    store.forget(node.id);

    // An unrelated proposal must never be mistaken for a reproposal.
    store.propose({ type: "memory", title: "Completely different", body: "", origin: "t" });
    expect(store.doctor().reproposedAfterForget30d).toBe(0);

    // Same title, different case/whitespace — normalization must still match.
    store.propose({ type: "memory", title: "  ALLERGY   note ", body: "", origin: "t" });
    expect(store.doctor().reproposedAfterForget30d).toBe(1);

    // Advance past the 30-day window: the earlier matching propose row falls
    // out, but a FRESH matching propose inside the new window still counts —
    // only in-window proposals count.
    days(31);
    store.propose({ type: "memory", title: "allergy note", body: "", origin: "t" });
    expect(store.doctor().reproposedAfterForget30d).toBe(1);
  });

  test("the reproposal signal stays content-free — no audit_log meta ever carries the title", () => {
    const S = "XSENTINELX";
    const node = activeMem(`${S} allergy note`);
    store.forget(node.id);
    store.propose({ type: "memory", title: `${S} allergy note`, body: "", origin: "t" });
    expect(store.doctor().reproposedAfterForget30d).toBe(1);
    store.close();

    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const hits = db
      .query("SELECT COUNT(*) AS c FROM audit_log WHERE meta LIKE ? OR ref LIKE ? OR action LIKE ?")
      .get(`%${S}%`, `%${S}%`, `%${S}%`) as { c: number };
    db.close();
    expect(hits.c).toBe(0);
    store = Store.open({ dir, now }); // afterEach symmetry
  });
});
