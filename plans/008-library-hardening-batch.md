# Plan 008: Library hardening batch — registry JSON, propsPatch/template semantics, backup guards

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- src/types.ts src/spine.ts src/consent.ts src/store.ts src/hardening.test.ts src/ergonomics.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW (part C: MED — a semantic decision, see Step 3)
- **Depends on**: plans/005-consent-verb-integrity.md (touches the same
  files; land 005 first to avoid conflicts)
- **Category**: bug
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

Three independent, probe-confirmed weaknesses, batched because they share
files and test harnesses:

- **A. Registry JSON is unhardened.** `nodes.props` got a narrow validator
  (`parseProps`, `src/types.ts:116-130`: "a malformed props cell degrades to
  an empty object instead of bricking every read") — but the SAME threat
  (bit-rot, out-of-band sqlite edits) against `node_types.template`,
  `node_types.props_schema`, or `pending_edits.fields` throws a raw
  `SyntaxError` that bricks every write of that type, or the whole
  `pendingQueue()` render. Probe-confirmed: corrupting `node_types.template`
  makes `createNode` throw `SyntaxError: JSON Parse error`.
- **B. Backup failure artifacts wedge the rotation.** `backup()` is
  check-then-act; a `VACUUM INTO` that fails mid-write leaves a partial
  file that permanently trips "backup target already exists" on retry, and
  nothing rejects a target inside the live store directory (a probe showed
  the reserved-sibling-name protection is accidental).
- **C. `propsPatch: {key: null}` is a silent no-op for templated keys.**
  The patch deletes the key, then `applyTemplateAndValidate` re-merges
  `template.props` and resurrects it (probe: `template.props = {prio:
  "normal"}`, patch `{prio: null}` → result still `{"prio":"normal"}`).
  This contradicts the documented "a null value REMOVES its key (RFC
  7386-style)" semantics at `src/spine.ts:415-418`.

## Current state

- `src/types.ts:116-130` — `parseProps`, the pattern to extend:
  ```ts
  export function parseProps(raw: string): Props {
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Props;
      return {};
    } catch {
      return {};
    }
  }
  ```
- `src/spine.ts:178-201` — `applyTemplateAndValidate`, the bare parses:
  ```ts
  const template = JSON.parse(t.template) as { body?: string; props?: Record<string, unknown> };
  const schema = JSON.parse(t.props_schema) as Record<
    string,
    { type: "string" | "number" | "boolean"; required?: boolean }
  >;
  const merged: Record<string, unknown> = { ...(template.props ?? {}), ...props };
  ```
- `src/consent.ts:344-347` — `applyFields`' bare parse of the same schema.
- `src/consent.ts:248-261` — `editEnvelopeFor`'s bare
  `JSON.parse(r.fields)`.
- `src/spine.ts:396-459` — `updateNode`; the propsPatch flow at 419-433:
  ```ts
  let mergedProps: Props | undefined;
  if (patch.propsPatch !== undefined) {
    const merged: Record<string, unknown> = { ...node.props };
    for (const [key, value] of Object.entries(patch.propsPatch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    mergedProps = merged;
  }
  const nextProps =
    patch.props !== undefined
      ? applyTemplateAndValidate(t, nextBody, patch.props).props
      : mergedProps !== undefined
        ? applyTemplateAndValidate(t, nextBody, mergedProps).props
        : (node.props as Record<string, unknown>);
  ```
- `src/consent.ts:385-386` — the precedent for birth-only template
  semantics: "template body-fill stays a birth-only semantic — the edited
  body is used as-is."
- `src/store.ts:316-322` — `backup()` (excerpted in plan 003; plan 003 adds
  a `chmodSync` line — this plan's edits compose after it).
- Test harness for corrupt rows: `src/hardening.test.ts` already opens raw
  `bun:sqlite` handles against the store dir to damage rows — copy that
  pattern.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Suites    | `bun test src/hardening.test.ts src/ergonomics.test.ts` | all pass |

## Scope

**In scope**:
- `src/types.ts` (new `parseJsonObject` helper next to `parseProps`)
- `src/spine.ts` (`applyTemplateAndValidate` hardening; propsPatch
  template-resurrection fix)
- `src/consent.ts` (`applyFields` schema parse; `editEnvelopeFor` fields
  parse)
- `src/store.ts` (`backup()` guards)
- `src/hardening.test.ts`, `src/ergonomics.test.ts` (tests)
- `src/contract.ts` (ONLY if Step 3's chosen semantics change a docstring)

**Out of scope**:
- `parseProps` itself — unchanged.
- Any registry write-path validation (registerType already JSON.stringifies
  caller objects — writes are safe; this is read-side hardening).
- The `files`/packaging or permission concerns of backups (plans 003/009).

## Git workflow

- Branch: `advisor/008-library-hardening-batch`
- Suggested commit: `fix(core): harden registry/envelope JSON reads, birth-only template fill, backup guards`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: One narrow validator for all row-level JSON objects

In `src/types.ts`, directly below `parseProps`, add:

```ts
/** parseProps' sibling for other row-level JSON objects (type templates,
 * prop schemas, edit envelopes): same degrade-don't-brick contract
 * (CODING.md). Damage is surfaced by the callers' audited warnings, not
 * by an untyped throw. */
export function parseJsonObject<T extends Record<string, unknown>>(raw: string): T {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as T;
    return {} as T;
  } catch {
    return {} as T;
  }
}
```

Replace the three bare parses:
- `src/spine.ts:183-184` (template + schema in `applyTemplateAndValidate`),
- `src/consent.ts:344` (schema in `applyFields`),
- `src/consent.ts:255` (fields in `editEnvelopeFor`).

Semantics note: a corrupted `props_schema` degrading to `{}` means "any
props allowed" — writes proceed un-validated rather than bricking. That is
the parseProps philosophy applied consistently; the doctor's duplicate scan
and owner inspection remain the damage detectors (same argument as
`src/types.ts:118-121`).

**Verify**: `bun run check` → exit 0.

### Step 2: Corruption tests

In `src/hardening.test.ts` (using its existing raw-Database damage
pattern):

1. Corrupt `node_types.template` to `"{not json"` → `createNode` of that
   type still succeeds (template treated as empty).
2. Corrupt `node_types.props_schema` the same way → `createNode` succeeds;
   `updateNode` succeeds.
3. Corrupt one `pending_edits.fields` cell → `pendingQueue()` returns the
   queue without throwing; the damaged envelope renders with empty fields.

**Verify**: `bun test src/hardening.test.ts` → all pass.

### Step 3: Make template prop-fill birth-only

In `src/spine.ts`, split `applyTemplateAndValidate` into fill and
validation concerns WITHOUT changing its exported signature (the consent
decide path calls it too):

Add an options parameter defaulting to today's behavior for births:

```ts
export function applyTemplateAndValidate(
  t: TypeRow,
  body: string,
  props: Props,
  opts: { fillTemplate?: boolean } = {},
): { body: string; props: Record<string, unknown> } {
  const fill = opts.fillTemplate ?? true;
  ...
  const merged: Record<string, unknown> = fill ? { ...(template.props ?? {}), ...props } : { ...props };
```

Call sites:
- `insertNode` (`src/spine.ts:230`): unchanged (birth — fills).
- `updateNode` (`src/spine.ts:428-433`): pass `{ fillTemplate: false }` for
  BOTH the whole-replace and propsPatch branches — an edit's result is
  exactly what the caller stated, validated against the schema; template
  defaults are a birth-only semantic (mirroring the body-fill rule quoted
  above).
- `applyFields` (`src/consent.ts:386`): pass `{ fillTemplate: false }` —
  same reasoning; the comment there already says body fill is birth-only.

Update the propsPatch docstring at `src/spine.ts:415-418` and the
`updateNode` docstring in `src/contract.ts:70-79` with one added clause:
"template defaults apply at birth only — an edit can remove a templated
key."

Behavior consequence to be aware of: after this change, a whole-replace
`props: {}` on a node whose type has a REQUIRED templated prop will now
throw `props_invalid` (previously the template silently refilled it). That
is the validator doing its job — the loud path the docs promise.

**Verify**: `bun test` → all pass EXCEPT any test that pinned the
resurrection behavior — if one exists, read it: if it asserts resurrection
as intended behavior, STOP (see conditions); the audit found none.

### Step 4: propsPatch regression tests

In `src/ergonomics.test.ts` (where updateNode ergonomics live):

1. Type with `template: { props: { prio: "normal" } }`; create node (gets
   `prio: "normal"`); `updateNode(id, { propsPatch: { prio: null } })` →
   returned node's props LACK `prio`; re-`getNode` confirms persisted.
2. Same type, patch `{other: "x"}` → `prio` survives (merge doesn't drop
   untouched keys).
3. A required schema prop cannot be null-removed: schema
   `{ level: {type:"string", required:true} }`, template provides it;
   patch `{ level: null }` → throws `props_invalid` (removal now real, so
   validation now catches it — the loud path).

**Verify**: `bun test src/ergonomics.test.ts` → all pass.

### Step 5: Backup guards

In `src/store.ts` `backup()` (which after plan 003 ends with `chmodSync` +
audit), add before the existing existsSync check:

```ts
const resolved = resolve(toPath);
if (dirname(resolved) === resolve(this.dir_))
  throw new MemoryError("props_invalid", "backup target cannot live inside the store directory");
```

This needs the store to know its dir: add a
`private readonly dir_: string;` set in the constructor via the ctx — the
constructor currently takes only `ctx`; extend `Store`'s private
constructor to accept and store the dir (`Store.open` has `opts.dir` in
hand). Import `dirname, resolve` from `node:path` (the file already
imports `join`).

And wrap the VACUUM so a failed backup never leaves a wedge:

```ts
try {
  ctx.mem.run("VACUUM INTO ?", [resolved]);
} catch (e) {
  rmSync(resolved, { force: true }); // a partial backup is worse than none
  throw e;
}
```

Tests (in `src/hardening.test.ts`):
4. `backup(join(dir, "memory.db-wal"))` → throws `props_invalid` (inside
   store dir).
5. Failed VACUUM cleanup: call `backup("/proc/definitely/not/writable/x.db")`
   (or a path in a read-only temp subdir created with mode 0o500) → throws,
   and the target does not exist afterwards.

**Verify**: `bun run check` → exit 0.

## Test plan

Eight new tests across `hardening` (corruption ×3, backup ×2) and
`ergonomics` (propsPatch ×3). Full suite green.

## Done criteria

- [ ] `grep -c "JSON.parse" src/spine.ts src/consent.ts` → only inside
      parse helpers/`parseProps`-style call sites; the three bare sites are
      gone (spine template/schema, consent schema, consent envelope)
- [ ] All 8 new tests pass; `bun run check` exits 0
- [ ] propsPatch null-removal works on templated keys (probe behavior fixed)
- [ ] backup refuses in-store targets; failed backup leaves no partial file
- [ ] `git status` clean outside in-scope paths
- [ ] `plans/README.md` status row updated

## STOP conditions

- Step 3 breaks an existing test that asserts template-refill-on-edit as
  DESIRED behavior — that means the semantics were load-bearing somewhere
  the audit missed; report with the test name and stop.
- A conformance scenario fails after Step 3 (none pins template-on-edit at
  planning time — a failure means drift).
- `Store`'s constructor shape has changed (drift) making Step 5's dir
  plumbing mismatch.

## Maintenance notes

- `parseJsonObject` is now the rule: ANY future JSON column read must go
  through it or `parseProps` — worth one line in `docs/CODING.md`'s SQL
  discipline section when docs are next touched (plan 010 may absorb).
- The birth-only template rule now covers body AND props uniformly; if a
  future "re-apply template" owner verb is wanted, it should be an explicit
  verb, not a side effect of editing.
- Reviewer scrutiny: Step 3's `fillTemplate: false` at exactly two call
  sites (updateNode, applyFields) — a third caller appearing later must
  choose deliberately.
