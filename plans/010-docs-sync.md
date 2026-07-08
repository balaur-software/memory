# Plan 010: Sync the docs with the code they govern — counts, versions, maps, error contract

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- README.md AGENTS.md docs/SCHEMA.md docs/DESIGN.md docs/HISTORY.md docs/HOSTING.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (Plans 002/009 touch some of
> these files — expect their diffs; what must still MATCH are the specific
> lines excerpted below.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/002-drop-the-cli.md (README/doc edits compose)
- **Category**: docs
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

This repo's doctrine makes doc drift a correctness issue: "The schema is
the contract. docs/SCHEMA.md … outranks the code" (AGENTS.md), and
DESIGN.md promises "if code and prose disagree, code wins and this file
gets fixed." Five verified drifts currently mislead exactly the readers
those docs exist for — agents loading AGENTS.md first, future implementers
reading SCHEMA.md as the durable contract, and hosts reading HOSTING.md:

1. README/AGENTS/HISTORY say invariants are I1–I14 and "13 of 14 pinned";
   SCHEMA.md defines I1–I17, conformance pins 16 of 17 (I14 by
   construction), and README even contradicts itself ("seventeen numbered
   invariants" at line 74 vs "13 of 14" at line 92).
2. SCHEMA.md's meta-table comment says `schema_version` is "currently 2";
   the code stamps 4 (`SCHEMA_VERSION = 4`) and the same doc's DDL already
   describes v4 columns. A second implementer following the comment would
   write a v2 marker into a v4-shaped file — tripping the future-file
   guard or re-running deltas.
3. DESIGN.md's architecture diagram and module map omit `entities.ts` (one
   of the largest modules — the whole identity arc) and `contract.ts` (one
   of README's "two contracts").
4. The `MemoryError` six-code union — the error contract hosts must switch
   on — is documented only in DESIGN.md, which does not ship; HOSTING.md
   (which ships) never mentions it.
5. HISTORY.md cites "13 of 14" while its own phase log records I15–I17
   landing with scenarios.

## Current state

(Line numbers as of `9182b14`; plans 002/009 may shift them — match on
content.)

- `README.md:74` — "seventeen numbered invariants" (correct).
- `README.md:92-94` — "13 of 14 schema invariants are pinned by the
  conformance suite (I14 by construction)" (stale).
- `README.md:113` — docs table: "The data contract: DDL, semantics,
  invariants I1–I14" (stale).
- `AGENTS.md:9` — "**The schema is the contract.** `docs/SCHEMA.md` (DDL +
  invariants I1–I14) outranks the code." (stale).
- `docs/HISTORY.md:45-46` — "13 of 14 invariants are conformance-pinned
  (I14, single writer, holds by construction)." (stale).
- `docs/SCHEMA.md:31-32` — meta table comment:
  ```
  -- rows: schema_version (integer as text, currently "2"), store_id (ulid),
  --       created (timestamp)
  ```
  vs `src/storage/schema.ts:11` — `export const SCHEMA_VERSION = 4;`.
- `docs/SCHEMA.md:198` — "## Invariants (conformance fixtures reference
  these by number)" — enumerates I1 (line 200) through I17 (line 278).
  Ground truth for the counts: scenario files reference I1–I13 and I15–I17
  (`grep -h '"invariants"' test/conformance/*.scenario.json`).
- `docs/DESIGN.md:19-31` — the architecture diagram (spine/consent/recall/
  lineage/lifecycle/doctor — no entities); `docs/DESIGN.md:98-119` — the
  module map (no `entities.ts`, no `contract.ts`).
- `docs/DESIGN.md:87-97` — "Errors and outcomes": the six-code union
  documented here only:
  `"not_found" | "invalid_transition" | "type_unknown" | "props_invalid" | "store_closed" | "conflict"`
  (verify against `src/types.ts:134-148`).
- `docs/HOSTING.md` — `grep -c "MemoryError" docs/HOSTING.md` → 0.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0 (docs-only change; still run it) |
| Count check | `grep -h '"invariants"' test/conformance/*.scenario.json \| tr -d ' "[]' \| sed 's/invariants://' \| tr ',' '\n' \| sort -u` | I1–I13, I15–I17 |

## Scope

**In scope**: `README.md`, `AGENTS.md`, `docs/SCHEMA.md` (the one comment
line), `docs/DESIGN.md` (diagram + map + one pointer line), `docs/HISTORY.md`
(one line), `docs/HOSTING.md` (new short "Errors" subsection).

**Out of scope**:
- Any code file.
- SCHEMA.md's DDL/invariant BODIES — only the meta comment line changes.
- Rewriting prose style anywhere — minimal diffs only.
- CLI.md — deleted by plan 002.

## Git workflow

- Branch: `advisor/010-docs-sync`
- Suggested commit: `docs: sync invariant counts, schema_version comment, module map, host error contract`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Invariant counts (4 sites)

- `README.md:92-94` → "16 of 17 schema invariants are pinned by the
  conformance suite (I14 by construction)".
- `README.md:113` → "…invariants I1–I17".
- `AGENTS.md:9` → "(DDL + invariants I1–I17)".
- `docs/HISTORY.md:45-46` → "All invariants except I14 are
  conformance-pinned; I14 (single writer) holds by construction." (the
  self-maintaining phrasing).

**Verify**: `grep -rn "I1–I14\|13 of 14" README.md AGENTS.md docs/` → no
matches.

### Step 2: SCHEMA.md version comment

Change `docs/SCHEMA.md:31` to describe the version this document defines:

```
-- rows: schema_version (integer as text — "4", the version this document
--       describes), store_id (ulid), created (timestamp)
```

**Verify**: `grep -n 'currently "2"' docs/SCHEMA.md` → no matches.

### Step 3: DESIGN.md map + diagram + error-doc pointer

- Architecture diagram (`docs/DESIGN.md:24-29`): add a line for entities
  between consent and recall, matching the diagram's style:
  `├── entities   aliases · resolveRef · identity questions · owner merges · peer card`
- Module map (`docs/DESIGN.md:100-118`): add two rows in path order:
  `contract.ts    StoreContract — the compiler-checked API surface` (after
  `store.ts`) and
  `entities.ts    identity: aliases, resolution, merge, peer card` (after
  `consent.ts`).

**Verify**: `grep -n "entities" docs/DESIGN.md` → ≥2 matches (diagram +
map).

### Step 4: The error contract in a shipped doc

In `docs/HOSTING.md`, after the type-registry section ("## The type
registry for a life", before "## 1 · The journal"), add a short section:

```markdown
## Errors — what a host catches

Domain forks are RETURN VALUES (`Outcome`, `ForgetReport`,
`Pending`) — you never try/catch your way through normal flow
(DESIGN.md "Errors and outcomes"). Exceptions mean broken invariants or
programmer error, always as `MemoryError` with a `code` you can switch on:

| code | means | typical host reaction |
|---|---|---|
| `not_found` | no such node/edge id | surface "gone"; drop stale refs |
| `invalid_transition` | FSM/verb refused for this status | re-read the node, re-render |
| `type_unknown` | type not registered | register the type first |
| `props_invalid` | bad argument or schema-violating props | fix the call; show the message |
| `store_closed` | use-after-close | reopen; a host lifecycle bug |
| `conflict` | state conflict (duplicate closed edge, I9 ruling, version guard…) | read the message; usually needs an owner decision |
```

Copy the code list from `src/types.ts:134-148` verbatim — do not invent
codes.

**Verify**: `grep -c "MemoryError" docs/HOSTING.md` → ≥1.

## Test plan

Docs-only; `bun run check` must still pass (biome checks md is NOT in its
includes — the gate simply proves no accidental code touch).

## Done criteria

- [ ] Step 1–4 greps all pass as specified
- [ ] `bun run check` exits 0
- [ ] Diff touches ONLY the six in-scope files (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The conformance-pinned invariant set (Commands table grep) differs from
  I1–I13+I15–I17 — the counts in Step 1 would be wrong; recompute and
  report the correct figure instead of writing a stale one.
- `src/types.ts`'s code union differs from the six codes listed here
  (drift — someone added a code; the HOSTING table must match the live
  union).

## Maintenance notes

- The "self-maintaining phrasing" in HISTORY.md (Step 1) exists so the NEXT
  invariant doesn't re-stale the count; use the same phrasing style if
  README's count ever gets rewritten again.
- Plan 013/012 spikes may add invariants (I18+) — whoever lands one updates
  README's "16 of 17" figure; the AGENTS.md rule already demands
  conformance-in-same-commit.
- If the error-code taxonomy is ever refactored (a recorded, unplanned
  finding: `conflict` carries ~10 meanings), HOSTING.md's table is now a
  second place to update — the price of shipping the contract.
