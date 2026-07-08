# Plan 020: Build Store.openReadOnly — the compiler-enforced read-only door

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Normative design**: `plans/design/readonly-open.md` (in-repo) — §2 is
> the API (verbatim target shapes), §3 the trap-by-trap semantics table,
> §4/§5 the two guards (copy the code blocks as written), §6 the
> readNothingChanged harness, §7 the doc changes. All 6 owner decisions
> confirmed 2026-07-08 as recommended (separate ReadStore class; lazy
> index failure at recall/search; reuse "conflict"; no dayAnchor RO
> variant; DI symmetry via OpenDbOptions; checkpoint caveat in DESIGN.md).
> Read §2–§7 in full before starting.
>
> **Drift check (run first)**: `git diff --stat f1b168a..HEAD -- src/storage/adapter.ts src/storage/bun.ts src/store.ts src/contract.ts src/index.ts docs/DESIGN.md docs/HOSTING.md`
> On drift beyond plans 018/019's documented edits, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (a new public class; must provably never write)
- **Depends on**: plans/019-build-life-documents-docs.md (stacking order;
  019 depends on 018 — both precede this in the branch chain)
- **Category**: direction/build
- **Planned at**: commit `f1b168a`, 2026-07-08

## Why this matters

DESIGN.md calls the second-app reader "the designed-for case" and
HOSTING.md §3 instructs hosts to open their own read-only connection —
but the API can't express it, so hosts must import `bun:sqlite`
themselves, piercing the ADR-0001 containment seam. The design's probes
settled the mechanics: concurrent WAL reads work; the absent-index and
stale-index failures are raw SQLite errors needing typed translation; and
`immutable=1` is a trap (silently ignores WAL) requiring a DESIGN.md
wording fix.

## Current state

Baseline: 169 tests / 13 files green (plus 018/019's additions on the
stacked branch — re-baseline with `bun test` before starting).

- `src/storage/adapter.ts` — `export type OpenDb = (path: string) => SqlDb;`
  → gains `OpenDbOptions { readonly?: boolean }` (design §2, verbatim).
- `src/storage/bun.ts` — `new Database(path, { create: true })` → mode
  switch per design §2. NO runtime write-guard inside the adapter — the
  compiler-enforced contract is the guard (design §2's stated rationale).
- `src/contract.ts` — `ReadStoreContract` exactly as design §2 lists it
  (17 members incl. `close()`); `StoreContract` untouched.
- `src/store.ts` — new `ReadStore` class + `Store.openReadOnly` static
  (or a `ReadStore.openReadOnly` — design shows the factory on ReadStore;
  EXPORT it as `Store.openReadOnly` delegating there OR export ReadStore
  directly — follow design §2 literally: class ReadStore with the static;
  add `openReadOnly` re-export from `src/index.ts`). Verb bodies delegate
  to the same spine/recall/entities/consent/lineage/doctor functions
  `Store` calls — zero logic duplication.
- The two guards to copy verbatim from design §4/§5:
  `assertReadableSchema` (refuse ANY version mismatch, code `conflict`)
  and `assertIndexReadable` (called at top of `recall`/`search` ONLY;
  absent index → typed `conflict` with the rebuild pointer; `agenda`/
  `episode` never call it).
- Absent-index representation: design §2 sketches
  `idx: idx ?? absentIndexSentinel()` — implement as `idx: SqlDb | null`
  on a ReadStore-private ctx variant OR a sentinel whose every method
  throws the §5 typed error; pick the one that keeps `spine.Ctx` untouched
  for the writer path (a local `ReadCtx` with `idx: SqlDb | null` +
  passing a non-null idx to shared functions only after the guard is the
  cleanest; the design leaves this implementation detail open — document
  your choice in NOTES).
- Semantics table (design §3): skip mkdir/chmod/migrations/day-insert/
  index-self-heal; `not_found` when memory.db absent.
- Docs: DESIGN.md concurrency section gains the probe-3 corrections
  (readonly needs a writable dir for -shm in WAL mode when uncheckpointed;
  `immutable=1` silently drops uncommitted WAL — never recommend it for a
  live store); HOSTING.md §3 and §11 rewritten onto `openReadOnly`
  (replace the "open your own read-only connection" instruction).
- `src/index.ts` — export `ReadStore`/`ReadStoreContract`/`openReadOnly`
  surface.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Suites    | `bun test src/hardening.test.ts test/conformance/runner.test.ts` | all pass |

## Scope

**In scope**: `src/storage/adapter.ts`, `src/storage/bun.ts`,
`src/store.ts`, `src/contract.ts`, `src/index.ts`, a new test file
`src/readstore.test.ts`, `test/conformance/` (one scenario if the runner
gains a cheap `openReadOnly` op — optional, see Step 4), `docs/DESIGN.md`,
`docs/HOSTING.md`.

**Out of scope**: `spine.ts`/`recall.ts`/`entities.ts`/`doctor.ts` logic
(delegation only — if a shared function seems to need a write under RO,
STOP); any `Store` (writer) behavior change; new MemoryError codes.

## Git workflow

- Branch: `advisor/020-readonly-open` from `advisor/019-life-documents-docs`
- Suggested commit: `feat(store): ReadStore.openReadOnly — the compiler-enforced second-app reader (ADR-0001 seam intact)`
- Do NOT push or open a PR.

## Steps

### Step 1: Adapter mode

`OpenDbOptions` + the bun.ts switch per design §2. Existing callers
unchanged (opts optional).

**Verify**: `bunx tsc --noEmit` → exit 0; `bun test` → baseline count.

### Step 2: ReadStoreContract + ReadStore + guards

Implement per design §2/§4/§5 and the §3 semantics table. Every verb body
is one delegation line. `close()` flips the guard and closes both
handles.

**Verify**: `bunx tsc --noEmit` → exit 0; and the compile-time promise:
a scratch file calling `(readStore as any).forget` is fine but
`readStore.forget(id)` without the cast MUST be a tsc error — verify by
compiling a negative snippet with `bunx tsc --noEmit` on a temp file and
then deleting it (report the error text in NOTES).

### Step 3: The readNothingChanged test

`src/readstore.test.ts` (new; use `test/helpers.ts` freshStore for the
writer side):

1. Writer populates (nodes, edges, alias, vector, pending proposal,
   history); writer stays OPEN; `openReadOnly` concurrently → every
   ReadStoreContract verb returns the same data the writer sees.
2. **Byte-compare harness** (design §6): close the writer; snapshot raw
   bytes of memory.db + index.db (+wal/shm if present); openReadOnly; run
   EVERY verb on the contract (loop over a checklist, not a sample);
   close; re-read bytes → byte-identical.
3. Guards: version-doctored file (raw UPDATE meta) → `conflict` with
   "open once with the writer" message; deleted index.db → open succeeds,
   `getNode`/`children`/`agenda`/`episode`/`doctor` work, `recall` throws
   the §5 typed `conflict`; `search` same.
4. Absent memory.db → `not_found`.
5. `statSync` modes unchanged by RO open (no chmod ran).

**Verify**: `bun test src/readstore.test.ts` → all pass.

### Step 4: Conformance (small)

Add a scenario exercising the RO door if the runner extension is cheap
(an `openReadOnly` op that swaps the store binding for reads); if the
runner change grows beyond ~30 lines, skip the scenario, note it, and
rely on `src/readstore.test.ts` (the byte-compare is the real invariant).

**Verify**: `bun test test/conformance/runner.test.ts` → all pass.

### Step 5: Docs

DESIGN.md concurrency corrections + HOSTING.md §3/§11 rewrites per
"Current state". The §11 rewrite composes with 018/019's edits already on
this branch — re-read the live section first.

**Verify**: `bun run check` → exit 0;
`grep -n "openReadOnly" docs/HOSTING.md` ≥2.

## Done criteria

- [ ] `ReadStore implements ReadStoreContract`; write verbs are COMPILE
      errors (negative snippet verified)
- [ ] Byte-compare test proves RO runs every verb without changing a byte
- [ ] Absent/stale index → typed `conflict` at recall/search only;
      graph reads unaffected
- [ ] Version mismatch → typed `conflict`, never a migration
- [ ] DESIGN.md immutable=1 caveat present; HOSTING §3/§11 use the new door
- [ ] `bun run check` exit 0; `plans/README.md` updated

## STOP conditions

- Any shared spine/recall/entities function turns out to WRITE on a path
  ReadStore delegates to (the design verified none do — a find here is
  drift or a missed audit; report it).
- The byte-compare fails — identify the verb and STOP (that verb is a
  hidden write; do not "fix" by excluding it silently).
- You want a new MemoryError code — decision 3 ratified reusing `conflict`.

## Maintenance notes

- Every FUTURE read verb added to `Store` should be considered for
  `ReadStoreContract` membership at review time — the contract is now the
  checklist.
- Plan 021's export verbs are writes-to-a-file but reads-of-the-store;
  the design's §9 composition note says they stay on `Store` (they audit,
  which writes) — do not add them here.
