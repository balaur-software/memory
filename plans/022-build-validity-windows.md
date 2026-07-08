# Plan 022: Build multi-window edge validity (Design B) — "left and later returned" becomes a stint

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Normative design**: `plans/design/multiwindow-validity.md` (in-repo) —
> §3/B the insertEdge three-way branch, §4 the asOf expectation tables
> (they become the golden scenario's assertions), §5 the
> renumber-before-rewire merge fix, §9 the build skeleton (schema SQL
> verbatim). Owner decisions confirmed 2026-07-08 as recommended: build B;
> overlapping windows REFUSED at insertEdge and surfaced as `conflict` in
> merge; ship `edgeHistory(source, target, type)`; closeEdge unchanged; no
> `edge.reopen` audit action; HOSTING §11 rebuy sentence ships. Read §3–§9
> in full before starting.
>
> **Drift check (run first)**: `git diff --stat f1b168a..HEAD -- src/storage/schema.ts src/spine.ts src/entities.ts src/contract.ts src/store.ts test/conformance test/fixtures docs/TEMPORAL.md docs/SCHEMA.md docs/HOSTING.md`
> Expect plans 018–021's documented edits on the stacked branch; anything
> else in these files, STOP.

## Status

- **Priority**: P2 (highest blast radius — LAST in the chain deliberately)
- **Effort**: L
- **Risk**: MED-HIGH (schema v5 with a full edges-table rebuild; merge
  semantics change)
- **Depends on**: plans/021-build-export-restore.md (stacking);
  substantively on plan 006's transactional-migration shape (landed).
- **Category**: direction/build
- **Planned at**: commit `f1b168a`, 2026-07-08

## Why this matters

An ordinary life event — Ana rejoins Siemens, the owner re-buys a sold
asset — dead-ends today in `conflict: "a closed fact stays closed"`. The
demand evidence is the repo's own: a pinned regression encodes the
refusal, HOSTING §11's endorsed finance pattern walks hosts into it, and
task blocking (plan 018's `blocked_by`) re-creates it. The ratified
design (B, sequence-keyed rows) was probe-verified read-equivalent to the
alternative with zero predicate changes, and its merge path can be made
strictly lossless — the deciding property for a 40-year file.

## Current state

(Stacked baseline: re-run `bun test` and record the count first.)

- `src/storage/schema.ts` — `SCHEMA_VERSION = 4`; the `v < N` transactional
  ladder (plan 006); edges DDL has `UNIQUE (source, target, type)`.
  The v5 rebuild SQL is in design §9 VERBATIM (create edges_v5 with
  `seq INTEGER NOT NULL DEFAULT 1` + `UNIQUE(source,target,type,seq)`,
  INSERT-SELECT with seq=1, DROP, RENAME, recreate `idx_edges_target`).
  Probe-verified: the UNIQUE swap REQUIRES this rebuild (no ALTER path).
- `src/spine.ts` `insertEdge` — the `ON CONFLICT ... DO NOTHING` +
  closed-triple throw becomes the three-way branch (design §3/B):
  1. no row for the triple → insert seq=1 (today's create path);
  2. latest row OPEN → idempotent return of that row (today's behavior;
     "latest" = MAX(seq));
  3. latest row CLOSED → validate the NEW window does not overlap ANY
     existing window on the triple (ratified decision 2 — refuse with
     `conflict` naming the overlapping stint), then insert seq = max+1.
     `audit "edge.create"` fires normally (decision 5: no reopen action).
  Preserve every existing refusal (system types timeless, until<=from,
  strict ISO).
- `src/spine.ts` `closeEdge` — UNCHANGED (decision 4; targets one row).
- New read (decision 3): `edgeHistory(source: NodeId, target: NodeId,
  type: string): Edge[]` — all stints oldest-first (`ORDER BY seq ASC`);
  id-gated semantics like `edgesOf` (plan 018): exclude nothing by
  status, but if EITHER endpoint is `surfacing='never'`… mirror
  `edgesOf`'s never-endpoint rule for the endpoint the caller did not
  name — both are named here, so no exclusion; document that reasoning in
  the contract docstring. Wire contract + store + conformance op.
- `src/entities.ts` `decideIdentity` merge rewire — replace the blind
  `UPDATE OR IGNORE` + collision-DELETE with renumber-before-rewire
  (design §5): for each of the dup's edge rows toward a (peer, type),
  compute the next free seq on (keep, peer, type) and move it there —
  NO row is ever dropped by IGNORE. Overlap between keep's and dup's
  windows on the same triple → throw `conflict` telling the owner to
  close/adjust first (ratified decision 2's merge half). NOTE: the merge
  is deliberately non-atomic by doctrine; the overlap CHECK must
  therefore run BEFORE any rewiring starts (pre-flight scan), so the
  refusal happens with nothing yet moved.
- `test/fixtures/` — generate + commit `v4.db` via
  `test/fixtures/make-fixtures.ts` (extend it; plan 006's convention) and
  add the v4→v5 upgrade test in `src/perpetuity.test.ts` (multi-row edges
  survive with seq=1, FK cascade intact after rebuild — verify
  `PRAGMA foreign_key_check` clean post-migration).
- Conformance:
  - Fix the runner's `children` asOf gap FIRST (design §6/§9 step 6):
    thread `ex.asOf` into the `store.children()` call, matching the
    neighborhood/entityContext handlers. (Prerequisite — the golden
    scenario needs it.)
  - `temporal-siemens-twice.scenario.json` — §4's tables verbatim as
    assertions (stint 1, gap, stint 2, NOW; neighborhood/children/
    entityContext × asOf).
  - REWRITE the now-obsolete refusal step in
    `temporal-siemens-years.scenario.json` (the `expectError: "conflict"`
    re-link step becomes a success step under B — design §9 says
    deliberately rewrite, never leave it silently failing).
  - `merge-multiwindow-collision.scenario.json` — every stint survives a
    merge renumbered; the overlap case refuses.
- Docs: `docs/SCHEMA.md` v5 section + I15 amendment (multi-window: the
  new UNIQUE, the no-overlap rule); `docs/TEMPORAL.md` — the deferral
  section becomes the shipped design (visit the "closed fact stays
  closed" doctrine text and reword: a closed fact stays closed — a rehire
  is a NEW stint, not a reopening); `docs/HOSTING.md` §11 gains the rebuy
  sentence (decision 6: "rebuying opens a new stint on the same edge
  triple — `link()` just works"); README status paragraph mentions
  nothing version-specific (check; only SCHEMA.md carries versions now).
- The insertEdge error message at `src/spine.ts` quoting "reopen
  semantics are deliberately deferred (TEMPORAL.md)" — dies with this
  plan; grep for it after Step 2 and confirm gone.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Suites    | `bun test src/spine.test.ts src/entities.test.ts src/temporal.test.ts src/perpetuity.test.ts test/conformance/runner.test.ts` | all pass |

## Scope

**In scope**: `src/storage/schema.ts`, `src/spine.ts`, `src/entities.ts`,
`src/contract.ts`, `src/store.ts`, `src/index.ts` (edgeHistory export),
`test/fixtures/make-fixtures.ts` + `test/fixtures/v4.db` (new),
`src/spine.test.ts`, `src/entities.test.ts`, `src/temporal.test.ts`,
`src/perpetuity.test.ts`, `test/conformance/` (runner asOf fix + 2 new +
1 rewritten scenario), `docs/SCHEMA.md`, `docs/TEMPORAL.md`,
`docs/HOSTING.md`.

**Out of scope**: `closeEdge` semantics; any audit-action addition;
`edgesOf` (plan 018 — already on the branch; its tests must stay green
untouched); Design A artifacts (no edge_validity table).

## Git workflow

- Branch: `advisor/022-validity-windows` from `advisor/021-export-restore`
- Suggested commit: `feat(temporal)!: multi-window edge validity (schema v5, sequence-keyed stints) — a rehire is a new stint`
- Do NOT push or open a PR.

## Steps

### Step 1: Schema v5 + fixture

`V5_DDL` from design §9 verbatim; `SCHEMA_VERSION = 5`; new
`if (v < 5) db.transaction(...)` rung on the ladder AND the fresh-create
path's transaction gains `db.exec(V5_DDL)`. WAIT — the fresh path creates
edges via MEMORY_DDL with the OLD unique; cleanest: update... NO — "never
edit an applied migration" applies to V2–V4 DDL strings, and MEMORY_DDL
is the baseline applied to fresh stores idempotently; per plan 006's
shape the fresh path execs the baseline then all deltas in one
transaction — V5's rebuild runs fine on a fresh empty edges table. Leave
MEMORY_DDL untouched; V5 rebuilds it. Extend `make-fixtures.ts` with a
v4 generator (current-minus-v5 shape = today's full DDL), regenerate
`v4.db`, commit it; add the v4→v5 perpetuity test (data survives, seq=1
backfilled, `PRAGMA foreign_key_check` empty, upgrade is transactional —
reuse the plan-006 shim pattern to prove a mid-v5 crash rolls back).

**Verify**: `bun test src/perpetuity.test.ts` → all pass incl. the new
rollback + fixture tests.

### Step 2: insertEdge three-way branch + edgeHistory

Per "Current state". The overlap check: a new window `[from, until)`
(nulls = open-ended) overlaps an existing `[f2, u2)` iff
`(from < u2 OR u2 IS NULL) AND (f2 < until OR until IS NULL)` — with the
convention that a NEW stint on a closed-latest triple must declare
`validity.from` ≥ the latest `valid_until` unless it has no dates at all
(an undated re-link after a closed stint: REFUSE with a message requiring
an explicit `validity.from` — an undated second stint would overlap the
dated first by the open-ended rule; state this in the error and pin it in
a test).

Tests (`src/spine.test.ts`/`src/temporal.test.ts`): rehire happy path
(close, re-link with later from → new id, seq 2); idempotency still holds
on the open stint; overlap refusals (both the dated-overlap and the
undated-second-stint case); `edgeHistory` returns both stints oldest
first; the old "closed fact stays closed" message is gone.

**Verify**: `bun test src/spine.test.ts src/temporal.test.ts` → all pass.

### Step 3: Merge renumber-before-rewire

Per design §5 with the pre-flight overlap scan. Tests
(`src/entities.test.ts`): merge two people each holding multi-stint
histories at the same org → ALL stints survive on the keeper, renumbered,
zero rows lost (COUNT before/after); overlapping-windows merge → refuses
`conflict` with NOTHING moved (assert edges unchanged after the throw).

**Verify**: `bun test src/entities.test.ts` → all pass.

### Step 4: Conformance

Runner `children` asOf fix; `edgeHistory` op; the two new scenarios +
the deliberate rewrite of `temporal-siemens-years.scenario.json` per
"Current state". Update `docs/CONFORMANCE.md` op vocabulary.

**Verify**: `bun test test/conformance/runner.test.ts` → all pass; the
rewritten Siemens scenario's old refusal step is gone
(`grep -c "expectError" test/conformance/temporal-siemens-years.scenario.json`
reflects the rewrite you made deliberately — state the number in NOTES).

### Step 5: Docs

SCHEMA.md v5 + I15 amendment; TEMPORAL.md reword; HOSTING §11 rebuy
sentence. README invariant count unchanged (I15 amended, not added — if
you ADD an I18 instead, update the counts everywhere per plan 010's
self-maintaining phrasing; prefer amending I15, the design's framing).

**Verify**: `bun run check` → exit 0.

## Done criteria

- [ ] Rehire works: close → re-link → new stint, seq=2, asOf reconstructs
      both eras exactly per design §4's tables (scenario-pinned)
- [ ] Overlaps refused at insertEdge AND pre-flight in merge; merge loses
      zero rows (count-pinned)
- [ ] v4.db fixture committed; v4→v5 upgrade + crash-rollback tests green
- [ ] Runner threads asOf through children expectations
- [ ] Old refusal message gone: `grep -rn "deliberately deferred" src/` → 0
- [ ] `bun run check` exit 0; `plans/README.md` updated

## STOP conditions

- The v5 rebuild breaks FK cascade behavior (`PRAGMA foreign_key_check`
  non-empty post-migration) — report; do not paper over with PRAGMA
  toggles beyond the documented `foreign_keys` handling around table
  rebuilds (if you must disable/re-enable FKs around the rebuild inside
  the transaction, verify SQLite permits it there; if not, STOP and
  report the constraint — this is the plan's known hardest edge).
- Any existing temporal/merge scenario changes result OTHER than the one
  deliberately rewritten step.
- The undated-second-stint semantics feel wrong mid-build — that exact
  rule was ratified (decision 2's refuse-overlap); report rather than
  soften it.

## Maintenance notes

- Future reads over validity keep working with zero predicate changes —
  that was B's selling point; a reviewer should verify no new read
  accidentally assumes one-row-per-triple (grep for `LIMIT 1` on edges
  queries by triple).
- `edgeHistory` + plan 018's `edgesOf` together are the full edge-read
  surface; if a host wants "all stints for a node" it composes them.
- The v5 fixture generator now covers v1–v4; v5 joins the set when v6
  ever ships.
