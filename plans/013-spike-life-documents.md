# Plan 013: Design spike — long-form Markdown notes and tabular (CSV/spreadsheet) life data

> **Executor instructions**: This is a DESIGN SPIKE, not a build plan. The
> deliverable is a design document + probe evidence + a decision list for
> the owner — no production code changes. Follow the steps; if a STOP
> condition occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- docs/HOSTING.md docs/SCHEMA.md src/spine.ts src/types.ts src/indexdb/fts.ts`
> On drift, re-read before designing — the spike is about these semantics.

## Status

- **Priority**: P2 (owner-requested 2026-07-07)
- **Effort**: M (spike only)
- **Risk**: LOW (no code changes)
- **Depends on**: plans/006-migration-durability.md conceptually (any v5
  proposal assumes transactional deltas)
- **Category**: direction / design
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

The owner stated (2026-07-07): *"I want this schema to be able to hold in
the future long-form notes in md format and also csv or spreadsheet data.
I will want to have it store information about my life."* The library is
the memory layer of a personal life OS; these are the two content shapes
it doesn't yet have a blessed answer for.

Probes already run (2026-07-07, findings to build on, re-run to confirm):

- **Long-form MD works mechanically**: a 206KB markdown body created in
  3.2ms; FTS found a needle buried ~150KB deep in 0.7ms. `nodes.body` is
  unbounded TEXT in a STRICT table; FTS5 indexes it whole.
- **But history amplifies**: `memory_history` snapshots the FULL
  title/body/props on every owner edit (`src/spine.ts:537-558`) — one
  206KB note edited 10× cost 3.0MB on disk (~14×). A daily-edited journal
  grows the record fast. (Made survivable by plan 004's checkpointing +
  secure_delete, but the growth itself is a policy question.)
- **Tabular data has a proven shape**: HOSTING.md §11 (net worth) — one
  node per row (`holding` snapshots), typed props, `snapshot_of` edges,
  SQL over the read-only file, append-only corrections. It generalizes.
- **But the gaps for a real CSV import**: `propsSchema` supports only
  `string | number | boolean` primitives (`src/types.ts:75-83`) — no
  arrays, objects, or date type (holdings works around with integer
  minor-units and strict-ISO strings); there is no bulk-import verb (5,000
  rows = 5,000 `createNode` calls, each also minting an `on_day` edge to
  the import day — flooding that day's `episode()` view); and export back
  out doesn't exist (plan 016's subject).

## Current state (read before designing)

- `src/storage/schema.ts:31-50` — the nodes DDL (`body TEXT NOT NULL`,
  `props TEXT`, STRICT).
- `src/spine.ts:537-558` — `snapshotHistory` (the amplification site);
  `src/spine.ts:271-285` — `fanOut` (FTS upsert + `linkOnDay` on every
  create — the import-flood site); `src/spine.ts:174-201` —
  `applyTemplateAndValidate` (the primitives-only schema enforcement).
- `src/types.ts:75-83` — `NodeTypeSpec.propsSchema`'s type.
- `docs/HOSTING.md` §7 (capture-wrapper vocabulary: bracketed-category
  observation prose — the existing convention for entity content), §3
  (measurements), §11 (net worth / holdings — the tabular precedent).
- `docs/SCHEMA.md` "Deliberate schema choices" (line 309+) — what was
  already considered and rejected; do not re-propose against it.
- `docs/TEMPORAL.md` retention deferral: "the doctor reports it first (a
  future `historyRows` metric)" — plan 014 adds that metric; this spike's
  history policy should compose with it.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Probes    | `bun <script>.ts` in a /tmp scratch dir | probe output |
| Gate (unchanged tree) | `bun run check` | exit 0 |

## Scope

**In scope**: `plans/design/life-documents.md` (create), probe scripts.

**Out of scope**: any change under `src/`, `test/`, `docs/`.

## Steps

### Step 1: Long-form MD — probe the real costs, then design the pattern

Probes: (a) reproduce the 14× history amplification and extend it — 50
edits, measure; (b) recall ranking on long docs — does bm25's length
normalization bury a 200KB note vs a 2-line note for the same term hits
(create both, compare rank)? (c) FTS index size share for long bodies.

Design questions to answer in the doc:
1. **The convention**: a `document`/`note` type in HOSTING.md (new §12) —
   `body` = raw markdown, `props.format: "markdown"`, title = H1? What
   surfacing default (journals are `ask`/`never` material)?
2. **History policy** (the real decision): options — (i) status quo +
   doctor `historyRows` visibility (plan 014) + a documented owner
   retention recipe; (ii) a per-type snapshot opt-out at registerType
   (`history: "none" | "full"` — a consent-adjacent semantic: what does
   I16 mean for a type that opted out?); (iii) size-threshold snapshots
   (snapshot only when body < N KB — a silent hole in "what did this used
   to say"; probably argue against). Cost each against I16 ("history dies
   with the tombstone") and TEMPORAL.md's retention deferral.
3. **Recall shape**: is FTS-on-full-body right for 200KB docs, or should
   the pattern bless section-nodes (one node per H2, `part_of` the doc)
   like the holdings row-per-node shape? Probe (b) informs this.

### Step 2: Tabular data — generalize the holdings pattern

Design questions:
1. **The row-per-node recipe**: a HOSTING.md §13 "tables" pattern — one
   type per sheet, one node per row, `props` = columns (typed via
   propsSchema), `part_of` → a table/collection node; corrections
   append-only like holdings? Where does it break (wide sheets, >10k
   rows)? Probe: import a realistic 2,000-row CSV via `createNode` loop —
   measure time, file size, `episode()` pollution of the import day.
2. **propsSchema richness**: does tabular life data NEED arrays/objects/
   dates in the schema language, or do conventions (ISO strings +
   minor-units, one prop per column) suffice? If a richer schema is
   recommended: cost it (validation code, SCHEMA.md contract change — NOT
   a db migration; props_schema is already free-form JSON).
3. **Bulk import ergonomics**: options — (i) a documented host recipe
   (loop + one `dayAnchor` link for the BATCH node instead of per row?);
   (ii) a library `importNodes(rows, opts)` choke-point verb (audited
   once, content-free count; skips per-row `on_day`, links rows
   `part_of` a batch node) — weigh against "zero planning-specific
   machinery" doctrine and I12 audit semantics; (iii) accept the flood
   (argue why not). NOTE the `on_day` fan-out cost found by the perf
   audit (`ensureDayNode` scans day rows per create — `src/spine.ts:297`);
   a batch verb sidesteps it, a recipe doesn't.
4. **Blob reality check**: actual spreadsheet FILES (.xlsx) are out —
   confirm the doctrine (the store holds declared data, not opaque blobs;
   `origin` points at the source file; lineage `derived_from` covers
   derived rows). State it explicitly so the owner ratifies the boundary.

### Step 3: Write the design doc

`plans/design/life-documents.md`: probe results with numbers; the MD
pattern (§12 draft text); the tables pattern (§13 draft text); the history
policy options costed against I16; propsSchema recommendation; bulk-import
recommendation; and a numbered **"Decisions for the owner"** list, each
with a recommendation (mirror PLANNING.md:197-230 style).

**Verify**: doc exists; `bun run check` exit 0 (tree untouched); every
current-behavior claim carries `file:line`.

## Done criteria

- [ ] `plans/design/life-documents.md` exists: probe numbers, two HOSTING
      pattern drafts, history-policy matrix, propsSchema + bulk-import
      recommendations, numbered owner-decision list
- [ ] No changes outside `plans/` (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- A probe contradicts the 2026-07-07 baseline numbers dramatically (e.g.
  long-body recall broken outright) — that's a bug finding first; report.
- `docs/SCHEMA.md` "Deliberate schema choices" already rejects a shape you
  were about to recommend — present the conflict, don't override silently.

## Maintenance notes

- The history-policy decision interacts with plan 014's `historyRows`
  doctor metric (visibility before policy — the repo's own preferred
  order per TEMPORAL.md).
- If a bulk-import verb is ratified, it must route through `insertNode`'s
  choke point (I10/I12 hold by construction) — a build-plan requirement,
  written here so it survives.
