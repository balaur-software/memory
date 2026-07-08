import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosine } from "./indexdb/vectors.ts";
import { termsFromText } from "./recall.ts";
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
  dir = mkdtempSync(join(tmpdir(), "bm-recall-"));
  tick = 0;
  store = Store.open({ dir, now });
  store.registerType({ name: "note", bornStatus: "active" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("termsFromText", () => {
  test("drops stopwords in both languages, keeps salient tokens", () => {
    const t = termsFromText("tell me everything about the marathon training");
    expect(t).toContain("marathon");
    expect(t).toContain("training");
    expect(t).not.toContain("everything");
    expect(t).not.toContain("about");
    const ro = termsFromText("vreau ceva despre alergare maine");
    expect(ro).toContain("alergare");
    expect(ro).not.toContain("despre");
  });

  test("proper nouns are kept even when short, first word is not a proper noun", () => {
    const t = termsFromText("I met Ana at the Q3 review");
    expect(t).toContain("Ana");
    expect(t).toContain("Q3");
    expect(t[0]).toBe("Ana"); // proper nouns rank first
    expect(termsFromText("Tomorrow we ride")).not.toContain("Tomorrow");
  });

  test("carries up to two terms from the prior turn, deduped, capped at six", () => {
    const t = termsFromText("should I call her back", ["how is my sister Ana doing after Brasov"]);
    expect(t).toContain("call");
    expect(t).toContain("Ana"); // carryover
    expect(t.length).toBeLessThanOrEqual(6);
    const dedup = termsFromText("Ana called again", ["Ana said hello"]);
    expect(dedup.filter((x) => x.toLowerCase() === "ana")).toHaveLength(1);
  });
});

describe("recall: I2 surfacing semantics", () => {
  test("ambient recall = active + always; ask only when the title is named; never unreachable", () => {
    store.createNode({ type: "note", title: "Alpine trip", body: "the zaffre mountains", origin: "t" });
    const ask = store.createNode({ type: "note", title: "Zaffre ledger", body: "numbers", origin: "t" });
    store.setSurfacing(ask.id, "ask");
    const askHidden = store.createNode({
      type: "note",
      title: "Hidden thing",
      body: "zaffre secrets",
      origin: "t",
    });
    store.setSurfacing(askHidden.id, "ask");
    const never = store.createNode({ type: "note", title: "Zaffre vault", body: "zaffre", origin: "t" });
    store.setSurfacing(never.id, "never");
    const archived = store.createNode({ type: "note", title: "Old zaffre", body: "zaffre", origin: "t" });
    store.transition(archived.id, "archived");

    const titles = store.recall(["zaffre"]).map((n) => n.title);
    expect(titles).toContain("Alpine trip");
    expect(titles).toContain("Zaffre ledger"); // ask, named in title
    expect(titles).not.toContain("Hidden thing"); // ask, body-only match
    expect(titles).not.toContain("Zaffre vault"); // never
    expect(titles).not.toContain("Old zaffre"); // archived
  });

  test("type filter narrows recall; search is cross-type", () => {
    store.registerType({ name: "person", bornStatus: "active" });
    store.createNode({ type: "note", title: "Vermeil note", origin: "t" });
    store.createNode({ type: "person", title: "Vermeil person", origin: "t" });
    expect(store.recall(["vermeil"], { type: "person" }).map((n) => n.title)).toEqual(["Vermeil person"]);
    expect(
      store
        .search(["vermeil"])
        .map((n) => n.title)
        .sort(),
    ).toEqual(["Vermeil note", "Vermeil person"]);
  });
});

describe("recall: candidate cap starvation (plan 007)", () => {
  test("60 never-surfaced matches don't starve the candidate cap; the 1 eligible match still surfaces", () => {
    for (let i = 0; i < 60; i++) {
      const decoy = store.createNode({
        type: "note",
        title: `Zebra decoy ${i}`,
        body: "zebra",
        origin: "t",
      });
      store.setSurfacing(decoy.id, "never");
    }
    const eligible = store.createNode({
      type: "note",
      title: "Zebra migration notes",
      body: "zebra",
      origin: "t",
    });
    const titles = store.recall(["zebra"], { limit: 1 }).map((n) => n.title);
    expect(titles).toEqual(["Zebra migration notes"]);
    expect(eligible.surfacing).toBe("always");
  });

  test("setSurfacing flip is reflected in recall immediately, both directions, without rebuildIndex()", () => {
    const n = store.createNode({ type: "note", title: "Flip candidate", body: "quokka", origin: "t" });
    expect(store.recall(["quokka"]).map((x) => x.id)).toContain(n.id);
    store.setSurfacing(n.id, "never");
    expect(store.recall(["quokka"]).map((x) => x.id)).not.toContain(n.id);
    store.setSurfacing(n.id, "always");
    expect(store.recall(["quokka"]).map((x) => x.id)).toContain(n.id);
  });
});

describe("recall: index.db self-heal (plan 007)", () => {
  test("an old 5-column nodes_fts (pre-surfacing) self-heals on open: recall works, column exists", () => {
    const n = store.createNode({ type: "note", title: "Heals fine", body: "quartzite", origin: "t" });
    store.close();

    const idx = new Database(join(dir, "index.db"));
    idx.exec("DROP TABLE nodes_fts;");
    idx.exec(
      "CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, kind UNINDEXED, title, content, extra);",
    );
    idx.close();

    store = Store.open({ dir, now }); // must not throw; must self-heal

    const check = new Database(join(dir, "index.db"), { readonly: true });
    const cols = check.query("SELECT name FROM pragma_table_info('nodes_fts')").all() as { name: string }[];
    check.close();
    expect(cols.some((c) => c.name === "surfacing")).toBe(true);

    expect(store.recall(["quartzite"]).map((x) => x.id)).toContain(n.id);
  });
});

describe("recall: the ranking blend", () => {
  test("reinforcement + freshness outrank a dormant equal match", () => {
    const a = store.createNode({ type: "note", title: "Cobalt plan A", body: "cobalt", origin: "t" });
    const b = store.createNode({ type: "note", title: "Cobalt plan B", body: "cobalt", origin: "t" });
    days(120);
    store.touch(b.id);
    store.touch(b.id);
    store.touch(b.id);
    const titles = store.recall(["cobalt"]).map((n) => n.title);
    expect(titles[0]).toBe("Cobalt plan B");
    expect(titles).toContain("Cobalt plan A"); // decayed, never erased (floor)
    expect(a.id).not.toBe(b.id);
  });

  test("importance boosts and slows decay", () => {
    store.createNode({ type: "note", title: "Umber low", body: "umber", origin: "t", importance: 0 });
    store.createNode({ type: "note", title: "Umber high", body: "umber", origin: "t", importance: 5 });
    days(200);
    const titles = store.recall(["umber"]).map((n) => n.title);
    expect(titles[0]).toBe("Umber high");
  });
});

describe("deadlines: the props.due window (task-arc plan 018)", () => {
  test("half-open window, order, type filter, limit, and I2 off the board; malformed due never surfaces", () => {
    store.registerType({ name: "task", bornStatus: "active" });
    const at = (title: string, due: string, type = "note") =>
      store.createNode({ type, title, props: { due }, origin: "o" });
    at("At from", "2026-07-06T00:00:00.000Z");
    at("Mid week", "2026-07-08T10:00:00.000Z");
    at("At to", "2026-07-13T00:00:00.000Z"); // exactly `to` — excluded (half-open)
    const ask = at("Ask me", "2026-07-07T09:00:00.000Z");
    store.setSurfacing(ask.id, "ask");
    const never = store.createNode({
      type: "note",
      title: "Never me",
      props: { due: "2026-07-07T10:00:00.000Z" },
      surfacing: "never",
      origin: "o",
    });
    const archived = at("Archived", "2026-07-09T10:00:00.000Z");
    store.transition(archived.id, "archived");
    const malformed = at("Malformed", "next week");
    at("Taskish", "2026-07-10T10:00:00.000Z", "task"); // owner-born on a different type

    const week = store.deadlines("2026-07-06", "2026-07-13");
    expect(week.map((n) => n.title)).toEqual(["At from", "Mid week", "Taskish"]);
    expect(never.props["due"]).toBe("2026-07-07T10:00:00.000Z"); // stored fine — just never surfaced
    expect(week.map((n) => n.title)).not.toContain(malformed.title); // the documented cost of the convention

    expect(store.deadlines("2026-07-06", "2026-07-13", { type: "task" }).map((n) => n.title)).toEqual([
      "Taskish",
    ]);
    expect(store.deadlines("2026-07-06", "2026-07-13", { limit: 1 }).map((n) => n.title)).toEqual([
      "At from",
    ]);
    expect(() => store.deadlines("2026-07-13", "2026-07-06")).toThrow("after");
    expect(() => store.deadlines("garbage", "2026-07-13")).toThrow("ISO-8601");
    expect(() => store.deadlines("2026-07-06", "2026-07-13", { limit: 0 })).toThrow("positive");
  });

  test("deadlines and agenda are parallel, independent axes on the same node", () => {
    const n = store.createNode({
      type: "note",
      title: "Do Saturday, due the 15th",
      when: "2026-07-11T00:00:00.000Z",
      props: { due: "2026-07-15T00:00:00.000Z" },
      origin: "o",
    });
    expect(store.agenda("2026-07-11", "2026-07-12").map((x) => x.id)).toContain(n.id);
    expect(store.deadlines("2026-07-11", "2026-07-12").map((x) => x.id)).not.toContain(n.id); // do-week, not due-week
    expect(store.deadlines("2026-07-15", "2026-07-16").map((x) => x.id)).toContain(n.id);
  });
});

describe("episode: statuses option (task-arc plan 018, design §3.3)", () => {
  test("default active-only; explicit statuses widen to non-active outcomes; validation mirrors children()", () => {
    const archived = store.createNode({ type: "note", title: "Filed report", origin: "o" });
    store.updateNode(archived.id, { propsPatch: { outcome: "done" } });
    store.transition(archived.id, "archived");
    const active = store.createNode({ type: "note", title: "Still open", origin: "o" });

    const defaultWindow = store.episode("2026-07-05", "2026-07-06");
    expect(defaultWindow.map((n) => n.title)).not.toContain("Filed report");
    expect(defaultWindow.map((n) => n.title)).toContain("Still open");
    expect(active.id).not.toBe(archived.id);

    const widened = store.episode("2026-07-05", "2026-07-06", { statuses: ["archived"] });
    expect(widened.map((n) => n.title)).toEqual(["Filed report"]);

    const both = store.episode("2026-07-05", "2026-07-06", { statuses: ["active", "archived"] });
    expect(both.map((n) => n.title).sort()).toEqual(["Filed report", "Still open"]);

    expect(() => store.episode("2026-07-05", "2026-07-06", { statuses: [] })).toThrow("cannot be empty");
    expect(() => store.episode("2026-07-05", "2026-07-06", { statuses: ["bogus" as never] })).toThrow(
      "unknown status",
    );
  });
});

describe("recall: vector fusion (vectors in, never models)", () => {
  const model = "test-embed-v1";
  const vec = (...xs: number[]) => new Float32Array(xs);

  test("cosine known answers", () => {
    expect(cosine(vec(1, 0), vec(1, 0))).toBeCloseTo(1);
    expect(cosine(vec(1, 0), vec(0, 1))).toBeCloseTo(0);
    expect(cosine(vec(1, 0), vec(-1, 0))).toBeCloseTo(-1);
    expect(cosine(vec(1, 0), vec(1, 0, 0))).toBeNull(); // dim mismatch
    expect(cosine(vec(0, 0), vec(1, 0))).toBeNull(); // zero vector
  });

  test("a query vector pulls in semantic matches the terms missed; RRF fuses", () => {
    const lex = store.createNode({ type: "note", title: "Sepia journal", body: "sepia", origin: "t" });
    const sem = store.createNode({
      type: "note",
      title: "Burnout week",
      body: "exhausted after launch",
      origin: "t",
    });
    store.putVector(lex.id, model, vec(1, 0, 0));
    store.putVector(sem.id, model, vec(0.1, 0.99, 0));
    const titles = store.recall(["sepia"], { queryVector: vec(0, 1, 0), model }).map((n) => n.title);
    expect(titles).toContain("Sepia journal"); // lexical hit
    expect(titles).toContain("Burnout week"); // vector-only hit
  });

  test("vector spaces never mix, and ask nodes are not vector-reachable (I2)", () => {
    const other = store.createNode({ type: "note", title: "Other space", body: "x", origin: "t" });
    store.putVector(other.id, "different-model", vec(0, 1, 0));
    const ask = store.createNode({ type: "note", title: "Quiet one", body: "y", origin: "t" });
    store.setSurfacing(ask.id, "ask");
    store.putVector(ask.id, model, vec(0, 1, 0));
    const titles = store.recall([], { queryVector: vec(0, 1, 0), model }).map((n) => n.title);
    expect(titles).not.toContain("Other space");
    expect(titles).not.toContain("Quiet one");
  });

  test("deleteVectors clears a space", () => {
    const n = store.createNode({ type: "note", title: "Gone", body: "z", origin: "t" });
    store.putVector(n.id, model, vec(0, 1));
    store.deleteVectors(model);
    expect(store.recall([], { queryVector: vec(0, 1), model })).toHaveLength(0);
  });
});
