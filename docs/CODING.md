# CODING.md — the rules

Rules exist to keep a decades-scale personal codebase reviewable by its one
owner. Add a rule only when it changes a real decision.

## Language & runtime

- TypeScript, strict. Bun ≥ 1.2 is the reference runtime; only
  `src/storage/bun.ts` may import `bun:sqlite` (the containment seam,
  ADR-0001).
- `tsconfig.json` is law: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`. Never weaken a flag
  to make code compile — fix the code.
- **Zero runtime dependencies.** `package.json` `"dependencies"` stays `{}`
  forever; a PR that adds one must instead inline the ~50 lines it actually
  needed. Dev dependencies (typescript, @types/bun, biome) are fine.

## Style

- **Functions and plain data.** Modules export functions over a shared
  storage handle; `Store` is the single class (the façade holding the open
  databases). No inheritance, no decorators, no DI containers.
- **String-literal unions, never `enum`.** `type Status = "proposed" | ...`
  — erasable, greppable, JSON-friendly.
- **Branded ids**: `type NodeId = string & { readonly __brand: "NodeId" }` —
  ids don't accidentally cross (a NodeId is not an EdgeId is not a string).
- **No `any`, no non-test `as`.** Unknown JSON enters through narrow
  validators (`parseProps`, hand-rolled ~20 lines — the zero-dep rule means
  no Zod; that's fine, the shapes are few).
- **SQL is colocated and literal.** The module that owns a table writes its
  SQL as template strings next to the functions that use it. No query
  builders, no string concatenation of user input — parameters always (`?`).
- **Errors**: throw `MemoryError` with a `code` union for broken invariants;
  return outcomes/reports for expected domain forks (see DESIGN.md). Never
  throw strings, never catch-and-swallow — a caught error is either handled
  meaningfully or rethrown.
- Every exported symbol carries a JSDoc line that says something the
  signature doesn't. Comments explain *why*; the code says *what*.
- Formatting and lint: Biome, dev-only, zero config beyond the repo file.
  `bun run check` (tsc --noEmit + biome + tests) must pass before any push.

## Data discipline

- Every mutation goes through the write choke points in `spine.ts` /
  `consent.ts` / `lifecycle.ts` — never raw SQL from a feature module to the
  `nodes` table. The choke points own fan-out (FTS upsert, on_day edge,
  audit) exactly once.
- Audit rows are content-free (SCHEMA I7/I12): ids, actions, counts, flags.
  A test greps the audit write paths for `title`/`body` interpolation and
  fails on any hit.
- `index.db` must stay disposable (I13): any feature that would make its
  loss lossy is wrong by definition — put the durable part in `memory.db`.
- Schema changes: edit `docs/SCHEMA.md` first (DDL + invariants), bump
  `schema_version`, append a migration in `storage/schema.ts`, never edit an
  applied migration.

## Tests

- `bun test`. One `*.test.ts` beside each module; fixtures build a real
  temp-dir Store (no mocks of the storage layer — SQLite IS the fast fake).
- The conformance suite (`test/conformance/`, see CONFORMANCE.md) is the
  contract's test: scenario JSONs asserting SCHEMA.md invariants by number.
  A PR that changes behavior updates the scenario in the same change or it
  is wrong.
- Determinism: tests inject the clock (`Store` takes `now?: () => Date`) and
  never sleep.

## Landing changes

- Conventional commits (`feat` / `fix` / `docs` / `refactor` / `test`).
- Never commit or push unless the owner explicitly asks; gate every push on
  `bun run check`.
- `docs/HISTORY.md`'s phase log is canonical — update it in the same
  change that lands a phase.
