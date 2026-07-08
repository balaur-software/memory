# Plan 005: Close the consent-gate validation bypass and whitelist destructive verb inputs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- src/consent.ts src/entities.ts src/spine.ts src/consent.test.ts src/entities.test.ts test/conformance`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-arm-the-gates.md
- **Category**: bug (all four probe-confirmed 2026-07-07)
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

Four confirmed holes in the write/verdict boundary — the exact layer the
library exists to make trustworthy:

1. **The gate mints schema-violating nodes.** `propose()`'s
   merge-into-pending branch updates body/props/importance with a raw SQL
   UPDATE, skipping `applyTemplateAndValidate` and the importance range
   check. Probe: a type declaring `score: number (required)` accepted
   `{score: "not-a-number"}` via a duplicate-title proposal, and
   `decide(approve)` activated it — while the code's own comment at
   `src/consent.ts:332-334` promises "the consent boundary must not be the
   one write that can mint a schema-violating node" (review-2 F3).
   `importance: 9` through the same branch escapes as a raw
   `SQLiteError: CHECK constraint failed` instead of `MemoryError`.
2. **Any unknown identity verdict runs the destructive merge.**
   `decideIdentity` checks only `verdict === "different"`; everything else
   — including a typo like `"Different"` — falls into the compound merge:
   edges rewired, aliases folded, the node retired to a terminal `merged`
   husk (I8). Irreversible.
3. **An unknown decision kind silently destroys work and forges the
   ledger.** `decide()`'s switches have no default: on a parked edit an
   unknown `kind` falls through to `clearEdit` (the agent's proposed edit is
   deleted) and writes an `ok:true` audit row; on a proposal it returns
   `undefined as Node` and also audits success. For a consent-ledger
   library a false audit entry is itself an invariant break (I12's value is
   trustworthiness).
4. **`setSurfacing` writes unvalidated input** — a bad value dies as a raw
   CHECK-constraint SQLiteError instead of `MemoryError("props_invalid")`,
   unlike `transition` (validated via `TRANSITIONS`) and `children`
   (validates statuses).

(These reach the library through hosts passing runtime data — the TS union
types do not protect JS callers, JSON-driven hosts, or future RPC surfaces.)

## Current state

- `src/consent.ts:150-169` — the merge branch (branch 1 of the gate):
  ```ts
  const pending = findByNormalizedTitle(ctx, p.type, title, "proposed");
  if (pending !== null) {
    const props = { ...pending.props, ...(p.props ?? {}) };
    const whenAt = p.when !== undefined ? parseStrictIso(p.when, "when") : pending.when;
    ctx.mem.run(
      "UPDATE nodes SET body = ?, importance = ?, props = ?, when_at = ?, origin = ?, author = ?, updated = ? WHERE id = ?",
      [ p.body, p.importance ?? pending.importance, JSON.stringify(props), ...
  ```
- `src/spine.ts:226-230` — the validation the create branch gets (in
  `insertNode`) and the merge branch skips:
  ```ts
  const importance = input.importance ?? 0;
  if (!Number.isInteger(importance) || importance < 0 || importance > 5)
    throw new MemoryError("props_invalid", "importance must be an integer between 0 and 5");
  const t = typeRow(ctx, input.type);
  const { body, props } = applyTemplateAndValidate(t, input.body ?? "", input.props ?? {});
  ```
  `applyTemplateAndValidate` and `typeRow` are already exported from
  `src/spine.ts` and already imported by `src/consent.ts:18-29`.
- `src/entities.ts:266-283` — `decideIdentity`'s verdict handling:
  ```ts
  export function decideIdentity(ctx: Ctx, keep: NodeId, other: NodeId, verdict: "same" | "different"): Node {
    if (keep === other) throw new MemoryError("conflict", "a node cannot be merged with itself");
    ...
    if (verdict === "different") { ... return mustGet(ctx, keep); }
    // --- the compound merge, in order (each step audited) ---
  ```
- `src/consent.ts:411-443` — `decide()`'s proposal branch: `let result: Node;`
  then a 4-case switch with no default; `src/consent.ts:462-479` — the
  parked-edit branch: switch with `case "reject": break;` and no default,
  followed unconditionally by `clearEdit(ctx, id)` + success audit.
- `src/spine.ts:697-701` — `setSurfacing`:
  ```ts
  export function setSurfacing(ctx: Ctx, id: NodeId, s: Surfacing): void {
    const node = mustGet(ctx, id);
    ctx.mem.run("UPDATE nodes SET surfacing = ?, updated = ? WHERE id = ?", [s, ...
  ```
- Error convention (`docs/DESIGN.md` "Errors and outcomes"): throw
  `MemoryError` with a code from the six-code union for invalid input —
  `"props_invalid"` is the bad-argument code used by siblings (see
  `children()` at `src/spine.ts:339-345`).
- Conformance rule (`AGENTS.md`): "behavior changes update their
  `test/conformance/*.scenario.json` in the same commit."

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Suites    | `bun test src/consent.test.ts src/entities.test.ts` | all pass |
| Conformance | `bun test test/conformance/runner.test.ts` | all pass |

## Scope

**In scope**:
- `src/consent.ts` (merge-branch validation; decide kind whitelist)
- `src/entities.ts` (verdict whitelist)
- `src/spine.ts` (setSurfacing whitelist ONLY — no other spine changes)
- `src/consent.test.ts`, `src/entities.test.ts` (new tests)
- `test/conformance/` (one new scenario pinning the gate validation)

**Out of scope** (do NOT touch):
- The compound merge/decide sequences themselves — their non-atomicity is
  documented design (I5), not a bug.
- `findByNormalizedTitle`'s N+1 shape — a separate recorded finding; do not
  refactor it here.
- `updateNode`'s propsPatch/template interaction — plan 008.

## Git workflow

- Branch: `advisor/005-consent-verb-integrity`
- Suggested commit: `fix(consent): validate the merge path and whitelist verdict/kind/surfacing inputs`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Validate the merge branch of the gate

In `src/consent.ts`, inside the `if (pending !== null)` branch and BEFORE
the `ctx.mem.run("UPDATE nodes SET ...")` call, add the same checks the
create path runs (mirror `insertNode`'s order — range check, then schema):

```ts
const importance = p.importance ?? pending.importance;
if (!Number.isInteger(importance) || importance < 0 || importance > 5)
  throw new MemoryError("props_invalid", "importance must be an integer between 0 and 5");
const checked = applyTemplateAndValidate(typeRow(ctx, p.type), p.body, props);
```

Then use `checked.props` (instead of `props`) and `importance` (instead of
`p.importance ?? pending.importance`) in the UPDATE's parameter list, and
`p.body` stays as-is (template body-fill is a birth-only semantic — match
the comment at `src/consent.ts:385-386`).

**Verify**: `bun test src/consent.test.ts` → existing tests pass.

### Step 2: Whitelist the identity verdict

In `src/entities.ts`, first line of `decideIdentity` (before the
`keep === other` check):

```ts
if (verdict !== "same" && verdict !== "different")
  throw new MemoryError("props_invalid", `verdict must be "same" or "different", got ${JSON.stringify(verdict)}`);
```

**Verify**: `bun test src/entities.test.ts` → pass.

### Step 3: Whitelist the decision kind

In `src/consent.ts`, first lines of `decide()` (before `mustGet`):

```ts
const KINDS = ["approve", "approve_edited", "approve_superseding", "reject"] as const;
if (!(KINDS as readonly string[]).includes(d.kind))
  throw new MemoryError("props_invalid", `unknown decision kind ${JSON.stringify((d as { kind: string }).kind)}`);
```

(Place `KINDS` as a module-level const next to the `Decision` type if you
prefer — either location is fine; keep it adjacent to what it validates.)

**Verify**: `bunx tsc --noEmit` → exit 0 (the cast pattern above compiles
under `verbatimModuleSyntax` + strict; adjust the narrowing locally if tsc
objects, without weakening the check).

### Step 4: Whitelist surfacing

In `src/spine.ts` `setSurfacing`, before the UPDATE:

```ts
if (s !== "always" && s !== "ask" && s !== "never")
  throw new MemoryError("props_invalid", `surfacing must be always|ask|never, got ${JSON.stringify(s)}`);
```

**Verify**: `bun run check` → exit 0.

### Step 5: Tests + conformance scenario

Tests (follow each file's existing style — `expect(() => ...).toThrow()`
with message fragments):

In `src/consent.test.ts`:
1. Merge-path schema enforcement: register gated type with
   `score: {type:"number", required:true}`; propose valid; propose same
   (case-shifted) title with `props: {score: "x"}` → throws `props_invalid`;
   with `importance: 9` → throws `props_invalid` (NOT a SQLiteError).
2. Valid merge still works: same-title propose with `{score: 7}` →
   `merged_pending`, props updated.
3. `decide(id, {kind: "aprove"} as never)` → throws `props_invalid`; the
   parked edit (if any) SURVIVES — assert `pendingQueue()` length unchanged
   and no new `consent.decide` audit row with ok=1
   (`SELECT COUNT(*) FROM audit_log WHERE action='consent.decide'` via raw
   `bun:sqlite`, the file's existing pattern).

In `src/entities.test.ts`:
4. `decideIdentity(a, b, "Different" as never)` → throws `props_invalid`;
   both nodes still `active` (no husk).

In `src/spine.test.ts` or `src/lifecycle.test.ts` (whichever holds
surfacing tests — check both, add where `setSurfacing` is already tested):
5. `setSurfacing(id, "sometimes" as never)` → throws `props_invalid`.

Conformance: add `test/conformance/consent-merge-validation.scenario.json`
pinning case 1 (registerType with schema → propose ok → propose duplicate
with bad prop, `"expectError": "props_invalid"`). Model the JSON on
`test/conformance/consent-schema-enforcement.scenario.json`. List it under
`"invariants": ["I4"]`.

**Verify**: `bun run check` → exit 0; new tests present and passing.

## Test plan

Five unit cases + one conformance scenario, per Step 5. The probe scripts
that confirmed these bugs live outside the repo; the tests above are their
in-repo pins.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] Probe behaviors now refused: bad merge props → `props_invalid`;
      `importance: 9` merge → `props_invalid`; typo verdict → `props_invalid`
      with no merge side effects; typo kind → `props_invalid` with parked
      edit intact; bad surfacing → `props_invalid`
- [ ] New conformance scenario runs in the suite
- [ ] `git status` clean outside in-scope paths
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any existing test breaks in a way that suggests intended behavior relied
  on the bypass (e.g. a scenario proposing schema-less merges) — report;
  the fix may need a semantic ruling from the owner.
- The excerpts don't match (drift).
- You find yourself wanting to make the compound merge atomic — that is
  documented design; out of scope.

## Maintenance notes

- Step 1 changes what the gate accepts: hosts that (incorrectly) relied on
  merge-path laxness will now get `props_invalid` — this is the contract
  working; release notes should say so.
- Any future verdict kind (e.g. a "redact" variant) must be added to the
  `KINDS` whitelist AND the `Decision` union together — the whitelist makes
  forgetting loud instead of silent.
- Reviewer scrutiny: Step 1's parameter reordering in the UPDATE — compare
  parameter list against column list carefully; a swapped pair would pass
  tsc.
