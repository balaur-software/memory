# Plan 011: Make the conformance runner assert what scenarios declare, and extract the shared test fixture

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- test/conformance/runner.test.ts src docs/CONFORMANCE.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: plans/001-arm-the-gates.md; run AFTER plans 005/007/008
  land (they add scenarios/tests this plan's tightened runner will judge).
- **Category**: tests
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

The repo's motto is "conformance or it didn't happen" — but on every
negative path the runner is lying by omission: 16+ scenario steps declare a
specific failure (`"expectError": "invalid_transition"` /` "conflict"` /
`"props_invalid"`), and the runner asserts only "some exception was
thrown". An unrelated TypeError, an unbound-ref bug in the scenario itself,
or the right guard firing for the wrong reason all pass green. Separately,
eleven test files carry a copy-pasted 15-line store fixture whose drift is
already visible — a mechanical tax on every future fixture change.

## Current state

- `test/conformance/runner.test.ts:24-30` — the Step type carries the code:
  ```ts
  type Step = {
    op: string;
    as?: string;
    advanceMs?: number;
    expectError?: string;
    ...
  ```
- `test/conformance/runner.test.ts:227-233` — the weak assertion:
  ```ts
  if (step.expectError !== undefined) {
    expect(run).toThrow();
  } else {
    const result = run();
    if (step.as && result) bindings.set(step.as, result as Node);
  }
  ```
- `MemoryError` shape (`src/types.ts:134-148`): `code` is the six-literal
  union; `name = "MemoryError"`.
- Declared codes in scenarios today:
  `grep -h '"expectError"' test/conformance/*.scenario.json | sort | uniq -c`
  → `props_invalid` (5), `invalid_transition` (3+4 inline), `conflict`
  (3+2 inline) — all valid `MemoryError` codes at planning time.
- The fixture duplication (extract target), e.g.
  `src/spine.test.ts:9-26` — module-level `dir`, `store`, tick clock
  `T0 = Date.parse("2026-07-05T12:00:00.000Z")`, `beforeEach` mkdtemp +
  `Store.open({dir, now})`, `afterEach` close + rm. The same block (± the
  tmp prefix and registered types) appears in 11 `src/*.test.ts` files.
- `docs/CONFORMANCE.md` documents the scenario format — the `expectError`
  field's semantics tighten with this plan; the doc must say codes are
  asserted.
- Packaging note: helpers must NOT ship — `test/` is export-ignored (plan
  009) and `src/**/*.test.ts` is excluded; put the helper under `test/`
  (e.g. `test/helpers.ts`), NOT under `src/`.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Runner    | `bun test test/conformance/runner.test.ts` | all scenarios pass |

## Scope

**In scope**:
- `test/conformance/runner.test.ts` (assert the declared code)
- `test/conformance/*.scenario.json` (ONLY if a declared code turns out to
  mismatch the real thrown code — reconcile, see Step 2)
- `test/helpers.ts` (create), the 11 `src/*.test.ts` fixture blocks
- `docs/CONFORMANCE.md` (one paragraph on expectError semantics)

**Out of scope**:
- Runner verb coverage extensions (new ops) — not needed by current
  scenarios.
- `src/` production code — if Step 2 reveals a WRONG code being thrown,
  that is a finding to report, not to fix here.

## Git workflow

- Branch: `advisor/011-conformance-strengthening`
- Suggested commit: `test: assert declared expectError codes; extract the shared store fixture`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Tighten the runner

Replace the weak branch in `test/conformance/runner.test.ts`:

```ts
if (step.expectError !== undefined) {
  let thrown: unknown;
  try {
    run();
  } catch (e) {
    thrown = e;
  }
  if (thrown === undefined) throw new Error(`step ${step.op}: expected ${step.expectError}, nothing thrown`);
  // Scenario codes pin MemoryError.code — the failure REASON is part of
  // the contract, not just the failure.
  expect(thrown).toBeInstanceOf(MemoryError);
  expect((thrown as MemoryError).code).toBe(step.expectError);
}
```

Import `MemoryError` from `../../src/index.ts` (the runner already imports
`Store`/`Node` from there — keep using the public barrel, per its header
rule "never src/ internals beyond the entry point").

**Verify**: `bun test test/conformance/runner.test.ts` → run it and READ
the output carefully.

### Step 2: Reconcile any label mismatches

If Step 1's run fails on a scenario, the declared code and the real thrown
code disagree. For each mismatch:

1. Read the throwing site in `src/` and decide which is right:
   - The scenario mislabeled → fix the scenario's `expectError` value.
   - The code throws a genuinely wrong/uncoded error (e.g. a raw
     SQLiteError) → STOP and report; production fixes are not this plan.
2. Record each reconciliation in the commit message.

At planning time all declared codes correspond to plausible `MemoryError`
codes, and plan 005 fixes the known raw-SQLiteError escapes — expect zero
to two mislabels, not a flood. More than three → STOP (systematic issue).

**Verify**: `bun test test/conformance/runner.test.ts` → all pass.

### Step 3: Extract the shared fixture

Create `test/helpers.ts`:

```ts
/** The shared store fixture: mkdtemp dir + injected tick clock. Tests
 * never sleep (AGENTS.md); the clock advances 1ms per call so ULIDs and
 * timestamps are strictly ordered. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/index.ts";

export const T0 = Date.parse("2026-07-05T12:00:00.000Z");

export function freshStore(prefix: string): { store: Store; dir: string; now: () => Date; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  let t = T0;
  const now = () => new Date(++t);
  const store = Store.open({ dir, now });
  return { store, dir, now, dispose: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
```

Then sweep the 11 `src/*.test.ts` files: replace each file's hand-rolled
`beforeEach`/`afterEach` fixture with `freshStore` (keep per-file type
registration inside each `beforeEach` — that is suite vocabulary, not
fixture). Files that reopen stores mid-test (e.g. `perpetuity.test.ts`,
`temporal.test.ts`) keep their bespoke reopen logic — convert only the
common open/close skeleton; where the module-level `store` variable is
reassigned mid-test, adapt carefully or leave that file untouched and note
it (do not force the helper where it fights the test).

**Verify** after EACH file conversion: `bun test src/<file>` → same pass
count as before the conversion. Full sweep: `bun test` → same total count.

### Step 4: Document the tightened semantics

`docs/CONFORMANCE.md`: find the scenario-format section describing
`expectError` (grep `expectError`) and state: the value is asserted against
`MemoryError.code` — a scenario passes only when the declared code is the
thrown code.

**Verify**: `grep -n "MemoryError.code" docs/CONFORMANCE.md` → 1 match.

## Test plan

This plan IS tests. Success = same-or-stronger suite: identical scenario
count, all green under the strict runner, identical unit-test counts after
fixture extraction, `bun run check` green.

## Done criteria

- [ ] Runner asserts `MemoryError.code === step.expectError` (grep the
      runner for `expectError` → the strict branch, no bare `toThrow()`)
- [ ] All scenarios pass; reconciliations (if any) listed in the commit
- [ ] `test/helpers.ts` exists; ≥8 of the 11 files use `freshStore`
- [ ] `bun test` total count unchanged from pre-plan baseline
- [ ] `docs/CONFORMANCE.md` documents code assertion
- [ ] `bun run check` exits 0; `plans/README.md` updated

## STOP conditions

- More than three scenario/code mismatches in Step 2 (systematic — needs an
  owner look, maybe an error-taxonomy decision first).
- A mismatch traces to production throwing a NON-MemoryError (raw SQLite
  error) — that is a bug report for the index, not a scenario edit.
- A fixture conversion changes any test's behavior (pass count or assertion
  semantics) — revert that file and note it.

## Maintenance notes

- New scenarios must declare codes that exist in the `MemoryError` union;
  the strict runner now enforces it.
- If the error-code taxonomy is later refactored (recorded, unplanned
  finding), every scenario's `expectError` values participate in that
  sweep — the compiler won't catch JSON, the runner will.
- `test/helpers.ts` is the one place fixture policy (temp dirs, tick
  clocks) now lives; resist per-file variants creeping back.
