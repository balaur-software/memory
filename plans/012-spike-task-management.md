# Plan 012: Design spike — deadlines and real task management on the planning arc

> **Executor instructions**: This is a DESIGN SPIKE, not a build plan. The
> deliverable is a design document + probe code + a decision list for the
> owner — no production code changes. Follow the steps; if a STOP condition
> occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- docs/PLANNING.md docs/HOSTING.md src/doctor.ts src/recall.ts src/contract.ts`
> On drift in these files, re-read them before writing the design doc —
> this spike is ABOUT their current semantics.

## Status

- **Priority**: P2 (owner-requested 2026-07-07)
- **Effort**: M (spike only; any build is a follow-up plan)
- **Risk**: LOW (no code changes) — the DESIGNS under study range MED–HIGH
- **Depends on**: plans/006-migration-durability.md conceptually (any v5
  migration this spike proposes assumes transactional deltas exist)
- **Category**: direction / design
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

The owner stated (2026-07-07): *"for tasks I want to be able to put
deadlines and have proper task management."* The planning arc
(docs/PLANNING.md, schema v4) deliberately shipped ONE time axis —
`when_at`, named "not `due_at` — events happen, they aren't due"
(PLANNING.md:72-73) — and mapped work states onto the existing FSM +
`props.outcome` convention. A real task often carries TWO times (the
scheduled/do moment and the deadline), and today a host must pick one for
`when_at` and hide the other in props where `agenda()` and
`doctor().dueCandidates` cannot see it.

PLANNING.md also pre-commits a decision rule this request satisfies: "a
second axis needs a demonstrated failure of the first"
(PLANNING.md:174-175, about priority — the same doctrine applies). The
owner's request IS the demonstrated need; the spike's job is to give the
owner a real decision to ratify, with costs stated, not to assume the
answer.

**Constraint inherited from the owner's same-day decision: the CLI is
dropped (plan 002). Everything here is library API + HOSTING.md host
patterns — no CLI verbs.**

## Current state (read all of these before designing)

- `docs/PLANNING.md` — the whole file, especially:
  - lines 59-75 (schema v4: `when_at` column + naming rationale),
  - 143-153 (work-state mapping table: done = `props.outcome` + archived;
    blocked/waiting = edges; recurring = `props.rrule`, HOST materializes),
  - 162-176 ("What stays out": scheduler, new FSM states, recurrence
    expansion, duration/timezones, priority-beyond-importance),
  - 197-230 (the five ratified open questions — the owner already
    confirmed `when_at` naming and no automatic day anchoring).
- `docs/HOSTING.md` §5 (task loop), §4 (recurrence/materialization
  pattern), §6 (project dashboards), "The daily tick" (line 334-341).
- `src/recall.ts:317-341` — `agenda()` (when_at window, always-surfaced
  only), `src/doctor.ts:120-127` — `dueCandidates` (when_at <= now).
- `src/contract.ts` — the read surface a task board composes from.
- Known related gap (recorded finding, relevant here): there is NO public
  edge read — `closeEdge` requires an `EdgeId` only `link()`'s return ever
  supplied, so "unblock this task" (`closeEdge` on a `blocked_by` edge) is
  impossible for a host that didn't persist edge ids. Any task-management
  design must address it (an `edgesOf(id)` read is the natural shape,
  precedented by `history()`'s id-gated rule).

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Probes    | `bun <script>.ts` in a scratch dir under /tmp | probe output |
| Gate (unchanged tree) | `bun run check` | exit 0 — this spike must leave it untouched |

## Scope

**In scope** (all under `plans/design/`):
- `plans/design/task-arc.md` (create — the deliverable)
- Probe scripts in a scratch dir (not committed, or committed under
  `plans/design/probes/` if illustrative)

**Out of scope**:
- ANY change under `src/`, `test/`, `docs/` — the spike proposes; the owner
  ratifies; a follow-up plan builds.

## Steps

### Step 1: Evidence probe — what breaks with one axis today

Write and run a probe against a scratch store exercising a realistic task
month (owner tasks with distinct do-vs-due moments, a blocked chain, a
recurring chore, a snooze, completions). Document concretely where one
axis fails: the "do Saturday, due the 15th" task must lie somewhere; the
overdue lens fires on the wrong moment; `agenda(from,to)` shows do-dates
but a "what's due this week" view is impossible without raw SQL over
props.

### Step 2: Enumerate the deadline designs with real costs

For each option, write: schema/API delta, migration cost, what
`agenda`/`dueCandidates` do, I17 interaction (declared-never-inferred),
conformance surface, and what HOSTING.md §5 rewrites to. Options to cover
(at minimum):

- **A. Schema v5 `due_at` column** (nodes + memory_history mirror, like
  when_at): first-class; doctor's due lens reads `COALESCE(due_at, when_at)`
  or gains a separate `overdueCandidates`; costs a migration + I18
  ("deadline is declared, never inferred") + PLANNING.md amendment.
- **B. Blessed `props.due` convention**: zero schema change; the doctor
  gains a lens that reads `json_extract(props,'$.due')` (metadata-only
  doctrine holds — it's still the owner's declared data); agenda stays
  when_at-only; weaker typing (no CHECK, no strict-ISO enforcement at
  write time unless the type's schema declares it).
- **C. Per-type semantics**: `when_at` MEANS "due" for `task` types and
  "happens" for events — zero schema change, but overloads one column with
  type-dependent meaning (the design doc should probably argue AGAINST
  this; write the argument down either way).

### Step 3: "Proper task management" gap inventory

Against HOSTING.md §5's current answers, assess and design (host-pattern
first, library-change only where the pattern demonstrably can't deliver):

1. **Deadlines** — Step 2's decision.
2. **Unblocking** — the `edgesOf(id)` read (id-gated like `history()`);
   sketch its contract signature and I2/I3 stance.
3. **Completion queries** — "what did I finish this week": `episode()` +
   `props.outcome` filtering is host-side today; is a `statuses` option on
   `episode()` (like `children()` has) enough?
4. **Recurrence** — PLANNING.md says host materializes; with no CLI, where
   does the reference materializer LIVE? Proposal: a documented ~30-line
   host recipe in HOSTING.md §4 (library stays scheduler-free), plus
   whether `derived_from` lineage on materialized instances should be the
   blessed convention.
5. **The daily tick without a CLI** — HOSTING.md's closing pattern
   currently implies a shell loop; rewrite target: a plain Bun script
   recipe (`tick.ts` the owner crons), composing agenda + doctor + backup.
6. **Ordering/priority** — importance 0-5 + `props.seq` (children order);
   confirm sufficient, per PLANNING.md's second-axis rule.

### Step 4: Write the design doc

`plans/design/task-arc.md` with: the probe evidence (Step 1), the design
matrix (Step 2), the gap inventory with recommendations (Step 3), a
recommended package (e.g. "B + edgesOf + episode statuses + two HOSTING
recipes" or "A + I18 + edgesOf" — argue for ONE), migration/conformance
cost of the recommendation, and an explicit **"Decisions for the owner"**
list (numbered, each with a recommendation), mirroring PLANNING.md's own
"Open questions for the owner" style (PLANNING.md:197-230).

**Verify**: the doc exists; `bun run check` still exit 0 (tree untouched);
every claim about current behavior carries a `file:line` reference.

## Done criteria

- [ ] `plans/design/task-arc.md` exists with: probe evidence, ≥3 deadline
      designs costed, gap inventory (6 items), one recommendation, numbered
      owner-decision list
- [ ] No changes outside `plans/` (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- PLANNING.md's "Open questions" turn out to have ratified something that
  contradicts a design you're about to recommend — present the conflict in
  the doc rather than picking silently.
- The probe reveals `agenda`/`dueCandidates` behavior contradicting their
  docs (that's a bug finding — report it; don't design around it silently).

## Maintenance notes

- If the owner ratifies option A (v5 `due_at`), the follow-up build plan
  MUST come after plan 006 (transactional migrations) and follow its
  "every future delta" rule.
- The `edgesOf` read is independently valuable (recorded finding) — if the
  task arc stalls, it can ship alone.
