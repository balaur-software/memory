# Plan 014: The DoctorReport revision — pay all three documented IOUs in one breaking change

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- src/doctor.ts src/contract.ts src/doctor.test.ts docs/ENTITIES.md docs/TEMPORAL.md docs/SCHEMA.md test/conformance`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW (breaking change is pre-announced by the repo's own docs)
- **Depends on**: plans/001-arm-the-gates.md
- **Category**: direction (documented-but-undelivered)
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

Three separate docs hold IOUs against "the next DoctorReport revision",
and paying them piecemeal would break hosts three times instead of once:

1. `docs/ENTITIES.md:211-212`: "Doctor fields for the identity queue —
   deferred to avoid a second breaking change; revisit with the next
   DoctorReport revision." The value is already computed internally
   (`identityCount`, `src/doctor.ts:38-45`) and folded invisibly into
   `pendingCount` — a classic surface asymmetry.
2. `docs/TEMPORAL.md:248-250` names its retention instrument: "the doctor
   reports it first (a future `historyRows` metric), and the owner
   decides." (Plan 013's history-policy design depends on this
   visibility existing.)
3. `docs/FIELD.md:74` sanctions exactly one residue of the rejected
   `improve()` verb: "at most a future doctor metric (reproposal-after-
   forget rate)" — nothing tells the owner when a deliberately-forgotten
   fact keeps being re-proposed by agents, the precise failure the consent
   gate exists to catch.

The doctor is the host's one health surface; this plan ships the revision
with all three at once, conformance-pinned, doctrine intact ("reports,
never acts"; audit rows stay content-free).

## Current state

- `src/contract.ts:33-48` — the current report shape:
  ```ts
  export interface DoctorReport {
    readonly activeCount: number;
    readonly pendingCount: number;
    readonly acceptRate30d: number | null;
    readonly deadWeightCandidates: readonly NodeId[];
    readonly staleCandidates: readonly NodeId[];
    readonly duplicateCandidates: ReadonlyArray<readonly [NodeId, NodeId]>;
    readonly dueCandidates: readonly NodeId[];
    readonly queueOldestDays: number | null;
    readonly integrityOk: boolean;
  }
  ```
- `src/doctor.ts:29-45` — `proposedCount`, `editCount`, `identityCount`
  are each computed with their own SQL, then summed:
  `const pendingCount = proposedCount + editCount + identityCount;`
- `src/doctor.ts:47-62` — `acceptRate30d` reads `audit_log` rows
  (`action = 'consent.decide'`) and parses `meta` JSON — the existing
  pattern for audit-derived metrics.
- The forget audit row (`src/lifecycle.ts:112-116`):
  `audit(ctx, "owner", "forget.cascade", id, true, {...})` — `ref` = the
  node id. The propose audit rows (`src/consent.ts:168,178,198`):
  `action = 'consent.propose'`, `ref` = node id, meta carries
  `{outcome, type}` — all content-free (I7/I12).
- **The reproposal-matching problem you must solve in Step 1**: after
  `forget()`, the node's title is destroyed (`title=''`) and a NEW
  proposal gets a NEW id — so "same fact re-proposed" cannot be matched by
  id or by stored text. The audit log is content-free by invariant, so it
  can't carry titles either. The design decision (made here, owner
  ratifies via the doc note): the forget cascade already computes a
  normalized-title footprint at forget time for its mention scan
  (`src/lifecycle.ts:77-82`); the doctrine-compliant option is a **salted
  hash of the normalized title** stored in the forget audit row's meta
  (content-free: irreversible without the store's salt; salt = `store_id`
  from meta), and the SAME hash recorded in `consent.propose` audit meta
  going forward. The metric then joins hashes within the window.
- Conformance: `test/conformance/I12-audit-coverage.scenario.json` and
  `project-dashboard.scenario.json` exercise doctor/report paths — check
  which pin `DoctorReport` fields before renaming anything.
- `docs/SCHEMA.md` — audit_log semantics section documents meta as
  content-free ids/counts/flags; the hash addition needs one sentence
  there (it remains content-free — a keyed hash reveals nothing without
  the file, and possession of the file reveals everything anyway).

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Suites    | `bun test src/doctor.test.ts test/conformance/runner.test.ts` | all pass |

## Scope

**In scope**:
- `src/contract.ts` (DoctorReport fields), `src/doctor.ts`
- `src/consent.ts` + `src/lifecycle.ts` (ONLY the audit-meta hash addition)
- `src/doctor.test.ts`, one conformance scenario
- `docs/ENTITIES.md`, `docs/TEMPORAL.md` (close the IOU sentences),
  `docs/SCHEMA.md` (audit-meta hash sentence)

**Out of scope**:
- Any auto-action on the metrics ("reports, never acts" — absolute).
- Retention policy itself (plan 013's design decides; this plan only
  measures).
- Renaming/removing EXISTING report fields.

## Git workflow

- Branch: `advisor/014-doctor-revision`
- Suggested commit: `feat(doctor)!: the announced report revision — pendingByKind, historyRows, reproposedAfterForget30d`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend the report shape

In `src/contract.ts`, add to `DoctorReport` (keeping every existing field):

```ts
/** The queue by kind — proposals awaiting a verdict, parked edits,
 * identity questions (ENTITIES.md's deferred fields, delivered). */
readonly pendingByKind: { readonly proposals: number; readonly edits: number; readonly identities: number };
/** Total memory_history rows — the retention instrument TEMPORAL.md
 * names; visibility first, policy is the owner's. */
readonly historyRows: number;
/** Proposals in the last 30 days whose normalized title matches a fact
 * the owner forgot (matched by salted hash in the audit ledger — never
 * by stored text). The sanctioned residue of the rejected improve()
 * (FIELD.md). Reports, never acts. */
readonly reproposedAfterForget30d: number;
```

In `src/doctor.ts`: `pendingByKind` reuses the three counts already
computed (lines 29-45); `historyRows` is
`SELECT COUNT(*) AS c FROM memory_history`; `reproposedAfterForget30d`
joins audit rows per Step 2's hashes (window: `at >= isoDaysAgo(now, 30)`
on the propose side; forgets any age).

### Step 2: The content-free reproposal signal

- Add a small helper (in `src/spine.ts` next to `audit()`, exported):
  `titleFootprint(ctx, title)` → first 16 hex chars of SHA-256 over
  `store_id + "\n" + normalizeText(title)` (`store_id` read once from
  meta; cache on Ctx if trivial, else query per call — forget/propose are
  not hot). Use `Bun.CryptoHasher` or `crypto.subtle`? — both async or
  Bun-specific: use `new Bun.CryptoHasher("sha256")` — synchronous, and
  ADR-0001 already contains the Bun bet (this is NOT sqlite, so it does
  not violate the bun.ts containment rule, which is specifically about
  `bun:sqlite`; note it in a comment).
- `src/lifecycle.ts` forget audit meta gains `tf: titleFootprint(...)`
  (computed BEFORE the title is destroyed — alongside the existing
  mention-scan block at lines 77-82).
- `src/consent.ts` — all three propose audit sites gain the same
  `tf` meta key.
- `docs/SCHEMA.md` audit-log section: one sentence documenting `tf` as a
  keyed, content-free footprint for the doctor's reproposal metric.

**Verify**: `bun test` → green; raw-inspect one audit row in a scratch
store: meta contains a 16-hex `tf`, not a title.

### Step 3: Tests + scenario + close the IOUs

- `src/doctor.test.ts` (follow its existing style):
  1. `pendingByKind` sums to `pendingCount` with one of each kind queued.
  2. `historyRows` counts snapshots after two updateNode calls.
  3. Reproposal: create (owner type via propose+approve or gated create),
     forget it, propose the same title again → report shows
     `reproposedAfterForget30d = 1`; a DIFFERENT title → stays 0; a
     reproposal 31+ "days" later (tick the injected clock) → 0.
- Conformance: `test/conformance/doctor-revision.scenario.json` pinning
  the three fields via the `report` expectation form (see
  `runner.test.ts:254-260` — it reads `reports` bound from forget; check
  whether the runner exposes doctor output; if NOT, extend the runner with
  a `doctor` op + expectation following its existing switch pattern — the
  runner is in scope for this addition).
- Close the IOU sentences: `docs/ENTITIES.md:211-212` and
  `docs/TEMPORAL.md:248-250` get "(delivered — see DoctorReport)" edits.

**Verify**: `bun run check` → exit 0.

## Test plan

Three unit tests + one scenario (Step 3). Existing doctor tests unchanged
and green.

## Done criteria

- [ ] Three new fields on `DoctorReport`, computed and tested
- [ ] Audit meta carries `tf` on forget + propose; no title text in any
      audit row (assert in test)
- [ ] IOU sentences in ENTITIES.md/TEMPORAL.md closed
- [ ] `bun run check` exit 0; conformance green
- [ ] `plans/README.md` status row updated

## STOP conditions

- A conformance scenario pins the EXACT current `DoctorReport` key set
  (additions break it) — reconcile the scenario, but if it asserts "no
  other keys" semantics deliberately, report first.
- `Bun.CryptoHasher` unavailable in the target Bun version (engines floor
  is 1.2 — verify; if missing, use the WebCrypto sync digest alternative
  or STOP).
- The hash-in-meta approach conflicts with an I7 reading you discover in
  SCHEMA.md stricter than "ids, counts, flags" — report; the owner rules
  on whether a keyed footprint counts as content.

## Maintenance notes

- The `tf` footprint only accrues from this version forward — forgets
  older than the change have no footprint, so the metric undercounts
  history; document that in the field's docstring (already worded
  "matched … in the audit ledger").
- Plan 013's history policy will read `historyRows`; plan 012's task
  designs may want `pendingByKind` in a host dashboard — no coupling,
  just consumers.
- This is the ONE sanctioned breaking revision — the next report change
  should again batch (note for future maintainers, per ENTITIES.md's own
  reasoning).
