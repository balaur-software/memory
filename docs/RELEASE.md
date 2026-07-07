# RELEASE.md — publishing `balaur-memory`

The package is published as a **Git tag-pinned GitHub dependency**, not to
the npm registry. Consumers pin to a tag:

```bash
bun add github:balaur-software/memory#v0.4.3
```

Bun clones the repo at that ref and uses the raw TypeScript directly
(ADR-0001: no build step, no `dist`). GitHub serves that install as a
`git archive` of the tag, so what's shipped is governed by
`.gitattributes` `export-ignore` — **not** by the `files` allowlist in
`package.json` (that field only applies to npm-pack/registry tarballs,
which this project never produces). See
[What ships in a tag](#what-ships-in-a-tag). Bumping the install in a
consumer is `bun update balaur-memory` or re-adding with a new tag.

For parallel development against a local checkout, see
[Linking for parallel dev](#linking-for-parallel-dev) below.

## Cutting a release

1. **Make sure `main` is clean and `bun run check` passes.**
   ```bash
   bun run check   # tsc --noEmit + biome + tests
   ```
2. **Bump `version` in `package.json`** (semver). The version is the
   contract — consumers see only the tag.
   - `patch` (e.g. `0.4.3 → 0.4.4`): fixes and conformance-only changes.
   - `minor` (e.g. `0.4.3 → 0.5.0`): additive API surface, migrations
     that preserve forward compatibility.
   - `major` (e.g. `0.4.3 → 1.0.0`): breaking API or schema changes.
3. **Update `docs/HISTORY.md`** with a one-line phase entry for the
   release (canonical log — `AGENTS.md`).
4. **Commit.** Conventional-commits style:
   ```bash
   git commit -am "chore(release): v0.4.4"
   ```
5. **Tag the commit** with the same version, prefixed `v`:
   ```bash
   git tag v0.4.4
   git push origin main
   git push origin v0.4.4
   ```
6. **Verify** from a clean checkout (or have the consumer run):
   ```bash
   bun add github:balaur-software/memory#v0.4.4
   ```
7. **Verify the consumer view.** `bun add` alone can't prove what a
   git-archive tarball contains (a linked/cloned resolution can hide
   export-ignore gaps) — inspect the installed tree directly:
   ```bash
   mkdir /tmp/verify-release && cd /tmp/verify-release
   bun init -y && bun add github:balaur-software/memory#v0.4.4
   find node_modules/balaur-memory -type f | sort
   ```
   Confirm no `test/`, no `*.test.ts`, no `AGENTS.md`, no `plans/`, and
   no docs beyond `docs/SCHEMA.md` / `docs/HOSTING.md` are present.

The tag is the release. There is no separate publish step, no registry
login, no stale `dist` to rebuild. A tag that doesn't match
`package.json#version` is a bug — fix it by tagging the matching commit,
never by moving the tag.

## What ships in a tag

Releases are git tags, consumed via `bun add github:…#<tag>`. GitHub
serves that as a `git archive`-style tarball of the tag, which honors
`.gitattributes` `export-ignore` — **that file is the actual shipping
allowlist**, not `package.json#files`. `package.json#files` only takes
effect if this package is ever published to the npm registry
(`npm pack`/`npm publish`); today it does nothing, but it's kept present
and in sync by hand in case that changes.

`.gitattributes` `export-ignore` marks as excluded:

- `test/`, `src/**/*.test.ts` — no test code or fixtures
- `plans/`, `AGENTS.md`, `docs/*` (all but `SCHEMA.md`/`HOSTING.md`),
  `docs/adr/` — contributor-facing docs and planning artifacts
- `.github/`, `.githooks/`, `.editorconfig`, `biome.json`, `bun.lock`,
  `.gitattributes`, `.gitignore` — repo/CI tooling, not consumer needs

What ships: `src/` (library code, tests excluded), `docs/SCHEMA.md`,
`docs/HOSTING.md` (the contracts a host needs at install time),
`package.json`, `README.md`, `LICENSE`, `tsconfig.json`. `AGENTS.md` is
deliberately **not** shipped — it's a contributor rule set, not a
consumer contract.

Keep `.gitattributes` and `package.json#files` in sync by hand — there is
no automated check that they agree.

### Backfilled tags

The runbook above ("the tag is the release") wasn't followed from the
start. Versions `v0.3.0`, `v0.3.1`, `v0.4.1`, `v0.4.2` shipped (per commit
messages / `docs/HISTORY.md`) without a corresponding git tag, leaving
them unpinnable. Backfilled 2026-07-07, tagging the commit whose own
`package.json#version` matches:

| Tag      | Commit    |
|----------|-----------|
| `v0.3.0` | `441a55b` |
| `v0.3.1` | `469749a` |
| `v0.4.1` | `35d75e1` |
| `v0.4.2` | `d454edd` |

Each backfilled tag's annotation notes it was added after the fact.
Pre-runbook versions `v0.1.x`–`v0.2.2` are deliberately left untagged —
they predate the "tag is the release" convention and no reliable
`package.json#version`-to-commit mapping was established for them at the
time.

## Schema-version coordination

A release that changes `meta.schema_version` (per `AGENTS.md`) MUST:
ship the migration in the same commit, bump `SCHEMA_VERSION` in
`src/storage/schema.ts`, update `docs/SCHEMA.md`, and call it out
explicitly in the `docs/HISTORY.md` entry. Consumers reading the
changelog before bumping is the only protection they get — there is no
registry advisory.

## Linking for parallel dev

When developing `balaur-memory` and a host (e.g. `balaur-life`) at the
same time, link the local checkout so edits land instantly without
re-pinning the tag:

```bash
# in balaur-memory/
bun link                       # registers this package globally

# in the host (e.g. balaur-life/)
bun link balaur-memory         # symlinks node_modules/balaur-memory → local checkout
```

The host's `package.json` should still declare the github-tag pin (so
CI/deploy/fresh checkouts resolve to a real release); `bun link` only
overrides the resolution in that one working tree. To go back to the
pinned release (Bun 1.3.x has no `bun unlink` yet — drop the symlink
manually and let `bun install` re-resolve):

```bash
rm node_modules/balaur-memory && bun install
```

Never commit the host with the link active — the link lives outside
`package.json`. The pin in `package.json` is the source of truth for
"what version this project builds against"; the link is a local dev
convenience only.
