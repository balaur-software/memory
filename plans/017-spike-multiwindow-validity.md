# Plan 017: Design spike — multi-window edge validity ("left and later returned")

> **Executor instructions**: This is a DESIGN SPIKE — deliverable is a
> design doc, no production changes. "Re-defer with a documented
> workaround" is an explicitly acceptable outcome. Follow the steps; on a
> STOP condition, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- src/spine.ts docs/TEMPORAL.md docs/HOSTING.md src/entities.ts`
> On drift, re-read before designing.

## Status

- **Priority**: P3
- **Effort**: S–M (spike; any build is L and its own plan)
- **Risk**: LOW (spike) — the BUILD under study is the highest-blast-radius
  change in the audit (uniqueness key, merge rewire, every asOf read,
  conformance)
- **Depends on**: plans/006-migration-durability.md conceptually (a v5)
- **Category**: direction / design
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

An ordinary life event — Ana rejoins Siemens; the owner moves back to
Brasov — dead-ends in a loud error today. `insertEdge` on a CLOSED
`(source, target, type)` triple throws
`conflict: "…a closed fact stays closed; reopen semantics are deliberately
deferred (TEMPORAL.md)"` (`src/spine.ts:634-640`). The deferral is
ratified (`docs/TEMPORAL.md:239-244`: "Multi-interval validity … is the
honest future design **if real use demands it** — deferred, stated"), and
it was conditioned on demand. The demand evidence is accumulating:
review-3 A2 records that the PREDECESSOR behavior (silently swallowing the
re-link) was an actual bug hit by the repo's own probes
(`src/spine.ts:630-633`), and HOSTING.md §11's endorsed finance pattern
("assets you sold get an `owns` edge with `valid_until`") walks every host
straight into the refusal on any re-acquisition. Hosts will work around
it with mangled edge types (`works_at_2`), fragmenting exactly the graph
`asOf` exists to reconstruct.

## Current state (read before designing)

- `src/spine.ts:595-647` — `insertEdge`: idempotent on OPEN triples via
  `ON CONFLICT(source, target, type) DO NOTHING`; throws on CLOSED. The
  UNIQUE key (`src/storage/schema.ts:54-62`): `UNIQUE (source, target, type)`.
- `src/spine.ts:649-669` — `closeEdge`.
- Every validity predicate (the sites a design must update) —
  `(e.valid_from IS NULL OR e.valid_from <= ?) AND (e.valid_until IS NULL OR e.valid_until > ?)`:
  `children` (`spine.ts:348-359`), `neighborhood` (`spine.ts:378-392`),
  `entityContext` (`entities.ts:416-433`).
- The merge rewire (`src/entities.ts:294-315`): `UPDATE OR IGNORE … SET
  source/target` + collision deletes — semantics under multiple windows
  per triple need re-derivation (which window survives a collision?).
- `docs/TEMPORAL.md` — the whole design doc, especially the deferral
  section and the "closed fact stays closed" doctrine; the golden
  conformance scenario `test/conformance/temporal-siemens-years.scenario.json`.
- Conformance surface: `merge-adversarial-edges.scenario.json`,
  `I3-neighborhood-active-only.scenario.json`, golden scenarios pin edge
  behavior.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Probes    | `bun <script>.ts` in /tmp scratch | probe output |
| Gate      | `bun run check`      | exit 0 (tree untouched) |

## Scope

**In scope**: `plans/design/multiwindow-validity.md` (create), probes.

**Out of scope**: production code; changing the "closed fact stays closed"
error TODAY (the workaround documentation, if that's the outcome, is a
HOSTING.md edit for a follow-up plan).

## Steps

### Step 1: Enumerate the designs with migration + semantics costs

At minimum:

- **A. Windows table**: `edge_validity(edge_id, valid_from, valid_until)`
  child rows; edges table keeps one row per triple. Costs: v5 migration
  moving existing validity columns into rows; every predicate becomes an
  EXISTS subquery; merge rewire mostly unchanged (edge row still unique);
  closeEdge closes the OPEN window; insertEdge on closed triple OPENS a
  new window.
- **B. Sequence-keyed rows**: `UNIQUE(source, target, type, seq)`; each
  stint is its own edge row. Costs: v5 migration rewriting the unique
  index; predicates unchanged (still per-row); idempotency needs
  "the open row" resolution; merge rewire collision semantics need
  redefinition; edge IDENTITY changes (multiple EdgeIds per relationship).
- **C. Bless the convention, build nothing**: a documented HOSTING.md
  pattern — a closed stint stays closed; a new stint is a NEW edge with a
  `context` marker (e.g. `resumes: <old edge id>`) and a *different*
  type? No — same type is the whole point; C must honestly confront that
  the UNIQUE constraint FORBIDS a same-type second row, making the "new
  stint" impossible without (A) or (B). If C survives at all it is
  "document the mangled-type workaround and its costs" — write that
  assessment down even if the conclusion is that C is a non-answer.
- **D. Re-defer with an explicit trigger**: name the concrete condition
  that re-opens this (e.g. "the first real host hits the refusal in
  production use").

### Step 2: The asOf semantics audit

For A and B: work through the golden Siemens scenario EXTENDED with a
rehire ("Siemens years, twice") — what do `neighborhood(asOf)`,
`children(asOf)`, `entityContext(asOf)` return in each design at t inside
stint 1, between stints, inside stint 2, and at NOW. Write the expected
tables; this becomes the conformance scenario of any build.

### Step 3: The deliverable

`plans/design/multiwindow-validity.md`: the design matrix with migration
costs, the asOf semantics tables, the merge-rewire analysis, a
recommendation (including possibly D — with its trigger), and the
owner-decision list. If the recommendation is A or B, include the build
plan's skeleton (steps + conformance scenarios) so the follow-up plan is
cheap to write.

**Verify**: doc exists; `bun run check` exit 0; tree untouched.

## Done criteria

- [ ] `plans/design/multiwindow-validity.md` with ≥4 designs costed, asOf
      semantics tables for A and B, merge analysis, one recommendation,
      owner-decision list
- [ ] No changes outside `plans/` (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The Siemens-twice walkthrough exposes an ambiguity in EXISTING asOf
  semantics (single-window) — that's a doc/bug finding first; report it
  before designing on sand.

## Maintenance notes

- Whichever design is ratified, plan 006's transactional-migration rule
  governs the v5; the golden "Siemens years, twice" scenario from Step 2
  should ship WITH the build, not after.
- Plan 012 (task arc) touches `blocked_by`/`waiting_on` edges — a task
  blocked, unblocked, and re-blocked is the SAME pattern; note the
  cross-dependency in the design doc.
