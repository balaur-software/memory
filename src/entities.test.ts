import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "./storage/ulid.ts";
import { Store } from "./store.ts";
import { MemoryError, type NodeId } from "./types.ts";

let dir: string;
let store: Store;
let tick = 0;
const T0 = Date.parse("2026-07-05T12:00:00.000Z");
const now = () => new Date(T0 + ++tick);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-entities-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "person", bornStatus: "active" });
  store.registerType({ name: "note", bornStatus: "active" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("aliases", () => {
  test("add/remove/list roundtrip, normalized, idempotent", () => {
    const ana = store.createNode({ type: "person", title: "Ana Popescu", origin: "owner" });
    store.addAlias(ana.id, "  SIS  ");
    store.addAlias(ana.id, "sis"); // idempotent (same normalized)
    store.addAlias(ana.id, "my sister");
    expect(store.aliasesOf(ana.id)).toEqual(["my sister", "sis"]);
    store.removeAlias(ana.id, "SIS");
    expect(store.aliasesOf(ana.id)).toEqual(["my sister"]);
    store.removeAlias(ana.id, "ghost"); // absent: silent no-op
  });

  test("guards: active-only, non-empty, not the node's own title", () => {
    const ana = store.createNode({ type: "person", title: "Ana Popescu", origin: "owner" });
    expect(() => store.addAlias(ana.id, "  ")).toThrow(MemoryError);
    expect(() => store.addAlias(ana.id, " ana  POPESCU ")).toThrow("own title");
    store.transition(ana.id, "archived");
    expect(() => store.addAlias(ana.id, "sis")).toThrow(MemoryError);
  });

  test("aliases surface in recall via the extra column, and survive rebuild", () => {
    const ana = store.createNode({ type: "person", title: "Ana Popescu", body: "", origin: "owner" });
    expect(store.recall(["zvyqa"])).toHaveLength(0);
    store.addAlias(ana.id, "zvyqa");
    expect(store.recall(["zvyqa"]).map((n) => n.id)).toContain(ana.id); // live reindex
    store.close();
    rmSync(join(dir, "index.db"), { force: true });
    store = Store.open({ dir, now });
    store.rebuildIndex();
    expect(store.recall(["zvyqa"]).map((n) => n.id)).toContain(ana.id); // GROUP_CONCAT path
    store.removeAlias(ana.id, "zvyqa");
    expect(store.recall(["zvyqa"])).toHaveLength(0); // removal reindexes too
  });
});

describe("resolveRef (I2 semantics)", () => {
  test("title and alias hits, type-scoped, candidates oldest-first, never a winner", () => {
    const ana1 = store.createNode({ type: "person", title: "Ana Popescu", origin: "owner" });
    const ana2 = store.createNode({ type: "person", title: "Ana Ionescu", origin: "owner" });
    store.addAlias(ana1.id, "ana");
    store.addAlias(ana2.id, "Ana");
    store.createNode({ type: "note", title: "Ana", origin: "owner" }); // other type: out of scope
    const got = store.resolveRef("person", " ANA ");
    expect(got.map((n) => n.id)).toEqual([ana1.id, ana2.id]); // both candidates, creation order
    expect(store.resolveRef("person", "ana popescu").map((n) => n.id)).toEqual([ana1.id]); // title hit
    expect(store.resolveRef("person", "nobody")).toHaveLength(0);
  });

  test("never is invisible; ask resolves (the text IS its name); non-active drop out", () => {
    const secret = store.createNode({ type: "person", title: "Dana Secret", origin: "owner" });
    store.setSurfacing(secret.id, "never");
    const askP = store.createNode({ type: "person", title: "Radu Q", origin: "owner" });
    store.setSurfacing(askP.id, "ask");
    const archived = store.createNode({ type: "person", title: "Old Radu Q", origin: "owner" });
    store.addAlias(archived.id, "radu q"); // alias collides with askP's title
    store.transition(archived.id, "archived");

    expect(store.resolveRef("person", "Dana Secret")).toHaveLength(0); // I2: never invisible
    const got = store.resolveRef("person", "radu q");
    expect(got.map((n) => n.id)).toEqual([askP.id]); // ask resolves; archived excluded
  });
});

describe("forget cascade, v2 amendments (I6)", () => {
  test("aliases are scrubbed with the tombstone and leave recall", () => {
    const ana = store.createNode({ type: "person", title: "Gone Person", body: "", origin: "owner" });
    store.addAlias(ana.id, "wexlor");
    expect(store.recall(["wexlor"])).toHaveLength(1);
    store.forget(ana.id);
    expect(store.recall(["wexlor"])).toHaveLength(0);
    expect(store.resolveRef("person", "wexlor")).toHaveLength(0);
    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const rows = db.query("SELECT COUNT(*) AS c FROM aliases WHERE node_id = ?").get(ana.id) as { c: number };
    db.close();
    expect(rows.c).toBe(0);
  });

  test("forgetting a survivor lists its merged husks in needsOwner", () => {
    const survivor = store.createNode({ type: "person", title: "Kept One", origin: "owner" });
    // Phase C's merge does this properly; Phase A crafts the husk raw.
    const huskId = ulid(now().getTime()) as NodeId;
    store.close();
    const db = new Database(join(dir, "memory.db"));
    const iso = new Date(T0 + ++tick).toISOString();
    db.query(
      `INSERT INTO nodes (id, type, title, body, status, surfacing, importance, props, origin, author, created, updated)
       VALUES (?, 'person', 'Husk One', 'still holds content', 'merged', 'always', 0, '{}', 'o', '', ?, ?)`,
    ).run(huskId, iso, iso);
    db.query(
      "INSERT INTO edges (id, source, target, type, context, created) VALUES (?, ?, ?, 'merged_into', '', ?)",
    ).run(ulid(now().getTime()), huskId, survivor.id, iso);
    db.close();
    store = Store.open({ dir, now });
    const report = store.forget(survivor.id);
    expect(report.needsOwner).toContain(`husk:${huskId}`);
    expect(store.getNode(huskId).body).toBe("still holds content"); // the husk itself is untouched
  });
});

describe("survivorOf", () => {
  const craftMerged = (title: string, into: NodeId | null): NodeId => {
    const id = ulid(now().getTime()) as NodeId;
    store.close();
    const db = new Database(join(dir, "memory.db"));
    const iso = new Date(T0 + ++tick).toISOString();
    db.query(
      `INSERT INTO nodes (id, type, title, body, status, surfacing, importance, props, origin, author, created, updated)
       VALUES (?, 'person', ?, '', 'merged', 'always', 0, '{}', 'o', '', ?, ?)`,
    ).run(id, title, iso, iso);
    if (into !== null) {
      db.query(
        "INSERT INTO edges (id, source, target, type, context, created) VALUES (?, ?, ?, 'merged_into', '', ?)",
      ).run(ulid(now().getTime()), id, into, iso);
    }
    db.close();
    store = Store.open({ dir, now });
    return id;
  };

  test("walks chains to the living end; non-merged returns itself; cycles never hang", () => {
    const living = store.createNode({ type: "person", title: "Alive", origin: "owner" });
    const husk2 = craftMerged("Husk Two", living.id);
    const husk1 = craftMerged("Husk One", husk2);
    expect(store.survivorOf(husk1).id).toBe(living.id); // two hops
    expect(store.survivorOf(living.id).id).toBe(living.id); // identity on the living
    // corrupt cycle: a → b → a, both merged — must terminate
    const a = craftMerged("Cycle A", null);
    const b = craftMerged("Cycle B", a);
    store.close();
    const db = new Database(join(dir, "memory.db"));
    db.query(
      "INSERT INTO edges (id, source, target, type, context, created) VALUES (?, ?, ?, 'merged_into', '', ?)",
    ).run(ulid(now().getTime()), a, b, new Date(T0 + ++tick).toISOString());
    db.close();
    store = Store.open({ dir, now });
    const end = store.survivorOf(b); // returns a node, does not hang
    expect(["Cycle A", "Cycle B"]).toContain(end.title);
  });
});
