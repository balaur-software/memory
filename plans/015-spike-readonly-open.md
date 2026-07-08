# Plan 015: Design spike — a read-only open mode for the second-app pattern

> **Executor instructions**: This is a DESIGN SPIKE — deliverable is a
> design doc + a working probe, no production changes. Follow the steps;
> on a STOP condition, stop and report. When done, update the status row
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- src/store.ts src/contract.ts src/storage/adapter.ts src/storage/bun.ts docs/DESIGN.md docs/HOSTING.md`
> On drift, re-read before designing.

## Status

- **Priority**: P3
- **Effort**: S–M (spike)
- **Risk**: LOW (no code changes; the DESIGN under study is MED — mode
  drift risks)
- **Depends on**: none
- **Category**: direction / design
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

The docs call concurrent readers "the designed-for case": DESIGN.md's
concurrency section — "memory.db runs WAL so external processes may read
concurrently (any external tool mounting the file read-only … is the
designed-for case)" — and HOSTING.md §3 instructs hosts: "Open your own
read-only connection for this … analytics never goes through the Store's
writer." But the API cannot express it: `StoreOptions` offers only the
full writer, so a TypeScript host must import `bun:sqlite` itself —
re-piercing the one-file containment seam ADR-0001 exists to protect. The
repo's own net-worth probe (`src/ergonomics.test.ts:133-148`, commit
9182b14) hand-rolled a `children()` + JS reduce precisely because the
blessed SQL path has no in-library door.

## Current state (read before designing)

- `src/store.ts:52-86` — `Store.open`: migrates memory.db (a WRITE),
  self-heals index.db (writes), inserts the `day` type row (a write) —
  three reasons a naive `readonly: true` flag on `open` would break.
- `src/storage/adapter.ts` — `OpenDb = (path: string) => SqlDb`; no mode
  parameter.
- `src/storage/bun.ts:9-10` — `new Database(path, { create: true })`;
  bun:sqlite supports `{ readonly: true }`.
- `src/contract.ts` — the full contract; the read-verb subset a
  `ReadStoreContract` would carry: `getNode`, `children`, `history`,
  `neighborhood`, `recall`, `search`, `agenda`, `episode`, `resolveRef`,
  `survivorOf`, `aliasesOf`, `entityContext`, `pendingQueue`,
  `conflictsFor`, `staleDerivations`, `doctor`. Traps to decide
  deliberately:
  - `touch()` — looks like a read-adjacent verb, IS a write (excluded).
  - `dayAnchor()` — get-OR-CREATE (excluded, or read-only variant that
    throws not_found).
  - `recall()` — pure read of both files BUT the FTS universe lives in
    index.db: a reader opening a store whose index.db is stale/absent
    must NOT rebuild (that's a write) — define behavior (open index.db
    readonly; absent index → lexical recall returns empty? or throw a
    typed error telling the host to run rebuildIndex via the writer?).
  - `doctor()` — runs `PRAGMA integrity_check` (read-only) — fine.
  - Migration guard: a reader must REFUSE (not migrate) a
    lower-than-current schema_version file, and refuse a future one —
    the same guard, different action (read-only never migrates).
- I14 (single writer) — readers were always allowed; this feature makes
  the rule easier to keep, not harder.
- WAL subtlety worth probing: a purely read-only SQLite connection to a
  WAL database needs the `-shm` file; when NO writer has the db open and
  the `-shm`/`-wal` don't exist, readonly open of a WAL db works (SQLite
  opens it read-only without recovery IF the db was cleanly checkpointed;
  otherwise it may fail with SQLITE_READONLY_RECOVERY). Probe this
  concretely with bun:sqlite — it determines whether `openReadOnly`
  needs a documented "the writer must have checkpointed" caveat.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Probes    | `bun <script>.ts` in /tmp scratch | probe output |
| Gate      | `bun run check`      | exit 0 (tree untouched) |

## Scope

**In scope**: `plans/design/readonly-open.md` (create), probe scripts.

**Out of scope**: any production change; SQL passthrough APIs ("no query
builder" stays decided — this exposes existing verbs only).

## Steps

### Step 1: Probe the mechanics

Scratch-dir probes with `bun:sqlite` directly (allowed in probes):
1. Reader while writer open: writer `Store.open` + writes; second process
   (or second Database handle `{readonly: true}`) reads concurrently →
   works? sees committed rows?
2. Reader with NO writer, after clean close → readonly open works?
3. Reader with NO writer, after a KILLED writer (WAL left dirty — simulate
   by copying db+wal mid-session) → SQLITE_READONLY_RECOVERY? Document
   the exact error.
4. Absent index.db + readonly → what should recall do (design input).

### Step 2: Design the API

Write up (with signatures) the recommended shape:

- `Store.openReadOnly(opts: { dir, now?, openDb? }): ReadStore` — separate
  narrow interface (NOT a boolean on `open` — mode-switching in one class
  invites drift; a `ReadStoreContract` makes the compiler enforce verb
  membership, the same trick `Store implements StoreContract` already
  uses).
- `OpenDb` gains a mode: `(path, opts?: { readonly?: boolean })` —
  adapter-interface change, one implementation site (`bun.ts`).
- Semantics table for every trap in "Current state": migration guard
  (refuse, message points at the writer), day-type insert (skipped),
  index self-heal (skipped; absent/mismatched index → the designed
  behavior from probe 4), `touch`/`dayAnchor`/`rebuildIndex`/every write
  verb (absent from the interface — compiler-enforced).
- Doc changes: DESIGN.md concurrency section + HOSTING.md §3/§11 rewritten
  onto the new door.
- Conformance: which scenarios a `readNothingChanged` harness needs (open
  RO, run reads, byte-compare both files after — proving RO means RO).

### Step 3: The deliverable

`plans/design/readonly-open.md`: probe results (1-4 with exact errors),
the API sketch, the semantics table, migration-guard wording, conformance
sketch, effort estimate for the build plan, and the owner-decision list
(e.g. "absent index.db under RO: empty recall vs typed error — recommend
typed error `conflict` with a rebuild pointer").

**Verify**: doc exists; `bun run check` exit 0; tree untouched.

## Done criteria

- [ ] `plans/design/readonly-open.md` with probes, API, semantics table,
      owner-decision list
- [ ] No changes outside `plans/` (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Probe 1 shows concurrent read is broken at the bun:sqlite level (would
  contradict DESIGN.md's WAL claim — bug finding first, report).

## Maintenance notes

- If built, `ReadStoreContract` becomes the natural export for plan 016's
  export verbs (exports are pure reads) — note the composition in the
  design doc.
