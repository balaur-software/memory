# Plan 006: Make migrations crash-safe and prove the legacy upgrade path with real fixtures

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- src/storage/schema.ts src/temporal.test.ts src/perpetuity.test.ts test/fixtures docs/SCHEMA.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW–MED
- **Depends on**: plans/001-arm-the-gates.md
- **Category**: bug / migration
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

This project's whole bet is that `memory.db` outlives everything
(ADR-0001: "the schema is the 40-year contract"). The migration runner is
the single riskiest moment in that file's life, and today it can brick it:

1. **Not transactional, not idempotent.** `migrateMemoryDb` execs each
   version delta then bumps `schema_version` in separate statements with no
   enclosing transaction. `ALTER TABLE ... ADD COLUMN` (V3, V4) is not
   idempotent — if the process dies after an ALTER but before the version
   bump, every subsequent open re-runs the delta and fails forever with
   `duplicate column name`. The same window exists on the fresh-create path
   (V2→V3→V4 exec'd before the version row is inserted).
2. **The v1→v2 leg has never executed.** The only in-place upgrade test
   (`src/temporal.test.ts:123-148`) synthesizes an "old" db by dropping v3/v4
   columns from a modern one and winds back to `'2'`; nothing tests
   `schema_version = '1'`, and no committed fixture db exists
   (`find test -name '*.db'` → nothing).

SQLite DDL is fully transactional, so wrapping each delta+bump in one
transaction is safe and cheap.

## Current state

- `src/storage/schema.ts:163-200` — the runner:
  ```ts
  export function migrateMemoryDb(db: SqlDb, now: () => Date): void {
    db.exec(MEMORY_DDL);
    const version = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
    if (version === null) {
      db.exec(V2_DDL);
      db.exec(V3_DDL);
      db.exec(V4_DDL);
      const at = now().toISOString();
      db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
      ...
    }
    const v = Number(version.value);
    if (Number.isNaN(v) || v > SCHEMA_VERSION) throw new MemoryError("conflict", ...)
    if (v < 2) { db.exec(V2_DDL); db.run("UPDATE meta SET value = '2' ..."); }
    if (v < 3) { db.exec(V3_DDL); db.run("UPDATE meta SET value = '3' ..."); }
    if (v < 4) { db.exec(V4_DDL); db.run("UPDATE meta SET value = '4' ..."); }
  }
  ```
- `V3_DDL` (`schema.ts:131-147`) starts with two non-idempotent ALTERs
  (`edges ADD COLUMN valid_from/valid_until`); `V4_DDL` (`schema.ts:154-158`)
  has two more (`nodes/memory_history ADD COLUMN when_at`). `V2_DDL` is all
  `CREATE TABLE IF NOT EXISTS` (idempotent).
- The adapter (`src/storage/adapter.ts`) exposes
  `transaction<T>(fn: () => T): T`; the bun implementation
  (`src/storage/bun.ts:26-36`) has a re-entrancy guard, so nesting inside a
  caller's transaction is safe. NOTE: `PRAGMA journal_mode = WAL` (first
  line of `MEMORY_DDL`) cannot run inside a transaction — the baseline
  `db.exec(MEMORY_DDL)` must stay OUTSIDE the wrap; only the version deltas
  + bumps go inside.
- File-header rule (`schema.ts:1-5`): "Never edit an applied migration;
  append and bump SCHEMA_VERSION." Wrapping execution is allowed — the DDL
  strings themselves must not change.
- The doc contract: `docs/SCHEMA.md` describes versions v2/v3/v4 (§"Version
  2/3/4" headings). Fixture generation below derives historical DDL from
  those sections, not from guesses.
- Existing tests to keep green: `src/temporal.test.ts:123-148` ("an older
  store upgrades in place through every delta"), `src/perpetuity.test.ts:58-74`
  (future-file guard A3).

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Suites    | `bun test src/temporal.test.ts src/perpetuity.test.ts` | all pass |

## Scope

**In scope**:
- `src/storage/schema.ts` (wrap deltas in transactions — no DDL string edits)
- `test/fixtures/` (create: committed legacy fixture dbs + generator script)
- `src/perpetuity.test.ts` (new upgrade + crash-recovery tests)

**Out of scope** (do NOT touch):
- The DDL constants themselves (`MEMORY_DDL`, `V2_DDL`, `V3_DDL`, `V4_DDL`)
  — never edit an applied migration.
- Adding new schema (indexes etc.) — recorded separately; a v5 is not this
  plan.
- `src/storage/bun.ts` — the adapter is correct as-is.

## Git workflow

- Branch: `advisor/006-migration-durability`
- Suggested commit: `fix(storage): transactional migration deltas + committed legacy fixtures (v1→v4 proven)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Wrap each delta + its version bump atomically

Rework the body of `migrateMemoryDb` (keeping `db.exec(MEMORY_DDL)` first,
outside any transaction, because of the WAL pragma):

```ts
db.exec(MEMORY_DDL);
const version = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
if (version === null) {
  db.transaction(() => {
    db.exec(V2_DDL);
    db.exec(V3_DDL);
    db.exec(V4_DDL);
    const at = now().toISOString();
    db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    db.run("INSERT INTO meta (key, value) VALUES ('store_id', ?)", [ulid(now().getTime())]);
    db.run("INSERT INTO meta (key, value) VALUES ('created', ?)", [at]);
  });
  return;
}
const v = Number(version.value);
if (Number.isNaN(v) || v > SCHEMA_VERSION) throw new MemoryError("conflict", /* keep existing message verbatim */);
if (v < 2) db.transaction(() => { db.exec(V2_DDL); db.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'"); });
if (v < 3) db.transaction(() => { db.exec(V3_DDL); db.run("UPDATE meta SET value = '3' WHERE key = 'schema_version'"); });
if (v < 4) db.transaction(() => { db.exec(V4_DDL); db.run("UPDATE meta SET value = '4' WHERE key = 'schema_version'"); });
```

Keep the existing forward-compat guard comment block (schema.ts:176-183)
verbatim above the guard. Keep the doc comment on the function, adding one
sentence: "Each delta and its version bump commit atomically — a crash
between them can no longer strand a half-migrated file."

**Verify**: `bun test` → all pass (155 at planning time; count may differ
if plan 002 landed — all green is the criterion).

### Step 2: Commit real legacy fixtures + their generator

Create `test/fixtures/make-fixtures.ts` — a script (never run in CI) that
builds each historical file shape from the DDL as documented in
`docs/SCHEMA.md`'s version sections, with a handful of rows (one node type,
two nodes, one edge, one audit row) and `schema_version` set to `'1'` /
`'2'` / `'3'` respectively. v1 = MEMORY_DDL's tables only (no aliases /
identity_pending / memory_history / validity columns / when_at). Derive
each shape by string-editing the CURRENT constants at runtime is NOT
acceptable — write the historical DDL explicitly in the script with a
comment naming the SCHEMA.md section each shape came from.

Run it once; commit the resulting `test/fixtures/v1.db`,
`test/fixtures/v2.db`, `test/fixtures/v3.db` (a few KB each). NOTE:
`.gitignore` contains `*.db` — add a negation line to `.gitignore`:

```
!test/fixtures/*.db
```

**Verify**: `git status` shows the three .db files as addable;
`git check-ignore test/fixtures/v1.db` → exits 1 (not ignored).

### Step 3: Fixture upgrade tests

In `src/perpetuity.test.ts`, add (copying each fixture to a temp dir first —
never open a committed fixture in place):

1. **v1→current**: copy `v1.db` → temp dir as `memory.db`; `Store.open`
   succeeds; `schema_version` = `'4'` (read raw); pre-existing node
   round-trips via `getNode`; a v3 feature works (link with validity); a v4
   feature works (`createNode` with `when`).
2. **v2→current** and **v3→current**: same shape, asserting the data
   written by the generator survives.
3. **Crash-recovery regression** (the bug this plan fixes): copy `v2.db`;
   simulate the historical failure by applying V3's first ALTER only
   (`ALTER TABLE edges ADD COLUMN valid_from TEXT` via raw `bun:sqlite`)
   while leaving `schema_version='2'` — this is exactly the on-disk state a
   pre-fix crash left behind. `Store.open` must now still fail (the delta
   isn't idempotent and this plan doesn't claim repair) — BUT assert the
   failure is the SQLite duplicate-column error, and add a second variant:
   with the fix, a crash cannot CREATE this state, so also test the fix
   directly — wrap: open a store on `v2.db` with an `openDb` shim whose
   `run` throws on the `UPDATE meta SET value = '3'` statement; assert
   after the failed open that the file still opens cleanly on a second,
   un-shimmed attempt (the transaction rolled the ALTER back). Use
   `StoreOptions.openDb` (`src/store.ts:40-41`) to inject the shim around
   `openBunDb`.

**Verify**: `bun test src/perpetuity.test.ts` → all pass, including the
rollback test proving a mid-delta failure leaves the file re-openable.

## Test plan

Steps 2–3: three fixture upgrade tests + one injected-failure rollback
test. Existing temporal/perpetuity migration tests stay untouched and
green. Full `bun run check` green.

## Done criteria

- [ ] `grep -c "db.transaction" src/storage/schema.ts` → 4 (fresh path + 3 deltas)
- [ ] DDL constants unchanged: `git diff 9182b14..HEAD -- src/storage/schema.ts | grep -c "^[-+].*ALTER TABLE"` → 0
- [ ] `test/fixtures/v1.db`, `v2.db`, `v3.db` committed; generator script present
- [ ] New tests pass; `bun run check` exits 0
- [ ] The rollback test fails if Step 1's transactions are reverted (verify
      once locally by stashing Step 1; then restore)
- [ ] `git status` clean outside in-scope paths
- [ ] `plans/README.md` status row updated

## STOP conditions

- `PRAGMA journal_mode = WAL` errors inside the new structure (would mean
  the pragma ended up inside a transaction — re-check Step 1's placement).
- The historical DDL for v1 cannot be reconstructed from `docs/SCHEMA.md`'s
  version sections unambiguously — report what's missing rather than
  guessing a shape.
- Any existing migration test fails after Step 1 (drift or a semantics
  change you didn't intend).

## Maintenance notes

- Every FUTURE delta (v5+) must follow the same shape: one
  `db.transaction()` wrapping delta + bump. Add that sentence to the
  file-header rule when a v5 lands.
- The fixture generator is the canonical way to add a new legacy fixture
  when v5 ships (v4.db then joins the set).
- Reviewer scrutiny: the injected-failure test's shim — it must throw on
  the version-bump UPDATE only, not on every `run`, or the test proves
  nothing.
