---
name: memory-domain-reference
description: Use when reasoning about balaur-memory internals or data — memory.db/index.db schema, invariants I1–I17, SCHEMA.md, StoreContract, propose/decide and the consent queue, surfacing always/ask/never, forget/quarantine tombstones, merge/aliases/decideIdentity, edge validity/closeEdge/asOf, when_at/agenda scheduling, recall ranking or vectors, MemoryError codes, or confusion like updateNode props clobbering, "when vs when_at", stale "I1-I14" claims, or a conformance scenario name.
---

# balaur-memory — domain reference

The domain-theory pack for `memory/` (balaur-memory): a consent-gated,
lineage-tracked, forgettable memory layer. Bun ≥1.2 **library**, zero
runtime deps, SQLite storage. As of 2026-07-08: last release = tag
`v0.4.3` (what consumers get — web pins it); HEAD = `f1b168a`,
**UNRELEASED**, 14 commits past v0.4.3 (the 2026-07 deep-audit chain).
Two of those commits are breaking: `3ddb84b` **removed the `balaur` CLI**
(the library is the only supported surface at HEAD; the CLI still ships
in ≤v0.4.3 pins) and `005da77` revised `DoctorReport`. Where released
and HEAD behavior differ below, it is marked.

**The contract is `docs/SCHEMA.md`** (DDL + invariants I1–I17,
schema_version 4) projected into TypeScript by `src/contract.ts`
(`StoreContract`; `class Store implements StoreContract` is
compiler-checked). If `src/storage/schema.ts` and SCHEMA.md disagree,
SCHEMA.md wins and the code gets fixed.

## When NOT to use this skill

| You are about to… | Use instead |
|---|---|
| Change code, release, or touch a non-negotiable rule | **memory-change-control** |
| Run the `balaur` CLI, manage data dirs, backup/restore in anger, host patterns | **memory-cli-and-hosting** |
| Write/modify tests or conformance scenarios, add evidence for a change | **memory-validation-and-qa** |
| Understand why something was rejected/deferred historically | **memory-failure-archaeology** |
| Cross-repo consumption (web's tag pin, bun link) | **balaur-workspace-map** |

This is a REFERENCE skill: it tells you what is true and where it is
enforced. It does not authorize changes.

## The two-file model

| File | Role | Fate |
|---|---|---|
| `memory.db` | THE RECORD. Source of truth, backed up, precious. WAL mode, STRICT tables, foreign keys ON. | A failure here is fatal by design. |
| `index.db` | Disposable sidecar: FTS5 (`nodes_fts`) + vectors, derived entirely from memory.db. | Deleting it is ALWAYS safe (I13); `rebuildIndex()` reconstructs it; `Store.open` self-heals a corrupt one. Never backed up. |

Conventions (everywhere, no exceptions):
- **Timestamps**: ISO-8601 UTC with milliseconds (`2026-07-05T20:14:03.123Z`), stored as TEXT. The library is UTC-only (I11).
- **IDs**: lowercase Crockford-base32 ULIDs, 26 chars, time-prefixed — lexical order IS creation order. Same-millisecond calls increment the previous randomness, so monotonicity holds even at sub-ms write rates (`src/storage/ulid.ts`).
- **JSON columns**: canonical JSON OBJECTS, never arrays at top level, `{}` when empty. A malformed props cell degrades to `{}` on read instead of bricking the row (`parseProps`); at HEAD (`7c51c3f`, unreleased) `node_types.template`/`props_schema` and `pending_edits.fields` get the same treatment via `parseJsonObject` — at v0.4.3 a corrupt registry cell still throws a raw SyntaxError.
- **Strict time parsing**: `parseStrictIso` (`src/types.ts`) accepts exactly `YYYY-MM-DD` (→ midnight UTC) or `YYYY-MM-DDTHH:MM:SS[.mmm]Z`. Lenient `Date.parse` timezone-shifting is refused — one rule everywhere time is declared.

## Tables (memory.db, schema_version 4)

| Table | Since | Purpose |
|---|---|---|
| `meta` | v1 | `schema_version`, `store_id` (ulid), `created`. Files from the FUTURE refuse to open — upgrade the library, never downgrade the file. |
| `node_types` | v1 | The type registry: `born_status` (`active`/`proposed` — the consent split, I1), `props_schema`, `template`. `"day"` is library-reserved. |
| `nodes` | v1 | The spine. Everything durable is a node: id, type, title, body, status, surfacing, importance 0–5, props, origin, author, use_count, last_used, review_at, `when_at` (v4), created, updated. |
| `edges` | v1 | Typed links, `UNIQUE (source, target, type)`; v3 adds `valid_from`/`valid_until` world time next to `created` transaction time. |
| `pending_edits` | v1 | Parked agent edits to active nodes (one per node — latest wins); a queryable table, not a props envelope. |
| `derivations` | v1 | Lineage: artifact ← source (node ids or host refs), `stale` flag — the forget cascade's downstream signal. |
| `audit_log` | v1 | Content-FREE ledger (I7/I12): actor owner/agent/system, action, ref (ids only), ok, meta (ids/counts/flags — never quoted text). |
| `aliases` | v2 | Names a node also answers to (normalized). One alias may point at MANY nodes — lookups return candidates, never a winner. Aliases are content: they join FTS `extra` and die in the forget cascade. |
| `identity_pending` | v2 | Open identity questions, unordered pair `a < b`, evidence enum. |
| `memory_history` | v3 | PRE-mutation content snapshots, append-only, actor-attributed. Content-bearing BY DESIGN — the complement to the content-free audit log, with the opposite fate under forget (I16). v4 adds `when_at`. |

index.db: `nodes_fts` (fts5: id, kind, surfacing unindexed; title,
content, extra — `extra` = the `when_to_use` prop + alias text) and
`vectors` (PK (id, model): model-keyed spaces, little-endian float32
blobs). The `surfacing` column is HEAD-only (`190b6e0`, unreleased): it
lets recall exclude `never` rows SQL-side; `migrateIndexDb` self-heals a
pre-surfacing 5-column index.db by drop + rebuild. v0.4.3 index files
have 5 columns.

System edge types (library-written, timeless — I15): `on_day` (episodic
anchor at creation, keyed by UTC calendar day), `supersedes` (Decide),
`merged_into` (identity), `no_match` (owner ruled distinct — permanent,
I9), `derived_from` (lineage). Default host edge type: `links`.

## The seventeen invariants — digest

Full statements, enforcement loci, and pinning scenarios:
**[references/invariants.md](references/invariants.md)**. Correct counts:
**I1–I17; 16 of 17 conformance-pinned; I14 by construction.**

> Doc drift REPAIRED (verified 2026-07-08): README/AGENTS no longer say
> "I1–I14" / "13 of 14", and SCHEMA.md's stale `currently "2"` DDL comment
> is gone (fixed in commit `5b0a7bb`). Ledger of record:
> `balaur-docs-and-writing` §3. Re-check:
> `grep -n 'I1–I14\|13 of 14' README.md AGENTS.md` (empty = repaired).
> `docs/SCHEMA.md` + `docs/CONFORMANCE.md` remain the source of truth.

| # | One line |
|---|---|
| I1 | Consent boundary: gated types born `proposed` when agent-authored; only an owner decision activates/rejects; owner writes born `active`. |
| I2 | Recall filter: ambient recall = active + `always`; `ask` only when the query literally names the title (or resolveRef exact-match); `never` = getNode(id) only. |
| I3 | Traversal: `neighborhood` returns active only, excludes `never` and `day`; `ask` IS returned (a named subject, not ambient matching). |
| I4 | Write-time AUDN gate: pending title-match → merge in; active title-match → no write; else create. Normalization = lowercase + collapse whitespace. |
| I5 | `approve_superseding` is compound and ORDERED: activate new → archive old → supersedes edge → audit; mid-failure stops and surfaces. |
| I6 | Forget tombstones content in place (title/body/props/origin/author/when_at gone), cascades every content table, keeps row/type/timestamps. |
| I7 | Forget-class audit rows are content-free — ids and counts only, never title/body text. |
| I8 | `rejected`/`forgotten` terminal; `merged` terminal except forget may destroy a husk (it still holds content). |
| I9 | No re-litigation: a `no_match` pair is never re-proposed and a "same" verdict on it is refused. Answered means answered. |
| I10 | Provenance at birth: every node insert sets `origin`; `author` when the words are a third party's. |
| I11 | UTC ISO-ms timestamps; lowercase monotonic ULIDs; `updated >= created`. |
| I12 | Every mutation writes exactly one audit row (compound: one per step + summary); history snapshots ride inside, adding none. |
| I13 | index.db is disposable: delete → rebuild → identical. Index failures never fail a record write. |
| I14 | Single writer per memory.db (one Store instance); WAL allows external readers. By construction — the one unpinned invariant. |
| I15 | Edge validity declared, never inferred; system edges timeless; closeEdge refuses them; reads default to now, `asOf` time-travels. |
| I16 | History dies with the tombstone; audit survives. Exactly three capture moments, all owner-authority. |
| I17 | `when_at` declared, never inferred/shifted/cleared by the library; agenda = active+always in half-open window; doctor's due lens excludes `never`. |

## The consent model

- **born_status is the split** (I1): `registerType({name, bornStatus})`.
  `bornStatus:"active"` = owner-authored type (createNode only);
  `bornStatus:"proposed"` = consent-gated (agents go through `propose`).
  Flipping bornStatus on a type with live nodes is refused.
- **The AUDN write gate** (I4), routed BEFORE anything is written, on
  normalized-title equality (`normalizeText` = lowercase + collapse
  whitespace) within the type:
  1. equals a PENDING proposal → `merged_pending` (fold in; latest proposal
     wins — body, importance, props merge, `when` if supplied);
  2. equals an ACTIVE node → `exists_active`, NO write at all (but a
     `never`-surfaced cover is not revealed — the duplicate is created and
     the owner-side queue resolves it);
  3. else → `created`, born `proposed`.
- **Rejected titles do NOT block fresh proposals** — the owner's no is
  final for that card, not a permanent word-ban; the gate's job is
  deduplication, not censorship (pinned by `src/consent.test.ts`).
- **The queue** (`pendingQueue()`) is a tagged union `Pending`:
  `proposal` | `edit` | `identity` — in that kind order, each kind
  oldest-first. Each proposal/edit carries advisory `conflicts` hints
  (title_match, then lexical_overlap; capped at 2; I2-filtered).
- **Four verdicts** (`decide`): `approve`, `approve_edited` (owner-corrected
  string fields, schema-coerced + validated), `approve_superseding`
  (proposals only — the I5 ordered compound), `reject` (proposal →
  terminal `rejected`; parked edit → envelope clears, node untouched).
- **The owner fast path**: `updateNode` works on consent-gated types — the
  host is the authenticator, and the queue protects the owner from the
  AGENT, not from themselves. Agent changes still route through
  `proposeEdit` → `decide`.

## Surfacing: storage consent vs usage consent

`surfacing` (`always`/`ask`/`never`) is the third axis besides status and
importance: the owner consented to STORING it; surfacing governs USING it
unprompted. Where each lens applies it:

| Lens | `always` | `ask` | `never` |
|---|---|---|---|
| `recall`/`search`/vector stage | yes | only when a query term IS a word of the title (pure-vector hits can't name, so vector universe = always only) | invisible |
| `agenda`/`episode` | yes | no (a window read names nothing) | invisible |
| `neighborhood`/`children` | yes | yes (owner-facing read of a named subject) | excluded |
| `resolveRef` | yes | yes (the text IS its name) | invisible |
| `entityContext` | subject: allowed (an id is the strongest naming); peers: yes | subject: allowed; peers: NO (the card names its subject, not its peers) | subject: refused; peers: excluded |
| `doctor` duplicate + due lenses, identity queue | yes | yes | excluded — even revealing a duplicate EXISTS is surfacing (**the F8 rule**, review-2 F8) |
| `getNode(id)` | yes | yes | yes — the only door |

## Status FSM and forgetting

Legal transitions (`TRANSITIONS` in `src/spine.ts`; `forgotten` and
`merged` are reachable ONLY via `forget()` / `decideIdentity()`, never a
bare `transition`):

```
proposed    → active | rejected        (via decide)
active      → archived | quarantined   (forget() also legal)
archived    → active                   (forget() also legal)
quarantined → active                   (forget() also legal)
rejected    → ∅   forgotten → ∅   merged → ∅ (except forget() — husk holds content)
```

Leaving `active` clears any parked edit; leaving `quarantined` clears
`review_at`. **Quarantine** = suppression with a conscience: hidden from
every surface, reversible, optional re-review date the doctor resurfaces.
**Forget** = honest erasure: content destroyed, never secretly "suppressed".

`forget(id)` — the honest cascade (I6), forgettable set = {active,
archived, quarantined, merged}:
- DESTROYED: title, body, props, origin, author, when_at; the node's edges;
  its parked edit, aliases, open identity questions, memory_history rows;
  its FTS row and vectors; its own derivation lineage (as artifact).
- SURVIVES: the row, `type`, timestamps (referential integrity); audit rows
  (content-free); derivations where it was a SOURCE get flagged `stale`.
- **Byte-level honesty (HEAD-only, `91996a7`, unreleased)**: at v0.4.3 the
  promise held at the ROW level but forgotten content could survive in
  `memory.db-wal`, free pages, and FTS segments. HEAD adds
  `PRAGMA secure_delete=ON` on both DBs, FTS5's secure-delete option, and
  a `wal_checkpoint(TRUNCATE)` after every forget cascade; SCHEMA.md's I6
  now discloses exactly what stays out of contract (filesystem/SSD
  remanence, OS snapshots, prior exports). Pinned by a raw-byte canary
  test in `src/hardening.test.ts`.
- `needsOwner` — what the cascade cannot honestly resolve alone, three
  categories: `mention:<id>` (best-effort lexical candidates on the
  forgotten title's words — possible prose mentions in other nodes),
  `husk:<id>` (merged husks chained into it — they still hold content and
  just lost their survivor; computed before the edges drop), and
  `external:prior-exports` (always listed: old backups/exports may retain
  the content).

## Identity (docs/ENTITIES.md)

- Candidate rules, evidence priority R1 title_match > R2 token_subset
  (strict subset, tokens ≥ 2 chars) > R3 alias_match; exclusions:
  self-pairs, non-active, `never`-surfaced, closed pairs (pending /
  no_match / merged_into). `suggestIdentities` is owner/host-SCHEDULED,
  never ambient. Full table: references/api.md.
- **Merge choreography** (`decideIdentity(keep, other, "same")` — survivor
  = `keep` by ARGUMENT ORDER, never a heuristic), ordered and step-audited:
  1. Drop outright: the pair's own edges, the dup's self-loops, and EVERY
     `no_match` edge incident to the dup — no_match edges DROP, never
     transplant (a non-relation of the dup is not a non-relation of the
     survivor; transplanting would poison an unruled pair, I9).
  2. Rewire the dup's remaining edges to keep; keep's existing edges win on
     unique collision; colliding leftovers drop.
  3. Fold names: dup's title + aliases become keep's aliases
     (`source='merge'`), except any name equal to keep's own title.
  4. Retire the dup as a `merged` husk — CONTENT-PRESERVING (title/body/
     props stay; the husk IS the history) — chained `merged_into` keep, out
     of every queue and surface.
  5. Reindex both; the husk leaves FTS + vectors.
- `"different"` writes a PERMANENT `no_match` edge (I9) — never re-proposed,
  never mergeable, and `closeEdge` refuses it (I15 guards the side door).
- **No unmerge in v1** — deliberate: the husk preserves every byte, manual
  recovery is possible, mechanical unmerge is absent.
- `survivorOf(id)` walks `merged_into` chains (cycle-capped); hosts never
  reimplement chain-walking.

## Temporal (docs/TEMPORAL.md)

- **Bi-temporal edges, honest about which clock is which**: `created` =
  transaction time (when the library learned it); `valid_from`/`valid_until`
  = world time (when it was true). Declared, never inferred (I15) — no
  LLM/heuristic dating pathway exists by design.
- `closeEdge` is LOUD, not idempotent: closing an already-closed edge
  throws (`conflict`) — closing twice is a host bug worth hearing about.
  Nothing true is destroyed by becoming false: the row stays.
- **Closed-triple re-link refusal**: `link()` on an existing CLOSED
  (source, target, type) throws — "a closed fact stays closed"; reopen /
  multi-window validity is a deliberately deferred open question.
- Reads (`neighborhood`, `entityContext`, `children`) default to the
  currently-valid world; `asOf` time-travels. Validity predicate at t:
  `(valid_from IS NULL OR valid_from <= t) AND (valid_until IS NULL OR valid_until > t)`.
- **memory_history (I16)**: pre-mutation snapshots at exactly THREE
  owner-authority moments — `updateNode`, `decide→approve_edited`, and
  parked-edit application (`consent.edit_applied`). Deliberately NOT
  captured: birth, status/surfacing changes, touch, merge (the husk is the
  history), forget (a snapshot at destruction would defeat destruction).
  History is append-only, id-gated, read-only — and dies with the
  tombstone while audit survives; that split IS the design.

## Planning (docs/PLANNING.md)

- **The naming trap**: the TypeScript field is `when` (on `Node`,
  `createNode`, `updateNode`, `Proposal`, verdict fields); the SQL column
  is `when_at` (`when` is an SQL keyword). Conformance/SQL assertions say
  `when_at`; API calls say `when`.
- `agenda(from, to)` = the half-open window `[from, to)` over `when_at`,
  active + `always` only (I2: an agenda pull names nothing), when_at ASC.
  `episode(from, to)` is its past-facing twin over `created`.
- **No scheduler, ever**: the library has no timers, no background jobs —
  it is a pure function of its data and the clock argument. THE HOST TICKS:
  it calls `agenda`/`doctor` at its own moments and decides what "overdue"
  means. Recurrence is host vocabulary (`props.rrule`); materializing the
  next instance is a host act.
- Past `when_at` is fine and meaningful — a past event is a memory.

## Recall ranking (deterministic core + optional vector fusion)

From `docs/DESIGN.md` "Ranking blend", constants verified in
`src/recall.ts` (conformance pins the defaults):

```
score(node) = bm25 × recency × importanceBoost × reinforcement
  recency         = max(exp(-λeff · days), 0.05)        days since last_used ?? updated
  λeff            = λ · (1 − 0.8 · importance/5)         importance slows decay
  importanceBoost = 1 + importance/5
  reinforcement   = 1 + r · ln(1 + use_count)

DEFAULT_RANKING = { lambda: 0.02, reinforcement: 0.2, rrfK: 60 }
RECENCY_FLOOR = 0.05   DEFAULT_LIMIT = 8   candidate cap = limit×4 + 16
```

The recency floor keeps a perfect lexical match alive at any age — decay
demotes, never erases. With a `queryVector` + `model`: cosine over that
model's stored vectors, then reciprocal-rank fusion `Σ 1/(60 + rank_i)`
across the lexical and vector rankings.

**Candidate-cap starvation fix (HEAD-only, `190b6e0`, unreleased)**: at
v0.4.3 the candidate query took its cap slice BEFORE eligibility
filtering, so a store dense with `never`/`ask` rows could starve out
eligible matches (probe-confirmed: 60 `never` rows + 1 `always` match →
zero results). At HEAD the SQL-side query excludes `never` rows before
the cap (the new FTS `surfacing` column), and the vector stage also
filters eligibility/type before its cap slice. `loadEligible` remains
the sole eligibility AUTHORITY — the FTS column is a query-time
optimization only. `conflictsFor` and the forget mention-scan keep the
old candidate universe (`lexicalCandidates`' `excludeNever` defaults
false). Pinned by `I2-recall-starvation.scenario.json`.

**Vectors doctrine**: vectors in, never models. The host embeds and calls
`putVector(id, model, Float32Array)`; `model` is the vector-space identity
— spaces never mix; cosine returns null (skip) on dimension mismatch. The
lexical path without vectors is deterministic and **not a degraded mode**.
FTS match input is quote-escaped — user text cannot inject FTS5 operators.

## API surface and errors

Full method-by-method reference (all 39 StoreContract methods, grouped,
with the Outcome/Pending/Decision/ForgetReport shapes and the six
MemoryError codes): **[references/api.md](references/api.md)**.

Rule of thumb: DOMAIN forks are return values (`Outcome`, `ForgetReport`,
candidate lists); `MemoryError` (`not_found` | `invalid_transition` |
`type_unknown` | `props_invalid` | `store_closed` | `conflict`) is for
broken invariants and programmer error.

## FOOTGUNS

- **`props` vs `propsPatch` in `updateNode`**: `props` REPLACES the whole
  object wholesale (loud on purpose); `propsPatch` merges shallowly and a
  `null` value REMOVES its key (RFC 7386 style). Passing both throws.
  Setting one prop via `props` silently deletes all the others.
- **Template fill is birth-only at HEAD** (`7c51c3f`, unreleased): a
  `propsPatch` null-removal of a templated key STAYS removed — owner
  edits pass `fillTemplate:false`. At v0.4.3 the template re-merge
  silently resurrects the removed key. Births (createNode, propose)
  still fill.
- **`when` vs `when_at`**: API field `when`, SQL column `when_at`. In
  `updateNode`, `when: undefined` = unchanged, `null` = clear, string =
  validated set. In verdict fields, `when: ""` (empty string) clears.
- **UTC day anchors**: `on_day`/`dayAnchor` key by the UTC calendar day
  (I11). A late-night capture east of UTC files under "yesterday" local —
  and the owner IS east of UTC. Owner-local day semantics are
  the HOST's job (convert before calling).
- **`parseStrictIso` vs CLI `--now`** (≤v0.4.3 consumers only — the CLI
  is gone at HEAD): the library refuses anything but `YYYY-MM-DD` /
  `YYYY-MM-DDTHH:MM:SS[.mmm]Z`. The v0.4.3 CLI's `--now` flag uses
  lenient `new Date(...)` (`git show v0.4.3:cli/index.ts`) — it accepts
  timezone-shifting strings the library itself would refuse. Freeze
  clocks with full Z-suffixed ISO to stay honest.
- **Backup**: `backup(toPath)` = `VACUUM INTO`; target must NOT exist —
  backups never overwrite. NEVER raw-copy `memory.db` while a store is
  open: WAL keeps recent writes in `memory.db-wal` and the copy silently
  loses them. Raw copy is safe only after `close()`. Verify backups by
  opening them. HEAD adds guards (`7c51c3f`, unreleased): a target
  resolving inside the live store dir is refused, and a mid-write
  VACUUM failure is cleaned up instead of wedging retries; HEAD also
  chmods backups 0600 (`1219dcd`). (Runbooks: memory-cli-and-hosting.)
- **Single-writer discipline (I14)**: one Store instance per memory.db.
  WAL permits external READ-ONLY mounts; a second writer is undefined
  behavior the library cannot detect.
- **The v0.4.3 CLI mkdirs any `--dir`** it is given — a typo'd path
  silently creates a fresh empty store instead of erroring (verified
  against `git show v0.4.3:cli/index.ts`: `mkdirSync(dir, {recursive:
  true})`). Applies to consumers pinning ≤v0.4.3; no CLI exists at HEAD.
  HEAD's `Store.open` creates a missing dir 0700 and chmods store files
  0600 (`1219dcd`, unreleased).
- **`touch` does not bump `updated`** — usage is not a content change; the
  freshness signal stays honest. Don't "refresh" a node by touching it.
- **`"day"` is a reserved type**; `registerType("day", ...)` throws.
  Untyped recall/episode/entityContext exclude `day` plumbing; an explicit
  `type:"day"` filter reaches it.
- **Idempotent no-ops are silent**: duplicate `link` (while open) and
  duplicate `addAlias` return/no-op WITHOUT audit rows — don't assert
  audit counts across them.

## Related skills

- **memory-change-control** — non-negotiables + rationale, change
  classification, release runbook. Read it BEFORE editing anything here;
  a behavior change without its conformance-scenario change in the same
  commit is wrong by definition.
- **memory-validation-and-qa** — scenario runner mechanics, op vocabulary,
  how to pin new behavior.
- **memory-cli-and-hosting** — `balaur` CLI reference, data-dir/backup/
  restore runbooks, HOSTING.md host patterns.
- **memory-failure-archaeology** — why rejected verbs are rejected;
  incident evidence behind the rules above.
- **balaur-memory-web-campaign** — wiring this library into the web chat
  agent through the consent gate (agent verbs only).

## Provenance and maintenance

Verified 2026-07-08 against HEAD `f1b168a` (UNRELEASED — 14 commits past
tag v0.4.3, which is what consumers get). Drift-prone facts and one-line
re-checks (run from `memory/`; `bun` = `~/.bun/bin/bun` on this machine):

| Fact (as of 2026-07-08) | Re-verify with |
|---|---|
| schema_version = 4 | `grep -n "SCHEMA_VERSION" src/storage/schema.ts` |
| Invariants I1–I17 | `grep -c "^- \*\*I" docs/SCHEMA.md` (expect 17) |
| 26 conformance scenarios; 16/17 pinned, I14 by construction | `ls test/conformance/*.scenario.json \| wc -l`; `grep -n "Sixteen of seventeen" docs/CONFORMANCE.md` |
| 169 tests pass (13 files) | `bun test 2>&1 \| tail -3` |
| README/AGENTS drift repaired in 5b0a7bb (verified 2026-07-08; ledger: balaur-docs-and-writing §3) | `grep -n "I1–I14\|13 of 14" README.md AGENTS.md` (empty = still repaired) |
| DEFAULT_RANKING {0.02, 0.2, 60}, floor 0.05 | `grep -n "DEFAULT_RANKING\|RECENCY_FLOOR" src/recall.ts` |
| MemoryError codes (6) | `grep -n "readonly code" -A 8 src/types.ts` |
| Status/surfacing enums, system edge types | `grep -n "type Status\|type Surfacing\|SYSTEM_EDGE_TYPES" src/types.ts` |
| Package version 0.4.3 (unreleased HEAD keeps the old number) / HEAD f1b168a | `grep '"version"' package.json; git log --oneline -1` |
| CLI removed at HEAD; still in the v0.4.3 tag | `ls cli 2>&1` (fails); `git show v0.4.3:cli/index.ts \| head -3` |
| nodes_fts has a `surfacing` column at HEAD | `grep -n "surfacing UNINDEXED" src/storage/schema.ts` |
| DoctorReport has pendingByKind/historyRows/reproposedAfterForget30d at HEAD only | `grep -n "reproposedAfterForget30d" src/contract.ts; git show v0.4.3:src/contract.ts \| grep -c reproposed` (0) |
| Capture moments (3) | `sed -n '/### Capture moments/,/^$/p' docs/TEMPORAL.md` |
| v0.4.3 CLI --now lenient | `git show v0.4.3:cli/index.ts \| grep -n "new Date(nowIso)"` |
