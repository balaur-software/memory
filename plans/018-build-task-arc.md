# Plan 018: Build the task arc — props.due convention, deadlineCandidates, deadlines(), edgesOf(), episode statuses

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Normative design**: `plans/design/task-arc.md` (in-repo, committed) —
> §3 (gap inventory: exact shapes), §4 (the ratified package), §5
> (decisions, all confirmed 2026-07-08 as recommended: B-extended; ship
> edgesOf; episode statuses + recipe; recordDerivation correction; tick.ts
> sample; no priority change). Read §3–§5 in full before starting.
>
> **Drift check (run first)**: `git diff --stat f1b168a..HEAD -- src/doctor.ts src/recall.ts src/spine.ts src/contract.ts src/store.ts docs/HOSTING.md docs/PLANNING.md test/conformance`
> On any in-scope drift, compare the design doc's cited excerpts against
> live code; on mismatch, STOP.

## Status

- **Priority**: P1 (owner-requested feature)
- **Effort**: M
- **Risk**: LOW (four pure reads + docs; zero schema change)
- **Depends on**: none (branches from main @ f1b168a; merged chain includes plans 001–014)
- **Category**: direction/build
- **Planned at**: commit `f1b168a`, 2026-07-08 (design ratified same day)

## Why this matters

The owner asked for deadlines and real task management. The ratified
design (task-arc.md §4) closes every probed gap with zero schema risk:
a blessed `props.due` convention made queryable by two new reads, the
`edgesOf(id)` read that makes "unblock this task" possible at all (no
public read returns Edge ids today), a `statuses` option so `episode()`
can see non-active outcomes, and HOSTING recipes for the tick and
recurrence lineage (fixing the live `link(...,"derived_from")` trap that
silently bypasses real lineage).

## Current state

Baseline: 169 tests / 13 files, `bun run check` exit 0 on main @ f1b168a.

- `src/doctor.ts:~120-127` — `dueCandidates`: the lens `deadlineCandidates`
  mirrors (same `CANDIDATE_CAP` 20, oldest-first, `never`/day excluded),
  but sourced from `json_extract(props,'$.due')`.
- `src/recall.ts` `agenda()` — the window read `deadlines()` mirrors
  (same strict-ISO bounds, half-open `[from,to)`, active + `always` only,
  same limit validation), sourced from `json_extract(props,'$.due')`,
  ordered by the due value ASC then id ASC.
- `src/recall.ts` `episode()` — gains `statuses?: readonly Status[]`
  in opts (default `["active"]`, validated against the known set — copy
  `children()`'s validation at `src/spine.ts` exactly). Window stays keyed
  on `created` (design §3.3 — do NOT touch the time axis).
- `src/spine.ts` `neighborhood()` — the bidirectional join `edgesOf`
  mirrors; `EDGE_COLS`/`rowToEdge` already exist in that file.
- `edgesOf` exact contract (design §3.2, ratified):
  ```ts
  edgesOf(id: NodeId, opts?: { type?: string; asOf?: string }): Edge[];
  ```
  Both directions; currently-valid by default, `asOf` time-travels;
  EXCLUDE edges whose OTHER endpoint has `surfacing='never'` (the
  neighborhood rule — leaking the id of a never node is discovery);
  include `ask` endpoints; do NOT filter system edge types.
- `src/contract.ts` + `src/store.ts` — one declaration + one delegation
  per new read; `DoctorReport` gains `deadlineCandidates: readonly NodeId[]`.
- Conformance: the runner asserts `expectError` against `MemoryError.code`
  (strict since plan 011); add ops for `edgesOf` and `deadlines` following
  the runner's existing switch pattern; the `doctor` op exists (plan 014).
- Docs: `docs/PLANNING.md` "Hosting conventions" gains the `props.due`
  convention addendum (NOT a schema section); `docs/HOSTING.md` §4 gets
  the `recordDerivation` correction (replace/augment the
  `link(..., "derived_from")` example — design §3.4), §5 gets due +
  edgesOf examples, and the closing "daily tick" section gets the
  runnable `tick.ts` sample (copy from design §3.5, adjusting only if the
  APIs added here change a call).

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Suites    | `bun test src/doctor.test.ts src/recall.test.ts test/conformance/runner.test.ts` | all pass |

## Scope

**In scope**: `src/doctor.ts`, `src/recall.ts`, `src/spine.ts` (edgesOf +
episode-statuses helper reuse only), `src/contract.ts`, `src/store.ts`,
`src/doctor.test.ts`, `src/recall.test.ts`, `src/spine.test.ts`,
`test/conformance/` (runner ops + 3 scenarios), `docs/HOSTING.md`,
`docs/PLANNING.md`.

**Out of scope**: any schema change (`src/storage/schema.ts` untouched —
that is Option A, NOT ratified); `when_at`/`agenda`/`dueCandidates`
semantics (unchanged); `episode()`'s time axis; the propsSchema type
union.

## Git workflow

- Branch: `advisor/018-task-arc` from `main` (verify
  `git rev-parse --short main` → `f1b168a`; STOP if different)
- Suggested commit: `feat(planning): the task arc — props.due convention, deadlineCandidates, deadlines(), edgesOf(), episode statuses`
- Do NOT push or open a PR.

## Steps

### Step 1: `edgesOf` (independent, land first)

`src/spine.ts`: new exported `edgesOf(ctx, id, opts)` per the contract
above, modeled on `neighborhood()`'s query but selecting `EDGE_COLS` and
joining nodes only to apply the never-endpoint exclusion. `contract.ts`
declaration + docstring (id-gated like `history()`; never-endpoints
excluded, ask included, system types included); `store.ts` delegation.

Tests (`src/spine.test.ts`): link a→b and c→a; `edgesOf(a)` returns both
with correct direction fields; close one edge → drops from default read,
reappears under `asOf` inside its window; set b `surfacing='never'` →
a↔b edge vanishes from `edgesOf(a)`; `on_day` edges DO appear; the
returned id feeds `closeEdge` successfully (the probe-confirmed gap).

**Verify**: `bun test src/spine.test.ts` → all pass.

### Step 2: `deadlineCandidates` + `deadlines()`

- `src/doctor.ts`: `deadlineCandidates` — active, `surfacing != 'never'`,
  `type != 'day'`, `json_extract(props,'$.due') IS NOT NULL AND <= now`,
  ORDER BY that value ASC, id ASC, LIMIT `CANDIDATE_CAP`. Add the field to
  `DoctorReport` in `contract.ts` with a docstring naming the convention
  ("props.due — declared ISO strings; malformed values simply never
  surface, the documented cost of the convention, design §2/B").
- `src/recall.ts`: `deadlines(ctx, from, to, opts)` mirroring `agenda()`
  body-for-body (bounds validation, limit validation, active+always,
  typed/untyped day handling) with `json_extract(props,'$.due')` as the
  axis. `contract.ts` + `store.ts` wiring.

Tests (`src/doctor.test.ts`, `src/recall.test.ts`): a task with
`props.due` past → in `deadlineCandidates`, one with future due → only in
`deadlines(window)`; malformed due (`"next week"`) → surfaces in NEITHER
(documented behavior, assert it); `ask`/`never` exclusions; ordering.

**Verify**: `bun test src/doctor.test.ts src/recall.test.ts` → all pass.

### Step 3: `episode()` statuses option

Add `statuses?: readonly Status[]` to episode's opts (contract + recall +
store): default `["active"]`, validate against the known status set
(copy `children()`'s check verbatim), apply as `status IN (...)` in the
SQL. Surfacing filter stays `always` (unchanged).

Tests: archived-with-outcome task created in-window appears with
`statuses: ["archived"]` and not by default.

**Verify**: `bun test src/recall.test.ts` → all pass.

### Step 4: Conformance

Runner: add `edgesOf` and `deadlines` ops + expectation forms following
the existing patterns (edges compare by type/direction; deadlines by
`titlesInOrder`). Scenarios: (1) `planning-deadlines.scenario.json` —
due convention: candidates + window + malformed-due-never-surfaces;
(2) `edges-of.scenario.json` — directions, closeEdge round-trip, asOf,
never-endpoint exclusion; (3) extend `project-dashboard.scenario.json`
or new `episode-statuses.scenario.json`. Update `docs/CONFORMANCE.md`'s
op vocabulary list.

**Verify**: `bun test test/conformance/runner.test.ts` → all pass.

### Step 5: Docs

Per "Current state" last bullet: PLANNING.md addendum, HOSTING.md §4
recordDerivation correction, §5 examples, tick.ts sample (run the sample
once against a scratch store before committing it — samples that don't
run are the doc drift this repo hates; stub `dueRecurrences`/
`materializeNext`/`renderQueue` inline as the design's sample implies or
inline minimal versions).

**Verify**: `bun run check` → exit 0; the tick sample executes against a
scratch dir without throwing.

## Done criteria

- [ ] Four new surfaces live: `doctor().deadlineCandidates`,
      `store.deadlines()`, `store.edgesOf()`, `episode(..., {statuses})`
- [ ] The probe gap closed: an edge id recovered via `edgesOf` feeds
      `closeEdge` (test exists)
- [ ] 3 conformance scenarios green under the strict runner
- [ ] HOSTING §4 no longer recommends `link(..., "derived_from")` for
      recurrence lineage
- [ ] `bun run check` exit 0; no `src/storage/schema.ts` diff
- [ ] `plans/README.md` status row updated

## STOP conditions

- You find yourself editing `src/storage/schema.ts` or adding a `due_at`
  column — that is Option A; not ratified.
- An existing conformance scenario changes result (the additions must be
  purely additive).
- `agenda()`/`dueCandidates` behavior would need to change to make
  `deadlines`/`deadlineCandidates` coherent — report; the design says
  they are parallel, untouched axes.

## Maintenance notes

- If Option A (`due_at` column) is ever ratified later, `deadlines()`/
  `deadlineCandidates` become its readers with the same names — the
  convention-to-column upgrade path is the design's stated migration
  story (§2/§5 decision 1).
- Plan 022 (validity windows) touches `insertEdge`; `edgesOf` reads are
  unaffected by it (per-row predicates), but its tests gain value there.
