# Plan 001: Arm CI and add a zero-dependency pre-push gate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- docs/ci.workflow.yml .github AGENTS.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none — this plan MUST land first; every other plan's
  verification story assumes CI exists.
- **Category**: dx
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

The repo's entire correctness guarantee (`bunx tsc --noEmit && bunx biome
check . && bun test`, 155 tests) is enforced by nothing: a complete CI
workflow exists only as an inert file at `docs/ci.workflow.yml` whose own
header says to move it, no `.github/` directory exists, no git hooks are
configured (`git config core.hooksPath` is unset), and no husky/lefthook is
installed. `AGENTS.md:41` states "`bun run check` must pass before any push"
as pure discipline. For a library consumed directly from git tags with no
registry buffer, a red push to main is currently undetectable by tooling.

## Current state

- `docs/ci.workflow.yml` — the complete, correct workflow, parked. Lines 1–2:
  ```yaml
  # Move me to .github/workflows/ci.yml (the integration lacks the Workflows
  # permission; one `git mv` after merge arms CI).
  ```
  The job runs: checkout → `oven-sh/setup-bun@v2` → `bun install` →
  `bunx tsc --noEmit` → `bunx biome ci .` → `bun test`.
- No `.github/` directory exists (`ls .github` → No such file or directory).
- No hooks: no `.githooks/` directory, `git config core.hooksPath` returns
  nothing, no hook-manager dependency (and none may be added — AGENTS.md:
  "Zero runtime dependencies... Dev-tooling is fine" but the repo
  deliberately has no hook manager; use git's native `core.hooksPath`).
- `AGENTS.md:37-42` — the "Commands" section that documents the check gate:
  ```markdown
  ## Commands

  - `bun install` · `bun run check` (tsc --noEmit + biome + tests) ·
    `bun test`
  - `bun run check` must pass before any push. Tests inject the clock; never
    sleep.
  ```
- `package.json:26-28` declares `"engines": { "bun": ">=1.2" }` but nothing
  has ever exercised Bun 1.2 (dev machine runs 1.3.14) — the CI matrix below
  makes the floor observable without blocking merges on it.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Install   | `bun install`        | exit 0              |
| Full gate | `bun run check`      | exit 0 (tsc, biome, 155 tests pass) |
| Tests     | `bun test`           | all pass            |

## Scope

**In scope** (the only files you should modify/create):
- `.github/workflows/ci.yml` (create, via `git mv` from `docs/ci.workflow.yml`)
- `docs/ci.workflow.yml` (removed by the move)
- `.githooks/pre-push` (create)
- `AGENTS.md` (add one line documenting hook activation)

**Out of scope** (do NOT touch):
- `package.json` — no hook-manager dependency, no script changes.
- The workflow's check commands themselves — they are correct; don't
  "improve" them.
- Branch-protection settings (a GitHub UI concern, not a repo file).

## Git workflow

- Branch: `advisor/001-arm-the-gates`
- Conventional commits (repo style, see `git log`: e.g.
  `chore(release): relocate to balaur-software org; v0.4.3`). Suggested:
  `ci: arm the workflow; add native pre-push gate`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Move the workflow into place

```bash
mkdir -p .github/workflows
git mv docs/ci.workflow.yml .github/workflows/ci.yml
```

Then edit `.github/workflows/ci.yml`: delete the 2-line "Move me" header
comment (it is now false), and replace the single `setup-bun` step with a
matrix so the `engines` floor is exercised without blocking merges:

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        bun-version: ["1.2", "latest"]
    continue-on-error: ${{ matrix.bun-version == '1.2' }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ matrix.bun-version }}
      - run: bun install
      - run: bunx tsc --noEmit
      - run: bunx biome ci .
      - run: bun test
```

**Verify**: `bunx tsc --noEmit && bun test` → exit 0 (the move can't break
code, this is the baseline re-check). And
`test -f .github/workflows/ci.yml && test ! -f docs/ci.workflow.yml && echo OK` → `OK`.

### Step 2: Create the pre-push hook

Create `.githooks/pre-push` (mode 0755) with exactly:

```bash
#!/bin/sh
# Native git hook (git config core.hooksPath .githooks) — no hook manager,
# per the zero-dependency stance. Bypass in emergencies: git push --no-verify.
set -e
echo "pre-push: bun run check"
bun run check
```

```bash
chmod +x .githooks/pre-push
git config core.hooksPath .githooks
```

**Verify**: `ls -l .githooks/pre-push | grep -c "x"` → ≥1 (executable), and
`git config core.hooksPath` → `.githooks`.

### Step 3: Document activation in AGENTS.md

In `AGENTS.md`, in the `## Commands` section (after the
"`bun run check` must pass before any push" line), add:

```markdown
- One-time setup: `git config core.hooksPath .githooks` — arms the native
  pre-push hook that runs `bun run check` (no hook manager; bypass with
  `--no-verify` only in emergencies).
```

**Verify**: `grep -n "core.hooksPath" AGENTS.md` → one match.

## Test plan

No new unit tests (infrastructure only). The verification IS the gate:

- `bun run check` → exit 0.
- Hook fires: `git push --dry-run` against any remote would run the hook;
  since pushing is out of scope, verify the hook executes standalone:
  `.githooks/pre-push` → runs check, exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/ci.yml` exists; `docs/ci.workflow.yml` does not
- [ ] `grep -c "Move me" .github/workflows/ci.yml` → 0
- [ ] `grep -c "bun-version" .github/workflows/ci.yml` → ≥2 (matrix present)
- [ ] `.githooks/pre-push` exists, is executable, and running it exits 0
- [ ] `grep -n "core.hooksPath" AGENTS.md` → one match
- [ ] `bun run check` exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `.github/workflows/` already exists with any file in it (someone armed CI
  since this plan was written — reconcile, don't overwrite).
- `docs/ci.workflow.yml` is missing or its content no longer matches the
  excerpt (drift).
- `bun run check` fails BEFORE your changes (the baseline is broken; that is
  not this plan's job to fix).

## Maintenance notes

- The `1.2` matrix leg is `continue-on-error`; if it fails persistently, the
  right fix is bumping `engines.bun` in `package.json` and documenting it in
  `docs/RELEASE.md` — an owner decision, not something CI should silently
  mask forever.
- Plan 002 deletes `cli/` and its tests; the workflow needs no change for
  that (it runs the whole suite, whatever it contains).
- Repository admins may later add branch protection requiring the `check`
  job — out of scope here but the natural follow-up.
