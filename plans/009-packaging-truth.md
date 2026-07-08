# Plan 009: Make what ships match what the docs claim — export-ignore, stray files, missing tags

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- package.json docs/RELEASE.md docs/HISTORY.md .gitattributes support.js "ANSI Braille System.dc.html"`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/002-drop-the-cli.md (the shipped set must be final
  before the ignore rules are written)
- **Category**: deps / packaging
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

Probe-confirmed 2026-07-07: `bun add github:balaur-software/memory#v0.4.3`
installs the **entire repository tree** (~1.1MB) into the consumer's
`node_modules` — every test file, all 15 docs, `AGENTS.md`, `bun.lock`, and
two stray files uploaded by mistake (`support.js`, 1,581 lines of generated
JS for an unrelated project, and `ANSI Braille System.dc.html`, 310KB).
The `files` allowlist in `package.json` only applies to `npm pack`/registry
tarballs — which this project never produces (releases are git tags).
`docs/RELEASE.md` states the opposite ("The `files` allowlist … is what
gets shipped"; `AGENTS.md` is "deliberately not shipped") — affirmatively
false for the only distribution channel the project uses.

Separately, the runbook's own invariant ("The tag is the release") is
already broken: commit messages record shipped versions v0.2.0–v0.4.3, but
only `v0.2.3`, `v0.4.0`, `v0.4.3` have tags — 0.3.0, 0.3.1, 0.4.1, 0.4.2
are unpinnable, and `docs/HISTORY.md` cites a v0.2.0 that never existed as
a tag.

## Current state

- Stray files at repo root (arrived via commit `c57348b` "Add files via
  upload"; imported by nothing — verified by grep):
  - `support.js` — header: `// GENERATED from dc-runtime/src/*.ts — do not
    edit.` (no `dc-runtime/` exists here)
  - `ANSI Braille System.dc.html`
- `package.json:17-25` — the `files` allowlist (post-plan-002 it lists
  `src`, `!src/**/*.test.ts`, `docs/SCHEMA.md`, `docs/HOSTING.md`; if plan
  002 has NOT landed it still lists cli entries — see STOP).
- No `.gitattributes` exists.
- `docs/RELEASE.md` — the "what ships" claims (grep `files` and `shipped`);
  plan 002 already removed the binary-build steps.
- Tags: `git tag -l` → `v0.2.3 v0.4.0 v0.4.3`. Version-bump commits found
  by `git log --oneline --all | grep -oE '\[v0\.[0-9.]+\]'`:
  v0.2.0–v0.4.3 (10 distinct). The four missing with identifiable commits:
  - `441a55b` — feat: temporal phase A … [v0.3.0]
  - `469749a` — feat: temporal phase B … [v0.3.1]
  - `35d75e1` — fix: the perpetuity batch … [v0.4.1]
  - `d454edd` — feat: the ergonomics batch … [v0.4.2]
- How GitHub serves `bun add github:…#tag`: a `git archive`-style tarball —
  which HONORS `.gitattributes` `export-ignore` rules. This is the fix
  mechanism. (Bun may also fall back to a full git clone for non-GitHub
  refs; the empirical check in Step 4 is the authority, not this
  assumption.)

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Local archive check | `git archive HEAD \| tar -t \| sort > /tmp/shipped.txt && cat /tmp/shipped.txt` | reflects export-ignore rules |

## Scope

**In scope**:
- Delete: `support.js`, `ANSI Braille System.dc.html`
- Create: `.gitattributes`
- Edit: `docs/RELEASE.md` (shipping-claims section), `docs/HISTORY.md`
  (v0.2.0 reference)
- Tags: create 4 annotated tags on existing commits (LOCAL ONLY — pushing
  tags is the operator's act)

**Out of scope**:
- `package.json` `files` — keep it (harmless, and correct if the package is
  ever registry-published); the fix is `.gitattributes`, not deleting
  `files`.
- Rewriting git history — the stray files remain in history; that is fine
  and noted in the commit message.

## Git workflow

- Branch: `advisor/009-packaging-truth`
- Suggested commit: `chore(packaging): export-ignore the non-shipped tree; remove stray uploads; document real git-tag shipping`
- Tags: `git tag -a vX.Y.Z <sha> -m "vX.Y.Z (backfilled 2026-07-07 — see docs/RELEASE.md)"`
- Do NOT push branches OR tags unless the operator instructed it.

## Steps

### Step 1: Remove the stray files

```bash
git rm support.js "ANSI Braille System.dc.html"
```

**Verify**: `bun run check` → exit 0 (nothing referenced them).

### Step 2: Write .gitattributes

Create `.gitattributes` at the repo root. Everything not needed by a
consumer of the library is export-ignored (the archive keeps: `src/` minus
tests, `docs/SCHEMA.md`, `docs/HOSTING.md`, `package.json`, `README.md`,
`LICENSE`, `tsconfig.json`):

```gitattributes
# What a git-tag install ships is governed HERE (git archive), not by
# package.json "files" (npm-pack only). Keep the two lists in sync.
.github         export-ignore
.githooks       export-ignore
.editorconfig   export-ignore
.gitattributes  export-ignore
.gitignore      export-ignore
AGENTS.md       export-ignore
biome.json      export-ignore
bun.lock        export-ignore
plans           export-ignore
test            export-ignore
src/**/*.test.ts export-ignore
docs/DESIGN.md      export-ignore
docs/CODING.md      export-ignore
docs/CONFORMANCE.md export-ignore
docs/TEMPORAL.md    export-ignore
docs/PLANNING.md    export-ignore
docs/ENTITIES.md    export-ignore
docs/HISTORY.md     export-ignore
docs/RELEASE.md     export-ignore
docs/INTEGRATIONS.md export-ignore
docs/FIELD.md       export-ignore
docs/adr            export-ignore
```

(If plan 010 or the owner decides more docs should ship, the list shrinks —
the mechanism is what matters. `docs/CLI.md` is gone via plan 002.)

**Verify**:
```bash
git add .gitattributes && git archive HEAD | tar -t | sort
```
→ output contains `src/store.ts`, `docs/SCHEMA.md`, `docs/HOSTING.md`,
`README.md`, `package.json`, `LICENSE`, `tsconfig.json`; contains NO
`test/`, no `*.test.ts`, no `AGENTS.md`, no `plans/`, no `docs/DESIGN.md`.
(Note: `git archive HEAD` reads attributes from the worktree only after
they are committed on the tested tree-ish; run the check after committing,
or use `git archive --worktree-attributes`.)

### Step 3: Correct the docs

- `docs/RELEASE.md`: rewrite the "what ships" passage to state reality:
  releases are git tags consumed via `bun add github:…#tag`; the shipped
  set is governed by `.gitattributes export-ignore` (git-archive
  semantics); `package.json#files` only matters if the package is ever
  registry-published, and the two lists are kept in sync by hand. Add one
  runbook step: "after tagging, verify the consumer view:
  `bun add github:balaur-software/memory#<tag>` in a scratch dir and
  inspect `node_modules/balaur-memory`."
- `docs/RELEASE.md`: add a "Backfilled tags" note listing
  v0.3.0/v0.3.1/v0.4.1/v0.4.2 with their SHAs and the note that
  pre-runbook versions v0.1.x–v0.2.2 are deliberately untagged.
- `docs/HISTORY.md`: locate the "(v0.2.0)" reference (grep `v0.2.0`) and
  correct it to the version that actually existed at that point per
  `git log -- package.json` (v0.2.x history: 0.1.0 → 0.2.2; pick the value
  the adjacent phase-log entry's commit actually had — check with
  `git show <that-commit>:package.json | grep version`).

**Verify**: `grep -n "files" docs/RELEASE.md` → the allowlist claim now
describes gitattributes; `grep -n "v0.2.0" docs/HISTORY.md` → 0 matches or
a corrected, existing version.

### Step 4: Backfill the four tags (local)

```bash
git tag -a v0.3.0 441a55b -m "v0.3.0 (backfilled 2026-07-07): temporal phase A"
git tag -a v0.3.1 469749a -m "v0.3.1 (backfilled 2026-07-07): temporal phase B"
git tag -a v0.4.1 35d75e1 -m "v0.4.1 (backfilled 2026-07-07): perpetuity batch"
git tag -a v0.4.2 d454edd -m "v0.4.2 (backfilled 2026-07-07): ergonomics batch"
```

For each, first confirm the commit's own package.json version matches:
`git show 441a55b:package.json | grep '"version"'` → `0.3.0`, etc. On any
mismatch, STOP (the log analysis was wrong; report the discrepancy).

**Verify**: `git tag -l | sort` → 7 tags; each backfilled tag's
`git show <tag>:package.json | grep version` matches its name.

## Test plan

No unit tests — packaging infrastructure. Verification is the
git-archive listing (Step 2) plus, when network access is available, the
scratch-dir `bun add` check written into RELEASE.md (do it if you can;
record the result in your report — the tag you install must be one that
contains `.gitattributes`, so this full check only becomes meaningful at
the NEXT release tag; say so in the report rather than claiming it).

## Done criteria

- [ ] `support.js` and `ANSI Braille System.dc.html` deleted
- [ ] `.gitattributes` present; `git archive` listing matches the intended
      shipped set (no tests, no plans/, no non-shipped docs, no AGENTS.md)
- [ ] RELEASE.md describes git-archive shipping + backfilled-tags note;
      HISTORY.md v0.2.0 corrected
- [ ] 4 backfilled tags exist locally, each matching its commit's
      package.json version
- [ ] `bun run check` exits 0
- [ ] `git status` clean outside in-scope paths
- [ ] `plans/README.md` status row updated

## STOP conditions

- Plan 002 has not landed (`cli/` still exists): the export-ignore list and
  RELEASE.md wording differ — stop and report rather than writing rules for
  a tree that is about to change.
- A backfill commit's package.json version doesn't match the tag name.
- `git archive` still lists ignored paths after committing (attribute
  syntax problem — fix or report; do not ship a half-working list).

## Maintenance notes

- The `.gitattributes`/`files` sync is manual — the RELEASE.md runbook step
  (scratch-dir install check) is the enforcement; reviewers of any release
  PR should ask "did the shipped-set check run?"
- The stray files remain in git history (harmless); if the owner ever wants
  them fully purged that is a history rewrite with force-push implications
  — deliberately not proposed.
- Tag pushes: `git push --tags` is the operator's call, noted in the
  runbook.
