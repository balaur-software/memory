# The seventeen invariants — full reference

Source of truth: `docs/SCHEMA.md` § "Invariants" (schema_version 4). This file
restates each invariant, names what enforces it in this TypeScript
implementation, and names the conformance scenario(s) that pin it
(`test/conformance/*.scenario.json`, coverage map in `docs/CONFORMANCE.md`).

Counts, correct as of 2026-07-08: **I1–I17 exist; 16 of 17 are
scenario-pinned; I14 holds by construction.** The old README/AGENTS
"I1–I14" / "13 of 14" drift was REPAIRED in commit `5b0a7bb` (docs sync,
verified 2026-07-08 — `grep -n 'I1–I14\|13 of 14' README.md AGENTS.md`
comes back empty); `docs/SCHEMA.md` and `docs/CONFORMANCE.md` remain the
source of truth for the counts.

Load-bearing invariants (I1, I2, I4, I5, I6, I9, I15, I16, I17) are quoted
verbatim from SCHEMA.md. The rest are faithfully condensed — read SCHEMA.md
for the canonical wording before changing anything.

---

## I1 — Consent boundary

> **I1 — Consent boundary.** A node whose type has `born_status='proposed'`
> enters as `proposed` when `author`/agent-authored, and only an owner
> decision moves it to `active`/`rejected`. Owner-authored nodes are born
> `active`.

- Enforced by: `src/spine.ts` `insertNode`/`createNode` (owner path, born
  active) and `src/consent.ts` `propose` (agent path, born proposed);
  `registerType` refuses flipping `born_status` on a type that already has
  nodes (a flip would bypass the gate).
- Pinned by: `I1-owner-writes-born-active` (owner half),
  `golden-I1-consent-boundary` (both halves).

## I2 — Recall filter (the surfacing axis)

> **I2 — Recall filter.** Ambient recall (`recall`, `search`) returns only
> `status='active' AND surfacing='always'` nodes. `surfacing='ask'` nodes
> are returned only when the query names them — an explicit term hit on
> the title, or on the resolution surfaces (`resolveRef`) an
> exact-normalized match of the title or an alias (an alias IS a name) —
> never via broad matching. `surfacing='never'` nodes are reachable only
> by `getNode(id)`.

- Enforced by: `src/recall.ts` `loadEligible` + `titleNamed` (an `ask` node
  surfaces only when a query term IS a word of its title); `resolveRef` and
  `conflictsFor` apply the same rule to hints; `agenda`/`episode` SQL is
  `active AND surfacing='always'` (a window read names nothing); the vector
  stage loads with no terms, so `ask` rows drop from pure-vector hits.
- HEAD-only (`190b6e0`, unreleased): the FTS candidate query ALSO excludes
  `never` rows SQL-side (a `surfacing` column in `nodes_fts`) so
  ineligible rows cannot starve the candidate cap — a performance/
  completeness fix, not a semantics change; `loadEligible` stays the
  sole eligibility authority.
- Pinned by: `I2-recall-surfacing`, `I2-consent-surfaces`,
  `I2-recall-starvation` (HEAD); composed into many other scenarios.

## I3 — Traversal filter

Graph reads (`neighborhood`) return active nodes only, exclude
`surfacing='never'` neighbors (never means never), and exclude `day`
anchors (plumbing). `ask` neighbors ARE returned: traversal is an
owner-facing read of a named subject, not ambient matching.

- Enforced by: `src/spine.ts` `neighborhood` SQL (`status='active' AND
  surfacing != 'never' AND type != 'day'`); `children` applies the same
  never/day exclusions with caller-stated statuses.
- Pinned by: `I3-neighborhood-active-only`.

## I4 — Write-time gate (AUDN)

> **I4 — Write-time gate.** `propose` MUST route: normalized-title equality
> vs a pending proposal → merge into it (`merged_pending`); vs an active
> node of the same type → no write at all (`exists_active`); else create
> (`created`). Normalization: lowercase, collapse whitespace.

- Enforced by: `src/consent.ts` `propose` (the routing runs BEFORE anything
  is written); normalization is `normalizeText` in `src/types.ts` — one
  rule everywhere identity is compared.
- Note: a REJECTED title does not block a fresh proposal — dedup, not
  censorship (documented in consent.ts header; pinned by
  `src/consent.test.ts` "a rejected title does not block a fresh proposal").
- Note: an `exists_active` match against a `surfacing='never'` node is NOT
  revealed (I2 on the propose surface) — the duplicate is created instead
  and the owner-side queue + `doctor().duplicateCandidates` resolve it.
- HEAD-only (`5cfc581`, unreleased): the merge-into-pending branch runs the
  same importance range check and `applyTemplateAndValidate` schema check
  as the create branch — at v0.4.3 a duplicate-title proposal could mint a
  schema-violating node through the merge path. Same commit whitelists
  `Decision.kind`, `decideIdentity` verdicts, and `setSurfacing` values.
- Pinned by: `golden-I4-audn-gate`, `consent-merge-validation` (HEAD).

## I5 — Adjudication is compound and ordered

> **I5 — Adjudication is compound and ordered.** `approve_superseding`
> performs: activate new → archive old → write `supersedes` edge → audit.
> A mid-sequence failure stops and surfaces; no silent rollback of audited
> steps.

- Enforced by: `src/consent.ts` `decide` (the `approve_superseding` branch
  runs the sequence in exactly that order; it also refuses a non-active or
  cross-type supersede target).
- Pinned by: `golden-I5-supersede` (including the I2 composition: the
  superseded node leaves ambient recall), `consent-schema-enforcement`
  (verdict fields are coerced + validated against the type's props schema —
  the consent boundary cannot mint a schema-violating node).

## I6 — Tombstone semantics

> **I6 — Tombstone semantics.** `forget` sets `status='forgotten'`,
> `title=''`, `body=''`, `props='{}'`, `origin=''`, `author=''`, and (v4)
> `when_at=NULL` — a scheduled moment is content, and a tombstone keeps no
> appointment; clears `pending_edits`, (v2) the node's `aliases` and its
> open `identity_pending` questions, and (v3) its `memory_history` rows;
> deletes the node's edges; scrubs it from `nodes_fts` and `vectors`;
> marks `derivations` rows with it as `source` stale; lists merged husks
> chained into it as `husk:<id>` in the report's `needsOwner` (computed
> before the edges drop). The row, `type`, and timestamps survive.

- Enforced by: `src/lifecycle.ts` `forget` — one transaction over
  memory.db, index scrub best-effort after (an index failure is audited,
  never thrown: index.db is disposable, I13).
- HEAD-only (`91996a7`, unreleased): the guarantee is now byte-level, not
  just row-level — `PRAGMA secure_delete=ON` on both DBs, FTS5
  secure-delete, and `wal_checkpoint(TRUNCATE)` after every cascade;
  SCHEMA.md's I6 discloses what stays out of contract (FS/SSD remanence,
  OS snapshots, prior exports). Pinned by a raw-byte canary test in
  `src/hardening.test.ts` (negative-verified). At v0.4.3, forgotten bytes
  can survive in the WAL, free pages, and FTS segments.
- Pinned by: `I6-forget-cascade` (incl. identity_pending + when_at
  clearing, the content-free-log probe for I7, and I8 terminality).

## I7 — Content-free forget audit

Audit entries for forget-class actions carry ids and counts only. No audit
row anywhere carries node title/body text.

- Enforced by: discipline at every `audit()` call site (`src/spine.ts`
  `audit` takes only ids/flags/counts in `meta`); alias verbs never log the
  alias text (an alias is usually a person's name).
- Pinned by: `I6-forget-cascade`, `I12-audit-coverage` (SQL probes over
  `audit_log`).

## I8 — Terminality

`rejected` and `forgotten` have no outgoing transitions. `merged` is
terminal for the FSM and for identity verdicts, with one deliberate
exception: a husk still holds content, so `forget` may destroy it
(ENTITIES.md amendment).

- Enforced by: the `TRANSITIONS` map in `src/spine.ts` (rejected/forgotten/
  merged map to `[]`; forgotten and merged are reachable only through their
  dedicated verbs `forget()` / `decideIdentity()`, never a bare
  `transition`); `FORGETTABLE` in `src/lifecycle.ts` =
  {active, archived, quarantined, merged}.
- Pinned by: `I8-fsm-terminality-and-guards`, `I6-forget-cascade`.

## I9 — No re-litigation (the Apple Photos lesson)

> **I9 — No re-litigation.** After a `no_match` edge exists between two
> nodes (either direction): (a) no candidate rule ever re-inserts the pair
> into `identity_pending`, and (b) `decideIdentity(..., "same")` on the
> pair is refused. Answered means answered — the Apple Photos lesson.

- Enforced by: `src/entities.ts` `pairClosed` (candidate generation skips
  no_match / merged_into / already-pending pairs) and the `closureEdge`
  refusal in `decideIdentity`; the merge itself DELETES every `no_match`
  edge incident to the duplicate rather than transplanting it (a
  non-relation of the dup is not a non-relation of the survivor);
  `closeEdge` refuses system edge types so a `no_match` cannot be
  "expired" through the side door (I15).
- Pinned by: `I9-apple-photos` (both halves, both directions),
  `merge-adversarial-edges` (no_match never transplants; self-loops die;
  chains flatten).

## I10 — Provenance at birth

Every insert into `nodes` sets `origin` (host-supplied; `''` only for
owner-manual creations). `author` is set whenever content carries a third
party's words.

- Enforced by: `origin` being a REQUIRED field of `CreateInput` and
  `Proposal` — the type system makes the omission unrepresentable; all
  births flow through the `insertNode` choke point.
- Pinned by: `I1-owner-writes-born-active`, `golden-I1-consent-boundary`.

## I11 — Timestamps and IDs

All times UTC ISO-8601 with ms; all ids lowercase ULID, monotonic within a
millisecond per process — under I14's single writer, lexical id order IS
creation order. `updated >= created` always.

- Enforced by: `src/storage/ulid.ts` (48-bit ms timestamp + 80-bit
  randomness, Crockford base32 lowercase; same-ms calls increment the
  previous randomness big-endian +1); `parseStrictIso` in `src/types.ts`
  for every declared time; `ctx.now().toISOString()` at every write.
- Pinned by: `I11-ids-and-timestamps`.

## I12 — Audit coverage

Every mutation of `nodes`, `edges`, `pending_edits`, and every decision
writes exactly one audit row (compound decisions: one per step plus one
summary). (v3) `memory_history` snapshots ride inside mutations that
already audit — they add no audit rows of their own; the history row is the
record.

- Enforced by: the choke-point architecture (`src/spine.ts` header): every
  mutation flows through spine functions that call `audit()` — coverage by
  construction, not discipline. Idempotent no-ops (duplicate `link`,
  duplicate `addAlias`) write NO audit row.
- Pinned by: `I12-audit-coverage`, `update-node`.

## I13 — Disposable index

Deleting `index.db` loses no information; `rebuildIndex()` reconstructs it
from `memory.db` exactly (FTS rows for active nodes only; vectors are
re-suppliable by the host).

- Enforced by: `Store.open` self-heal (a CORRUPT index.db is treated like a
  missing one — dropped, recreated, rebuilt; memory.db never gets that
  treatment: a failure there is fatal); `fanOut`/`reindexNode` catch index
  failures and audit them instead of failing the record write.
- Pinned by: `I13-index-disposability` (delete → reopen → rebuild →
  identical recall, byte-exact `extra` column).

## I14 — Single writer (by construction — the unpinned one)

One `Store` instance owns writes to a given `memory.db`. WAL mode permits
concurrent external readers (e.g. a read-only tool mounting the file).

- Enforced by: host discipline. A conformance test cannot prove host
  discipline; the invariant documents it (`docs/CONFORMANCE.md`). This is
  the ONE invariant with no scenario.

## I15 — Validity is declared, never inferred

> **I15 — Validity is declared, never inferred.** (v3) `valid_from` /
> `valid_until` are set only from explicit arguments to `link`/`closeEdge`
> (strict ISO-8601 UTC; date-only = midnight UTC; `until > from`). The
> library never derives a validity date from content, context, or clock
> heuristics. System edge types (`on_day`, `supersedes`, `merged_into`,
> `no_match`, `derived_from`) carry NULL validity always, and `closeEdge`
> refuses them — closing a `no_match` edge would reopen I9 through the
> side door. Edge-carrying reads (`neighborhood`, `entityContext`) default
> to the currently-valid world; `asOf` time-travels.

- Enforced by: `src/spine.ts` `insertEdge` (strict ISO parse; system types
  refuse any validity; `until <= from` refused; re-linking a CLOSED
  (source, target, type) triple throws `conflict` — "a closed fact stays
  closed", reopen semantics deliberately deferred) and `closeEdge` (refuses
  system types, already-closed edges, `until <= valid_from`).
- Validity predicate used by every temporal read, at time `t`:
  `(valid_from IS NULL OR valid_from <= t) AND (valid_until IS NULL OR valid_until > t)`.
- Pinned by: `temporal-siemens-years`.

## I16 — History dies with the tombstone

> **I16 — History dies with the tombstone.** (v3) `memory_history` rows
> are content: `forget(id)` removes every row for the node in the cascade
> transaction. Audit rows, being content-free, survive. History is
> append-only otherwise — no other verb may delete it. Snapshots are
> taken at exactly three owner-authority moments: `updateNode`,
> `approve_edited`, and parked-edit application (TEMPORAL.md).

- The three capture moments (TEMPORAL.md "Capture moments", exhaustive v1),
  each snapshotting the PRE-change content:

  | Moment | action recorded | origin |
  |---|---|---|
  | `updateNode` | `node.update` | `''` |
  | `decide` → `approve_edited` (proposal or parked edit) | `consent.approve_edited` | `''` |
  | `decide` → `approve` applying a parked-edit envelope | `consent.edit_applied` | the envelope's origin |

- Deliberately NOT capture moments: node birth (a creation is not a
  change), status transitions and surfacing changes (metadata, already
  audited), `touch` (usage), the merge (both nodes' content is preserved in
  place — the husk IS the history), and `forget` (a snapshot at destruction
  time would defeat destruction).
- Enforced by: `snapshotHistory` in `src/spine.ts` (rides inside mutations
  that already audit; snapshots taken AFTER validation, so a refused edit
  snapshots nothing) + the `DELETE FROM memory_history` line of the forget
  cascade.
- Pinned by: `I16-history-forget`.

## I17 — Scheduled time is declared, never inferred

> **I17 — Scheduled time is declared, never inferred.** (v4) `when_at` is
> set only from explicit arguments (`createNode`/`propose`/`updateNode`/
> verdict fields — the empty-string verdict field clears; `null` clears
> via updateNode), strict ISO-8601 UTC via the shared rule. The library
> never derives, shifts, or clears it on its own. `agenda(from, to)`
> returns only `status='active' AND surfacing='always'` nodes in the
> half-open window (I2: an agenda pull names nothing); the doctor's
> `dueCandidates` lens excludes `never`-surfaced nodes (the F8 rule).
> History snapshots carry the pre-change `when_at` (I16 unchanged).

- Enforced by: `parseStrictIso` on every `when` argument; `agenda` SQL in
  `src/recall.ts`; `dueCandidates` SQL in `src/doctor.ts`; the forget
  cascade clears `when_at` (a tombstone keeps no appointment, I6).
- Pinned by: `planning-tuesday` (plus `project-dashboard` for the
  surrounding planning reads).

---

## Conformance coverage map (from docs/CONFORMANCE.md — 26 scenarios at HEAD)

| Scenario | Invariants pinned |
|---|---|
| `I1-owner-writes-born-active` | I1 (owner half), I10 |
| `golden-I1-consent-boundary` | I1 (both halves), I10, hint kinds |
| `I2-recall-surfacing` | I2 (always/ask/never across recall) |
| `I2-consent-surfaces` | I2 on the gate + hints (no exists_active oracle for `never`) |
| `I3-neighborhood-active-only` | I3 + I2 on traversal (never/day excluded, ask included) |
| `golden-I4-audn-gate` | I4 (created / merged_pending / exists_active) |
| `golden-I5-supersede` | I5 + the I2 composition (superseded leaves ambient recall) |
| `I6-forget-cascade` | I6 incl. identity_pending + when_at clearing, I7, I8 |
| `I8-fsm-terminality-and-guards` | I8 (guarded targets) |
| `I9-apple-photos` | I9, both halves: never re-proposed; merge refused either order |
| `I11-ids-and-timestamps` | I11 |
| `I12-audit-coverage` | I12, I7 |
| `I13-index-disposability` | I13 (delete → reopen → rebuild → identical recall) |
| `entities-questions` | R1–R3 evidence priority, exclusions, idempotent re-runs (I2) |
| `golden-two-anas-merge` | the compound merge: rewire/fold/chain/husk, I7, I2 recall |
| `entity-context-peer-card` | the bounded peer card: I2/I3 filtering, recency order, edges |
| `merge-adversarial-edges` | I9 under merge: no_match never transplants; self-loops die; chains flatten |
| `consent-schema-enforcement` | the decide path coerces + validates props against the type schema (I5) |
| `update-node` | retitle reconciles a now-equal alias; props replace wholesale; audited (I12) |
| `temporal-siemens-years` | I15: declared validity, closeEdge + system-type + closed-triple refusals, asOf |
| `I16-history-forget` | I16: three capture moments replayed; history dies; audit survives |
| `planning-tuesday` | I17: declared appointments, gated task flow, agenda windows + I2, reschedule replay |
| `project-dashboard` | children with stated statuses (I2), propsPatch no-clobber, owner fast path, episode |
| `I2-recall-starvation` *(HEAD, `190b6e0`)* | I2: ineligible (never) rows must not starve the recall candidate cap |
| `consent-merge-validation` *(HEAD, `5cfc581`)* | I4: the merge-into-pending branch enforces the props schema |
| `doctor-revision` *(HEAD, `005da77`)* | I7, I12: the doctor's reproposal metric stays content-free (salted footprints, never text) |

The three HEAD-tagged scenarios exist only past v0.4.3 (unreleased). The
`doctor()` report MATH is still covered by unit tests
(`src/doctor.test.ts`) — the `doctor-revision` scenario pins the
content-free property (I7/I12) of the new reproposal metric, not a
doctor-specific invariant.
