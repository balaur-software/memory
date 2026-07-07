import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { MemoryError } from "./types.ts";

let dir: string;
let store: Store;
let tick = 0;
const T0 = Date.parse("2026-07-05T12:00:00.000Z");
const now = () => new Date(T0 + ++tick);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-ergo-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "note", bornStatus: "active" });
  store.registerType({ name: "task", bornStatus: "proposed" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("propsPatch (G3)", () => {
  test("merges shallowly, null removes a key, siblings survive, schema still validates", () => {
    const n = store.createNode({
      type: "note",
      title: "Task-ish",
      props: { priority: "high", estimate: 3 },
      origin: "o",
    });
    const patched = store.updateNode(n.id, { propsPatch: { outcome: "done" } });
    expect(patched.props).toEqual({ priority: "high", estimate: 3, outcome: "done" }); // no clobber
    const removed = store.updateNode(n.id, { propsPatch: { estimate: null } });
    expect(removed.props).toEqual({ priority: "high", outcome: "done" }); // null removes

    expect(() => store.updateNode(n.id, { props: { a: 1 }, propsPatch: { b: 2 } })).toThrow("not both");

    store.registerType({
      name: "gauge",
      bornStatus: "active",
      propsSchema: { amount: { type: "number", required: true } },
    });
    const g = store.createNode({ type: "gauge", title: "G", props: { amount: 1 }, origin: "o" });
    expect(() => store.updateNode(g.id, { propsPatch: { amount: "nope" } })).toThrow("must be a number");
    expect(() => store.updateNode(g.id, { propsPatch: { amount: null } })).toThrow("required"); // cannot remove a required prop
  });

  test("history snapshots the pre-patch props", () => {
    const n = store.createNode({ type: "note", title: "P", props: { a: 1 }, origin: "o" });
    store.updateNode(n.id, { propsPatch: { b: 2 } });
    expect(store.history(n.id)[0]?.props).toEqual({ a: 1 });
  });

  test("template prop-fill is birth-only — null-removing a templated key does not resurrect it (plan 008)", () => {
    store.registerType({
      name: "ticket",
      bornStatus: "active",
      template: { props: { prio: "normal" } },
    });
    const n = store.createNode({ type: "ticket", title: "Ticket 1", origin: "o" });
    expect(n.props).toEqual({ prio: "normal" }); // template filled at birth

    const patched = store.updateNode(n.id, { propsPatch: { prio: null } });
    expect(patched.props).toEqual({}); // removed, not re-filled from the template
    expect(store.getNode(n.id).props).toEqual({}); // persisted, not just the return value
  });

  test("propsPatch merge doesn't drop untouched templated keys (plan 008)", () => {
    store.registerType({
      name: "ticket2",
      bornStatus: "active",
      template: { props: { prio: "normal" } },
    });
    const n = store.createNode({ type: "ticket2", title: "Ticket 2", origin: "o" });
    const patched = store.updateNode(n.id, { propsPatch: { other: "x" } });
    expect(patched.props).toEqual({ prio: "normal", other: "x" }); // untouched keys survive the merge
  });

  test("a required schema prop supplied only by the template cannot be null-removed on edit (plan 008)", () => {
    store.registerType({
      name: "gated-required",
      bornStatus: "active",
      propsSchema: { level: { type: "string", required: true } },
      template: { props: { level: "info" } },
    });
    const g = store.createNode({ type: "gated-required", title: "G", origin: "o" });
    expect(g.props).toEqual({ level: "info" }); // template supplies the required prop at birth
    // removal is now real (birth-only fill), so validation catches the now-missing required prop
    expect(() => store.updateNode(g.id, { propsPatch: { level: null } })).toThrow(MemoryError);
    expect(() => store.updateNode(g.id, { propsPatch: { level: null } })).toThrow("required");
  });
});

describe("episode (G1)", () => {
  test("the lived-past window: created order, half-open, day-safe, I2", () => {
    const a = store.createNode({ type: "note", title: "Morning thought", origin: "o" });
    store.createNode({ type: "note", title: "Ask me", surfacing: "ask", origin: "o" });
    store.createNode({ type: "note", title: "Never me", surfacing: "never", origin: "o" });
    store.propose({ type: "task", title: "Still proposed", body: "", origin: "t" });
    const b = store.createNode({ type: "note", title: "Evening thought", origin: "o" });
    const arch = store.createNode({ type: "note", title: "Archived thought", origin: "o" });
    store.transition(arch.id, "archived");

    const day = store.episode("2026-07-05", "2026-07-06");
    expect(day.map((n) => n.title)).toEqual(["Morning thought", "Evening thought"]); // order + filters
    expect(day.map((n) => n.type)).not.toContain("day"); // plumbing out
    expect(store.episode("2026-07-06", "2026-07-07")).toEqual([]); // outside the window
    expect(store.episode("2026-07-05", "2026-07-06", { type: "day" }).length).toBeGreaterThan(0); // explicit type reaches anchors
    expect(store.episode("2026-07-05", "2026-07-06", { limit: 1 }).map((n) => n.id)).toEqual([a.id]);
    expect(b.id).not.toBe(a.id);

    expect(() => store.episode("2026-07-06", "2026-07-05")).toThrow("after");
    expect(() => store.episode("whenever", "2026-07-06")).toThrow("ISO-8601");
    expect(() => store.episode("2026-07-05", "2026-07-06", { limit: 0 })).toThrow("positive");
  });

  test("a pure read: walking a month creates no day nodes", () => {
    store.createNode({ type: "note", title: "One entry", origin: "o" });
    const before = store.episode("2026-07-01", "2026-08-01", { type: "day" }).length;
    store.episode("2026-07-01", "2026-08-01");
    store.episode("2026-06-01", "2026-07-01"); // an empty month
    const after = store.episode("2026-07-01", "2026-08-01", { type: "day" }).length;
    expect(after).toBe(before); // no side-effect day creation (the dayAnchor-walk trap, closed)
  });
});

describe("children (G2)", () => {
  test("stated statuses: done steps count toward progress when asked", () => {
    store.registerType({ name: "project", bornStatus: "active" });
    const proj = store.createNode({ type: "project", title: "Trip", origin: "o" });
    const t1 = store.createNode({ type: "task", title: "Book hotel", origin: "o" });
    const t2 = store.createNode({ type: "task", title: "Pack bags", origin: "o" });
    const t3 = store.createNode({ type: "task", title: "Hidden step", surfacing: "never", origin: "o" });
    store.link(t1.id, proj.id, "part_of");
    store.link(t2.id, proj.id, "part_of");
    store.link(t3.id, proj.id, "part_of");
    store.link(proj.id, t2.id, "tracks"); // outgoing from proj — must NOT count (direction)
    store.transition(t1.id, "archived"); // done

    expect(store.children(proj.id, "part_of").map((n) => n.title)).toEqual(["Pack bags"]); // default active
    const all = store.children(proj.id, "part_of", { statuses: ["active", "archived"] });
    expect(all.map((n) => n.title)).toEqual(["Book hotel", "Pack bags"]); // progress 1/2 derivable
    expect(all.map((n) => n.id)).not.toContain(t3.id); // never stays invisible (I2)

    expect(() => store.children(proj.id, " ")).toThrow("required");
    expect(() => store.children(proj.id, "part_of", { statuses: [] })).toThrow("empty");
    expect(() => store.children(proj.id, "part_of", { statuses: ["done" as unknown as "active"] })).toThrow(
      "unknown status",
    );
  });

  test("validity windows apply, with asOf time travel", () => {
    store.registerType({ name: "project", bornStatus: "active" });
    const proj = store.createNode({ type: "project", title: "Team", origin: "o" });
    const old = store.createNode({ type: "note", title: "Former member", origin: "o" });
    const e = store.link(old.id, proj.id, "member_of", "", { from: "2020-01-01" });
    store.closeEdge(e.id, "2024-01-01");
    const cur = store.createNode({ type: "note", title: "Current member", origin: "o" });
    store.link(cur.id, proj.id, "member_of", "", { from: "2024-02-01" });

    expect(store.children(proj.id, "member_of").map((n) => n.title)).toEqual(["Current member"]);
    expect(
      store.children(proj.id, "member_of", { asOf: "2022-06-01T00:00:00.000Z" }).map((n) => n.title),
    ).toEqual(["Former member"]);
  });
});

describe("net worth (holdings) host pattern (HOSTING §11)", () => {
  const netWorth = (accounts: { id: import("./types.ts").NodeId }[], asOf: string) => {
    const totals: Record<string, number> = {};
    for (const acct of accounts) {
      const latest = store
        .children(acct.id as import("./types.ts").NodeId, "snapshot_of")
        .filter((n) => n.when && n.when <= asOf)
        .sort((a, b) => (a.when! < b.when! ? 1 : -1))[0];
      if (!latest) continue;
      const { balance_minor, currency } = latest.props as { balance_minor: number; currency: string };
      totals[currency] = (totals[currency] ?? 0) + balance_minor;
    }
    return totals;
  };

  test("latest-per-account, liabilities net, point-in-time, ask stays out of ambient recall", () => {
    store.registerType({ name: "account", bornStatus: "active" });
    store.registerType({
      name: "holding",
      bornStatus: "active",
      propsSchema: {
        balance_minor: { type: "number", required: true },
        currency: { type: "string", required: true },
      },
    });

    const checking = store.createNode({ type: "account", title: "ING current", origin: "setup" });
    const card = store.createNode({ type: "account", title: "Visa", origin: "setup" });
    const brokerage = store.createNode({ type: "account", title: "IBKR", origin: "setup" });
    const accounts = [checking, card, brokerage];

    const mint = (acct: (typeof accounts)[number], when: string, balance_minor: number, currency = "EUR") =>
      store.link(
        store.createNode({
          type: "holding",
          title: acct.title,
          when,
          surfacing: "ask",
          props: { balance_minor, currency },
          origin: "import",
        }).id,
        acct.id,
        "snapshot_of",
      );

    mint(checking, "2026-07-01", 421_000); // €4,210.00 asset
    mint(card, "2026-07-01", -89_000); // −€890.00 liability
    mint(brokerage, "2026-07-01", 1_000_00, "USD"); // separate currency, not summed into EUR
    // a later statement supersedes by recency, not by mutation — the series is append-only
    mint(checking, "2026-08-01", 500_000);
    mint(card, "2026-08-01", -50_000);

    // before any snapshot: nothing to sum
    expect(netWorth(accounts, "2026-06-30")).toEqual({});

    // July: liabilities net against assets, currencies stay apart
    expect(netWorth(accounts, "2026-07-15")).toEqual({ EUR: 421_000 - 89_000, USD: 1_000_00 });

    // August: latest snapshot per account wins (not the sum of all readings)
    expect(netWorth(accounts, "2026-08-15")).toEqual({ EUR: 500_000 - 50_000, USD: 1_000_00 });

    // the money never surfaces in ambient recall (ask + unrelated query, I2)
    expect(store.search(["weekend", "plans"])).toEqual([]);
    // but the per-account series is reachable by traversal
    expect(store.children(checking.id, "snapshot_of")).toHaveLength(2);

    // integer minor units are enforced — a float-y string is refused at the schema
    expect(() =>
      store.createNode({
        type: "holding",
        title: "bad",
        props: { balance_minor: "1,200", currency: "EUR" },
        origin: "import",
      }),
    ).toThrow("must be a number");
  });
});

describe("the owner fast path on gated types (G7)", () => {
  test("snooze is one call; done-with-outcome is two; agents still route through the queue", () => {
    const t = store.createNode({ type: "task", title: "Call Ana", when: "2026-07-08", origin: "o" });
    // snooze: ONE call, no queue theater
    const snoozed = store.updateNode(t.id, { when: "2026-07-10T09:00:00.000Z" });
    expect(snoozed.when).toBe("2026-07-10T09:00:00.000Z");
    expect(store.pendingQueue()).toHaveLength(0); // nothing entered the queue
    // done with outcome: TWO calls
    store.updateNode(t.id, { propsPatch: { outcome: "done" } });
    expect(store.transition(t.id, "archived").status).toBe("archived");
    // the record is intact: both moves captured, audited
    expect(store.history(t.id).map((s) => s.action)).toEqual(["node.update", "node.update"]);
    // the agent path is unchanged: propose still gated, proposeEdit still parks
    const p = store.propose({ type: "task", title: "Agent idea", body: "", origin: "turn:t" });
    expect(p.node.status).toBe("proposed");
  });
});
