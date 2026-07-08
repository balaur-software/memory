# Design spike: multi-window edge validity ("left and later returned")

> **Type**: design spike (plan 017). No production code changed by this
> document — it is a proposal + evidence for the owner to ratify. All
> `file:line` references are to the **approved worktree**
> (`.claude/worktrees/agent-ad93112a64c4916e7`, HEAD `5b0a7bb`), the
> post-fix tree, not the main repo tree. Drift check
> (`git diff --stat 9182b14..HEAD -- src/spine.ts docs/TEMPORAL.md
> docs/HOSTING.md src/entities.ts`) was run against the main repo before
> writing this doc and returned empty — no drift. Migrations in this tree
> are transactional (`plans/006-migration-durability.md:234-238`: "Every
> FUTURE delta (v5+) must follow the same shape"); `SCHEMA_VERSION` is `4`
> (`src/storage/schema.ts:11`) — nothing here has shipped as v5.
> `decideIdentity` whitelists verdicts (`src/entities.ts:266-271`); the CLI
> is removed (plan 002) — every recommendation below is a library API
> delta and/or a `HOSTING.md` host-pattern recipe, nothing else.

## 0. Executive summary

Five probe scripts (paths in Appendix B) ran against the real
`Store`/`spine.ts`/`entities.ts` code in the worktree (probes 1–3) and
against the raw SQLite the storage layer runs on, to verify migration
mechanics rather than assume them (probes 4–5) — none against
reimplementations:

1. **The existing single-window `asOf` predicate has no boundary
   ambiguity.** Nine boundary instants (exact `valid_from`, 1ms before,
   mid-window, exact `valid_until`, 1ms before/after, back-to-back stints)
   all resolve cleanly under the half-open interval
   `[valid_from, valid_until)`. No STOP condition triggered — full
   transcript in Appendix A. Multi-window designs can build on this
   predicate with confidence.
2. **Design A (windows table) and Design B (sequence-keyed rows) are
   read-semantically IDENTICAL** — both were probed against the literal
   "Ana rejoins Siemens" rehire and produced byte-identical
   `neighborhood`/`children`/`entityContext` output at every checkpoint
   (Appendix, §4). They differ entirely in **migration mechanics, `EdgeId`
   identity, and merge-collision blast radius** — not in what a read
   returns.
3. **The two designs split the cost differently, and it does not net out
   in Design A's favor the way the plan's own framing suggested.**
   Migration mechanics were VERIFIED directly against SQLite 3.53.0 (the
   version bundled with this project's bun:sqlite): Design A's migration
   is actually the LIGHTER one at the schema level — `ALTER TABLE ...
   DROP COLUMN` works natively for `valid_from`/`valid_until` (they aren't
   part of any constraint), no rebuild needed. Design B's migration
   genuinely DOES require a full table rebuild — SQLite refuses to drop
   the autoindex backing a table-level `UNIQUE` constraint, confirmed by
   trying (§3, `probe5-alter-unique-swap.ts`). But B pays that one-time
   cost for a system with **zero read-predicate changes, an unambiguous
   `Edge`/`EdgeId` shape, and — the deciding factor — a merge-collision
   path that can be made strictly lossless**, where A's cannot (its
   shared-`EdgeId`-per-triple design makes ONE merge collision destroy an
   entire relationship's windowed history, and even after that's fixed by
   re-parenting, A still forces an overlap-adjudication question B's
   fixed form does not). See §5 for the full analysis, §7 for the
   weighing.
4. **The "bless a convention" option (C) has two real variants**, both
   already buildable with **zero library changes** today. Neither is a
   good answer at scale — full cost breakdown in §6 — but one of them
   (reify the stint as a node) is exactly the pattern `HOSTING.md §11`
   already ships for money, so it deserves to be documented as the
   interim workaround regardless of what else happens.
5. **Recommendation: build Design B, not deferred** (§7) — the demand
   evidence is not hypothetical (§1), the two designs were probed as
   equivalent in outcome, and B is the lower-risk implementation of the
   two real builds. A ratified owner-decision list (§8) and a build-plan
   skeleton (§9) are included so a follow-up plan can be written cheaply.
   If the owner prefers to wait, §7 also states Design D's trigger
   precisely — and notes it may already be satisfied.

## 1. Why this matters (the demand evidence, verified against the tree)

`insertEdge` on a CLOSED `(source, target, type)` triple throws today:

```
edge <id> (<type>) between these nodes exists and is CLOSED
(valid_until <ts>) — a closed fact stays closed;
reopen semantics are deliberately deferred (TEMPORAL.md)
```

(`src/spine.ts:645-651`). The UNIQUE key forcing this
(`src/storage/schema.ts:62`) is `UNIQUE (source, target, type)` — there is
no room for a second row on the same triple, closed or not.

The deferral is ratified and explicitly conditioned on demand
(`docs/TEMPORAL.md:239-244`):

> Multi-interval validity (a history of windows per triple) is the honest
> future design **if real use demands it** — deferred, stated.

Three independent pieces of evidence say the condition is being met:

1. **The predecessor bug was real, not hypothetical.** The comment at
   `src/spine.ts:641-644` says the CLOSED-triple refusal exists specifically
   because "the silent stale-validity result made 'left then returned'
   invisible (review-3 A2)" — i.e. the library's OWN conformance probing
   hit this pattern before any host did. The regression test
   (`src/perpetuity.test.ts:45-58`, test `A2`) encodes it permanently:
   `store.link(ana.id, co.id, "works_at", "", { from: "2026-01-01" })`
   throws `"CLOSED"` after `closeEdge`. This is Ana-rejoins-Siemens,
   verbatim, already a pinned scenario.
2. **`HOSTING.md`'s own endorsed finance pattern walks every host into the
   wall.** §11's closing rule of thumb (`docs/HOSTING.md:351`): "**assets
   you sold get an `owns` edge with `valid_until`** (§8 / I15) so
   `neighborhood(asOf)` reconstructs what you held on any past date." A
   host that sells a stock and later rebuys the SAME security hits exactly
   the CLOSED-triple refusal — the library's own documentation manufactures
   the failure case it warns readers about nowhere else in that section.
3. **A second, independent host feature already needs the same shape.**
   `plans/design/task-arc.md:94-107` (plan 012, task management spike)
   documents `closeEdge` as "the only verb that can 'unblock' a task by
   closing its `blocked_by` edge." A task blocked, unblocked, and
   **re-blocked by the same blocker** (a dependency that resolves, then
   regresses — common in real project tracking) is the identical
   closed-triple-reopen pattern under a different edge type. Plan 012
   does not resolve this (it is a spike itself); it is additional evidence
   that this is a general graph-modeling gap, not a finance-specific one.

Left unaddressed, hosts work around it with mangled edge types
(`works_at_2`) or ad hoc node reification, both real options — costed
honestly in §6 — but both fragment exactly the graph `asOf` exists to
reconstruct in one clean traversal.

## 2. STOP-condition check (done first, per the plan)

Plan 017's STOP condition: *"The Siemens-twice walkthrough exposes an
ambiguity in EXISTING single-window `asOf` semantics — report it in the
doc's appendix as a bug finding before designing on sand."*

**Result: no ambiguity found.** Probe 1 (Appendix A) walked nine boundary
instants around the real `Store`'s single-window behavior — exact
`valid_from`, 1ms before/after every boundary, the exact `valid_until`
closing instant, and a genuine back-to-back (zero-gap) stint transition
between two DIFFERENT triples (the only way to construct that shape
under today's single-window constraint). Every checkpoint resolved to
exactly the expected node set, with no double-count and no dead gap at
the boundary instant. The predicate
`(valid_from IS NULL OR valid_from <= t) AND (valid_until IS NULL OR
valid_until > t)` is a clean half-open interval `[from, until)` and stays
clean under it. This is a **negative finding, reported per the STOP
condition's instruction to report either way** — the multi-window designs
below inherit this predicate unmodified (Design B) or via an EXISTS
rewrite of the identical shape (Design A), and both were separately probed
clean (§4). Full transcript: Appendix A.

## 3. The design matrix

### A. Windows table

`edge_validity(edge_id, seq, valid_from, valid_until)` child rows,
`PRIMARY KEY (edge_id, seq)`; `edges` keeps exactly one row per
`(source, target, type)` triple — the UNIQUE constraint is **unchanged**.

| Cost | Detail |
|---|---|
| Migration | New table `edge_validity`; backfill one row per existing edge (`seq=1`, its current `valid_from`/`valid_until`); drop the two now-relocated columns off `edges`. **Verified directly** (`probe4-alter-drop-column.ts`, against the real bun:sqlite/SQLite 3.53.0 this project ships on): `ALTER TABLE edges DROP COLUMN valid_from` / `valid_until` succeed NATIVELY, no table rebuild — those columns aren't part of any constraint or index. So Design A's migration is three lightweight statements (`CREATE TABLE`, one backfill `INSERT ... SELECT`, two `DROP COLUMN`s) plus the read-side rewrite below — genuinely LOW invasiveness at the schema-mechanics level, lighter than this doc first assumed. |
| Read predicates | `children`, `neighborhood`, `entityContext` — **all three rewritten** from a direct `e.valid_from`/`e.valid_until` column read to an `EXISTS (SELECT 1 FROM edge_validity v WHERE v.edge_id = e.id AND …)` subquery. Probed correct (§4). |
| `Edge` (TS type) | **Unchanged.** A read attaches "the window that matched at this `asOf`" as if it were the edge's own `validFrom`/`validUntil` — unambiguous per query because windows must not overlap (an invariant this design needs to state, not just assume — see §8). |
| `EdgeId` identity | **One id for the whole relationship's life.** A rehire opens a NEW window on the SAME `edges.id`. Upside: "show me this relationship's full history by id" is one join. Downside: the audit log's `edge.create` action fires again on the SAME edge id for a rehire — reads as a duplicate-creation event unless the audit meta is extended to say "reopen" vs "create" (a real but small cost). |
| `insertEdge` control flow | Restructured: no `edges` row for the triple → create row + window 1. Row exists, open window → idempotent no-op (today's behavior). Row exists, latest window CLOSED → **append a new window row**, same edge id. |
| `closeEdge` | Targets the `EdgeId` (unchanged signature) but now means "close the currently open window for this edge" — deterministic because at most one window is open at a time by construction. |
| Merge rewire | See §5 — **worse blast radius than B**: one `edges` row can carry N windows; a merge collision drop (`ON DELETE CASCADE` from `edge_validity`) discards ALL of them in one shot, not just the colliding stint. |

### B. Sequence-keyed rows

`UNIQUE(source, target, type, seq)` replaces `UNIQUE(source, target,
type)`; each stint is its own full `edges` row with its own `EdgeId`.

| Cost | Detail |
|---|---|
| Migration | Add `seq INTEGER NOT NULL DEFAULT 1` to `edges` (native `ADD COLUMN`, cheap); then relax `UNIQUE(source,target,type)` to `UNIQUE(source,target,type,seq)`. **Verified this genuinely needs a full table rebuild** (`probe5-alter-unique-swap.ts`): a table-level `UNIQUE` constraint backs an `sqlite_autoindex_*` that SQLite explicitly refuses to `DROP INDEX` ("index associated with UNIQUE or PRIMARY KEY constraint cannot be dropped"); adding a parallel `CREATE UNIQUE INDEX (source,target,type,seq)` does NOT help — the OLD 3-column constraint stays live underneath and still rejects a second `seq` row for one triple (confirmed: the exact insert this whole design exists to allow still fails with `UNIQUE constraint failed: t.source, t.target, t.type` even after adding the new index). So Design B's migration is **`CREATE edges_new` (4-column unique key) → `INSERT ... SELECT` → `DROP edges` → `RENAME`** — heavier than Design A's, on this axis specifically. Probed working end-to-end as a rebuild (`probe2-design-b-seq-rows.ts`). |
| Read predicates | **Unchanged.** `children`/`neighborhood`/`entityContext` already just JOIN on `(source,target,type)` and filter by the validity predicate on the SAME row; multiple qualifying rows already collapse correctly — `neighborhood`/`children` via `DISTINCT`, `entityContext` via its `bySide` `Map`. **Probed, not asserted** (§4): the real, unmodified `spine.children`/`spine.neighborhood`/`entities.entityContext` ran against a hand-rebuilt two-row schema and returned the exact expected asOf table. |
| `Edge` (TS type) | **Unchanged, and unambiguous by construction** — one row is one `Edge`; no shared-id-multiple-windows question ever arises. |
| `EdgeId` identity | **One id per stint.** "Show me this relationship's full history" needs a query over all rows matching `(source,target,type)`, not a single id lookup — a new read primitive is warranted (see §9) but isn't a correctness gap, just missing ergonomics. Audit log is cleaner: each stint's `edge.create` is a genuinely new id, unambiguously a new event. |
| `insertEdge` control flow | Same shape as A's: no open row → create with `seq = 1`. Latest row for the triple open → idempotent no-op. Latest row closed → **insert new row, `seq = (current max seq for the triple) + 1`**. |
| `closeEdge` | **Simpler than A** — targets a specific `EdgeId`, which already denotes exactly one window; no "resolve which window is open" indirection needed. |
| Merge rewire | See §5 — smaller blast radius than A IF paired with an explicit seq-renumber step; WORSE than A (non-deterministic partial loss) if the rewire logic is left as today's naive `UPDATE OR IGNORE`. |

### C. Bless a convention, build nothing

The plan's own framing is right to force this into confronting the UNIQUE
constraint head-on: **C cannot put a second same-type row on one triple —
that is the whole problem being deferred.** Two workarounds exist that
sidestep the constraint instead of relaxing it. Neither needs a single
library change; both are buildable today, in a host, with zero involvement
from `balaur-memory`.

**C1 — mangled/suffixed edge types** (the pattern the plan names,
`works_at_2`): closes the current edge, links a NEW edge with a
disambiguated TYPE string instead of the same type.

- Preserves the 1-hop `neighborhood`/`entityContext` traversal — zero
  library friction.
- Costs: the host must invent and persist its OWN per-triple stint
  counter (nothing in the schema tracks "how many `works_at_N` types has
  this pair used"); "all of Ana's employers, ever" becomes a query over an
  UNBOUNDED and host-invented type namespace (`works_at`, `works_at_2`,
  `works_at_3`, …) instead of one type string; `suggestIdentities` and any
  future edge-type-aware feature (graph analytics, type-based recall
  weighting) silently stops recognizing `works_at_2` as "the same kind of
  relationship" as `works_at` — this is exactly the "fragmenting exactly
  the graph `asOf` exists to reconstruct" the plan predicts.

**C2 — reify the stint as its own node** (the pattern `HOSTING.md §11`
ALREADY ships, for money): instead of one edge per relationship, create
one `employment`-typed node per stint (`when` = the start date, a host
prop for the end), and link it to both Ana and Siemens with plain,
un-repeated edge types (`store.link(stint.id, ana.id, "employee")`,
`store.link(stint.id, siemens.id, "employer")`). Each stint is a
DIFFERENT node id, so no `(source,target,type)` triple ever repeats — the
UNIQUE constraint never engages. This is structurally identical to the
`holding` node pattern already in production docs
(`docs/HOSTING.md:258-352`: multiple `holding` nodes, each with its own
`snapshot_of` edge to ONE account, no collision because each holding has a
distinct id).

- Zero library changes; the pattern is already vetted by an existing,
  documented, host-facing recipe.
- Costs: `entityContext` is explicitly 1-hop
  (`src/entities.ts:378-381`, the `EntityContext` interface doc: "the
  node, its names, and its capped 1-hop neighborhood") — Ana's peer card
  would show the **`employment` node**
  as her peer, not Siemens. The org's name has to be encoded INTO the
  stint node's title (`"Ana @ Siemens (2021–2026)"`) for the card to read
  usefully at all, because the library will not compose "Ana → stint →
  Siemens" into one peer entry. `neighborhood(ana)` likewise returns stint
  nodes, not orgs — a host wanting "which orgs has Ana worked at" needs a
  2-hop walk it writes itself (exactly the `netWorth()` JS-reduce pattern
  `HOSTING.md:333-345` already prescribes for holdings — so the shape is
  precedented, but it is host-maintained logic, not a library primitive).

**Conclusion for C**: both variants are real, low-effort, ship-today
options — and C2 in particular should be written up as the interim
`HOSTING.md` guidance regardless of what else happens (§7) — but neither
is a good general answer: C1 fragments the type vocabulary, C2 fragments
the traversal depth. Both push cost onto every host that needs this
pattern, repeatedly, instead of paying it once in the library. This
matches the plan's own prediction and confirms C is, honestly, a
non-answer at the library level — a documented workaround, not a design.

### D. Re-defer with an explicit trigger

The plan's suggested trigger: *"the first real host hits the refusal in
production use."* Two observations on the wording specifically:

1. `RELEASE.md`'s "Linking for parallel dev" section
   (`docs/RELEASE.md:123-131`) names a real downstream host,
   `balaur-life`, developed against this library. This spike found no
   evidence either way on whether that host has hit the refusal — that
   is out of scope to check (out-of-repo) — but a host exists to hit it.
2. The trigger as worded requires a HOST to hit the wall. Evidence item 2
   in §1 shows the library's OWN shipped documentation (`HOSTING.md §11`)
   is what walks a compliant host into the wall on the very first
   buy-sell-rebuy cycle — i.e. the trigger condition is not "if" but
   "when a host follows the docs as written and its owner does anything
   life does constantly (rejoin, resell, rebuy, reblock)." Given that,
   treating D's trigger as *not yet met* requires treating "no host has
   filed the bug report yet" as meaningfully different from "the docs
   guarantee it will happen" — a distinction of paperwork, not of risk.

D remains available (see §7's fallback) but this spike does not recommend
resting on it.

## 4. The `asOf` semantics tables (probed, not derived)

Both tables below are the **literal probe output** from running the real
`spine.ts`/`entities.ts` code (Design B, unmodified) and a hand-adapted
EXISTS-subquery rewrite (Design A, the literal v5 shape) against the SAME
scenario: **"Ana rejoins Siemens"** — stint 1 `2021-03-01 → 2026-01-31`
(closed), stint 2 `2026-06-01 → (open)` (the rehire). This is the golden
`temporal-siemens-years.scenario.json` extended exactly as plan 017 Step 2
specifies, minus the type-mangling workaround the golden scenario
currently uses to represent Ana's second job (Bitdefender, a different
org) — here both stints are the SAME triple, `(ana, siemens, works_at)`.

| Checkpoint | `asOf` | `neighborhood(ana)` | `children(siemens,"works_at")` | `entityContext(ana).peers` |
|---|---|---|---|---|
| gap before stint 1 | `2020-01-01T00:00:00.000Z` | `[]` | `[]` | `[]` |
| mid stint 1 | `2024-06-15T12:00:00.000Z` | `["Siemens"]` | `["Ana Popescu"]` | `Siemens via works_at 2021-03-01..2026-01-31` |
| stint 1 close instant (excluded — half-open) | `2026-01-31T00:00:00.000Z` | `[]` | `[]` | `[]` |
| gap between stints | `2026-03-01T00:00:00.000Z` | `[]` | `[]` | `[]` |
| stint 2 open instant (included) | `2026-06-01T00:00:00.000Z` | `["Siemens"]` | `["Ana Popescu"]` | `Siemens via works_at 2026-06-01..+inf` |
| mid stint 2 / present | `2026-07-05T12:00:00.000Z` (also the default, no `asOf`) | `["Siemens"]` | `["Ana Popescu"]` | `Siemens via works_at 2026-06-01..+inf` |

**This single table is the result for BOTH Design A and Design B** — the
probes produced byte-identical output at every checkpoint
(`probe2-design-b-seq-rows.ts` vs `probe3-design-a-windows-table.ts`,
Appendix B). The raw-row sanity checks embedded in the probes also confirm
the mechanism, not just the outcome:

- `SELECT COUNT(*) FROM edges WHERE source=ana AND target=siemens AND
  type='works_at'` → **2** under both designs (the row count the current
  UNIQUE constraint forbids).
- `neighborhood(ana)` peer count at mid-stint-1 → **1**, not 2 — `DISTINCT`
  (B) and the EXISTS subquery (A) both collapse correctly to one Siemens
  entry despite two underlying rows.
- Identity check (Design A only): `COUNT(DISTINCT edge_id)` across the two
  `edge_validity` rows → **1** — confirms A's defining trait, one `EdgeId`
  spans the whole relationship; Design B's two rows carry two distinct
  `EdgeId`s by construction (each stint is its own `edges` row with its
  own generated id). Both probes constructed their rows directly (raw
  `INSERT`, not `store.link()`/`store.insertEdge()`) because the WRITE
  side (`insertEdge`'s conflict handling) is exactly the code that needs
  the control-flow rewrite described in §3/§9 before either schema can be
  written to through the public API — these probes test the READ side
  only, which is the part §3 claims is unchanged (B) or mechanically
  rewritten (A).

## 5. The merge-rewire analysis

`decideIdentity`'s rewire (`src/entities.ts:299-320`) today, in order:

1. Delete edges that would become self-loops or transplant a `no_match`
   verdict (`entities.ts:299-304`).
2. `UPDATE OR IGNORE edges SET source = ? WHERE source = ?` (and the
   symmetric `target` update) — `entities.ts:308-315`. On a UNIQUE
   collision, `OR IGNORE` silently leaves the losing row unchanged
   (still pointing at `other`).
3. `DELETE FROM edges WHERE source = ? OR target = ?` sweeps up whatever
   step 2 couldn't rewire — `entities.ts:316`. The JSDoc states the
   resulting policy plainly: "keep's win on conflict" (`entities.ts:258`).

Today (single window per triple), a collision means: both `keep` and
`other` independently have an edge to the same peer of the same type.
Exactly one window — `other`'s — is discarded. That is the full cost, by
design, today.

Multi-window changes what "a collision" can mean, and the two designs pay
for it very differently:

**Design A.** `edges` still holds exactly one row per triple, so step 2's
collision detection is UNCHANGED at the SQL level — but that one colliding
row can now carry an entire multi-year `edge_validity` history (N windows,
via `ON DELETE CASCADE` from the FK on `edge_id`). Step 3's blind
`DELETE FROM edges WHERE source = ? OR target = ?` deletes `other`'s
ENTIRE windowed history for that relationship in one shot, not just the
window that happens to be open. **This is a strictly worse outcome than
today's single-window loss** — a merge that used to lose one fact now
loses an unbounded number of facts, silently, because the collision unit
(one `edges` row) no longer corresponds to the loss unit (one window).
Fixing this for A requires replacing step 2's blind `UPDATE OR IGNORE`
with an explicit **re-parent**: on collision, `INSERT INTO edge_validity
SELECT keep_edge_id, next_seq, valid_from, valid_until FROM edge_validity
WHERE edge_id = other_edge_id` before dropping `other`'s row — which
raises a genuinely new question the JSDoc's "keep's win" policy never had
to answer: **if `keep`'s and `other`'s folded windows now temporally
OVERLAP** (both had `works_at` open to the same org at the same historical
moment, because they were secretly the same person's two duplicate
records), does the merge keep both overlapping windows as-is, or does it
need the owner's adjudication? This is a real open question — §8.

**Design B.** Step 2's `UPDATE OR IGNORE ... WHERE source = ?` now
operates per-stint-row. If `keep` has NO existing row for that
`(peer,type)`, ALL of `other`'s stint rows rewire cleanly — no loss, and
this is actually BETTER than today's policy (the full history transfers).
If `keep` ALSO independently has row(s) for that `(peer,type)` — i.e. both
people have their own history with the same org — collisions become
**seq-alignment-dependent**: whichever of `other`'s rows happen to share a
`seq` number with one of `keep`'s existing rows get silently dropped by
`IGNORE`, while non-colliding `seq` numbers succeed. This produces a
PARTIAL, ARBITRARY loss keyed off incidental seq numbering — worse in
CHARACTER (nondeterministic, implementation-accidental) even though
smaller in typical MAGNITUDE (one stint, not the whole history) than A's
failure mode. Fixing this for B requires the collision path to
**renumber before rewiring**: compute
`next_seq = (SELECT COALESCE(MAX(seq),0)+1 FROM edges WHERE source=keep
AND target=peer AND type=type)` per moved row instead of relying on
`IGNORE` to signal a collision at all — which, done right, means **B's
merge never has to drop a window silently**; every stint transfers,
renumbered to avoid the constraint. B's failure mode is thus fixable into
a strictly ADDITIVE merge (nothing lost, ever), which A's shared-row
identity cannot offer without also solving the same overlap-adjudication
question A already has.

**Net**: B's fixed merge behavior (additive, no silent loss, no
overlap-adjudication question forced at merge time) is strictly better
than A's fixed merge behavior (requires an explicit overlap policy
decision even after the re-parent fix). This is the single biggest
technical argument for B over A and is reflected in §7's recommendation.

## 6. Cross-check: the existing conformance surface

- `test/conformance/temporal-siemens-years.scenario.json:26-33` — the
  step that currently ASSERTS the refusal
  (`"expectError": "conflict"` on a same-triple relink after `closeEdge`)
  becomes, under either A or B, a step that SUCCEEDS and opens a new
  window. This scenario needs an explicit rewrite alongside whichever
  build ships, not a silent behavior change under an unmodified fixture —
  see §9.
- `test/conformance/merge-adversarial-edges.scenario.json` exercises
  self-loop/no_match/chain collision paths but never puts TWO windows on
  one triple before merging — §5's collision analysis is new ground this
  scenario does not currently cover; the build-plan skeleton (§9) adds a
  scenario for it.
- `test/conformance/I3-neighborhood-active-only.scenario.json` is
  orthogonal (status/surfacing filtering, not validity) — unaffected by
  either design; included in the "must keep passing" list for the build.
- **A small pre-existing gap found while probing**: the conformance
  runner's `"children"` expectation handler
  (`test/conformance/runner.test.ts:326-338`) does not thread `ex.asOf`
  into the `store.children()` call it makes — only `"neighborhood"` and
  `"entityContext"` expectations wire `asOf` through
  (`runner.test.ts:296-306`, `340-345`). `children(id, edgeType, {
  asOf })` itself already supports the parameter
  (`src/spine.ts:339-343`); only the TEST HARNESS doesn't expose it. This
  is not a production bug — no host-facing behavior is wrong — but any
  build that wants a `children(asOf)` conformance assertion for the
  Siemens-twice scenario needs this harness fix first. Small, listed in
  §9's build plan.

## 7. Recommendation

**Build Design B (sequence-keyed rows), not deferred.**

Rationale, weighing everything above:

- The demand evidence (§1) is not speculative: a pinned regression test
  already encodes the exact scenario, the library's own shipped host
  guidance manufactures it, and a second independent host feature
  (task blocking) needs the identical shape.
- A and B are read-equivalent (§4, probed) — so the choice comes down to
  migration cost, identity shape, and merge cost, and it is a genuine
  trade, not a clean sweep for either:
  - **Migration**: A is lighter (verified — no `edges` rebuild needed,
    §3). B is heavier (verified — a full rebuild is unavoidable, §3).
    Advantage: A. But this is a ONE-TIME cost paid once at ship time.
  - **Read predicates**: A needs a real rewrite (3 call sites, `EXISTS`
    subqueries — mechanical and already probed correct, but it IS a
    diff). B needs zero changes (probed, §4). Advantage: B, and this cost
    recurs every time a FUTURE read is added to the validity surface —
    B's authors never have to remember the subquery shape exists.
  - **`EdgeId` identity / audit honesty**: A keeps one id for a
    relationship's whole life (a real ergonomic plus, closed on B's side
    by a small new read primitive, §9 item 4) — but A's rehire re-fires
    `audit(...,"edge.create",...)` on an id that already exists, which
    reads as a duplicate-creation event unless audit meta grows a new
    distinction. B's rehire gets a fresh id, so "create" stays literally
    true every time, with no follow-up fix needed. Advantage: B, narrowly.
  - **Merge safety** (§5, the deciding factor): A's shared-`EdgeId`
    design means ONE collision during a merge deletes an entire
    relationship's windowed history via cascade, not just the colliding
    stint — worse than today's single-window loss, not just different.
    Fixing that (re-parenting instead of deleting) still leaves A with an
    unresolved overlap-adjudication question. B's naive form fails
    differently (smaller magnitude, worse character — non-deterministic
    partial loss keyed on incidental `seq` numbers) but its FIXED form
    (renumber-before-rewire) is achievable as strictly additive and
    lossless, with no forced overlap decision at merge time. Advantage:
    B, decisively — this is the property that matters most for a file
    `ADR-0001` calls a 40-year contract, and it is the one place A's
    fixed form still has a gap B's does not.
- Net: B pays a heavier one-time migration for a system that needs no
  ongoing predicate maintenance and can be made merge-safe without
  forcing extra owner decisions later. That trade favors B.

**If the owner prefers not to build now**, Design D is the honest
fallback, with its trigger stated precisely per §3: *"the first commit to
a host's codebase (in-repo or `balaur-life`) that reaches for `works_at_2`
or a reified stint node to route around the CLOSED-triple refusal."* Given
§1's evidence, that trigger is plausibly satisfied by the DOCUMENTATION
alone (`HOSTING.md §11`) even absent a filed host bug — the owner should
weigh that when deciding whether "re-defer" is actually cheaper than
"build," since the interim state under D still needs the C2 workaround
(§6) written into `HOSTING.md` as an explicit, supported pattern — itself
a small doc change, and one worth making regardless of the A/B/D
decision, so hosts have a sanctioned answer today either way.

## 8. Owner-decision list (ratify before Phase A of any build)

Mirroring `TEMPORAL.md`'s own "open questions for the owner" structure
(`docs/TEMPORAL.md:264-282`), since this build amends that same arc:

1. **A or B?** Recommendation: B (§7). Confirm, or override with a
   reason this doc should capture.
2. **Overlapping windows on one triple — forbidden, or allowed?** Neither
   design's schema PREVENTS two windows with overlapping
   `[valid_from, valid_until)` ranges on the same triple (owner
   double-entry, a backfill error, or — per §5 — a merge that folds two
   independently-true histories together). Recommend: `insertEdge`
   refuses to OPEN a new window that overlaps an existing one on the same
   triple (symmetric to the existing `until <= valid_from` refusal,
   `src/spine.ts:624-625`); the merge rewire (§5) surfaces an overlap as a
   `conflict` requiring the owner's `decideIdentity` call to be retried
   with an explicit close, rather than silently keeping both. Confirm, or
   choose "allowed, both windows stand" instead.
3. **A whole-relationship history read.** Design B splits one
   relationship's story across multiple `EdgeId`s. Recommend a new read,
   e.g. `edgeHistory(source, target, type): Edge[]` (all stints, oldest
   first) — the natural complement to `history(nodeId)` for edges.
   Confirm the shape, or say the existing `entityContext`/`neighborhood`
   asOf-walk is enough.
4. **`closeEdge`'s "already closed" refusal** (`src/spine.ts:673`,
   `"edge <id> is already closed"`) stays exactly as-is under B — it
   refers to one row, one window, unambiguously. Confirm this needs no
   change (it doesn't, under B) — flagged only so it isn't silently
   assumed to need touching.
5. **Audit granularity for a rehire.** Under B, `insertEdge` opening
   window 2 on a previously-closed triple is a NEW `edges.id`, so
   `audit(...,"edge.create",...)` (`src/spine.ts:654`) fires exactly as it
   does for any new edge — no change needed. Confirm no additional
   `"edge.reopen"` audit action is wanted (recommend: no — a rehire IS a
   new fact by a new id, "create" already says it honestly).
6. **`HOSTING.md §11`'s wording.** Whatever ships, the "assets you sold
   get an `owns` edge with `valid_until`" line needs a follow-on sentence
   for the rebuy case — either "and rebuying reopens automatically" (if B
   ships) or the C2 reification recipe (if deferred). This doc change is
   small and low-risk either way — recommend shipping it now regardless
   of the A/B/D timeline (§7).

## 9. Build-plan skeleton (Design B) — for the follow-up plan

**Schema (v5)**:

```sql
-- v5: sequence-keyed edges — a triple may now have multiple stints.
-- (per plans/006-migration-durability.md:234-238's shape: one
-- db.transaction() wrapping the delta exec + the version bump.)
CREATE TABLE edges_v5 (
  id      TEXT PRIMARY KEY,
  source  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type    TEXT NOT NULL DEFAULT 'links',
  context TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  valid_from  TEXT,
  valid_until TEXT,
  seq INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source, target, type, seq)
) STRICT;
INSERT INTO edges_v5 SELECT id, source, target, type, context, created,
  valid_from, valid_until, 1 FROM edges;
DROP TABLE edges;
ALTER TABLE edges_v5 RENAME TO edges;
CREATE INDEX idx_edges_target ON edges(target);
```

**Steps**:

1. `storage/schema.ts`: `V5_DDL`, `SCHEMA_VERSION = 5`, wired into
   `migrateMemoryDb` per the existing `v < N` ladder
   (`storage/schema.ts:193-207`). Committed legacy fixture per plan 006's
   convention (a v4 fixture db, proving the v4→v5 leg for real, not just
   the fresh-create path).
2. `spine.ts` `insertEdge`: replace the single `ON CONFLICT ... DO
   NOTHING` with the three-way branch in §3/B ("no row" / "latest row
   open" / "latest row closed → new row, `seq = max+1`"). Preserve every
   existing refusal (system edge types, `until <= from`,
   `props_invalid`).
3. `spine.ts` `closeEdge`: unchanged signature and logic — already
   targets one unambiguous row.
4. New read: `edgeHistory(ctx, source, target, type): Edge[]` (owner
   decision 3, §8) — one indexed query, oldest-first.
5. `entities.ts` `decideIdentity`: replace the blind
   `UPDATE OR IGNORE ... WHERE source = ?` (`entities.ts:308-315`) rewire
   with the renumber-before-rewire logic from §5 ("Design B" paragraph):
   for each of `other`'s rows to a given `(peer,type)`, compute the next
   free `seq` for `(keep,peer,type)` before moving it, so no row is EVER
   dropped by `IGNORE`. Requires an owner ruling on overlap handling
   (§8 item 2) before the collision path can be finished.
6. `test/conformance/runner.test.ts`: fix the `"children"` `asOf` gap
   (§6) — thread `ex.asOf` into the `store.children()` call at
   `runner.test.ts:326-338`, matching the `"neighborhood"`/
   `"entityContext"` handlers.
7. `docs/TEMPORAL.md` and `docs/SCHEMA.md`: v5 section, new invariant or
   amendment to I15 covering multi-window (`UNIQUE(source,target,type,
   seq)`, the overlap ruling from owner decision 2).
8. `docs/HOSTING.md §11`: the rebuy-after-sell sentence (owner decision
   6).

**Conformance scenarios** (new, alongside the fixes above):

- `temporal-siemens-twice.scenario.json` — the literal §4 walkthrough:
  stint 1 closed, stint 2 opened on the SAME triple, assertions at every
  checkpoint in §4's table (`neighborhood`, `children`, `entityContext`,
  `asOf` in-window/between-window/at-NOW). Retires/replaces the current
  `expectError: "conflict"` step in
  `temporal-siemens-years.scenario.json:26-33`, which flips to a success
  step under this build — do not leave the old assertion in place
  unmodified (it would start failing, correctly, and needs a deliberate
  rewrite, not a silent break).
- `merge-multiwindow-collision.scenario.json` — two people, each with
  their own multi-stint history at the SAME org, merged via
  `decideIdentity`; asserts every stint survives (renumbered), and asserts
  the overlap behavior ratified in owner decision 2.
- Extend `I3-neighborhood-active-only.scenario.json`'s coverage
  incidentally (no scenario changes expected — status/surfacing filtering
  is orthogonal, listed here only as a "must still pass" check).

## Appendix A — boundary-semantics probe (STOP-condition evidence)

Script: `probe1-existing-boundary.ts` (Appendix B). Ran against the real,
unmodified `Store` — golden Siemens-years shape (stint 1 Siemens
2021-03-01→2026-01-31 closed, stint 2 Bitdefender 2026-02-01→open) plus a
constructed zero-gap boundary case (two DIFFERENT triples, back-to-back,
since a same-triple back-to-back cannot be constructed under today's
single-window constraint — that constraint IS this spike's subject).

```
valid_from of job1 exactly                    asOf=2021-03-01T00:00:00.000Z  neighborhood=["Siemens"]
1ms before valid_from of job1                 asOf=2021-02-28T23:59:59.999Z  neighborhood=[]
mid stint 1                                   asOf=2024-06-15T12:00:00.000Z  neighborhood=["Siemens"]
valid_until of job1 EXACTLY (closing instant) asOf=2026-01-31T00:00:00.000Z  neighborhood=[]
1ms before valid_until of job1                asOf=2026-01-30T23:59:59.999Z  neighborhood=["Siemens"]
1ms after valid_until of job1 (gap start)     asOf=2026-01-31T00:00:00.001Z  neighborhood=[]
valid_from of job2 EXACTLY (reopening instant) asOf=2026-02-01T00:00:00.000Z  neighborhood=["Bitdefender"]
1ms before valid_from of job2                 asOf=2026-01-31T23:59:59.999Z  neighborhood=[]
mid stint 2 / NOW-ish                         asOf=2026-07-05T12:00:00.000Z  neighborhood=["Bitdefender"]

At t = job1.valid_until exactly, is Siemens present?     false
At t = job2.valid_from exactly, is Bitdefender present?  true

back-to-back boundary instant (two different triples), t=2022-01-01T00:00:00.000Z
  neighborhood = ["Siemens","Adjacent-Co"]   (Siemens = older, still-existing separate edge; Adjacent-Co = the new
                                               triple opening at the exact instant the other closes)
```

**Reading**: the predicate is a correct half-open interval — the closing
instant belongs to NEITHER window (excluded from the old, and the new
window's `valid_from <= t` only includes it if a DIFFERENT triple opens at
that exact instant, which it correctly does). No double-count, no dead
gap, no off-by-one. **No bug found; STOP condition not triggered.**

## Appendix B — probe scripts (reproduce these before trusting this doc)

All under
`/tmp/claude-1000/-home-alex-projects-balaur-memory/abfef91e-d2fb-43a8-8e26-754fd479d3d3/scratchpad/`,
importing directly from the worktree's `src/`:

- `probe1-existing-boundary.ts` — Appendix A's boundary walk, real `Store`,
  no schema modification. `bun run probe1-existing-boundary.ts`.
- `probe2-design-b-seq-rows.ts` — Design B: rebuilds `edges` with a `seq`
  column and `UNIQUE(source,target,type,seq)` (the literal v5 shape from
  §9), hand-inserts the two-stint Siemens rehire directly (bypassing
  `insertEdge`, which still enforces today's constraint — this probe
  tests the READ side only, which is the part §3 claims is unchanged),
  then calls the REAL unmodified `spine.children` / `spine.neighborhood` /
  `entities.entityContext` against it. `bun run
  probe2-design-b-seq-rows.ts`.
- `probe3-design-a-windows-table.ts` — Design A: rebuilds `edges` to drop
  `valid_from`/`valid_until`, adds `edge_validity(edge_id, seq,
  valid_from, valid_until)`, backfills existing edges as one window each,
  hand-inserts the two-stint rehire as two `edge_validity` rows under ONE
  `edges.id`, then runs the hand-adapted EXISTS-subquery equivalents of
  `neighborhood`/`children`/`entityContext` (spine.ts's real functions
  hardcode the old column shape and cannot run against this schema
  unmodified — that IS Design A's "every predicate becomes an EXISTS
  subquery" cost, demonstrated by necessity rather than asserted).
  `bun run probe3-design-a-windows-table.ts`.
- `probe4-alter-drop-column.ts` — confirms `ALTER TABLE ... DROP COLUMN`
  works natively (no rebuild) against an in-memory table shaped like
  `edges`, on the SQLite version (3.53.0) this project's bun:sqlite
  bundles — the evidence behind Design A's corrected, lighter migration
  cost in §3. `bun run probe4-alter-drop-column.ts`.
- `probe5-alter-unique-swap.ts` — confirms the opposite for Design B: the
  autoindex backing a table-level `UNIQUE` constraint cannot be dropped
  (`DROP INDEX sqlite_autoindex_*` errors), and adding a parallel 4-column
  unique index does NOT relax the old 3-column constraint underneath —
  the exact rehire insert this design exists to allow still fails until
  the table is rebuilt. The evidence behind Design B's confirmed-heavier
  migration cost in §3. `bun run probe5-alter-unique-swap.ts`.

None of these scripts wrote anywhere outside the scratchpad directory or a
`mkdtemp` scratch dir cleaned up at the end of each run; no file under
`.claude/worktrees/` or the main repo tree was modified by this spike.
