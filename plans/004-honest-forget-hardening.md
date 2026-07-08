# Plan 004: Make forget() honest at the byte level — secure_delete, checkpoint, disclosed residue

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- src/storage/schema.ts src/lifecycle.ts src/hardening.test.ts docs/SCHEMA.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/003-private-files-by-default.md (same `Store.open`
  region; land 003 first)
- **Category**: security
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

The product's core promise is honest erasure: "'Forgotten' never secretly
means 'suppressed'" (`src/lifecycle.ts:63-68`, README). An empirical probe
(2026-07-07) showed the promise is stronger than the bytes: after
`forget()` + `close()`, the forgotten title/body remained **4× in
`memory.db-wal`**, **1× in `memory.db` free pages** (after a manual
checkpoint), and **1× in `index.db`** FTS segment data — because nothing
sets `PRAGMA secure_delete`, nothing checkpoints the WAL after a forget,
FTS5's `DELETE` leaves tokens in segments until merge, and no doc discloses
any of this. `docs/SCHEMA.md` I6 enumerates what forget destroys and the
`ForgetReport.needsOwner` list acknowledges only *external* copies
(`"external:prior-exports"`). Meanwhile `src/store.ts`'s backup comment
calls the `VACUUM INTO` output "forensically clean" — implicitly conceding
the live file is not.

After this plan: deleted content is overwritten at the storage layer
(`secure_delete` on both files, FTS5 `secure-delete` on the index), the WAL
is truncated after every forget, a strings-level regression test pins it,
and SCHEMA.md states exactly what byte-level erasure is and is not
guaranteed.

## Current state

- `src/storage/schema.ts:13-15` — memory.db DDL opens with pragmas that run
  on EVERY open (migrateMemoryDb execs MEMORY_DDL unconditionally):
  ```ts
  const MEMORY_DDL = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  ```
- `src/storage/schema.ts:94-105` — INDEX_DDL creates `nodes_fts` (FTS5) and
  `vectors`; `migrateIndexDb(db)` at `schema.ts:203-205` execs it on every
  open. No pragmas are set for index.db.
- `src/lifecycle.ts:94-117` — the forget cascade's transaction (edges,
  pending_edits, aliases, identity_pending, memory_history, derivations,
  tombstone UPDATE, audit), followed at lines 119-126 by the index scrub
  (`deleteFts`, `deleteVectorsFor`) in a try/catch.
- `src/lifecycle.ts:43-56` — `ForgetReport.needsOwner` docstring: mentions
  prose mentions, husks, and `"external:prior-exports"`.
- The adapter interface (`src/storage/adapter.ts`) exposes `exec(sql)` —
  use it for pragmas/checkpoints.
- `grep -rn "secure_delete" src/ docs/` → no matches today.
- SQLite version: Bun 1.3.14 bundles SQLite ≥3.44 — both
  `PRAGMA secure_delete` (ancient) and the FTS5 `secure-delete` config
  (needs ≥3.42) are available. The FTS5 config persists in the FTS shadow
  config table once set; setting it idempotently on every open is harmless.
- Test conventions: `src/hardening.test.ts` — mkdtemp fixture, injected
  clock, raw `Database` reads with `bun:sqlite` allowed in tests.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| One suite | `bun test src/hardening.test.ts` | all pass |

## Scope

**In scope**:
- `src/storage/schema.ts` (pragmas + FTS secure-delete config)
- `src/lifecycle.ts` (post-forget WAL truncation)
- `src/hardening.test.ts` (canary regression test)
- `docs/SCHEMA.md` (I6 wording + "Backup and restore" disclosure)

**Out of scope** (do NOT touch):
- A periodic/automatic `VACUUM` of the live file — the library never acts
  unbidden ("reports, never acts"); a doctor `vacuum-candidate` metric is a
  possible future direction, not this plan.
- `backup()` — already forensically clean via `VACUUM INTO`.
- Filesystem-level残 remanence (SSD wear leveling, snapshots) — disclose in
  docs as out of contract, do not attempt to solve.
- `ForgetReport` shape — no new fields; the fix makes the current honesty
  claims true instead of extending the report.

## Git workflow

- Branch: `advisor/004-honest-forget-hardening`
- Suggested commit: `fix(lifecycle): byte-level honest forgetting — secure_delete, post-forget checkpoint, FTS secure-delete (verified: canary test)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Enable secure_delete on both files

In `src/storage/schema.ts`, add to the top of `MEMORY_DDL` (after the
existing two pragmas):

```sql
PRAGMA secure_delete = ON;
```

Create the same effect for index.db: in `migrateIndexDb`, exec
`PRAGMA secure_delete = ON;` before the DDL, and after `INDEX_DDL` exec the
FTS5 secure-delete config:

```sql
INSERT INTO nodes_fts(nodes_fts, rank) VALUES('secure-delete', 1);
```

(This is the documented FTS5 command-insert form; it configures the table
to overwrite deleted segment entries. Idempotent — safe on every open.)

**Verify**: `bun test` → all pass (existing suite unaffected), and a quick
probe: open a store in a temp dir, then with `bun:sqlite` read
`PRAGMA secure_delete` on `memory.db` → `1`.

### Step 2: Truncate the WAL after every forget

In `src/lifecycle.ts`, after the forget transaction closes and BEFORE the
index scrub block (i.e. between line 117's `});` and the `let indexScrubbed`
line), add:

```ts
// The record's WAL still holds pre-forget page images; truncate it so
// destroyed content does not outlive the verb in a sidecar file. Runs
// outside the transaction (checkpointing inside one is a no-op).
try {
  ctx.mem.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} catch {
  audit(ctx, "system", "forget.checkpoint", id, false);
}
```

Note: with I14's single writer this checkpoint cannot be blocked by other
writers; concurrent external *readers* can delay TRUNCATE — the try/catch
plus content-free audit row covers that honestly.

**Verify**: `bun test` → all pass.

### Step 3: The canary regression test

Add to `src/hardening.test.ts`:

```
test("forgotten content does not survive in the store's bytes", ...)
```

1. Create a node with unmistakable canary strings (e.g. title
   `"CANARY-TITLE-9f3a7"`, body `"CANARY-BODY-2c8e1"`), plus one alias and
   one history-producing `updateNode`.
2. `store.forget(id)`; then `store.close()`.
3. Read RAW BYTES of every existing file among `memory.db`,
   `memory.db-wal`, `memory.db-shm`, `index.db`, `index.db-wal` (use
   `readFileSync` + `latin1` string or `includes` on Buffer).
4. Assert neither canary string appears in any file.
5. Keep the existing behavioral forget tests untouched — this test is
   additive.

**Verify**: `bun test src/hardening.test.ts` → all pass including the new
canary test. Then intentionally re-run the test with Step 1's pragma line
commented out locally to confirm the test actually FAILS without the fix
(then restore). Report if it does not fail — that means the test is weak.

### Step 4: Disclose the guarantee and its limits in SCHEMA.md

In `docs/SCHEMA.md`:

- In the I6 invariant text (around line 225), append two sentences: the
  reference implementation sets `secure_delete=ON` on both files and the
  FTS5 `secure-delete` config, and truncates the WAL after each forget, so
  destroyed content is overwritten in the store's own files; what remains
  out of contract: filesystem/SSD-level remanence, OS snapshots, and any
  copy that left the store (`needsOwner`'s `external:prior-exports`).
- In "Backup and restore" (around line 288): note backups are compacted
  clean copies (`VACUUM INTO`) and pre-existing backups of since-forgotten
  content are the owner's to manage.

**Verify**: `grep -n "secure_delete" docs/SCHEMA.md` → ≥1 match.

## Test plan

- New: the canary bytes test (Step 3) — the regression pin for this entire
  plan, negative-verified once by disabling the pragma.
- Existing: full suite green (`bun run check`).

## Done criteria

- [ ] `grep -n "secure_delete" src/storage/schema.ts` → 2 sites (memory + index)
- [ ] `grep -n "wal_checkpoint" src/lifecycle.ts` → 1 site
- [ ] Canary test present and passing; suite green (`bun run check` exit 0)
- [ ] `grep -n "secure_delete" docs/SCHEMA.md` → ≥1
- [ ] `git status` clean outside in-scope paths
- [ ] `plans/README.md` status row updated

## STOP conditions

- The canary test still fails AFTER Steps 1–2 (bytes surviving somewhere
  unexpected — e.g. `-shm`, or FTS segments despite the config): report the
  exact file and offset context; do not chase it with ad-hoc VACUUMs.
- `PRAGMA secure_delete` probe does not return 1 (adapter not applying
  DDL pragmas — would contradict `migrateMemoryDb`'s unconditional exec).
- The FTS5 `secure-delete` insert errors (SQLite too old — report the
  version from `select sqlite_version()`).
- `src/lifecycle.ts` no longer matches the excerpt (drift).

## Maintenance notes

- `secure_delete=ON` costs some write throughput (overwrites freed pages);
  at personal scale this is noise, but if a future bulk-delete feature
  lands, measure before batching thousands of forgets.
- Any future code path that deletes content-bearing rows (a history
  retention policy, alias GC) inherits byte-honesty automatically from the
  pragma — but a NEW database file (e.g. an export staging db) must set the
  pragma itself; note this in review of any such PR.
- Deferred deliberately: a doctor metric suggesting an occasional owner-run
  `VACUUM` of the live file (frees space; erasure no longer needs it once
  secure_delete is on).
