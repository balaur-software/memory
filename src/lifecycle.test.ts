import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { MemoryError, type NodeId } from "./types.ts";

let dir: string;
let store: Store;
let tick = 0;
const T0 = Date.parse("2026-07-05T12:00:00.000Z");
const now = () => new Date(T0 + ++tick);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-lifecycle-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "memory", bornStatus: "proposed" });
  store.registerType({ name: "note", bornStatus: "active" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const activeMem = (title: string, body = "") => {
  const p = store.propose({ type: "memory", title, body, importance: 3, origin: "turn:t" });
  return store.decide(p.node.id, { kind: "approve" });
};

describe("quarantine", () => {
  test("suppressed in recall, search, traversal; reachable only by getNode", () => {
    const n = activeMem("The breakup letter", "painful garnet words");
    const friend = store.createNode({ type: "note", title: "Linked note", origin: "t" });
    store.link(friend.id, n.id);
    store.quarantine(n.id, "2026-10-01T00:00:00.000Z");

    expect(store.recall(["garnet"])).toHaveLength(0);
    expect(store.search(["garnet"])).toHaveLength(0);
    expect(store.neighborhood(friend.id).map((x) => x.id)).not.toContain(n.id);
    const got = store.getNode(n.id); // ask-twice: only a deliberate id lookup
    expect(got.status).toBe("quarantined");
    expect(got.reviewAt).toBe("2026-10-01T00:00:00.000Z");
    expect(got.body).toBe("painful garnet words"); // content preserved — suppression, not erasure
  });

  test("guards and reversibility: active-only in, review date clears on the way out", () => {
    const n = activeMem("Quiet fact");
    store.quarantine(n.id);
    expect(() => store.quarantine(n.id)).toThrow(MemoryError); // already quarantined
    expect(() => store.quarantine("nope" as NodeId)).toThrow(MemoryError);
    const q = activeMem("Dated fact", "with garnet");
    store.quarantine(q.id, "2026-08-01T00:00:00.000Z");
    const back = store.transition(q.id, "active");
    expect(back.reviewAt).toBeNull(); // the state carried the date, not the node
    expect(store.recall(["garnet"]).map((x) => x.id)).toContain(q.id); // recall restored
    expect(() => store.quarantine(n.id, "not-a-date")).toThrow(MemoryError); // n is quarantined anyway, but date validates first? order: status first — use fresh node
    const fresh = activeMem("Fresh");
    expect(() => store.quarantine(fresh.id, "not-a-date")).toThrow("ISO-8601");
  });
});

describe("forget (I6): the honest cascade", () => {
  test("tombstone, edges dropped, index scrubbed, derivations flagged, mentions surfaced", () => {
    const fact = activeMem("Xylograph project", "secret xylograph plans with Ana");
    const other = store.createNode({
      type: "note",
      title: "Meeting notes",
      body: "discussed the xylograph project at length",
      origin: "t",
    });
    store.link(other.id, fact.id);
    store.putVector(fact.id, "m1", new Float32Array([1, 0]));
    store.recordDerivation("host:recap:2026-07-04", [fact.id, other.id]);
    store.proposeEdit(fact.id, { fields: { body: "envelope carrying content" }, origin: "t" });

    const report = store.forget(fact.id);

    expect(report.tombstoned).toBe(fact.id);
    expect(report.edgesDropped).toBe(2); // on_day + the manual link
    expect(report.indexScrubbed).toBe(true);
    expect(report.flaggedStale).toEqual(["host:recap:2026-07-04"]);
    expect(report.needsOwner.some((r) => r === `mention:${other.id}`)).toBe(true); // best-effort prose hint
    expect(report.needsOwner).toContain("external:prior-exports");

    const t = store.getNode(fact.id);
    expect(t.status).toBe("forgotten");
    expect(t.title).toBe("");
    expect(t.body).toBe("");
    expect(t.props).toEqual({});
    expect(t.origin).toBe("");
    expect(t.type).toBe("memory"); // type + timestamps survive

    expect(store.staleDerivations()).toEqual(["host:recap:2026-07-04"]);
    expect(store.recall(["xylograph"]).map((x) => x.id)).not.toContain(fact.id);
    expect(store.recall([], { queryVector: new Float32Array([1, 0]), model: "m1" })).toHaveLength(0);
    expect(store.pendingQueue()).toHaveLength(0); // the envelope's content went too

    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const edges = db
      .query("SELECT COUNT(*) AS c FROM edges WHERE source = ? OR target = ?")
      .get(fact.id, fact.id) as { c: number };
    const leak = db
      .query("SELECT COUNT(*) AS c FROM audit_log WHERE meta LIKE '%Xylograph%' OR meta LIKE '%xylograph%'")
      .get() as { c: number };
    const cascade = db.query("SELECT meta FROM audit_log WHERE action = 'forget.cascade'").get() as {
      meta: string;
    };
    db.close();
    expect(edges.c).toBe(0);
    expect(leak.c).toBe(0); // I7: the log proves the forget without remembering the content
    expect(JSON.parse(cascade.meta)["edgesDropped"]).toBe(2);
  });

  test("terminality (I8): forgotten is a dead end; forgettable-from set enforced", () => {
    const n = activeMem("Ephemeral");
    store.forget(n.id);
    expect(() => store.transition(n.id, "active")).toThrow(MemoryError);
    expect(() => store.forget(n.id)).toThrow(MemoryError); // double-forget refused
    expect(() => store.quarantine(n.id)).toThrow(MemoryError);

    const p = store.propose({ type: "memory", title: "Still proposed", body: "", origin: "t" });
    expect(() => store.forget(p.node.id)).toThrow(MemoryError); // proposals are decided, not forgotten

    const arch = activeMem("Old thing");
    store.transition(arch.id, "archived");
    expect(store.forget(arch.id).tombstoned).toBe(arch.id); // archived is forgettable

    const quar = activeMem("Hidden thing");
    store.quarantine(quar.id);
    expect(store.forget(quar.id).tombstoned).toBe(quar.id); // quarantined is forgettable
  });
});

describe("lineage verbs", () => {
  test("recordDerivation is idempotent and validated; staleness accumulates distinctly", () => {
    const a = activeMem("Source A");
    const b = activeMem("Source B");
    store.recordDerivation("host:week:27", [a.id, b.id]);
    store.recordDerivation("host:week:27", [a.id]); // idempotent
    expect(store.staleDerivations()).toEqual([]);
    store.forget(a.id);
    expect(store.staleDerivations()).toEqual(["host:week:27"]);
    store.forget(b.id); // already-stale rows stay flagged once
    expect(store.staleDerivations()).toEqual(["host:week:27"]);
    expect(() => store.recordDerivation("", [a.id])).toThrow(MemoryError);
    expect(() => store.recordDerivation("x", [])).toThrow(MemoryError);
  });
});
