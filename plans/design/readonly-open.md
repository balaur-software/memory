# Design spike: a read-only open mode for the second-app pattern

> **Type**: design spike (plan 015). No production code changed by this
> document — it is a proposal + evidence for the owner to ratify. All
> `file:line` references are to the **approved worktree**
> (`.claude/worktrees/agent-ad93112a64c4916e7`), the post-fix tree, not the
> main-repo tree (verified against `main`@`9182b14`: the worktree already
> carries the `mkdirSync`/`chmodSync` 0600 hardening and the
> `migrateIndexDb` boolean-return self-heal that `main` does not yet have —
> see §0.1). Probe scripts live under
> `/tmp/claude-1000/-home-alex-projects-balaur-memory/abfef91e-d2fb-43a8-8e26-754fd479d3d3/scratchpad/probes/probe{1,2,3,3b,3c,3d,3e,4}*.ts`
> and were re-run immediately before this document was written; every
> transcript below is a verbatim capture, not a reconstruction.

## 0. The ask

DESIGN.md's concurrency section says WAL readers are "the designed-for
case" (`docs/DESIGN.md:79-83`); HOSTING.md §3 and §11 tell hosts to "open
your own read-only connection" for analytics and net-worth reads
(`docs/HOSTING.md:126-127`, `docs/HOSTING.md:305-307`). But `StoreOptions`
(`src/store.ts:35-42`) offers no read-only mode, so a host that wants this
"designed-for case" today must `import { Database } from "bun:sqlite"`
itself — piercing the one-file containment seam ADR-0001 guardrail 2 exists
to protect (`docs/adr/0001-bun-typescript.md:32-35`,
`src/storage/adapter.ts:1-6`). The repo's own net-worth probe
(`src/ergonomics.test.ts:172-248`) hand-rolls `children()` + a JS reduce
specifically because there is no in-library read door; HOSTING.md's own SQL
sketch for the same pattern (`docs/HOSTING.md:305-319`) is *not*
`Store`-mediated at all — it's raw SQL a host is trusted to write itself
against a connection it has to build by hand.

This document (a) probes what actually happens at the bun:sqlite/SQLite
level when a second connection opens `memory.db`/`index.db` read-only under
four scenarios, (b) designs the `Store.openReadOnly` / `ReadStoreContract`
API shape the plan sketched, (c) tabulates exact behavior for every write
trap in the current `Store.open`/verb set, and (d) sketches conformance and
effort for a follow-up build plan.

### 0.1 Drift check

```
$ diff <(git show HEAD:src/store.ts) .claude/worktrees/agent-ad93112a64c4916e7/src/store.ts
```

confirms the worktree adds, relative to `main`@`9182b14`: `mkdirSync(dir,
{mode:0o700})` at open, the `chmodSync(…, 0o600)` privacy loop over both
files' `""/-wal/-shm` variants, `migrateIndexDb` returning `boolean`
(`recreated`) instead of `void`, and `dir_` tracked on the instance for
`backup()`'s containment check. All of these are additional **write**
behaviors a read-only open must skip — they sharpen this spike's "current
state" list rather than changing its conclusions.

## 1. Probe evidence

### 1.1 Probe 1 — reader while writer open

**Script**: `probe1-reader-while-writer-open.ts`. A `Store` writer stays
open (uncheckpointed WAL); a second, independent `new Database(memPath,
{readonly:true})` opens the *same* file and reads concurrently, including
a fresh query issued **after** the writer commits a second row.

```
reader: opened readonly OK while writer open
reader: count of notes (before 2nd write) = 1
writer: created 01kx04nf6hna3pjxaw4pp5dy6p
reader: count of notes (after 2nd write, SAME connection, fresh query) = 2
reader: write correctly refused: SQLiteError: attempt to write a readonly database
```

**Result: DESIGN.md's WAL claim holds exactly.** Concurrent read while a
writer is live works, sees every committed row (no stale snapshot pinning
across separate query calls — each `query()` call is its own read
transaction), and a write attempt on the reader handle is refused at the
SQLite level, not just by convention. **No STOP condition triggered.**

### 1.2 Probe 2 — reader with no writer, after a clean close

**Script**: `probe2-reader-after-clean-close.ts`.

```
writer: closed cleanly
file memory.db: exists=true
file memory.db-wal: exists=false
file memory.db-shm: exists=false
reader: opened readonly OK after clean close, count = 2
```

`Store.close()` → `Database.close()` triggers SQLite's "last connection
closes → auto-checkpoint + delete `-wal`/`-shm`" behavior. A subsequent
readonly open sees a plain single-file db and just works. This is the easy
case.

### 1.3 Probe 3 — reader with no writer, after a "killed" writer (dirty WAL)

**Script**: `probe3-reader-after-killed-writer.ts`. A writer stays open
(20 rows, default WAL autocheckpoint threshold is 1000 pages so nothing has
been folded back into the main file yet — data lives entirely in `-wal`).
While it's still open, `memory.db` + `memory.db-wal` are copied to a fresh,
**writable** directory (the naive-backup-script move HOSTING.md's backup
section already warns against, `docs/HOSTING.md:243`) — simulating a reader
opening files an unattached, killed writer left behind.

```
--- variant A-no-shm: copiedWal=true copiedShm=false ---
A-no-shm: readonly open + query SUCCEEDED, count = 20

--- variant B-with-shm: copiedWal=true copiedShm=true ---
B-with-shm: readonly open + query SUCCEEDED, count = 20
```

Both variants **succeed**, including the one that never copied `-shm` at
all. `bun:sqlite` bundles **SQLite 3.53.0** (`bun -e 'db.query("select
sqlite_version()")'` confirms), far past the 3.22.0 (2018) baseline where
read-only WAL replicas gained the ability to build the wal-index in
**private heap memory** instead of the shared `-shm` file, provided they
can still *create* `-shm` if they choose to (probe 3g below shows they do).
So: **no `SQLITE_READONLY_RECOVERY` in this repo's SQLite version**, for
the scenario the plan described. This refines rather than falsifies the
plan's worry — see 1.3.1 for the scenario that *does* fail.

**Diagnostic addendum (`probe3g`, inline, not a separate file)**: confirmed
the destination directory had no `-shm` before open and had one after —
the default readonly path *does* write a `-shm` file into the directory it
opens from, even though the connection itself is `SQLITE_OPEN_READONLY`.

#### 1.3.1 The scenario that DOES fail: a genuinely non-writable directory

The plan's WAL worry was really pointing at "what if the reader can't
write anything, anywhere" — i.e. the literal reading of DESIGN.md's "any
external tool mounting the file read-only" (an OS-level read-only mount,
not merely `{readonly:true}` on the SQLite handle while the directory
itself stays writable). Probes 3b–3e isolate this:

**`probe3b-readonly-dir-perms.ts`** — dirty WAL copy, destination
**directory** chmod `0500` (no write), files chmod `0400`, no `-shm`
copied:

```
readonly open on non-writable dir FAILED: SQLiteError: unable to open database file
error.code = SQLITE_CANTOPEN
error.errno = 14
```

**`probe3c-file-perms-only-dir-writable.ts`** — same dirty-WAL copy, but
only the **files** are chmod `0400`; the directory stays writable:

```
dir writable, files 0400 only (dirty/uncheckpointed WAL present)
SUCCEEDED, count = { c: 21 }
```

**`probe3d-nonwritable-dir-clean-state.ts`** — isolates whether this is a
dirty-WAL-only problem: a **cleanly closed** store (no `-wal` at all,
probe 2's easy case), then the directory is chmod'd `0500` **after** close:

```
dir 0500 (non-writable), file 0400, NO wal present (clean close)
FAILED: SQLiteError: attempt to write a readonly database SQLITE_READONLY_DIRECTORY 1544
```

**This is the headline finding.** `{readonly:true}` on a WAL-mode database
needs the **containing directory** to be writable — not just readable —
*regardless of whether there is anything to recover*, because SQLite must
be able to attempt to create/open `-shm` as part of establishing WAL
machinery for any connection, even a read-only one with nothing to do.
Two distinct real errors surface depending on WAL cleanliness against a
non-writable dir: `SQLITE_CANTOPEN` (dirty WAL present) and
`SQLITE_READONLY_DIRECTORY` (clean, checkpointed state) — neither is the
`SQLITE_READONLY_RECOVERY` the plan hypothesized, but both are the same
underlying fact: **a truly OS-level-read-only-mounted store directory
cannot be opened as a WAL reader at all**, clean or dirty.

**`probe3e-immutable-uri-danger.ts`** — does SQLite's `?immutable=1` URI
flag (which disables all WAL locking/change-detection, treating the main
file as a frozen snapshot) rescue the non-writable-directory case? It opens
successfully but is **silently wrong**:

```
--- variant: non-writable dest dir ---
non-writable-dir: immutable=1 FAILED: SQLiteError: no such table: nodes
--- variant: fully writable dest dir ---
writable-dir: immutable=1 FAILED: SQLiteError: no such table: nodes
```

`immutable=1` ignores `-wal` **unconditionally** — proven by the
"writable dir" variant failing identically to the non-writable one. Since
all 20 rows (plus the `CREATE TABLE` statements themselves, in this small
test) lived in the uncheckpointed WAL, the "frozen" main file it reads is
missing everything, and the failure mode is silent-wrong-data (here
loud-because-no-table, but in a partially-checkpointed real store it would
just be **stale-but-plausible data**, not an error at all). **`immutable=1`
must not be used** as a workaround — it trades a loud, honest open failure
for a silent correctness bug.

**Practical takeaway**: the common host pattern DESIGN.md/HOSTING.md
describe — a second connection or sibling process on the *same machine, same
OS user, same directory* — always has a writable directory (the writer
created it 0700, `src/store.ts:55`) and therefore always works, as probe 1
already proved live. The failure mode only bites a genuinely OS-mounted
read-only replica (a container bind-mount, an NFS read-only export, `chmod
000` at the directory level) — and there, **the writer must checkpoint
first** (`PRAGMA wal_checkpoint(TRUNCATE)`, or a clean `store.close()`) for
readonly open to work at all. §7 folds this into the doc-change list: this
is a correction to DESIGN.md's current wording, not just an addition.

### 1.4 Probe 4 — absent / stale index.db under readonly

**Script**: `probe4-absent-and-stale-index.ts`, three parts.

**(a) absent index.db**, `{readonly:true}`, no `create`:

```
FAILED as expected: SQLiteError: unable to open database file
code: SQLITE_CANTOPEN errno: 14
```

Confirms: a reader must never call `openDb(idxPath)` the way `Store.open`
does (which relies on bun:sqlite's default `{create:true}` — see
`src/storage/bun.ts:10`) — a readonly `OpenDb` mode needs its own explicit
existence check with a clear, typed message rather than letting a raw
`SQLITE_CANTOPEN` leak to the host.

**(b) old-shape `nodes_fts`** (pre-surfacing, 5-column — exactly the shape
`migrateIndexDb` detects and self-heals today via `DROP TABLE` +
`rebuildFts`, both writes: `src/storage/schema.ts:216-224`,
`src/store.ts:90-93`). A readonly connection issues the *exact* SQL
`lexicalCandidates` builds when called the way `recall()` actually calls it
(`excludeNever=true` unconditionally, `src/recall.ts:227`, which appends
`AND surfacing != 'never'`, `src/recall.ts:123`):

```
PRODUCTION-shaped recall query (excludeNever=true) FAILS: SQLiteError: no such column: surfacing
```

(A control query that omits the `surfacing` predicate succeeds against the
same old-shape table — isolating that the *specific* column recall's
production code path references is what's missing, not the whole table.)

**(c) zero-byte index.db** (e.g. a `touch`'d placeholder, or a truncated
file from a bad copy):

```
FAILED: SQLiteError: no such table: nodes_fts
```

**Design input from 1.4**: a raw `SQLiteError` with a driver-level message
("no such column: surfacing", "unable to open database file") is not
acceptable to leak through `ReadStore.recall()` — it's not a `MemoryError`,
hosts can't `switch` on it (`docs/HOSTING.md:93-97`), and it exposes SQL
shape as part of the error contract. §5/§6 below specify the guard.

## 2. API sketch

```ts
// src/storage/adapter.ts — one interface change, additive
export interface OpenDbOptions {
  readonly readonly?: boolean; // default false — unchanged behavior
}
export type OpenDb = (path: string, opts?: OpenDbOptions) => SqlDb;

// src/storage/bun.ts — the only file allowed to import bun:sqlite
export const openBunDb: OpenDb = (path, opts) => {
  const db = new Database(path, opts?.readonly ? { readonly: true } : { create: true });
  // ... unchanged wiring; `run`/`exec`/`transaction` are simply never called
  // by ReadStore verbs, so no runtime guard is needed inside the adapter —
  // the compiler-enforced ReadStoreContract (below) is the actual guard.
  ...
};
```

```ts
// src/contract.ts — additive; StoreContract is untouched (Store keeps
// `implements StoreContract` exactly as today)
export interface ReadStoreContract {
  getNode(id: NodeId): Node;
  children(id: NodeId, edgeType: string, opts?: { statuses?: readonly Status[]; asOf?: string }): Node[];
  history(id: NodeId): HistorySnapshot[];
  neighborhood(id: NodeId, asOf?: string): Node[];
  recall(terms: readonly string[], opts?: RecallOptions): Node[];
  search(terms: readonly string[], limit?: number): Node[];
  agenda(from: string, to: string, opts?: { type?: string; limit?: number }): Node[];
  episode(from: string, to: string, opts?: { type?: string; limit?: number }): Node[];
  resolveRef(type: string, text: string): Node[];
  survivorOf(id: NodeId): Node;
  aliasesOf(id: NodeId): string[];
  entityContext(id: NodeId, limit?: number, asOf?: string): EntityContext;
  pendingQueue(): Pending[];
  conflictsFor(id: NodeId): Conflict[];
  staleDerivations(): string[];
  doctor(now?: Date): DoctorReport;
  close(): void;
}
```

```ts
// src/store.ts — new static factory + new (small) class; Store itself is
// unmodified except that both classes now share the guard/ctx machinery.
export interface ReadStoreOptions {
  readonly dir: string;
  readonly now?: () => Date;
  readonly openDb?: OpenDb;
}

export class ReadStore implements ReadStoreContract {
  private readonly ctx: spine.Ctx;
  private open_ = true;
  private constructor(ctx: spine.Ctx) { this.ctx = ctx; }

  static openReadOnly(opts: ReadStoreOptions): ReadStore {
    const openDb = opts.openDb ?? openBunDb;
    const now = opts.now ?? (() => new Date());
    const memPath = join(opts.dir, "memory.db");
    if (!existsSync(memPath))
      throw new MemoryError("not_found", `no memory.db under ${opts.dir} — nothing to read (has the writer run yet?)`);
    const mem = openDb(memPath, { readonly: true });
    assertReadableSchema(mem); // §5: refuse, never migrate
    const idxPath = join(opts.dir, "index.db");
    const idx = existsSync(idxPath) ? openDb(idxPath, { readonly: true }) : null;
    return new ReadStore({ mem, idx: idx ?? absentIndexSentinel(), now });
  }
  // verb bodies delegate to the SAME spine/recall/entities/consent/lineage/
  // doctor functions Store already calls — zero logic duplication; the only
  // new code is the factory + the guard functions below.
  ...
  close(): void { this.open_ = false; this.ctx.mem.close(); this.ctx.idx?.close(); }
}
```

Why a separate class + narrower contract rather than `Store.open({dir,
readonly: true})`: a boolean mode flag on one class means every verb body
needs an internal `if (this.readonly) throw` guard, checked at runtime, for
every write verb (`touch`, `dayAnchor`, `forget`, `propose`, `decide`, …
seventeen of them). That is a maintenance trap the moment a new write verb
lands and its author forgets the guard — a silent hole in the read-only
promise. `ReadStore implements ReadStoreContract` makes the **compiler**
enforce verb membership, exactly the trick `Store implements StoreContract`
already uses to keep `src/contract.ts` and the shipped surface from
drifting (`src/contract.ts:1-9`) — calling `readStore.forget(id)` is a
type error, not a runtime `MemoryError`, and adding a write verb to `Store`
cannot accidentally leak into `ReadStore` because `ReadStore` never touches
`StoreContract` at all.

## 3. Semantics table

| Trap | `Store.open` (writer) behavior | `ReadStore.openReadOnly` behavior |
|---|---|---|
| `mkdirSync(dir, {mode:0o700})` (`src/store.ts:55`) | Creates the dir if absent | **Skipped.** A read-only open of a directory that doesn't exist is `not_found` — there is nothing to read, and a reader creating a directory is itself a write. |
| `chmodSync(*, 0o600)` privacy loop (`src/store.ts:80-85`) | Runs on every open | **Skipped entirely** — touches no file mode. Read-only means read-only, including "does not even `chmod`." |
| `migrateMemoryDb` (`src/storage/schema.ts:166-208`) | Applies DDL deltas, bumps `schema_version`, inserts `store_id`/`created` on a fresh file | **Refused, never run.** §5's migration guard: read `meta.schema_version` via a plain `SELECT` (a read), compare to `SCHEMA_VERSION`; anything other than an exact match throws `conflict` before any other verb runs. |
| `migrateIndexDb` self-heal (`recreated`/`recovered` branches, `src/store.ts:66-76`, `90-93`) | `DROP TABLE nodes_fts` + `rebuildFts` on old-shape or corrupt index.db | **Skipped.** A reader opens `index.db` `{readonly:true}` as-is; §1.4's probe defines what happens next (see "absent/mismatched index" row below). |
| `day` type registration `INSERT ... ON CONFLICT DO NOTHING` (`src/store.ts:96-100`) | Runs on every open | **Skipped** — no write, and a `ReadStore` never calls `createNode`, so there is no downstream need for the type to be registered in-process. |
| `touch(id)` | Writes `use_count`/`last_used` (`src/spine.ts:720-732`) | **Absent from `ReadStoreContract`** — compile error to call it, not a runtime throw. |
| `dayAnchor(date)` | Get-or-create (`src/spine.ts:301-314`, `ensureDayNode` inserts on miss) | **Absent from `ReadStoreContract`.** (Considered and rejected: a "read-only variant that throws not_found on miss" — rejected because it adds a second, subtly-different verb name for what is fundamentally the same operation with a different failure mode, more API surface than the win justifies for a verb whose entire purpose is host-side scheduling logic that belongs on the writer anyway.) |
| `rebuildIndex()` | Rewrites `index.db` from `memory.db` (write) | **Absent.** The whole point of a stale/absent index under RO is that only the writer may fix it — see next row. |
| every other write verb (`createNode`, `updateNode`, `link`, `closeEdge`, `transition`, `setSurfacing`, `propose`, `proposeEdit`, `decide`, `quarantine`, `forget`, `addAlias`, `removeAlias`, `suggestIdentities`, `decideIdentity`, `recordDerivation`, `putVector`, `deleteVectors`, `backup`) | writes | **Absent from `ReadStoreContract`** — compiler-enforced, not runtime-checked. |
| `getNode`, `children`, `history`, `neighborhood`, `pendingQueue`, `conflictsFor`, `staleDerivations`, `resolveRef`, `survivorOf`, `aliasesOf`, `entityContext` | pure reads (verified: no `.run(`/`.exec(` call anywhere on these code paths — `src/consent.ts:286-329`, `src/lineage.ts:34-40`, `src/entities.ts` read verbs) | **Included, delegate to the same functions Store calls.** No behavior change. |
| `agenda`/`episode` | pure reads of `memory.db` only — never touch `index.db` (`src/recall.ts:289-358` reference `ctx.mem`, not `ctx.idx`, anywhere) | **Included, unaffected by index.db's state at all** — clean/stale/absent index makes no difference to these two verbs. |
| `recall`/`search` | reads both files; `lexicalCandidates` queries `ctx.idx` with the production `excludeNever=true` shape | **Included, but gated on index readability (see below).** |
| absent/mismatched `index.db` under RO, reached via `recall`/`search` | n/a (writer self-heals) | **Typed error, not a raw `SQLiteError`.** §1.4 showed the raw failures (`SQLITE_CANTOPEN` absent; `no such column: surfacing` old-shape). `ReadStore.openReadOnly` checks index.db's shape at open time the same way `migrateIndexDb` checks it today (read-only: `SELECT name FROM pragma_table_info('nodes_fts')`, no `DROP`/no `INSERT`) and, on a mismatch or absence, **does not fail at open** — `getNode`/`children`/etc. still work — but `recall`/`search` throw `MemoryError("conflict", "index.db is absent/stale under read-only open — ask the writer to run store.rebuildIndex()")` the first time they're called. Open-time-only failure would break the "read everything else fine, just no FTS" host pattern for no reason; verb-time failure keeps the blast radius to the one verb that actually needs the index. |
| `doctor()` | `PRAGMA integrity_check` + read-only aggregate queries (`src/doctor.ts:27-174`, confirmed no `.run(`/`.exec(` anywhere in the file) | **Included, unchanged** — already a pure read against `ctx.mem`. |
| I14 (single writer) | One `Store` instance owns writes | **Unaffected — `ReadStore` was always the case I14 already permitted** ("WAL mode permits concurrent external readers", `docs/SCHEMA.md:279-281`); this feature gives that permitted case a name and a compiler-checked door, it does not loosen I14. |

## 4. Migration-guard wording

Read-only open must refuse, not migrate, on ANY schema mismatch —
lower *or* higher than `SCHEMA_VERSION` — because a reader that proceeds
against an unmigrated shape hits exactly probe 4b's failure mode (a raw
`SQLiteError` for a missing/renamed column) the moment a verb touches the
column a pending migration would have added. The writer-side guard already
refuses *future* schemas loudly (`src/storage/schema.ts:188-192`); the
reader's guard is the same idea, narrower (no ability to fix, so no lower
bound is safe to pass through either):

```ts
function assertReadableSchema(mem: SqlDb): void {
  const row = mem.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  if (row === null)
    throw new MemoryError("conflict", "memory.db has no schema_version — open it with the writer (Store.open) first");
  const v = Number(row.value);
  if (Number.isNaN(v) || v !== SCHEMA_VERSION)
    throw new MemoryError(
      "conflict",
      `memory.db is schema v${row.value}; this reader supports only v${SCHEMA_VERSION} — ` +
      `open once with the writer (Store.open) to migrate, then retry the read-only open`,
    );
}
```

Reuses the existing `"conflict"` code (already the writer's schema-mismatch
code, `src/storage/schema.ts:189-191`) rather than adding a new
`MemoryErrorCode` — keeps the closed union in `src/types.ts:150-157` closed,
consistent with the project's error-code discipline
(`docs/HOSTING.md:93-97`: "hosts can switch on `code` without string
matching" — a stable, small set is the point).

## 5. Index-readability guard (recall/search only)

```ts
function assertIndexReadable(idx: SqlDb | null): void {
  if (idx === null)
    throw new MemoryError("conflict", "index.db is absent under read-only open — run store.rebuildIndex() via the writer, then retry");
  const cols = idx.query<{ name: string }>("SELECT name FROM pragma_table_info('nodes_fts')");
  if (!cols.some((c) => c.name === "surfacing"))
    throw new MemoryError("conflict", "index.db has an old/incompatible shape under read-only open — run store.rebuildIndex() via the writer, then retry");
}
```

Called at the top of `ReadStore.recall`/`ReadStore.search`, mirroring where
`lexicalCandidates` would otherwise hit the raw column error. `agenda` and
`episode` never call this (they don't touch `index.db` at all — see §3).

## 6. Conformance sketch — `readNothingChanged`

Not a `*.scenario.json` (those drive pure `Store` verb sequences through
`test/conformance/runner.test.ts`; this needs OS-level byte comparison of
the actual files, which the scenario format has no vocabulary for). Sketch
as a new `*.test.ts` beside the module, e.g. `src/store.readonly.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

function hashDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ["memory.db", "memory.db-wal", "memory.db-shm", "index.db", "index.db-wal", "index.db-shm"]) {
    try { out[f] = createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"); }
    catch { out[f] = "ABSENT"; }
  }
  return out;
}

test("readNothingChanged: every ReadStoreContract verb, byte-identical files before/after", () => {
  // 1. build a populated store with the WRITER (nodes, edges, aliases,
  //    pending items, a forgotten node, vectors — enough to exercise every
  //    read verb's SQL paths), then store.close() so the state is clean
  //    (probe 2's easy case — the harness is testing verb purity, not the
  //    WAL edge cases §1.3 already covered separately).
  // 2. hash every memory.db*/index.db* file.
  // 3. ReadStore.openReadOnly({dir}); call EVERY ReadStoreContract verb at
  //    least once (getNode, children, history, neighborhood, recall,
  //    search, agenda, episode, resolveRef, survivorOf, aliasesOf,
  //    entityContext, pendingQueue, conflictsFor, staleDerivations, doctor)
  //    with realistic args against the fixture above; readStore.close().
  // 4. re-hash; expect(afterHashes).toEqual(beforeHashes) for every file —
  //    including the ABSENT sentinel, so a verb that CREATES memory.db-shm
  //    and leaves it behind (a real risk: recall's index query legitimately
  //    creates index.db-shm as a side effect of readonly WAL machinery,
  //    per probe 3g) is caught if it doesn't get cleaned up by close().
});
```

The `-shm`-gets-created-then-removed-by-close() detail from probe 3g means
step 4's hash set needs `close()` called *before* the after-hash, and the
harness should also assert `-shm`/`-wal` are gone post-close (mirroring
probe 2) — a `ReadStore` that leaks WAL sidecar files into a directory it
was told is read-only would be a real (if filesystem-permission-caught)
bug.

A second, smaller scenario worth a conformance case (not just the
`*.test.ts`): `ReadStore.openReadOnly` against a schema-mismatched
`memory.db` throws exactly the `conflict` from §4, verified as a
`*.scenario.json`-adjacent unit test since scenarios don't have a vocabulary
for "open a store built by a different schema version."

## 7. Documentation changes needed

- **`docs/DESIGN.md:79-83`** — the "any external tool mounting the file
  read-only … is the designed-for case" sentence needs the §1.3.1
  correction folded in: works unconditionally for a second connection/
  process sharing the store's (writable) directory; a **genuinely**
  OS-mounted-read-only directory only works if the writer has checkpointed
  first (clean close, or `PRAGMA wal_checkpoint(TRUNCATE)`) — otherwise
  open itself fails loudly (`SQLITE_CANTOPEN`/`SQLITE_READONLY_DIRECTORY`,
  never silently, and `immutable=1` must not be reached for as a fix — it
  trades the loud failure for silent stale data, §1.3.1).
- **`docs/HOSTING.md:126-127` (§3) and `:305-319` (§11)** — rewrite "open
  your own read-only connection … analytics never goes through the Store's
  writer" onto `ReadStore.openReadOnly`, keeping the raw-SQL sketches as
  the documented **advanced** escape hatch (they still work — a `ReadStore`
  doesn't remove the ability to hand-roll SQL against `ctx.mem`/`ctx.idx`
  for hosts that want it — but the primary recipe becomes the typed door).
- **`docs/SCHEMA.md:279-281` (I14)** — add one sentence naming
  `ReadStore.openReadOnly` as the library-blessed way to exercise the
  "concurrent external readers" permission the invariant already grants;
  no invariant text changes (I14 itself is unaffected, §3's last row).

## 8. Effort estimate for the build plan

**S–M**, matching this spike's own estimate — most of the implementation
is delegation, not new logic:

- `OpenDb`/`openBunDb` mode param: ~10 lines, one file (`src/storage/bun.ts`).
- `ReadStoreContract` in `src/contract.ts`: interface only, copy-adapted
  doc comments from `StoreContract` (~40 lines).
- `ReadStore` class + `assertReadableSchema`/`assertIndexReadable` guards
  in `src/store.ts`: the verb bodies are one-line delegations to functions
  that already exist (`spine.mustGet`, `spine.children`, `recallMod.recall`,
  `doctorFn`, …) — realistically ~120-150 lines including doc comments,
  well under half the size of `Store` itself.
- Conformance: the `readNothingChanged` harness (§6) plus the
  schema-mismatch-under-RO unit test — a day, generously, including writing
  a populated fixture store that exercises every verb's SQL path.
- Docs: the three edits in §7 — an hour once the API is final.

No new dependencies, no new files outside `src/store.ts` /
`src/contract.ts` / `src/storage/{adapter,bun}.ts` / one new `*.test.ts` /
three doc edits. The riskiest part is not code volume but **getting the
verb list and the two guards exactly right** (§3/§4/§5) — which is what
this spike spent its effort on so the build plan doesn't have to
re-derive it.

## 9. Composition note for plan 016

`ReadStoreContract` is the natural export surface for plan 016's export
verbs (exports are pure reads by construction) — a future `Store.export()`
or standalone export helper can be typed to accept a `ReadStoreContract`
(or `ReadStore` directly) rather than the full `StoreContract`, making "an
export function cannot accidentally write" a compiler fact instead of a
code-review discipline. Worth stating explicitly in plan 016's own design
doc rather than assumed.

## 10. Owner-decision list

1. **Separate class (`ReadStore`) vs. boolean flag on `Store`.**
   Recommend: separate class + `ReadStoreContract` (§2's compiler-enforced
   argument). Rejecting the boolean flag is close to a forced move given
   §2's maintenance-trap argument, but it's still the owner's call since it
   is the single biggest API-shape decision here.
2. **Absent/stale `index.db` under RO: fail at `openReadOnly()` time vs.
   fail lazily at first `recall()`/`search()` call.** Recommend: lazily
   (§3's table, §5) — `getNode`/`children`/`agenda`/etc. have no reason to
   be unusable just because FTS is stale, and open-time failure would make
   `ReadStore.openReadOnly` unusable for any host that only wants graph
   reads against a store whose owner hasn't run the writer in a while.
3. **Error code for the two new guard failures (schema mismatch under RO,
   index unreadable under RO).** Recommend: reuse `"conflict"` (§4/§5) —
   keeps `MemoryErrorCode` closed at six variants rather than growing it
   for two cases hosts would handle identically to the existing
   schema-mismatch `conflict` ("tell the owner to run the writer").
   Alternative considered: a dedicated `"readonly_unavailable"` code —
   rejected as unnecessary granularity for a host-facing switch statement
   that would do the same thing either way.
4. **`dayAnchor()` read-only variant.** Recommend: omit entirely, not even
   a `not_found`-throwing variant (§3's row) — the verb's whole purpose is
   host-side day-scheduling that belongs on the writer; a read-only
   lookalike adds API surface for a use case (checking whether today's
   anchor exists, without creating it) that `children`/`getNode` combined
   with a host-tracked day-node id already cover if truly needed.
5. **Whether `ReadStore.openReadOnly` should accept an already-open
   `SqlDb` pair (dependency injection, matching `StoreOptions.openDb`)
   instead of only a `dir` string** — relevant for hosts that manage their
   own connection pooling. Recommend: yes, mirror `StoreOptions.openDb`
   exactly (§2's sketch already does this) — no new decision needed, it's
   free symmetry with the existing `Store.open` shape.
6. **Whether to document the `PRAGMA wal_checkpoint(TRUNCATE)` /
   clean-close requirement for *genuine* OS-level read-only mounts as a
   HOSTING.md caveat, or leave it as a DESIGN.md-only concurrency-section
   detail.** Recommend: DESIGN.md (architecture-level fact) with a
   one-line pointer from HOSTING.md §3/§11 — the common host case (same
   directory, same machine) never needs the checkpoint, so leading with it
   in the host-pattern cookbook would overstate how often it matters.
