---
name: memory-validation-and-qa
description: Use when adding or reviewing tests in balaur-memory — writing a *.scenario.json conformance scenario, editing test/conformance/runner.test.ts, adding a *.test.ts beside a src/ module, deciding what evidence a behavior change needs, interpreting `bun test` / `bun run check` output (biome warnings/infos noise, "nested root configuration" errors), invariant coverage questions (I1–I17), the audit content-leak sentinel, or writing the "verified: N tests" commit receipt.
---

# memory-validation-and-qa — what counts as evidence, and how to add it

Scope: the `memory/` repo (balaur-memory). Everything here is about proving a
change is correct. For WHY the rules exist (rationale + incidents) see
**memory-change-control**. For what an invariant MEANS see
**memory-domain-reference**. For CLI usage and data-dir runbooks see
**memory-cli-and-hosting**. For debugging a failure you didn't cause, start
with **balaur-debugging-playbook**.

**When NOT to use this skill**: you're changing docs only (no behavior) — no
test evidence needed, see balaur-docs-and-writing; you're releasing a version
— release runbook lives in memory-change-control; you're wiring memory into
the web app — balaur-memory-web-campaign owns that choreography.

## 1. The evidence hierarchy

Jargon: an **invariant** is one of the numbered guarantees I1–I17 in
`docs/SCHEMA.md` (the schema contract). A **conformance scenario** is a
declarative JSON file in `test/conformance/` that pins invariants against the
public API and the raw database.

| Rank | Artifact | Proves | Lives at |
|---|---|---|---|
| 1 | Conformance scenario (`*.scenario.json`) | The CONTRACT. "The contract is the database, so the assertions read the database" — raw SQL against memory.db/index.db is the oracle. | `test/conformance/` |
| 2 | Unit test (`*.test.ts` beside the module) | The IMPLEMENTATION: internals, error paths, edge math | `src/` (`cli/` is gone since `3ddb84b`) |
| 3 | Probe test | A HOSTING claim — that a host pattern documented in `docs/HOSTING.md` actually works on the real API (e.g. the net-worth probe, `src/ergonomics.test.ts` `describe("net worth (holdings) host pattern (HOSTING §11)")`) | inside unit suites |
| 4 | Commit receipt | The public record: commit messages carry `verified: N tests` / "`bun run check` green (N tests / 0 fail)" — real precedent in `git log` (e.g. v0.4.1/v0.4.2 commits) | commit message |

A behavior change with only unit tests is half-proven. If it changes what the
contract guarantees, the scenario change goes **in the same commit** — a
behavior change without its scenario change is wrong by definition
(`docs/CONFORMANCE.md` "Rules").

## 2. Baseline and gate (as of 2026-07-08, HEAD `f1b168a`)

Verified by running on this box (Bun 1.3.14 at `~/.bun/bin/bun`):

- `bun test`: **169 pass / 0 fail / 786 expect() calls / 13 files** (~9s
  observed under load; historically sub-second). 13 files = 11 suites in
  `src/`, 1 in `src/storage/` (ulid), 1 conformance runner. (`cli/` and
  its 18-test suite were removed at `3ddb84b`; the 2026-07 deep-audit
  chain then grew the suite 137 → 169.)
- 26 scenario files, pinning **16 of 17 invariants** (all except I14 — see §4).
- `bunx tsc --noEmit`: exit 0.
- `bunx biome check src test`: exit 0 with **3 warnings + 50 infos** over
  58 files. **This noise is the NORMAL passing state** — biome only fails on
  errors. Do not treat warnings/infos as your regression; do not "fix" them
  in an unrelated change.

Run the universal gate from the repo root:

```bash
cd memory && bun run check   # = bunx tsc --noEmit && bunx biome check . && bun test
```

CI runs the same gate (`.github/workflows/ci.yml`, armed at `61ddbd2`,
with `biome ci` instead of `biome check`), and a native `.githooks/pre-push`
hook runs `bun run check` (activate once: `git config core.hooksPath .githooks`).

### Known false failure (machine-specific, re-verified 2026-07-08)

If `bun run check` fails with
`Found a nested root configuration` pointing into
`.claude/worktrees/agent-*/biome.json`: those are agent worktrees (each
carries its own `biome.json`, which biome 2.x rejects as nested roots).
Not your regression and not a repo defect. As of 2026-07-08 exactly one
remains — `agent-ad96ea5a9d59c8f21` on `advisor/018-task-arc`, **locked**
(build plan 018 IN PROGRESS per `plans/README.md`) — and root
`bun run check` DOES still fail on it. **Do not remove a locked worktree**;
it is another session's live workspace. Verify honestly with the scoped
equivalents: `bunx tsc --noEmit && bunx biome check src test && bun test`.

Also known noise: `biome.json` declares schema 2.3.8 while the installed
biome is newer — harmless drift, owner's call to migrate.

## 3. Conformance suite mechanics

Runner: `test/conformance/runner.test.ts` (~372 lines). Spec of record:
`docs/CONFORMANCE.md`. Auto-discovery: every `test/conformance/*.scenario.json`
is picked up by `readdirSync(...).filter(f => f.endsWith(".scenario.json"))`
(runner.test.ts:79) — drop a file in, it runs; no registration step.

### Scenario anatomy

```jsonc
{
  "name": "human-readable test name",
  "invariants": ["I13"],                      // SCHEMA.md invariant numbers this pins
  "clock": "2026-07-05T12:00:00.000Z",        // deterministic start time
  "steps": [
    { "op": "registerType", "name": "note", "bornStatus": "active" },
    { "op": "createNode", "as": "x1",          // "as" binds the result to @x1
      "input": { "type": "note", "title": "Xanadu one", "body": "xanadu", "origin": "t" } },
    { "op": "addAlias", "id": "@x1.id", "alias": "zulu" },   // @name.id resolves a binding
    { "op": "transition", "id": "@x1.id", "to": "forgotten",
      "expectError": "invalid_transition" }    // asserts the op throws THIS MemoryError.code
  ],
  "expect": [
    { "recall": { "terms": ["xanadu"] }, "titles": ["Xanadu one"] },
    { "sql": "SELECT COUNT(*) FROM nodes WHERE type = 'note'", "equals": 1 },
    { "sqlIndex": "SELECT extra FROM nodes_fts WHERE id = ?", "params": ["@x1.id"], "equals": "zulu" }
  ]
}
```

Mechanics (all verified against the runner source):

- **Clock**: the runner does `t = Date.parse(clock)` and opens the store with
  `now: () => new Date(++t)` — every clock read advances 1 ms, so ulids stay
  ordered without sleeping. A step's optional `advanceMs` adds to `t` before
  the step runs (recency decay, `review_at`, staleness become testable).
- **Bindings**: `as` stores the returned node under a name; later steps and
  expects reference `@name` / `@name.id`. `propose` with `as` also records the
  gate outcome string; `forget` with `as` records the forget report.
- **`expectError` is STRICT since `b76a971`** (the conformance-strengthening
  commit): the runner asserts the step throws a `MemoryError` whose `.code`
  equals the declared string (runner.test.ts:232-244) — "the failure REASON
  is part of the contract, not just the failure". Declared values must be
  real codes (`conflict`, `invalid_transition`, `props_invalid`, …).
  (Before b76a971 the string was documentation only and ANY throw passed —
  if you read old scenarios/advice claiming that, it is outdated.)
  Documented in `docs/CONFORMANCE.md`.
- **Raw SQL is the oracle**: `sql` runs read-only against `memory.db`,
  `sqlIndex` against `index.db`; the first column of the first row is compared
  to `equals`. `params` entries starting with `@` resolve bindings.

### Op vocabulary (22 ops, 1:1 with the public API)

`registerType, createNode, updateNode, link, closeEdge, dayAnchor, transition,
touch, setSurfacing, propose, proposeEdit, decide, addAlias,
suggestIdentities, decideIdentity, putVector, quarantine, forget, doctor,
recordDerivation, rebuildIndex, reopenWithoutIndex`

Notes: `link` takes optional edge `type`, `context`, `validity` and binds its
Edge via `as` (so `closeEdge` can reference `@e.id`); `registerType` takes an
optional `propsSchema`; `reopenWithoutIndex` closes the store, deletes
`index.db`, reopens — the I13 disposability probe; `doctor` (new at
`005da77`) binds the DoctorReport via `as`, mirroring `forget`'s report
binding, so `report` expects can assert its fields.

### Expect vocabulary (13 kinds)

| Kind | Asserts |
|---|---|
| `bound` | a bound value (`equals` or regex `matches`) |
| `sql` / `sqlIndex` | first column of first row from memory.db / index.db |
| `outcome` | a `propose` gate outcome (`created` / `merged_pending` / `exists_active`) |
| `conflicts` | the hint reasons for a bound node (order-insensitive) |
| `report` | a path in a bound forget report (`equals` / `length` / `contains`) |
| `recall` | ranked read titles (`titles` unordered / `titlesInOrder`) |
| `entityContext` | the peer card: `aliases`, `peerTitlesInOrder`, `peerVia`; optional `asOf` |
| `history` | snapshot replay: `length` / `bodiesInOrder` / `actions` / `origins` / `whens` |
| `agenda` / `episode` | a `[from, to]` window's `titlesInOrder` (optional `type`) |
| `children` | dashboard read: `edgeType`, optional `statuses`, `titles` (unordered) |
| `neighborhood` | traversal `titlesEqual` (unordered); optional `asOf` |

### Purity rules (what keeps the suite portable)

- The runner imports ONLY the public entry point (`../../src/index.ts`) plus
  `bun:sqlite` for raw reads — **never `src/` internals**. Any future port
  (Node, Go) reimplements the ~350-line runner and must pass the same JSONs.
- **Fixtures are fictional data only.** No real names, places, finances. The
  existing files use invented sentinels (Xanadu, kovrat, zkoval…). A scenario
  with real personal data is a contract violation, not a style issue.
- Each scenario gets a fresh temp-dir store, torn down after.

## 4. The certified scenario inventory (26 files, as of 2026-07-08)

`ls memory/test/conformance/*.scenario.json` — invariant tags read from each
file; purposes match the `docs/CONFORMANCE.md` coverage map (the doc of record
if this table drifts). The three newest (the 2026-07 deep audit) are at the
bottom of the table.

| Scenario | Pins | One-line purpose |
|---|---|---|
| `I1-owner-writes-born-active` | I1, I10 | owner writes are born active with provenance |
| `golden-I1-consent-boundary` | I1, I10 | both halves of the consent boundary + hint kinds |
| `I2-recall-surfacing` | I2 | always/ask/never across recall |
| `I2-consent-surfaces` | I2, I4 | consent on the gate + hints; no exists_active oracle for `never` |
| `I3-neighborhood-active-only` | I3, I2 | traversal excludes never/day, includes ask |
| `golden-I4-audn-gate` | I4 | dedup gate: created / merged_pending / exists_active |
| `golden-I5-supersede` | I5, I2 | supersede + superseded leaves ambient recall |
| `consent-schema-enforcement` | I5 | decide path coerces + validates props against the type schema |
| `I6-forget-cascade` | I6, I7, I8 | forget cascade incl. identity_pending, when_at clearing, content-free log |
| `I8-fsm-terminality-and-guards` | I8 | guarded FSM targets |
| `I9-apple-photos` | I9 | never re-proposed; merge refused either order |
| `I11-ids-and-timestamps` | I11 | id and timestamp discipline |
| `I12-audit-coverage` | I12, I7 | audit rows exist and are content-free |
| `I13-index-disposability` | I13 | delete index.db → reopen → rebuild → identical recall, byte-exact `extra` |
| `temporal-siemens-years` | I15 | declared validity, closeEdge refusals, asOf time travel |
| `I16-history-forget` | I16, I7 | three capture moments replayed; history dies with tombstone; audit survives |
| `planning-tuesday` | I17, I2 | declared appointments, gated task flow, agenda windows, reschedule replay |
| `entities-questions` | I2 | R1–R3 evidence priority, exclusions, idempotent re-runs |
| `golden-two-anas-merge` | I2, I7 | the compound merge: rewire/fold/chain/husk |
| `entity-context-peer-card` | I2, I3 | bounded peer card: filtering, recency order, edges |
| `merge-adversarial-edges` | I9, I8 | no_match never transplants; self-loops die; chains flatten |
| `update-node` | I12 | retitle reconciles aliases; props replace wholesale; audited |
| `project-dashboard` | I2, I12 | children with stated statuses, propsPatch no-clobber, owner fast path, episode window |
| `I2-recall-starvation` | I2 | NEW (`190b6e0`): ineligible (`never`) rows must not starve the recall candidate cap |
| `consent-merge-validation` | I4 | NEW (`5cfc581`): the merge-into-pending branch enforces the props schema |
| `doctor-revision` | I7, I12 | NEW (`005da77`): the doctor's reproposal metric is content-free (salted footprints, never stored text) |

Coverage map: **16 of 17 invariants scenario-pinned**. The exception is
**I14 (single writer)** — by construction, not by scenario: one Store instance
owns writes and a conformance test cannot prove host discipline. Do NOT try to
add an I14 scenario. The `doctor()` report's MATH is covered by unit tests
(`src/doctor.test.ts` — it never mutates, so there is no invariant to pin);
the `doctor-revision` scenario pins the I7/I12 content-free property of the
new reproposal metric, not doctor math.

If an invariant's number, count, or pinning changes, the coverage map table in
`docs/CONFORMANCE.md` changes in the same commit.

## 5. Unit-test conventions

Verified against `test/helpers.ts`, `src/spine.test.ts`,
`src/hardening.test.ts`; rules of record in `docs/CODING.md` "Tests".

- **Placement**: `*.test.ts` beside the code in `src/`. Core modules
  have same-named suites (spine, consent, lifecycle, recall, entities,
  doctor); thematic suites cover arcs and review batches (`hardening`,
  `perpetuity`, `ergonomics`, `planning`, `temporal`) — these have no
  same-named module and that's fine. (The `cli/index.test.ts` suite was
  removed with the CLI at `3ddb84b` — an accepted coverage loss.)
- **Fixtures build a REAL store**: "no mocks of the storage layer — SQLite IS
  the fast fake." **The canonical fixture since `b76a971` is the shared
  `freshStore` helper** (`test/helpers.ts`: mkdtemp dir + injected 1ms tick
  clock; `T0 = 2026-07-05T12:00:00.000Z`) — use it for new suites:

```ts
// the shape src/spine.test.ts actually uses (verified 2026-07-08):
import { freshStore } from "../test/helpers.ts";

let dir: string; let store: Store; let now: () => Date;
beforeEach(() => {
  ({ store, dir, now } = freshStore("bm-"));
  store.registerType({ name: "note", bornStatus: "active" });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
// helpers.ts also exports a dispose() closure and T0 if you prefer those
```

  9 of the 11 `src/` test files use it. `recall.test.ts` and
  `doctor.test.ts` DELIBERATELY keep bespoke fixtures: both advance the
  clock by DAYS via a module-level tick that the helper's closed-over
  counter cannot express — don't "migrate" them to freshStore.
- **Determinism**: always inject the clock via `Store.open({ now })`. NEVER
  `sleep`/`setTimeout`. Time-passage tests advance the injected tick.
- **Raw-SQL assertions**: test files may `import { Database } from "bun:sqlite"`
  directly to read memory.db/index.db read-only. This is the sanctioned
  exception to the ADR-0001 containment seam ("only `src/storage/bun.ts` may
  import bun:sqlite") — the rule scopes to production code (non-test `src/`);
  every raw-asserting test suite and the runner already do this. Since
  `91996a7` one suite goes further: the byte-level forget canary reads RAW
  FILE BYTES of every store file post-forget.
- **Errors**: expect `MemoryError` (or its message substring) for broken
  invariants; expect outcome/report values for domain forks. In scenarios,
  declare the exact `.code` (§3 — the strict runner enforces it).

## 6. Meta-tests that police the rules themselves

These fail the build if a RULE is broken, not just a behavior. Know them so
you don't "fix" them into silence:

| Test | Where (verified 2026-07-08) | Polices |
|---|---|---|
| "sentinel content through every verb never reaches the audit log" | `src/hardening.test.ts` (describe "audit stays content-free — structural", ~line 274) | I7/I12: pushes an `XSENTINELX` marker through every mutating verb, then SQL-greps `audit_log` (`meta LIKE / ref LIKE / action LIKE`) and requires 0 hits. Any new verb that leaks title/body into audit fails here. |
| "audit rows are content-free and cover mutations" | `src/spine.test.ts` (~line 148) | audit coverage exists AND carries no content |
| "index.db is disposable: delete, reopen, rebuild" | `src/spine.test.ts` (~line 136) + `I13-index-disposability.scenario.json` | I13 at both evidence levels |
| "forgotten content does not survive in the store's bytes" | `src/hardening.test.ts` (describe "forget() is honest at the byte level", ~line 385; new in `91996a7`) | I6 at the BYTE level: reads raw bytes of every store file post-forget; was negative-verified (pragma off → test fails) |
| "the reproposal signal stays content-free" | `src/doctor.test.ts` (~line 147; new in `005da77`) | I7 on the doctor's `tf` footprints: no audit meta ever carries the title |

Wording note: CODING.md says "a test greps the audit write paths for
title/body interpolation" — the realization is the *runtime* sentinel grep of
audit_log contents above (behavioral, per-verb), not a static source-code
grep. There is no source-grepping test (verified: no test reads `.ts` source).
If you add a mutating verb, ADD IT to the sentinel test's verb walk — the test
only covers verbs it exercises.

## 7. The acceptance checklist for a behavior change

Copy-paste as your todo list:

```
[ ] Semantics change? Update the design doc first (SCHEMA.md for contract/
    invariants — bump schema_version + append migration; DESIGN/TEMPORAL/
    PLANNING/ENTITIES for their arcs). Doc before code.
[ ] Write the failing unit test beside the module (real temp-dir store,
    injected clock, no mocks).
[ ] Implement until green.
[ ] Update or add the conformance scenario IN THE SAME COMMIT if any
    contract-visible behavior changed (new invariant => new scenario tagged
    with its number; changed behavior => changed expects).
[ ] Update doc counts: CONFORMANCE.md coverage map if an invariant or
    scenario changed; SCHEMA.md invariant list if the contract changed.
[ ] bun run check green (169-test baseline as of 2026-07-08 — your number
    should be >= that and 0 fail; biome warnings/infos noise is normal;
    see §2 for the locked-worktree nested-root false failure).
[ ] Commit message carries the receipt: "verified: N tests" (conventional
    commit type per CODING.md). Do NOT commit/push unless the owner asked —
    see memory-change-control.
```

## 8. What NOT to do

- **No snapshot tests** (`toMatchSnapshot`) — none exist (verified); assert
  explicit values.
- **No mocks of storage** — no `mock()` anywhere (verified); a temp-dir SQLite
  store is faster than a mock and is the real thing.
- **No coverage tooling / coverage gates** — the invariant coverage map IS the
  coverage notion here. Don't add nyc/c8/`bun test --coverage` thresholds.
- **Never edit a scenario's fixtures/expects to make your code pass** — that
  is changing the contract. If the contract should change, that's a SCHEMA.md
  edit + owner-visible decision first (see memory-change-control).
- **Never import `src/` internals in the runner** — it breaks portability, the
  suite's whole point.
- **No real personal data in fixtures**, ever.
- **Don't weaken tsconfig or biome config to get green** — fix the code
  (CODING.md).

## Related skills

- **memory-change-control** — rationale behind the rules, change
  classification, the release runbook, commit/push policy.
- **memory-domain-reference** — what each invariant I1–I17 actually means;
  ranking math; API surface.
- **memory-failure-archaeology** — past findings and dead ends; check before
  concluding a failure is novel.
- **memory-cli-and-hosting** — `balaur` CLI reference and HOSTING.md patterns
  (whose probes §1 rank 3 refers to).
- **balaur-debugging-playbook** — cross-repo symptom → triage.

## Provenance and maintenance

Volatile facts in this skill, each with a one-line re-verification command
(run from `memory/`):

| Fact (as of 2026-07-08) | Re-verify with |
|---|---|
| 169 pass / 786 expects / 13 files | `bun test 2>&1 \| tail -5` |
| 26 scenario files | `ls test/conformance/*.scenario.json \| wc -l` |
| 16/17 invariants pinned; I14 by construction | `grep -h '"invariants"' test/conformance/*.scenario.json \| tr -d ' "[],' \| grep -o 'I[0-9]*' \| sort -uV` |
| Biome noise baseline: 3 warnings + 50 infos, exit 0 | `bunx biome check src test; echo $?` |
| Op vocabulary = 22 ops (incl. `doctor`) | `grep -c 'case "' test/conformance/runner.test.ts` (counts op cases; also read the `switch` in runner.test.ts) |
| expectError pins MemoryError.code (strict since b76a971) | read `expectError` handling near runner.test.ts:232-244 |
| freshStore shared fixture; recall/doctor suites stay bespoke | `head -12 test/helpers.ts; grep -ln freshStore src/*.test.ts \| wc -l` (expect 9) |
| Audit sentinel location | `grep -n "audit stays content-free" src/hardening.test.ts` |
| Byte-level forget canary present | `grep -n "honest at the byte level" src/hardening.test.ts` |
| SCHEMA_VERSION = 4 | `grep -n "SCHEMA_VERSION =" src/storage/schema.ts` |
| HEAD = f1b168a (14 unreleased commits past v0.4.3; no cli/) | `git log --oneline -2 && ls cli 2>&1` |
| Coverage-map table matches CONFORMANCE.md | diff §4 above against `docs/CONFORMANCE.md` "Coverage map" |
| One locked `.claude/worktrees` entry; biome nested-root false failure at root | `git worktree list && bunx biome check . 2>&1 \| tail -3` |
