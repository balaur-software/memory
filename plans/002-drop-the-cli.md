# Plan 002: Remove the CLI — the Bun library becomes the only supported surface

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- cli package.json biome.json README.md docs/CLI.md docs/RELEASE.md docs/INTEGRATIONS.md docs/HOSTING.md docs/HISTORY.md AGENTS.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-arm-the-gates.md (CI verifies the removal)
- **Category**: tech-debt (owner-directed scope reduction)
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

**This is an explicit owner decision, stated 2026-07-07: "We can drop the
CLI and we won't handle any integrations except direct bun library."** The
library (`import { Store } from "balaur-memory"`) becomes the single
supported surface; the `balaur` CLI, its `bin` entry, and the
`bun build --compile` standalone-binary story are removed.

What this buys: ~1,200 lines of host code (cli/ is 537+316+157+103+91 lines)
plus `docs/CLI.md` stop needing maintenance; several audited CLI bugs
(silent `suggest-identities` no-op, `--field` coercion crash, `--now`
timezone shift, missing display gate for quarantined content) become moot
rather than needing fixes; the package's public surface shrinks to exactly
`src/` + three docs.

What this costs — the owner accepted these, but state them in the commit
message so the decision is auditable: (a) the repo loses its only reference
host and the worked example HOSTING.md's patterns lean on; (b)
`cli/index.test.ts` exercised the full parse→Store→render path end-to-end
(16 of the 155 tests) — that coverage disappears; (c) ADR-0001's deployment
story ("`bun build --compile` for a standalone binary") no longer has a
target — the ADR text itself is historical record and is NOT edited.

## Current state

- `cli/` — five files: `index.ts` (entry, 103L), `args.ts` (parser, 91L),
  `commands.ts` (39 subcommands, 537L), `render.ts` (formatters, 157L),
  `index.test.ts` (in-process CLI tests, 316L). Nothing in `src/` imports
  from `cli/` (verify in Step 1).
- `package.json:14-16` — the bin entry:
  ```json
  "bin": {
    "balaur": "./cli/index.ts"
  },
  ```
- `package.json:17-25` — `files` includes `"cli"`, `"!cli/**/*.test.ts"`,
  and `"docs/CLI.md"`.
- `package.json:44-45` — `"build"` and `"build:cross"` scripts exist solely
  to compile the CLI binary.
- `biome.json:5` — `"files": { "includes": ["src/**", "test/**", "cli/**", "*.json"] }`.
- `README.md:50-68` — section "### The `balaur` CLI (the second supported
  surface)"; `README.md:118` — docs-table row for `docs/CLI.md`.
- `docs/CLI.md` — the full command reference (delete).
- `docs/RELEASE.md` — references the standalone binary / `bun run build`
  flow and what ships (rewrite of shipping claims happens in plan 009; here
  only remove CLI-specific build steps).
- `docs/INTEGRATIONS.md:3-8` — "The two supported surfaces for now are the
  in-process library … and the `balaur` CLI" (update to one surface).
- `docs/HOSTING.md` — CLI mentions in prose (architecture line 20 "a CLI",
  §10 backup and "daily tick" reference `balaur` commands in places —
  verify with grep and convert those snippets to library calls).
- `AGENTS.md` — no direct CLI references in the load-bearing rules (verify
  with grep; update only if a match appears).
- Baseline: `bun test` → 155 tests / 14 files. After this plan: 139 tests /
  13 files (the 16 CLI tests go with `cli/index.test.ts`).

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Tests     | `bun test`           | all pass, 13 files  |
| Reference sweep | `grep -rn --include="*.ts" --include="*.json" --include="*.md" -i "balaur \|cli/" src docs README.md AGENTS.md package.json biome.json` | see per-step expectations |

## Scope

**In scope**:
- `cli/` (delete entirely)
- `package.json` (remove `bin`, `build`, `build:cross`, and the three
  cli/CLI.md entries in `files`)
- `biome.json` (remove `"cli/**"` from includes)
- `README.md` (remove CLI section + docs-table row; adjust the two-surface
  framing)
- `docs/CLI.md` (delete)
- `docs/INTEGRATIONS.md`, `docs/HOSTING.md`, `docs/RELEASE.md`,
  `docs/HISTORY.md` (surgical mention updates only)

**Out of scope** (do NOT touch):
- `src/` — no library code changes of any kind in this plan.
- `docs/adr/0001-bun-typescript.md` — ADRs are historical records; the
  deployment-story drift is acceptable and documented here, not there.
- `docs/SCHEMA.md`, `docs/DESIGN.md`, `docs/CODING.md` — no CLI references
  that require changes (verify; if grep finds one, STOP).
- Rewriting RELEASE.md's `files`-allowlist shipping claims — that is plan
  009's job; only remove the binary-build steps here.

## Git workflow

- Branch: `advisor/002-drop-the-cli`
- Suggested commit: `feat!: drop the balaur CLI — the Bun library is the only supported surface`
  with a body recording the owner decision and the three accepted costs
  listed in "Why this matters".
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the CLI is a leaf

```bash
grep -rn "from \"../cli\|from \"./cli\|from '\.\./cli\|require.*cli/" src test
```

**Verify**: no output (nothing outside `cli/` imports it). If anything
matches, STOP.

### Step 2: Delete the CLI and its config hooks

```bash
git rm -r cli
git rm docs/CLI.md
```

In `package.json`: delete the `bin` object; delete the `build` and
`build:cross` scripts; in `files`, delete the lines `"cli"`,
`"!cli/**/*.test.ts"`, and `"docs/CLI.md"`.
In `biome.json`: change includes to `["src/**", "test/**", "*.json"]`.

**Verify**: `bun run check` → exit 0, and `bun test 2>&1 | tail -2` reports
tests across **13 files** (was 14).

### Step 3: Update README.md

- Delete the whole section `### The \`balaur\` CLI (the second supported
  surface)` (lines ~50–68 at planning time).
- In the docs table, delete the `docs/CLI.md` row.
- Search for remaining mentions: `grep -n -i "cli\|bunx balaur\|bin\b" README.md`
  and rephrase any survivor so the README describes exactly one surface
  (the in-process library). Keep the edit minimal — do not rewrite
  unrelated prose.

**Verify**: `grep -c -i "balaur CLI\|bunx balaur" README.md` → 0.

### Step 4: Update the satellite docs

- `docs/INTEGRATIONS.md`: in the Status bullet (lines 3–8), change "The two
  supported surfaces for now are the in-process library … and the `balaur`
  CLI shipped in the same package …" to state the single supported surface
  (the in-process library) and that ALL process-boundary surfaces including
  a CLI are deferred/out of scope per the owner's 2026-07 decision.
- `docs/HOSTING.md`: `grep -n -i "balaur \|CLI" docs/HOSTING.md`; for each
  hit, either delete the CLI phrasing or convert the example to the
  equivalent `Store` call (the guide's code samples are already library
  calls almost everywhere — expect only prose mentions).
- `docs/RELEASE.md`: remove the standalone-binary/`bun run build` steps;
  `grep -n -i "compile\|dist/\|binary\|balaur " docs/RELEASE.md` and remove
  matched steps. Do NOT rewrite the `files`/shipping-claims section (plan
  009).
- `docs/HISTORY.md`: append one phase-log line at the top of the log, in the
  file's existing style, recording the CLI removal and the owner decision.
  (AGENTS.md: "docs/HISTORY.md's phase log is canonical — update it in the
  change that lands a phase.")

**Verify**: `grep -rn -i "bunx balaur\|balaur CLI\|bun run build" README.md docs/ --include="*.md" | grep -v HISTORY.md | grep -v adr/` → no output.

### Step 5: Full sweep and gate

```bash
grep -rn "cli/" package.json biome.json README.md docs/*.md | grep -v adr | grep -v HISTORY
bun run check
```

**Verify**: grep → no output; check → exit 0.

## Test plan

No new tests. The deletion is verified by:
- `bun test` → all pass, 13 files (16 fewer tests than baseline 155).
- `bunx tsc --noEmit` → exit 0 (proves nothing referenced deleted symbols).

## Done criteria

- [ ] `cli/` and `docs/CLI.md` do not exist
- [ ] `grep -c "bin\|build:cross" package.json` → 0 matches for both
- [ ] `bun run check` exits 0
- [ ] `bun test` runs 13 files, 0 fail
- [ ] Reference sweep greps in Steps 3–5 all return empty
- [ ] `docs/HISTORY.md` has the new phase-log entry
- [ ] `git status` clean outside in-scope paths
- [ ] `plans/README.md` status row updated

## STOP conditions

- Step 1's grep finds an import of `cli/` from outside `cli/`.
- Any `src/` file appears to need modification to keep the build green.
- `docs/SCHEMA.md`, `docs/DESIGN.md`, or `docs/CODING.md` turn out to
  reference the CLI in a way requiring edits (unexpected — report instead).
- The operator/owner has NOT confirmed this removal (the decision above is
  dated 2026-07-07; if you have any signal it was reversed, stop).

## Maintenance notes

- Plans 009 (packaging) and 010 (docs sync) assume this plan landed; their
  file lists shrink accordingly.
- The audited CLI bugs (suggest-identities cap=0, `--field` coercion crash,
  `--now` lenient parse, no quarantine display gate) are resolved by
  deletion; they are recorded as superseded in `plans/README.md` so nobody
  re-fixes them.
- If a CLI is ever wanted again, `git log` retains the full implementation;
  `docs/INTEGRATIONS.md` remains the design sketch for process-boundary
  surfaces.
- Reviewer scrutiny: the README/HOSTING edits — the prose must not
  accidentally promise a surface that no longer exists.
