# Plan 021: Build export() and Store.restore() — portability with honest accounting

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Normative design**: `plans/design/export-restore.md` (in-repo) — §3
> the stream×format×consent matrix, §4 the format drafts (JSONL/ICS/vCard
> with escaping rules), §5 the verbs (signatures + restore's 9 steps +
> refusals, copy-faithful), §6 the forget-report integration. Owner
> decisions confirmed 2026-07-08 as recommended: consent option (a) with
> opt-in flags; ONE export verb; restore THROWS on failed integrity;
> backup-accounting deferred (decision 4 — do NOT bundle); MIF dropped;
> INTEGRATIONS.md note deferred. Read §3–§7 in full before starting.
>
> **Drift check (run first)**: `git diff --stat f1b168a..HEAD -- src/store.ts src/contract.ts src/lifecycle.ts src/index.ts docs/SCHEMA.md docs/HOSTING.md`
> Expect plans 018–020's documented edits on the stacked branch; anything
> else, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (touches forget's report semantics + a new file-writing verb)
- **Depends on**: plans/019-build-life-documents-docs.md (re-based: plan
  020 is DEFERRED per owner sequencing 2026-07-08 — branch from
  `advisor/019-life-documents-docs`, and ignore this plan's references to
  020 edits being present on the branch)
- **Category**: direction/build
- **Planned at**: commit `f1b168a`, 2026-07-08

## Why this matters

A decades-scale personal store currently has no sanctioned way to get
data OUT in any interchange format, and restore is manual prose while
backup is one verb. Worse, `forget()`'s report claims
`"external:prior-exports"` unconditionally — an honesty line with nothing
behind it (probe-confirmed it fires on stores that never exported).
This plan ships `export(toPath, {format})` (JSONL/ICS/vCard, hand-rolled
zero-dep emitters), `Store.restore(backupPath, dir)`, and replaces the
boilerplate with real accounting.

## Current state

(Stacked baseline: re-run `bun test` first and record the count.)

- `src/store.ts` `backup()` — the shape `export()` mirrors: resolve +
  in-store-dir refusal (`props_invalid`), exists refusal (`conflict`),
  try/catch cleanup, chmod 0600, content-free audit. `Store` already has
  `dir_` (plan 008).
- New module `src/export.ts` (design §5.1 placement): three emitters + a
  dispatcher; `store.ts`'s `export()` method wraps with refusals + write
  + chmod + audit `store.export` meta `{format, ...counts}`.
- Signatures/options/report: design §5.1 VERBATIM (`ExportFormat`,
  `ExportOptions` with the six flags and their defaults, `ExportReport`).
  Defaults: status `active+archived`; surfacing `always+ask`;
  never/quarantined/history/audit/archived-ics/ask-ics all opt-in per the
  flag table.
- Stream matrix (design §3): JSONL = nodes+edges+aliases+derivations
  (history/audit behind flags); ICS = when_at-bearing VEVENTs (active,
  always by default); vCard = person-type + aliases. Edges to
  filtered-out nodes are DROPPED (probe-verified rule).
- Emitters (design §4): JSONL field names = SCHEMA.md column names
  verbatim; ICS per RFC 5545 line-folding/escaping as drafted; vCard per
  RFC 6350. NO format libraries (zero-dep rule).
- `Store.restore(backupPath, dir): Store` — design §5.2's nine steps
  copy-faithful: not_found on missing backup; `conflict` on non-empty
  target dir; mkdir 0700; copy + chmod 0600; `Store.open` (free
  schema-guard); `rebuildIndex()`; integrity check → THROW `conflict` on
  failure (ratified decision 3); content-free audit `store.restore` meta
  `{activeCount, integrityOk}`; return the Store.
- `src/lifecycle.ts` — the forget-report integration (design §6, verbatim
  code): replace the unconditional
  `needsOwner.push("external:prior-exports")` with the counted
  `external:exports:<n>` line, omitted entirely at zero. NOTE this
  changes `ForgetReport.needsOwner` contents — grep
  `test/ src/` for `prior-exports` and update every pinning test/scenario
  DELIBERATELY (each edit named in the commit body).
- `docs/SCHEMA.md` — a JSONL appendix (stream schema, field-name parity
  note) + the audit actions list gains `store.export`/`store.restore`;
  the I6/needsOwner wording swaps "prior exports" boilerplate framing for
  the counted form. `docs/HOSTING.md` §10 gains restore-as-one-verb and
  an export example.
- Conformance runner is strict; scenarios that assert forget-report
  contents: grep `needsOwner` in `test/conformance/*.scenario.json`
  (e.g. the I6 cascade scenario) — they will need the counted-form update.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Suites    | `bun test src/export.test.ts src/lifecycle.test.ts test/conformance/runner.test.ts` | all pass |

## Scope

**In scope**: `src/export.ts` (new), `src/store.ts`, `src/contract.ts`,
`src/index.ts`, `src/lifecycle.ts` (ONLY the needsOwner line),
`src/export.test.ts` (new), `src/lifecycle.test.ts`,
`test/conformance/` (scenario updates + one export scenario),
`docs/SCHEMA.md`, `docs/HOSTING.md`.

**Out of scope**: `external:backups:<n>` accounting (decision 4 —
explicitly deferred); an import verb; MIF (dropped — must NOT appear in
`ExportFormat`); INTEGRATIONS.md.

## Git workflow

- Branch: `advisor/021-export-restore` from `advisor/020-readonly-open`
- Suggested commit: `feat(store): export (jsonl|ics|vcard) + Store.restore — portability with audited, honest accounting`
- Do NOT push or open a PR.

## Steps

### Step 1: Emitters (`src/export.ts`) + the verb

Implement per design §4/§5.1. Consent filtering happens in the row
SELECTs (status/surfacing per the matrix + flags), never post-hoc in the
emitter. Then `store.ts` `export()` + `contract.ts` + `src/index.ts`
exports (`ExportFormat`, `ExportOptions`, `ExportReport`).

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 2: Export tests

`src/export.test.ts` (freshStore helper): fixture with every
status×surfacing combination + edges crossing the consent boundary +
aliases + one vector + history rows. Assert:
1. Default JSONL: no never/quarantined ids anywhere in the bytes; edges
   to filtered nodes absent; counts in `ExportReport` match line counts.
2. `includeNever: true` → they appear; same for quarantined flag.
3. ICS: when_at node → one VEVENT; escaping survives a title with
   `,;\n`; archived excluded by default, included with flag.
4. vCard: person + aliases render; non-person types absent.
5. Refusals: in-store target → `props_invalid`; existing target →
   `conflict`; failed write leaves no partial file.
6. Audit: one `store.export` row, meta has format+counts, NO content
   (grep the meta for fixture titles).

**Verify**: `bun test src/export.test.ts` → all pass.

### Step 3: restore()

Implement §5.2's nine steps. Tests (same file): round-trip parity
(backup → restore → getNode/recall equal), non-empty-dir refusal,
missing-backup refusal, integrity-failure throw (corrupt a copied file's
middle bytes raw), restored files at 0600/dir 0700.

**Verify**: `bun test src/export.test.ts` → all pass.

### Step 4: The honesty hook

`src/lifecycle.ts` per design §6. Update every test/scenario pinning
`external:prior-exports` to the new semantics: fresh store → line ABSENT;
after 2 successful exports + 1 failed → `external:exports:2`. Add that
exact case to `src/lifecycle.test.ts`, and update the conformance
scenario(s) found by the grep.

**Verify**: `bun run check` → exit 0 (the strict runner will catch any
missed scenario pin — that is the point).

### Step 5: Docs

SCHEMA.md JSONL appendix + audit actions + needsOwner wording; HOSTING
§10 restore verb + export example (run both samples once in scratch).

**Verify**: `bun run check` → exit 0; `grep -n "store.restore\|export(" docs/HOSTING.md` ≥2.

## Done criteria

- [ ] `export()` ships all three formats with the ratified defaults;
      sensitive rows leak only behind explicit flags (test-pinned)
- [ ] `Store.restore` round-trips a real backup and throws on corruption
- [ ] Fresh-store forget report has NO exports line; post-export report
      counts correctly (test + scenario pinned)
- [ ] `grep -rn "external:prior-exports" src/ test/` → 0 (fully replaced)
- [ ] No `mif` string anywhere in the new surfaces
- [ ] `bun run check` exit 0; `plans/README.md` updated

## STOP conditions

- An emitter seems to need a dependency — zero-dep is absolute; the
  design's drafts are dependency-free, reuse them.
- The needsOwner change breaks a scenario in a way the design didn't
  anticipate (i.e. something pins the OLD line as an invariant with
  rationale) — report before rewriting it.
- You want to bundle `external:backups:<n>` — deferred by decision 4.

## Maintenance notes

- Decision 4's follow-up (backup accounting) reuses §6's exact mechanism
  with action `store.backup` — a future S plan.
- `includeMerged` (decision 1b) deferred — one more status in a WHERE
  clause when demanded.
- If plan 020's ReadStore ever grows an export, the audit-row requirement
  keeps it on the writer — the design's composition note stands.
