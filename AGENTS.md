# balaur-memory project instructions

A standalone TypeScript library on Bun: the consent-gated memory layer of a
personal life OS, built on its own research and its own schema contract — no
parent application. Keep this file lean and high-signal.

## The load-bearing rules

- **The schema is the contract.** `docs/SCHEMA.md` (DDL + invariants I1–I14)
  outranks the code. Schema changes bump `meta.schema_version`, ship a
  migration, and update the doc in the same change. Never edit an applied
  migration.
- **Vectors in, never models.** The library never calls an LLM or an
  embedder — hosts hand in `Float32Array`s. Every API is synchronous. If a
  feature seems to need a model or async, it belongs in a host.
- **`bun:sqlite` is imported by exactly one file**: `src/storage/bun.ts`
  (ADR-0001 containment). Everything else consumes the adapter interface.
- **Zero runtime dependencies.** `package.json` `"dependencies"` stays `{}`.
  Inline the ~50 lines instead. Dev-tooling (typescript, @types/bun, biome)
  is fine.
- **The consent boundary lives in the data layer** (status FSM + queue),
  never in caller discipline. Audit rows are content-free: ids, counts,
  flags — never node text (I7/I12).
- **`index.db` must stay disposable** (I13). A feature that makes its loss
  lossy is wrong by definition.
- **Conformance or it didn't happen**: behavior changes update their
  `test/conformance/*.scenario.json` in the same commit.

## Working style

Full rules: `docs/CODING.md`. Summary: strict tsconfig (never weaken a
flag); functions + plain data (Store is the single class); string-literal
unions, branded ids, no `enum`, no `any`; SQL handwritten and colocated,
parameters always; mutations only through the write choke points; throw
`MemoryError` for broken invariants, return outcomes for domain forks.

## Commands

- `bun install` · `bun run check` (tsc --noEmit + biome + tests) ·
  `bun test`
- `bun run check` must pass before any push. Tests inject the clock; never
  sleep.

## Landing changes

- `docs/HISTORY.md`'s phase log is canonical — update it in the change that
  lands a phase.
- Conventional commits. Never commit or push unless the owner explicitly
  asks.
