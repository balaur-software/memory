# Plan 003: Create the store directory (0700) and make every data file 0600

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- src/store.ts src/hardening.test.ts docs/SCHEMA.md docs/HOSTING.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-arm-the-gates.md. Plan 002 (CLI removal) is
  assumed landed; if `cli/` still exists, see STOP conditions.
- **Category**: security (+ fixes a probe-confirmed API bug)
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

Two probe-confirmed problems, one fix site:

1. **`Store.open` does not create the directory it promises.** The docstring
   at `src/store.ts:36-37` says "(created if absent)" and the README
   quickstart relies on it, but opening with a missing dir throws a raw
   `Error: unable to open database file`. (The deleted CLI used to paper
   over this with its own `mkdirSync`.)
2. **A life's most private data is world-readable.** Files are created with
   SQLite's default 0644 (`memory.db`, `index.db`, WAL/SHM) and backups
   inherit the same; a probe confirmed `-rw-r--r--` on all of them and 0775
   on a default-umask directory. On any multi-user machine every local
   account can read the record — including pre-checkpoint WAL content of
   "forgotten" memories.

After this plan: `Store.open({dir})` creates the directory 0700 when absent,
chmods every store file to 0600 after open, and `backup()` chmods its output
to 0600.

## Current state

- `src/store.ts:8` — current fs imports:
  ```ts
  import { existsSync, rmSync } from "node:fs";
  ```
- `src/store.ts:35-42` — the docstring making the (currently false) promise:
  ```ts
  export interface StoreOptions {
    /** Directory holding memory.db and index.db (created if absent). */
    readonly dir: string;
  ```
- `src/store.ts:52-56` — `Store.open` begins:
  ```ts
  static open(opts: StoreOptions): Store {
    const now = opts.now ?? (() => new Date());
    const openDb = opts.openDb ?? openBunDb;
    const mem = openDb(join(opts.dir, "memory.db"));
    migrateMemoryDb(mem, now);
  ```
- `src/store.ts:316-322` — `backup()`:
  ```ts
  backup(toPath: string): void {
    const ctx = this.guard();
    if (existsSync(toPath))
      throw new MemoryError("conflict", "backup target already exists — backups never overwrite");
    ctx.mem.run("VACUUM INTO ?", [toPath]);
    spine.audit(ctx, "owner", "store.backup", "", true, {});
  }
  ```
- SQLite creates `-wal`/`-shm` siblings lazily on first write, copying the
  main db file's permissions — so chmodding `memory.db`/`index.db` right
  after open (before any writes besides migration) covers the siblings;
  chmod the siblings too when they already exist (reopened store).
- Conventions: single-class Store, mutations through choke points, throw
  `MemoryError` for broken invariants (`docs/CODING.md`). Tests inject the
  clock and use `mkdtempSync` temp dirs — see the fixture at
  `src/hardening.test.ts:9-26` for the pattern to copy.
- `docs/HOSTING.md` §10 (Backup) tells hosts to back up daily — mention the
  0600 guarantee there.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| One suite | `bun test src/hardening.test.ts` | all pass |

## Scope

**In scope**:
- `src/store.ts`
- `src/hardening.test.ts` (add tests)
- `docs/SCHEMA.md` ("Backup and restore" section — one sentence on modes)
- `docs/HOSTING.md` (§10 — one sentence on modes)

**Out of scope** (do NOT touch):
- `src/storage/bun.ts` — the adapter stays a pure SQLite seam; permissions
  are Store-level policy, not adapter behavior.
- `PRAGMA secure_delete` / WAL checkpointing — that is plan 004.
- Windows ACL semantics — `chmodSync` is a no-op on Windows; acceptable,
  note it in the docs sentence.

## Git workflow

- Branch: `advisor/003-private-files-by-default`
- Suggested commit: `fix(store): create dir 0700, chmod store files and backups 0600`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the directory and tighten modes in `Store.open`

In `src/store.ts`, extend the fs import:

```ts
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
```

At the very top of `Store.open` (before `openDb(join(opts.dir, "memory.db"))`):

```ts
mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
```

(`mkdirSync` with `recursive: true` is a no-op when the dir exists — an
existing directory's mode is deliberately NOT changed; only newly created
dirs get 0700.)

After BOTH databases are open and migrated (i.e. just before the
`new Store({...})` construction at `src/store.ts:73`), add:

```ts
// A life's record is private by default: 0600 on every store file the
// process owns. -wal/-shm inherit the main file's mode when SQLite
// creates them; chmod existing ones for stores created before this rule.
for (const f of ["memory.db", "index.db"]) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = join(opts.dir, f + suffix);
    if (existsSync(p)) chmodSync(p, 0o600);
  }
}
```

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 2: Chmod backup output

In `backup()`, after the `VACUUM INTO` line and before the audit line, add:

```ts
chmodSync(toPath, 0o600); // backups carry the same privacy as the record
```

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 3: Tests

Add to `src/hardening.test.ts` (follow the file's existing fixture style —
module-level `dir`/`store` with `beforeEach` `mkdtempSync` + `afterEach`
close/rm, injected tick clock):

1. **dir created when absent**: open a store at
   `join(tmp, "does/not/exist/yet")` → no throw; `statSync(dir).mode & 0o777`
   → `0o700`.
2. **file modes**: after open + one `createNode` (forces WAL creation),
   every existing file among `memory.db{,-wal,-shm}`, `index.db{,-wal,-shm}`
   has `mode & 0o777` === `0o600`.
3. **backup mode**: `store.backup(join(dir, "..", "snap.db"))` →
   `statSync(...).mode & 0o777` === `0o600`.
4. **regression**: the old failure — `Store.open` on a nested missing dir —
   no longer throws (covered by test 1; assert a node round-trips).

**Verify**: `bun test src/hardening.test.ts` → all pass, including 3–4 new.

### Step 4: One documentation sentence in each doc

- `docs/SCHEMA.md`, section "Backup and restore": add a sentence — the
  reference implementation creates store directories 0700 and keeps
  `memory.db`, `index.db`, their WAL/SHM siblings, and `backup()` outputs at
  0600 (POSIX; no-op on Windows).
- `docs/HOSTING.md` §10: mirror the same sentence for backups.

**Verify**: `grep -n "0600" docs/SCHEMA.md docs/HOSTING.md` → one match each.

## Test plan

See Step 3 — four cases in `src/hardening.test.ts`, modeled on that file's
existing structure. `bun run check` green overall.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] New tests pass; `statSync` assertions on 0700/0600 present in
      `src/hardening.test.ts`
- [ ] `grep -n "mkdirSync" src/store.ts` → one match (in `open`)
- [ ] `grep -n "chmodSync" src/store.ts` → two sites (open + backup)
- [ ] The `StoreOptions.dir` docstring "(created if absent)" is now true —
      no doc change needed there
- [ ] `git status` clean outside in-scope paths
- [ ] `plans/README.md` status row updated

## STOP conditions

- `cli/` still exists (plan 002 not landed): the CLI's own
  `mkdirSync(dir, { recursive: true })` at `cli/index.ts:79` would now be
  redundant but harmless — proceed with this plan, but note it in your
  report instead of editing the CLI.
- `Store.open`'s body no longer matches the excerpt (drift).
- Mode assertions fail on the CI platform in a way suggesting non-POSIX
  semantics — report, don't loosen the tests blindly.

## Maintenance notes

- Plan 004 (honest forgetting) touches the same `Store.open` region to set
  pragmas — land this first; 004's excerpts assume this plan's shape.
- If a future `Store.openReadOnly` lands (see plans/README direction rows),
  it must NOT mkdir or chmod — read-only means touching nothing.
- Reviewer scrutiny: the chmod loop must run after BOTH dbs are open
  (index.db may have been recreated by the corrupt-sidecar recovery path at
  `src/store.ts:64-72`).
