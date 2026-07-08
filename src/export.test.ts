/**
 * export()/Store.restore() (design plans/design/export-restore.md):
 * consent-filtered portability (JSONL/ICS/vCard) and one-command restore.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshStore } from "../test/helpers.ts";
import { Store } from "./store.ts";
import { MemoryError } from "./types.ts";

let dir: string;
let store: Store;
let dispose: () => void;

/** One node of every status × surfacing combination, an edge crossing the
 * never boundary, an owner alias + a merge-derived alias, a history row,
 * and a derivation with both a node source and an opaque host-ref side. */
function buildFixture(s: Store) {
  s.registerType({ name: "memory", bornStatus: "proposed" });
  s.registerType({ name: "note", bornStatus: "active" });
  s.registerType({ name: "person", bornStatus: "active" });

  const pub = s.createNode({ type: "note", title: "Public note", body: "public body", origin: "o" });
  const ask = s.createNode({
    type: "note",
    title: "Ask note",
    body: "ask body",
    origin: "o",
    surfacing: "ask",
  });
  const never = s.createNode({
    type: "note",
    title: "Never note",
    body: "never body",
    origin: "o",
    surfacing: "never",
  });
  const archived = s.createNode({ type: "note", title: "Archived note", body: "archived body", origin: "o" });
  s.transition(archived.id, "archived");
  const quarantined = s.createNode({
    type: "note",
    title: "Quarantined note",
    body: "quarantined body",
    origin: "o",
  });
  s.quarantine(quarantined.id);
  const forgotten = s.createNode({
    type: "note",
    title: "Forgotten note",
    body: "forgotten body",
    origin: "o",
  });
  s.forget(forgotten.id);
  const proposedOut = s.propose({ type: "memory", title: "Proposed memory", body: "", origin: "turn:1" });
  const rejectedOut = s.propose({ type: "memory", title: "Rejected memory", body: "", origin: "turn:2" });
  s.decide(rejectedOut.node.id, { kind: "reject" });

  const survivor = s.createNode({ type: "person", title: "Ana Survivor", origin: "o" });
  const dup = s.createNode({ type: "person", title: "Ana Duplicate", origin: "o" });
  s.decideIdentity(survivor.id, dup.id, "same"); // dup becomes a merged husk; "ana duplicate" folds in as an alias
  s.addAlias(survivor.id, "ana s");

  s.link(pub.id, never.id, "links"); // an edge crossing the never boundary

  s.updateNode(pub.id, { body: "public body, revised" }); // one memory_history row

  s.recordDerivation("host:recap:1", [pub.id]); // node-id source, passes
  s.recordDerivation("host:recap:2", [never.id]); // node-id source, fails by default

  return {
    pub,
    ask,
    never,
    archived,
    quarantined,
    forgotten,
    proposed: proposedOut.node,
    rejected: rejectedOut.node,
    survivor,
    dup,
  };
}

beforeEach(() => {
  ({ store, dir, dispose } = freshStore("bm-export-"));
});

afterEach(() => {
  dispose();
});

/** A fresh scratch directory to hold one test's export target(s). */
function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("export(): JSONL (design §4.1)", () => {
  test("default: never/quarantined ids absent everywhere in the bytes; edges to filtered nodes dropped; counts match line counts", () => {
    const fx = buildFixture(store);
    const out = scratchDir("bm-export-jsonl-");
    const target = join(out, "export.jsonl");
    const report = store.export(target, { format: "jsonl" });
    expect(report.format).toBe("jsonl");

    const raw = readFileSync(target, "utf8");
    for (const excluded of [fx.never.id, fx.quarantined.id, fx.dup.id, fx.proposed.id, fx.rejected.id]) {
      expect(raw.includes(excluded)).toBe(false);
    }

    const lines = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { stream: string; id?: string; source?: string; target?: string });
    const byStream = new Map<string, typeof lines>();
    for (const l of lines) byStream.set(l.stream, [...(byStream.get(l.stream) ?? []), l]);

    // report counts equal actual line counts per stream
    for (const [streamName, count] of Object.entries(report.counts)) {
      expect((byStream.get(streamName) ?? []).length).toBe(count);
    }
    // no history/audit lines by default
    expect(byStream.get("history") ?? []).toHaveLength(0);
    expect(byStream.get("audit") ?? []).toHaveLength(0);

    // no edge touches a filtered-out node on either side
    const edges = byStream.get("edge") ?? [];
    for (const e of edges) {
      expect(e.source).not.toBe(fx.never.id);
      expect(e.target).not.toBe(fx.never.id);
      expect(e.source).not.toBe(fx.quarantined.id);
      expect(e.source).not.toBe(fx.dup.id);
    }

    // the derivation whose source is the never node is excluded by default
    const derivations = byStream.get("derivation") ?? [];
    expect(derivations.some((d) => d.source === fx.never.id)).toBe(false);
    expect(derivations.some((d) => d.source === fx.pub.id)).toBe(true);

    // active/archived/always/ask nodes present
    const nodeIds = new Set((byStream.get("node") ?? []).map((n) => n.id));
    expect(nodeIds.has(fx.pub.id)).toBe(true);
    expect(nodeIds.has(fx.ask.id)).toBe(true);
    expect(nodeIds.has(fx.archived.id)).toBe(true);
    expect(nodeIds.has(fx.survivor.id)).toBe(true);
  });

  test("includeNever surfaces the never node; includeQuarantined surfaces the quarantined node — independently", () => {
    const fx = buildFixture(store);

    const neverOut = join(scratchDir("bm-export-never-"), "export.jsonl");
    const neverReport = store.export(neverOut, { format: "jsonl", includeNever: true });
    const neverRaw = readFileSync(neverOut, "utf8");
    expect(neverRaw.includes(fx.never.id)).toBe(true);
    expect(neverRaw.includes(fx.quarantined.id)).toBe(false); // still off
    expect(neverReport.counts.node).toBeGreaterThan(0);

    const quarOut = join(scratchDir("bm-export-quar-"), "export.jsonl");
    store.export(quarOut, { format: "jsonl", includeQuarantined: true });
    const quarRaw = readFileSync(quarOut, "utf8");
    expect(quarRaw.includes(fx.quarantined.id)).toBe(true);
    expect(quarRaw.includes(fx.never.id)).toBe(false); // still off
  });

  test("includeHistory and includeAuditLog are independent opt-ins, default off", () => {
    buildFixture(store);
    const off = join(scratchDir("bm-export-hoff-"), "export.jsonl");
    const offReport = store.export(off, { format: "jsonl" });
    expect(offReport.counts.history).toBeUndefined();
    expect(offReport.counts.audit).toBeUndefined();

    const on = join(scratchDir("bm-export-hon-"), "export.jsonl");
    const onReport = store.export(on, { format: "jsonl", includeHistory: true, includeAuditLog: true });
    expect(onReport.counts.history).toBeGreaterThan(0); // the updateNode snapshot
    expect(onReport.counts.audit).toBeGreaterThan(0);
  });
});

describe("export(): ICS (design §4.2)", () => {
  test("one VEVENT per when_at node; escaping survives , ; and a newline; archived/ask gated by flags; never is unreachable regardless of flags", () => {
    store.registerType({ name: "note", bornStatus: "active" });
    const title = "Lunch, then; a note\nsecond line";
    store.createNode({
      type: "note",
      title,
      origin: "o",
      when: "2026-08-01T10:00:00.000Z",
    });
    const archivedScheduled = store.createNode({
      type: "note",
      title: "Archived appointment",
      origin: "o",
      when: "2026-08-02T10:00:00.000Z",
    });
    store.transition(archivedScheduled.id, "archived");
    const askScheduled = store.createNode({
      type: "note",
      title: "Ask appointment",
      origin: "o",
      surfacing: "ask",
      when: "2026-08-03T10:00:00.000Z",
    });
    const neverScheduled = store.createNode({
      type: "note",
      title: "Never appointment",
      origin: "o",
      surfacing: "never",
      when: "2026-08-04T10:00:00.000Z",
    });

    const defaultOut = join(scratchDir("bm-export-ics-def-"), "export.ics");
    const defaultReport = store.export(defaultOut, { format: "ics" });
    const defaultRaw = readFileSync(defaultOut, "utf8");
    expect(defaultReport.counts.event).toBe(1);
    expect((defaultRaw.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
    expect(defaultRaw).toContain("Lunch\\, then\\; a note\\nsecond line"); // escaped comma/semicolon/newline
    expect(defaultRaw.includes(archivedScheduled.id)).toBe(false);
    expect(defaultRaw.includes(askScheduled.id)).toBe(false);
    expect(defaultRaw.includes(neverScheduled.id)).toBe(false);

    const widenedOut = join(scratchDir("bm-export-ics-wide-"), "export.ics");
    const widenedReport = store.export(widenedOut, {
      format: "ics",
      includeArchived: true,
      includeAsk: true,
      includeNever: true, // must have NO effect for ICS
    });
    const widenedRaw = readFileSync(widenedOut, "utf8");
    expect(widenedReport.counts.event).toBe(3); // scheduled + archived + ask, never excluded regardless
    expect(widenedRaw.includes(archivedScheduled.id)).toBe(true);
    expect(widenedRaw.includes(askScheduled.id)).toBe(true);
    expect(widenedRaw.includes(neverScheduled.id)).toBe(false); // never truly unreachable
  });

  test("undated nodes never appear, even when active/always", () => {
    store.registerType({ name: "note", bornStatus: "active" });
    store.createNode({ type: "note", title: "No appointment", origin: "o" });
    const out = join(scratchDir("bm-export-ics-undated-"), "export.ics");
    const report = store.export(out, { format: "ics" });
    expect(report.counts.event).toBe(0);
  });
});

describe("export(): vCard (design §4.3)", () => {
  test("person nodes render with aliases (owner + merge-derived); non-person types are absent", () => {
    const fx = buildFixture(store);
    const out = join(scratchDir("bm-export-vcard-"), "export.vcf");
    const report = store.export(out, { format: "vcard" });
    const raw = readFileSync(out, "utf8");

    expect(report.counts.card).toBe(1); // only the survivor — dup is a merged husk, excluded
    expect(raw).toContain("BEGIN:VCARD");
    expect(raw).toContain(`UID:urn:balaur:${fx.survivor.id}`);
    expect(raw).toContain("FN:Ana Survivor");
    expect(raw).toContain("NICKNAME:ana s"); // owner alias
    expect(raw).toContain("NICKNAME:ana duplicate"); // merge-folded alias (source='merge')
    expect(raw.includes("Public note")).toBe(false); // non-person types absent
    expect(raw.includes(fx.dup.id)).toBe(false); // the husk itself gets no card
  });
});

describe("export(): refusals mirror backup()", () => {
  test("in-store target refuses props_invalid; existing target refuses conflict", () => {
    store.registerType({ name: "note", bornStatus: "active" });
    expect(() => store.export(join(dir, "x.jsonl"), { format: "jsonl" })).toThrow(MemoryError);
    try {
      store.export(join(dir, "x.jsonl"), { format: "jsonl" });
    } catch (e) {
      expect((e as MemoryError).code).toBe("props_invalid");
    }

    const out = scratchDir("bm-export-exists-");
    const target = join(out, "taken.jsonl");
    writeFileSync(target, "already here");
    try {
      store.export(target, { format: "jsonl" });
      throw new Error("expected a conflict");
    } catch (e) {
      expect((e as MemoryError).code).toBe("conflict");
    }
  });

  test("a failed write leaves no partial file", () => {
    const nonWritableDir = scratchDir("bm-export-nowrite-");
    const target = join(nonWritableDir, "x.jsonl");
    chmodSync(nonWritableDir, 0o500); // read+execute only
    try {
      expect(() => store.export(target, { format: "jsonl" })).toThrow();
      expect(existsSync(target)).toBe(false);
    } finally {
      chmodSync(nonWritableDir, 0o700);
      rmSync(nonWritableDir, { recursive: true, force: true });
    }
  });
});

describe("export(): audit is content-free (I7)", () => {
  test("exactly one store.export row per successful export; meta carries format+counts, never fixture titles", () => {
    buildFixture(store);
    const out = join(scratchDir("bm-export-audit-"), "export.jsonl");
    store.export(out, { format: "jsonl", includeHistory: true });
    store.close();

    const db = new Database(join(dir, "memory.db"), { readonly: true });
    const rows = db.query("SELECT meta FROM audit_log WHERE action = 'store.export'").all() as {
      meta: string;
    }[];
    const leak = db
      .query(
        "SELECT COUNT(*) AS c FROM audit_log WHERE meta LIKE '%Public note%' OR meta LIKE '%public body%'",
      )
      .get() as { c: number };
    db.close();
    store = Store.open({ dir }); // afterEach symmetry (dispose() closes it)

    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0]?.meta ?? "{}") as Record<string, unknown>;
    expect(meta.format).toBe("jsonl");
    expect(typeof meta.node).toBe("number");
    expect(leak.c).toBe(0);
  });
});

describe("Store.restore() (design §5.2)", () => {
  test("round-trips a real backup: getNode + recall parity", () => {
    const fx = buildFixture(store);
    const backupDir = scratchDir("bm-restore-backup-");
    const backupPath = join(backupDir, `memory-${Date.now()}.db`);
    store.backup(backupPath);

    const restoreDir = scratchDir("bm-restore-target-");
    rmSync(restoreDir, { recursive: true, force: true }); // restore must create it itself
    const restored = Store.restore(backupPath, restoreDir);
    try {
      const original = store.getNode(fx.pub.id);
      const copy = restored.getNode(fx.pub.id);
      expect(copy.title).toBe(original.title);
      expect(copy.body).toBe(original.body);
      expect(restored.recall(["public"]).map((n) => n.id)).toContain(fx.pub.id);

      expect(statSync(restoreDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(restoreDir, "memory.db")).mode & 0o777).toBe(0o600);
    } finally {
      restored.close();
      rmSync(restoreDir, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  test("refuses a missing backup file (not_found)", () => {
    const restoreDir = scratchDir("bm-restore-missing-");
    rmSync(restoreDir, { recursive: true, force: true });
    try {
      Store.restore(join(tmpdir(), "bm-does-not-exist.db"), restoreDir);
      throw new Error("expected not_found");
    } catch (e) {
      expect((e as MemoryError).code).toBe("not_found");
    }
  });

  test("refuses a non-empty target directory (conflict) — an empty or absent dir is fine", () => {
    store.registerType({ name: "note", bornStatus: "active" });
    store.createNode({ type: "note", title: "anything", origin: "o" });
    const backupDir = scratchDir("bm-restore-conflict-backup-");
    const backupPath = join(backupDir, "memory.db");
    store.backup(backupPath);

    const occupied = scratchDir("bm-restore-occupied-");
    writeFileSync(join(occupied, "stray-file.txt"), "already here");
    try {
      Store.restore(backupPath, occupied);
      throw new Error("expected conflict");
    } catch (e) {
      expect((e as MemoryError).code).toBe("conflict");
    } finally {
      rmSync(occupied, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  test("throws on a corrupted copy — integrity_check failure, never the fixture", () => {
    store.registerType({ name: "note", bornStatus: "active" });
    for (let i = 0; i < 60; i++) {
      store.createNode({
        type: "note",
        title: `Filler ${i}`,
        body: `padding body text to grow the file ${i} `.repeat(20),
        origin: "o",
      });
    }
    const backupDir = scratchDir("bm-restore-corrupt-backup-");
    const backupPath = join(backupDir, "memory.db");
    store.backup(backupPath);

    // corrupt a COPY of the backup, never the backup itself or the fixture.
    // Offset chosen empirically (scratch probe): byte-flips well past the
    // schema pages so Store.open()/rebuildIndex() still succeed, but land
    // on a btree page PRAGMA integrity_check's full scan does catch.
    const corruptCopy = join(backupDir, "corrupt-copy.db");
    const bytes = readFileSync(backupPath);
    const corrupted = Buffer.from(bytes);
    const start = Math.floor(corrupted.length * 0.65);
    for (let i = start; i < start + 500 && i < corrupted.length; i++) corrupted[i] = 0xff;
    writeFileSync(corruptCopy, corrupted);

    const restoreDir = scratchDir("bm-restore-corrupt-target-");
    rmSync(restoreDir, { recursive: true, force: true });
    try {
      Store.restore(corruptCopy, restoreDir);
      throw new Error("expected a corruption throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MemoryError);
      expect((e as MemoryError).code).toBe("conflict");
      expect((e as MemoryError).message).toContain("integrity_check");
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }

    // the original backup (never touched) still restores cleanly
    const cleanDir = scratchDir("bm-restore-clean-");
    rmSync(cleanDir, { recursive: true, force: true });
    const clean = Store.restore(backupPath, cleanDir);
    clean.close();
    rmSync(cleanDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  });
});
