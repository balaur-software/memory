---
name: memory-change-control
description: Use when changing balaur-memory — how a change is classified, gated, or released. Triggers, editing docs/SCHEMA.md or src/storage/schema.ts, bumping SCHEMA_VERSION, adding a dependency, importing bun:sqlite, touching audit/consent/index.db/doctor behavior, writing conformance scenarios, cutting a release (git tag vX.Y.Z, unreleased breaking changes at HEAD), opening a PR, CI/.githooks gates, or AGPL/relicensing and "can I commit/push?" questions.
---

# memory-change-control — how changes land in balaur-memory

Repo: `/home/alex/projects/balaur/memory` (github.com/balaur-software/memory).
This skill is the change-control law: the non-negotiable rules with their
rationale and the historical incident behind each, the change-type → gate
table, the release runbook, and the PR workflow doctrine.

**Definitions used throughout** (defined once here):

- **The gate** = `bun run check` = `bunx tsc --noEmit && bunx biome check . && bun test`
  (`package.json` scripts). Green gate before any push, always — now also
  enforced natively by `.githooks/pre-push` (armed via
  `git config core.hooksPath .githooks`, documented in AGENTS.md).
- **Invariant** = a numbered contract clause I1–I17 in `docs/SCHEMA.md`
  (the data contract: SQLite DDL + semantics). `schema_version` = the
  integer in the `meta` table of `memory.db`; code constant `SCHEMA_VERSION`
  in `src/storage/schema.ts:11` (currently 4).
- **Conformance scenario** = a declarative JSON test in
  `test/conformance/*.scenario.json` that pins invariants by number,
  executed by `test/conformance/runner.test.ts` (see `docs/CONFORMANCE.md`).
- **Tag-pin** = consumers install `bun add github:balaur-software/memory#vX.Y.Z`;
  the git tag IS the release (no npm registry, no build, raw TypeScript).

## When NOT to use this skill

| You actually want | Go to |
|---|---|
| What the rules protect — schema semantics, all 17 invariants, consent/temporal/planning theory, API surface | **memory-domain-reference** |
| The incident chronicle in depth: every finding, dead end, rejected verb | **memory-failure-archaeology** |
| Test/conformance mechanics: how to write a scenario, runner ops, adding evidence | **memory-validation-and-qa** |
| The `balaur` CLI, data dirs, backup/restore | **memory-cli-and-hosting** |
| Cross-repo consumption (web pinning memory), workspace choreography | **balaur-workspace-map** |

## The non-negotiables

Digest table; each rule is expanded below with rationale and incident.

| # | Rule | One-line test |
|---|---|---|
| 1 | Schema is the contract | Did you edit SCHEMA.md + append a migration + bump SCHEMA_VERSION + HISTORY.md callout, all in ONE commit? |
| 2 | Conformance or it didn't happen | Behavior change ships its scenario in the same commit |
| 3 | Zero runtime deps, forever | `package.json` `"dependencies"` stays `{}` |
| 4 | Vectors in / dates in — never models | No LLM calls, no embedder, no async API, no inferred dates |
| 5 | `bun:sqlite` containment | Runtime import in exactly `src/storage/bun.ts` (tests exempt) |
| 6 | Audit rows content-free | No node text ever reaches `audit_log` |
| 7 | `index.db` stays disposable | Deleting it must lose nothing |
| 8 | Consent boundary in the data layer | Never caller discipline |
| 9 | Strict tsconfig never weakened | Fix the code, not the flag |
| 10 | Doctor reports, never acts | Auto-archive is forbidden by design |

### 1. Schema is the contract

- **Rule.** `docs/SCHEMA.md` outranks the code (`src/storage/schema.ts:2-4`
  says it verbatim: "if this file and SCHEMA.md disagree, SCHEMA.md wins").
  Schema change protocol — ALL in one commit:
  1. Edit `docs/SCHEMA.md` (DDL + invariants).
  2. Append a new migration in `src/storage/schema.ts`. **NEVER edit an
     applied migration** (header rule, `src/storage/schema.ts:4`).
  3. Bump `SCHEMA_VERSION` (`src/storage/schema.ts:11`).
  4. Call it out explicitly in the `docs/HISTORY.md` entry
     (`docs/RELEASE.md` "Schema-version coordination").
- **Rationale.** ADR-0001 (`docs/adr/0001-bun-typescript.md`): the schema is
  the durable API; any language, any decade, opens `memory.db`. The
  TypeScript is the replaceable part.
- **Evidence the discipline is real: the future-file guard.** Opening a
  `memory.db` whose `schema_version` exceeds `SCHEMA_VERSION` throws
  "upgrade the library, never downgrade the file"
  (`src/storage/schema.ts:182-187`; pinned by `src/perpetuity.test.ts:58`,
  landed in PR #22, the perpetuity batch, commit 35d75e1). Downgrade-against-
  data must refuse — that only works if versions and migrations are honest.
- **Doc drift (repaired)**: the README/AGENTS "I1–I14" / "13 of 14" wording
  and SCHEMA.md's `currently "2"` DDL comment were fixed in commit `5b0a7bb`
  (verified 2026-07-08). Ledger of record: `balaur-docs-and-writing` §3.
  Re-check: `grep -n 'I1–I14\|13 of 14' README.md AGENTS.md` (empty =
  repaired). The real counts remain **I1–I17, 16 of 17 scenario-pinned
  (I14 by construction)** — `docs/SCHEMA.md` + `docs/CONFORMANCE.md`.

### 2. Conformance or it didn't happen

- **Rule.** A behavior change ships its `test/conformance/*.scenario.json`
  change in the same commit — "a behavior change without its scenario change
  in the same commit is wrong by definition; reviewers reject it"
  (`docs/CONFORMANCE.md` Rules). Two more hard rules there: scenario
  fixtures are **fictional only** (never real personal data), and the runner
  **never imports `src/` internals** — public API (`src/index.ts`) plus raw
  SQLite reads only (`test/conformance/runner.test.ts:1-14`). That is what
  keeps the suite portable to a future port in another language.
- **Rationale.** The suite tests the schema contract, not this codebase; a
  Node or Go port passes the same scenarios or it is not balaur-memory.
- **Evidence.** 26 scenarios pin 16 of 17 invariants (as of 2026-07-08;
  `ls test/conformance/*.scenario.json | wc -l`). The coverage map is in
  `docs/CONFORMANCE.md`. Since `b76a971` the runner is STRICT about
  `expectError`: it asserts the thrown `MemoryError.code` equals the
  scenario's declared value — the failure reason is part of the contract.

### 3. Zero runtime dependencies, forever

- **Rule.** `package.json` `"dependencies"` stays `{}` (verified
  2026-07-08). A PR that adds one must instead inline the ~50 lines
  it actually needed (`docs/CODING.md`). Dev-tooling (typescript,
  @types/bun, biome) is fine.
- **Rationale.** Decades-scale personal codebase; every dependency is a
  future funeral (the Kuzu shutdown, ADR-0001, is the standing tale).
- **Proof it's livable.** No Zod: unknown JSON enters through hand-rolled
  narrow validators (`parseProps` and, since `7c51c3f`, `parseJsonObject`
  in `src/types.ts`). Historical proof: the (now-removed) CLI's parser
  was hand-rolled `cli/args.ts`, ~40 lines — see it at
  `git show v0.4.3:cli/args.ts`.

### 4. Vectors in / dates in — never models

- **Rule.** The library never calls an LLM or an embedder; hosts hand in
  `Float32Array`s. Every API is synchronous. Same for time: `valid_from` /
  `valid_to` (I15) and `when_at` (I17) are **declared by the caller, never
  inferred** by any model. If a feature seems to need a model or async, it
  belongs in a host (`AGENTS.md`, ADR-0001).
- **The empirical WHY.** Zep/Graphiti's LLM-driven temporal extraction
  hallucinates "today" as the validity date in ~56% of historical backfills
  — their issue #1492 (`docs/TEMPORAL.md:14-18`, `docs/FIELD.md:77`). This
  library adopted their bi-temporal edge model but **fixed** the failure by
  making dates input-only.

### 5. `bun:sqlite` containment (ADR-0001)

- **Rule.** Exactly one runtime file imports `bun:sqlite`:
  `src/storage/bun.ts` (verified 2026-07-08: the only non-test import
  under `src/`; `cli/` no longer exists at HEAD). Everything else
  consumes the adapter interface (`src/storage/adapter.ts`).
- **Sanctioned exception — do not "fix" it:** test files and the
  conformance runner MAY import `bun:sqlite` for raw-SQL assertions
  (e.g. `test/conformance/runner.test.ts:8`, `src/hardening.test.ts`).
  The contract is the database, so the assertions read the database.
- **Rationale.** Bun is a young VC-funded runtime; Kuzu — a VC-funded
  embedded database — shut down and archived in 2025 (ADR-0001 Context).
  The exit ramp is documented: port `src/storage/` to `node:sqlite` behind
  the same adapter, a bounded, conformance-verified job (ADR-0001
  Consequences, "Revisit trigger").

### 6. Audit rows are content-free (I7/I12)

- **Rule.** `audit_log` rows carry ids, actions, counts, flags — never node
  `title`/`body` text (`docs/CODING.md` Data discipline; SCHEMA.md I7, I12).
- **Enforcement is a test, not a convention.** The structural audit-leak
  sentinel (`src/hardening.test.ts:225-263`, landed in PR #8) pushes a
  sentinel string through **every verb** — create, update, link, alias,
  propose, decide, quarantine, merge, forget — then SQL-`LIKE`-scans the
  whole `audit_log` for it and fails on any hit. A well-meaning debug field
  that interpolates node text into an audit row FAILS the build.
- **Rationale.** The audit trail must be safe to read, ship, and keep even
  when the memories it describes were forgotten.

### 7. `index.db` stays disposable (I13)

- **Rule.** `index.db` (FTS + vectors) is derived entirely from `memory.db`;
  deleting it is always safe and it rebuilds byte-equivalently. **A feature
  that makes its loss lossy is wrong by definition** — put the durable part
  in `memory.db` (`AGENTS.md`, `docs/CODING.md`).
- **Evidence.** Scenario `I13-index-disposability` (delete → reopen →
  rebuild → identical recall, byte-exact `extra`), hardened to
  byte-exactness in PR #15.

### 8. The consent boundary lives in the data layer

- **Rule.** The consent gate (status FSM + pending queue, I1: gated types
  are born `proposed`, only the owner's `decide` activates) is enforced by
  the storage layer's write choke points — **never by caller discipline**
  (`AGENTS.md`). Every mutation goes through the choke points in
  `spine.ts` / `consent.ts` / `lifecycle.ts`; no feature module writes raw
  SQL to `nodes` (`docs/CODING.md` Data discipline).
- **Rationale.** A consent feature that a forgetful caller can bypass is
  not a consent feature. This matters directly to the campaign wiring the
  web agent in (see **balaur-memory-web-campaign**): the agent gets verbs,
  the gate does the enforcing.

### 9. Strict tsconfig, never weakened

- **Rule.** `tsconfig.json` is law: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`. Never weaken a flag
  to make code compile — fix the code (`docs/CODING.md`). Also: no `any`,
  no non-test `as`, string-literal unions never `enum`, branded ids.

### 10. The doctor reports, never acts

- **Rule.** `doctor()` is a metadata-only health report. Its own header
  (`src/doctor.ts:1-12`): "it reports, it never acts … auto-archiving from
  these signals is **forbidden by design, not by configuration**."
- **Rationale.** `deadWeightCandidates` is a Missing-Not-At-Random signal:
  a dormant memory may be a rare-but-critical fact (an allergy looks
  identical to dead weight in `use_count`). Everything the doctor emits is
  a CANDIDATE for the owner's review. Do not add an "auto-cleanup" flag;
  it will be rejected.

## Change classification → gate

| Change type | Gate to ship it |
|---|---|
| **Docs-only** | `bun run check` green (biome lints markdown-adjacent files). Rides silently until the next tag: consumers pin tags, so a commit on main is **invisible to every consumer** until a release is cut. As of 2026-07-08 that gap is LARGE: HEAD `f1b168a` is 14 unreleased commits past v0.4.3, including two breaking ones. |
| **Behavior** (any observable API/semantics change) | Unit tests + the conformance scenario change **in the same commit** (rule 2). Update `docs/HISTORY.md` if it lands a phase. |
| **Schema** (`memory.db` DDL/semantics) | The full one-commit protocol of rule 1: SCHEMA.md + appended migration + `SCHEMA_VERSION` bump + HISTORY.md callout. Release that ships it must call it out (RELEASE.md "Schema-version coordination") — the changelog is the only advisory consumers get. |
| **Breaking API or schema** | Major version bump. For **minor** bumps, migrations must preserve forward compatibility (`docs/RELEASE.md` step 2: minor = "additive API surface, migrations that preserve forward compatibility"; major = "breaking API or schema changes"). |

### Live precedents at HEAD (unreleased, as of 2026-07-08)

Two breaking changes sit on main awaiting the owner's version decision —
`package.json` still says 0.4.3, no tag past v0.4.3 exists, so consumers
(web pins `#v0.4.3`) are untouched until a release is cut:

- **`005da77` `feat(doctor)!`** — the announced DoctorReport revision
  (adds `pendingByKind`, `historyRows`, `reproposedAfterForget30d`; see
  memory-domain-reference references/api.md). A textbook worked example of
  this table's "Breaking API" row done right: three documented IOUs paid
  in ONE breaking change instead of three, scenario + unit tests in the
  same commit. Per RELEASE.md step 2 the release that ships it is major
  (or an owner-stated exception) — that decision is pending.
- **`3ddb84b` `feat!` (the CLI removal)** — a SCOPE-change precedent, not
  just an API one: an explicit owner decision (2026-07-07, quoted in the
  commit body: "We can drop the CLI and we won't handle any integrations
  except direct bun library") removed a whole supported surface, with the
  accepted costs enumerated in the commit message (lost reference host,
  lost 18 end-to-end CLI tests, ADR-0001's standalone-binary story
  orphaned). When scope changes, that is the shape: owner quote, costs
  named, docs (README/INTEGRATIONS/RELEASE/HISTORY) updated in the same
  commit.

## Release runbook

Canonical source: `docs/RELEASE.md` (verified 2026-07-08 — the steps below
match it, including the consumer-view step added in `79a0a6e`). The
package publishes as a git-tag GitHub dependency, never npm.
**Do not run any of these git steps unless the owner explicitly asked for a
release.**

1. `main` clean, `bun run check` green.
2. Bump `version` in `package.json` (semver; patch = fixes/conformance-only,
   minor = additive + forward-compatible migrations, major = breaking).
3. Add the one-line release row to `docs/HISTORY.md` (canonical phase log).
4. Commit: `git commit -am "chore(release): vX.Y.Z"`.
5. Tag the same version: `git tag vX.Y.Z` then
   `git push origin main && git push origin vX.Y.Z`.
6. Verify from a clean checkout: `bun add github:balaur-software/memory#vX.Y.Z`.
7. **Verify the consumer view** (RELEASE.md step 7, new in `79a0a6e`):
   `bun add` alone can't prove what a git-archive tarball contains —
   `find node_modules/balaur-memory -type f | sort` in a scratch project
   and confirm no `test/`, `*.test.ts`, `AGENTS.md`, `plans/`, and no
   docs beyond `docs/SCHEMA.md` / `docs/HOSTING.md`.

Hard rules around tags:

- **Tags NEVER move.** A tag that doesn't match `package.json#version` is a
  bug — fix by tagging the matching commit, never by moving the tag
  (`docs/RELEASE.md`, last paragraph of "Cutting a release").
- **All seven released versions are now tagged AND on origin** (verified
  2026-07-08, `git tag -l` + `git ls-remote --tags origin`): the
  release-day tags `v0.2.3`, `v0.4.0`, `v0.4.3` are **lightweight**
  (`git cat-file -t` → `commit`); `v0.3.0`, `v0.3.1`, `v0.4.1`, `v0.4.2`
  were **backfilled as annotated tags** on 2026-07-07 (plan 009,
  documented in RELEASE.md; each annotation says it was added after the
  fact). Versions 0.1.x–0.2.2 deliberately stay untagged; `[v0.1.1]` is
  still a commit-message-only label. No tag exists past v0.4.3 — HEAD is
  unreleased.
- **What a git-tag install ships is governed by `.gitattributes`
  export-ignore rules** (new in `79a0a6e`) — git-tag installs are served
  as git-archive tarballs, which honor export-ignore, NOT
  `package.json#files` (npm-pack only, unused here; kept in sync as
  `src` minus tests + `docs/SCHEMA.md` + `docs/HOSTING.md`). No `bin`,
  no `cli/`, no `docs/CLI.md` — all removed with the CLI (`3ddb84b`).
  `AGENTS.md` is deliberately not shipped. NOTE: the v0.4.3 tag predates
  all of this — a v0.4.3 install (web's) still contains `cli/`, `test/`,
  and the since-removed stray upload files.

### The PR #13 incident — why the checklist is atomic

Commit subjects claimed version bumps that **never landed in the manifest**:
5eec736 says `[v0.2.0]` and 0061d37 says `[v0.2.1]`, but `package.json`
jumped straight from `0.1.0` to `0.2.2` in one hop at d8118e5 (PR #13,
entities phase D). Verify yourself:

```bash
cd /home/alex/projects/balaur/memory
git log -p --follow -- package.json | grep -E '^(commit|[+-]\s*"version")'
```

Versions 0.1.1, 0.2.0, 0.2.1 exist only in commit messages. That is why the
runbook makes the `package.json` bump an explicit numbered step in the same
`chore(release)` commit as the HISTORY row, with the tag matching the
manifest — never trust a version stated only in a commit subject.

## Workflow doctrine

- **PR-per-phase is the rule.** Branch from **fresh post-merge main** →
  implement → `bun run check` green → PR → "the merge is the ratification"
  (`docs/HISTORY.md`, standing discipline). The four direct-to-main
  commits after PR #26 (c57348b, 8c853c8, 64c0542, 9182b14) were
  expedience, not policy. The 2026-07 deep-audit chain (14 linear commits
  61ddbd2..f1b168a, landed 2026-07-08) also bypassed GitHub PRs, but with
  a different ratification record: each commit was an advisor plan
  executed on a worktree branch, reviewed and approved per-plan, with
  `plans/README.md` carrying the status ledger — process substitution,
  not drift. New work should still go PR-per-phase unless the owner sets
  up another reviewed chain.
- **Stale forks are rebuilt, not conflict-resolved.** Precedent: PR #23 went
  stale against main, was abandoned, and the work was rebuilt on fresh main
  as PR #24 (branch `ergonomics-life-layer-2`; `docs/HISTORY.md` phase row:
  "DONE (PR #24, merged; #23 superseded)"). If your branch conflicts with
  main, rebuild it on fresh main.
- **Conventional commits** (`feat`/`fix`/`docs`/`refactor`/`test`), and
  feature commits state the **verified test count** in the subject — e.g.
  d454edd "feat: the ergonomics batch … (verified: 136 tests)". Run
  `bun test` and use the real number; never carry a count forward.
- **`bun run check` green before any push** (`docs/CODING.md`).
- **Never commit or push unless the owner explicitly asks** — `AGENTS.md`,
  root workspace doctrine, no exceptions. This skill never authorizes a
  commit; it only tells you what a correct one looks like.
- `docs/HISTORY.md` is the canonical phase log — update it in the same
  change that lands a phase.

### Local-clone state to be aware of (machine-specific, as of 2026-07-08)

- The 2026-07 audit's advisor worktrees are mostly gone (their branches
  merged — `git branch --no-merged main` is empty). ONE worktree remains:
  `.claude/worktrees/agent-ad96ea5a9d59c8f21` on branch
  `advisor/018-task-arc` (locked, at f1b168a) — the IN-PROGRESS build
  plan 018 (see `plans/README.md`). **Do not remove it**; it is another
  session's live workspace. Verify:
  `git -C /home/alex/projects/balaur/memory worktree list`.
- That worktree contains a `biome.json`, which still makes a repo-root
  `bunx biome check .` (and therefore `bun run check`) fail with
  "Found a nested root configuration" (re-verified 2026-07-08). This is
  **environmental, not your breakage and not a code regression**:
  `bunx tsc --noEmit` passes, `bun test` passes 169/169, and biome scoped
  to real sources passes (`bunx biome check src test` → exit 0, warnings/
  infos only). If the worktree is gone when you read this, `bun run
  check` passes as-is. Do not delete other sessions' worktrees to get
  green; scope biome or wait for them to be cleaned up.

## CI status

- **CI is ARMED** (as of `61ddbd2`, merged; verified 2026-07-08):
  `.github/workflows/ci.yml` exists (the former parked
  `docs/ci.workflow.yml`, moved), with a non-blocking Bun 1.2 floor check
  alongside latest. A native zero-dependency `.githooks/pre-push` runs
  `bun run check`; one-time activation is
  `git config core.hooksPath .githooks` (documented in AGENTS.md).
- Difference to know: the workflow runs `bunx biome ci .` while the local
  gate runs `bunx biome check .` — `biome ci` is read-only/CI-flavored;
  results can differ at the margins from local `check`.

## Governance: AGPL and the relicensing window

- License: **AGPL-3.0-or-later** (`package.json`, `LICENSE`).
- The tradeoff is documented in `docs/DESIGN.md` (License section): the sole
  author currently "retains trivial relicensing freedom. Decide deliberately
  before accepting external contributions (library copyleft reaches
  consumers; Apache-2.0 is the conventional adoption-maximizing switch and
  must happen while the contributor set can consent)."
- Operational meaning: **accepting the first outside PR closes the cheap
  relicensing window** (every later relicense needs every contributor's
  consent). Accepting external contributions is therefore an owner
  decision with a stated cost — never merge outside work without raising
  this explicitly.

## Doc-drift ledger (what to trust when docs disagree)

| Stale statement | Where | Trust instead |
|---|---|---|
| README/AGENTS/SCHEMA drift rows ("I1–I14", "13 of 14", `currently "2"`) — REPAIRED in commit `5b0a7bb` (verified 2026-07-08) | ledger of record: `balaur-docs-and-writing` §3 | `docs/SCHEMA.md` (I1–I17) + `docs/CONFORMANCE.md` (16 of 17); re-check `grep -n 'I1–I14\|13 of 14' README.md AGENTS.md` (empty = repaired) |
| biome `$schema` 2.3.8 | `biome.json:2` | Installed Biome is newer (`bunx biome --version`); config still parses — cosmetic drift |
| ~~Two tracked oddities `ANSI Braille System.dc.html`, `support.js`~~ — **RESOLVED**: removed from HEAD in `79a0a6e` (packaging-truth batch; they were unreferenced strays from upload commit c57348b) | were at repo root; still present inside v0.4.3-pinned installs (web's node_modules) | `ls 'ANSI Braille System.dc.html' support.js` fails at HEAD |

`docs/RELEASE.md` sanctions `bun link balaur-memory` for parallel dev as a
working-tree-only override — this matches current workspace doctrine (unlink
= `rm node_modules/balaur-memory && bun install`; never commit a host with
the link active). See **balaur-workspace-map** for the full cross-repo
consumption rules.

## Provenance and maintenance

All facts verified 2026-07-08 on this machine. Drift-prone facts and their
one-line re-verification commands (run from `/home/alex/projects/balaur/memory`):

| Fact (as of 2026-07-08) | Re-verify with |
|---|---|
| HEAD = f1b168a, 14 unreleased commits past v0.4.3 (incl. 2 breaking) | `git log --oneline -3 && git describe --tags` |
| Tag set: all 7 on origin (release-day v0.2.3/v0.4.0/v0.4.3 lightweight; v0.3.0/v0.3.1/v0.4.1/v0.4.2 backfilled annotated 2026-07-07); nothing past v0.4.3 | `git tag -l && git cat-file -t v0.4.3 && git ls-remote --tags origin` |
| `package.json` version 0.4.3 (stale-by-design until release), `"dependencies": {}`, no `bin`, no build scripts | `grep -E '"version"|"dependencies"|"bin"' package.json` |
| `.gitattributes` export-ignore governs tag installs | `cat .gitattributes` |
| `SCHEMA_VERSION = 4` | `grep -n "SCHEMA_VERSION =" src/storage/schema.ts` |
| 169 tests pass, 13 files | `bun test 2>&1 \| tail -3` |
| 26 conformance scenarios | `ls test/conformance/*.scenario.json \| wc -l` |
| Invariants I1–I17 in SCHEMA.md | `grep -c '^\- \*\*I[0-9]' docs/SCHEMA.md` |
| Only `src/storage/bun.ts` imports bun:sqlite at runtime | `grep -rln '"bun:sqlite"\|from "bun:sqlite"' src \| grep -v test` |
| CI armed (.github/workflows/ci.yml + .githooks/pre-push) | `ls .github/workflows .githooks` |
| One locked agent worktree (advisor/018-task-arc) / biome nested-config failure at root | `git worktree list && bunx biome check . 2>&1 \| tail -3` |
| Advisor branches all merged | `git branch --no-merged main` (empty) |
| I1–I14 wording repaired in AGENTS/README (5b0a7bb; ledger: balaur-docs-and-writing §3) | `grep -n "I1–I14\|13 of 14" AGENTS.md README.md` (empty = repaired) |
| Deep-audit chain landed direct-to-main, linear | `git log --format='%h %p %s' 64c0542..HEAD` (single parents) |
| Stray upload files gone from HEAD | `ls 'ANSI Braille System.dc.html' support.js 2>&1` (fails) |
