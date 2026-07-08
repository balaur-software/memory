# Plan 016: Design spike — export/portability and one-command restore, as library verbs

> **Executor instructions**: This is a DESIGN SPIKE — deliverable is a
> design doc + probes, no production changes. Follow the steps; on a STOP
> condition, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- docs/INTEGRATIONS.md docs/HOSTING.md docs/SCHEMA.md src/contract.ts src/lifecycle.ts`
> On drift, re-read before designing.

## Status

- **Priority**: P3
- **Effort**: M (spike)
- **Risk**: LOW (no code changes)
- **Depends on**: plans/002-drop-the-cli.md (reshapes this feature:
  library verbs, NOT CLI commands); reads plan 015's design if present
  (exports are pure reads — the surfaces compose)
- **Category**: direction / design
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

A decades-scale personal store currently has no way to get data OUT in any
interchange format, and restore is a manual multi-step recipe while
`backup()` is one verb. The repo already wants this:

- `docs/INTEGRATIONS.md:74-79` sketches an export surface
  (`--mif | --ics | --vcard | --jsonl` — "All pure reads over the schema;
  none require library changes") — written when the CLI existed; the
  owner has since dropped the CLI (2026-07-07), so the design must land
  as library verbs.
- `docs/HOSTING.md` §10 documents restore as manual prose (place the
  file, open, `rebuildIndex()`) with no verb.
- **The honesty hook**: `forget()`'s report always includes
  `"external:prior-exports"` (`src/lifecycle.ts:90` — "the standing truth
  that prior exports/backups may retain the content"). Today that line is
  aspirational — nothing tracks that an export ever happened. An export
  verb that writes a content-free audit row (`store.export`, meta: format
  + row count) makes the claim real; the forget path could then report
  how many exports exist rather than a standing boilerplate line.

## Current state (read before designing)

- `src/store.ts:316-322` — `backup(toPath)` (VACUUM INTO): the precedent
  verb — audited content-free, refuses overwrite.
- `src/contract.ts` — where export/restore signatures would land.
- Consent surface question (THE design decision): what does an export
  include? `never`-surfaced and quarantined nodes are the owner's most
  sensitive rows. Options: (a) exports are an OWNER verb — everything
  active+archived by default, `never` included only with an explicit
  `includeNever: true`; (b) surfacing-filtered by default. Ground it in
  I2's text (`docs/SCHEMA.md:204-216`) — I2 governs *ambient recall*, not
  owner-initiated bulk reads; but the peer-card precedent
  (`entityContext` refuses `never`, `src/entities.ts:410-411`) shows the
  project errs conservative. Both defensible — the spike recommends,
  the owner ratifies.
- Formats, per INTEGRATIONS.md's list — assess each:
  - **JSONL** (archival/interchange): full-fidelity dump — nodes, edges,
    aliases, derivations, history?, audit? (history is content; audit is
    content-free — decide per stream). One JSON object per line, schema
    documented in SCHEMA.md appendix.
  - **ICS**: `when_at`-bearing nodes as VEVENTs (PLANNING.md:171-172
    already claims "trivially exportable: when_at + title is already an
    ICS VEVENT").
  - **vCard**: `person`-type nodes + aliases.
  - **MIF** ("memory interchange format", from FIELD.md's landscape) —
    verify what concrete spec (if any) FIELD.md refers to
    (`grep -n -i "mif" docs/FIELD.md docs/INTEGRATIONS.md`); if it is
    vaporware in 2026, say so and drop it — do not invent a format.
- Restore: `Store.restore(backupPath, dir)` static — copy/place as
  `memory.db` in a FRESH dir (refuse non-empty), open, `rebuildIndex()`,
  verify `PRAGMA integrity_check` + schema_version guard. It is the
  HOSTING §10 recipe as one verb.
- Zero-dependency rule: ICS/vCard emitters must be hand-rolled minimal
  writers (both formats are line-based text — small); JSONL is free.
  No format libraries.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Probes    | `bun <script>.ts` in /tmp scratch | probe output |
| Gate      | `bun run check`      | exit 0 (tree untouched) |

## Scope

**In scope**: `plans/design/export-restore.md` (create), probe scripts
(e.g. a ~40-line JSONL exporter probe over a scratch store; an ICS emitter
probe validated against a calendar app import if convenient).

**Out of scope**: production code; import-FROM-other-tools (a different,
bigger feature — note it as future work); sync (out of scope by doctrine).

## Steps

### Step 1: Decide the streams and the consent rule

For each table (nodes, edges, aliases, derivations, memory_history,
audit_log): in or out of each format, and under which surfacing/status
filter. Write the matrix. Probe: JSONL-dump a scratch store with all
statuses/surfacings present; eyeball the sensitive-row handling.

### Step 2: Format assessments

JSONL schema draft (field names = SCHEMA.md column names verbatim); ICS
mapping (which statuses? archived tasks with outcomes?); vCard mapping
(title/aliases/props); MIF verification per "Current state" (evidence or
drop).

### Step 3: The verbs

Signatures + semantics for `export(opts): ...` (or per-format verbs —
argue one way), `Store.restore(...)`, their audit rows (content-free:
format, counts), the forget-report integration (replace the boilerplate
`"external:prior-exports"` with real accounting: e.g.
`external:exports:<n>` when n export audit rows exist), and error cases
(target exists — mirror backup's refusal).

### Step 4: The deliverable

`plans/design/export-restore.md`: the stream/consent matrix, format
drafts, verb signatures, audit + forget-report integration, zero-dep
emitter sketches, and the numbered owner-decision list (consent default
being decision #1).

**Verify**: doc exists; `bun run check` exit 0; tree untouched.

## Done criteria

- [ ] `plans/design/export-restore.md` with stream matrix, ≥2 format
      drafts (JSONL + ICS minimum), verb signatures, forget-report
      integration, owner-decision list
- [ ] MIF either evidenced or explicitly dropped with the grep result
- [ ] No changes outside `plans/` (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- FIELD.md/INTEGRATIONS.md turn out to define MIF concretely enough that
  it IS a real spec with a version — then it needs real spec-reading time;
  report scope before spending it.

## Maintenance notes

- Exports compose with plan 015's `ReadStoreContract` if that lands
  (pure-read verbs). Note in the design which surface each verb belongs
  to.
- The audit-accounting change to `forget()`'s needsOwner line touches
  I6/I7 wording in SCHEMA.md — flag it in the build plan when written.
