# Plan 019: Land the life-documents patterns — HOSTING.md §12 (long-form Markdown) and §13 (tables)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Normative design**: `plans/design/life-documents.md` (in-repo) — Part 2
> is the §12 draft, Part 3 is the §13 draft, "Decisions for the owner" 1–7
> were all confirmed 2026-07-08 as recommended (adopt §12 and §13 as
> drafted; history status quo + the revise recipe; section-nodes opt-in;
> NO propsSchema change; NO bulk-import verb; .xlsx blobs out of scope).
> Read Parts 2–5 in full before starting.
>
> **Drift check (run first)**: `git diff --stat f1b168a..HEAD -- docs/HOSTING.md plans/design/life-documents.md`
> On drift, reconcile before editing.

## Status

- **Priority**: P2 (owner-requested feature; docs-only by ratified design)
- **Effort**: S
- **Risk**: LOW (documentation + verified samples; zero library change)
- **Depends on**: plans/018-build-task-arc.md ONLY for merge ordering
  (both edit `docs/HOSTING.md` — stack on 018's branch to avoid conflicts)
- **Category**: direction/build (docs)
- **Planned at**: commit `f1b168a`, 2026-07-08

## Why this matters

The owner asked for long-form Markdown notes and CSV/spreadsheet data as
supported life-data shapes. The ratified design found the LIBRARY already
handles both (206KB body: 3.2ms create, sub-ms deep recall; 2,000-row
import at 0.287ms/row) — what's missing is the blessed conventions, and
an honest statement of the two costs probes quantified: history
amplification (~70× at 50 edits of a 206KB note) and import-day
`episode()` domination. This plan lands the two HOSTING sections with
runnable samples, changing no code.

## Current state

- `docs/HOSTING.md` — numbered sections §1–§11 (§11 = net worth) plus the
  "Errors" section and the closing "The daily tick". New §12 and §13
  append after §11, before the daily-tick closing section. NOTE: plan 018
  also edits HOSTING.md (§4/§5 + tick sample) — this plan stacks on top.
- `plans/design/life-documents.md` Part 2 — the §12 draft: `document`
  type registration, body = raw markdown, title = H1, `props.format:
  "markdown"`, `surfacing: "ask"` default, the history-cost warning with
  the probe numbers, the "wording edit vs substantial rewrite → new node
  + `revises` edge + archive" recipe, and the opt-in section-node pattern
  (one node per `##`, `part_of` the doc).
- Part 3 — the §13 draft: one type per sheet, one node per row,
  propsSchema-typed columns, rows `part_of` a `table` collection node,
  append-only corrections, the import recipe, and the import-day
  episode() caveat with its typed-query mitigation (ratified decision 6:
  the gap is ACCEPTED and must be stated, not hidden).
- Baseline: 169 tests / 13 files (this plan adds none — but every code
  sample in the new sections must be EXECUTED once against a scratch
  store before committing; broken doc samples are drift by construction).

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0 (docs-only — proves no code touch) |
| Sample run | `bun <sample>.ts` in scratchpad | executes clean |

## Scope

**In scope**: `docs/HOSTING.md` (plus scratch sample-verification scripts
outside the repo), and two ONE-LINE drift fixes recorded during plan 018's
review: `docs/SCHEMA.md` (system-edge table: `derived_from` is claimed
"written by: library (recordDerivation)" — recordDerivation writes the
`derivations` TABLE, not an edge; correct the claim to match reality) and
`docs/CONFORMANCE.md` (~line 105 claims doctor() "is covered by unit
tests... rather than scenarios" — false since doctor-revision.scenario.json;
correct it).

**Out of scope**: ALL code. Specifically refused by ratified decisions:
propsSchema union changes, any bulk-import verb, history policy changes,
any new library read. If a sample won't work without a code change, STOP.

## Git workflow

- Branch: `advisor/019-life-documents-docs` from `advisor/018-task-arc`
  (verify 018's branch exists and its gate is green; STOP if missing)
- Suggested commit: `docs(hosting): §12 long-form documents + §13 tables — the life-documents patterns (probe-verified)`
- Do NOT push or open a PR.

## Steps

### Step 1: Transplant §12 from the design draft

Copy Part 2's draft into `docs/HOSTING.md` as `## 12 · Long-form
documents (journals, essays, life notes)`, editing only for flow with the
surrounding sections (match §11's voice: register-once block, worked
code, rules-of-thumb bullets). MUST retain: the history-amplification
numbers and the revise-recipe (decision 2), the section-node pattern
marked opt-in (decision 3), `surfacing: "ask"` default with the
rationale.

**Verify**: extract every code block from the new §12 into a scratch
script, run against a temp store → no throw; `grep -n "revises" docs/HOSTING.md` ≥1.

### Step 2: Transplant §13

Same treatment for Part 3 → `## 13 · Tables (CSV / spreadsheet-shaped
life data)`. MUST retain: append-only correction rule, the import-day
`episode()` caveat stated plainly with the typed-query mitigation
(decision 6), the .xlsx boundary sentence (decision 7).

**Verify**: run §13's import sample (a small inline CSV, not 2,000 rows)
against a scratch store → no throw; `grep -n "xlsx\|\.xlsx" docs/HOSTING.md` ≥1.

### Step 2b: The §11 rebuy-workaround sentence (cherry-picked from plan 022's design)

Plan 022 (multi-window validity) is DEFERRED, but its design doc
(`plans/design/multiwindow-validity.md`, §7 end + §8 decision 6) says the
HOSTING §11 workaround sentence "is worth making regardless of the A/B/D
decision, so hosts have a sanctioned answer today." Add to §11's
rules-of-thumb bullets: re-acquiring a sold asset currently cannot re-link
the same `owns` triple (a closed fact stays closed — the deliberate
TEMPORAL.md deferral); the sanctioned interim pattern is reifying the
stint as its own node (e.g. an `ownership` node with `when`, linked to
both parties), the same row-per-fact shape §11's snapshots already use.
Keep it to 3–5 lines; cite TEMPORAL.md's deferral.

**Verify**: `grep -n -i "rebuy\|re-acquir\|reifying" docs/HOSTING.md` ≥1.

### Step 3: Cross-references

- §12/§13 reference `doctor().historyRows` (shipped, plan 014) — verify
  the field name against `src/contract.ts` before citing it.
- The README's docs table already lists HOSTING.md — no README change.

**Verify**: `bun run check` → exit 0; `git diff --stat` shows only
`docs/HOSTING.md`.

## Done criteria

- [ ] §12 and §13 exist, numbered correctly, samples probe-verified
- [ ] History cost + import-day caveat stated with numbers (grep "70×" or
      the design's figures as adapted)
- [ ] `bun run check` exit 0; diff touches only docs/HOSTING.md
- [ ] `plans/README.md` status row updated

## STOP conditions

- A design-draft code sample fails against the merged library (the draft
  was probed pre-merge; a failure means drift — report, don't patch code).
- You feel the need to add a library verb or schema field — every such
  option was explicitly rejected in the ratified decisions.

## Maintenance notes

- If `historyRows` evidence later motivates a per-type history opt-out
  (deferred decision 2-ii), §12's cost paragraph is the doc to update.
- Plan 022's HOSTING §11 rebuy sentence and this plan's sections are
  disjoint — no coordination needed.
