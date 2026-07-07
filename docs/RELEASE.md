# RELEASE.md — publishing `balaur-memory`

The package is published as a **Git tag-pinned GitHub dependency**, not to
the npm registry. Consumers pin to a tag:

```bash
bun add github:balaur-software/memory#v0.4.3
```

Bun clones the repo at that ref and uses the raw TypeScript directly
(ADR-0001: no build step, no `dist`). The `files` allowlist in
`package.json` is what gets shipped — `src`, the two contract docs.
Bumping the install in a consumer is `bun update balaur-memory` or
re-adding with a new tag.

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

The tag is the release. There is no separate publish step, no registry
login, no stale `dist` to rebuild. A tag that doesn't match
`package.json#version` is a bug — fix it by tagging the matching commit,
never by moving the tag.

## What ships in a tag

The `files` field in `package.json` controls it:

- `src/` — the library (tests excluded via `!src/**/*.test.ts`)
- `docs/SCHEMA.md`, `docs/HOSTING.md` — the contracts a
  host needs at install time

Everything else (`README.md`, `LICENSE`, `AGENTS.md`, the rest of `docs/`,
`test/`, `support.js`, the `.dc.html` scratchpad) is in the repo but not
in the install. `AGENTS.md` is deliberately **not** shipped — it's a
contributor rule set, not a consumer contract.

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
