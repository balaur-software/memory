---
name: memory-failure-archaeology
description: Use when asking "has this been tried?" or "why is it like this?" in balaur-memory — before proposing unmerge, undo, auto-merge, improve(), schedulers, node validity windows, an Embedder, a CLI revival, or a port revisit; when investigating past PRs, hardening findings (F1–F12, A1–A5), the 2026-07 deep audit (CLI removal, byte-level forgetting, recall starvation), the no_match edge transplant, VACUUM INTO backup, the dayAnchor-walk trap, or missing git tags.
---

# memory-failure-archaeology — the chronicle of settled battles

This is the failure-and-decision ledger for the `memory/` repo
(balaur-memory): every major investigation, dead end, rejected mechanism,
and deferral, as **symptom → root cause → evidence → status**. Its job is
to stop you from re-fighting a battle that is already settled, and to tell
you which battles are merely *deferred* (and what reactivates them).

**When NOT to use this skill:**

| You want... | Go to |
|---|---|
| The current rules (non-negotiables, release runbook, change classes) | **memory-change-control** |
| Schema/invariant theory, verb semantics, ranking math | **memory-domain-reference** |
| CLI usage, backup/restore runbooks, host patterns | **memory-cli-and-hosting** |
| How to add tests/conformance evidence for a change | **memory-validation-and-qa** |
| Landscape claims, FIELD.md leads, licensing | **balaur-external-positioning** |
| Cross-repo architecture, tag-pin doctrine | **balaur-workspace-map** |

## How to use this ledger

1. Search this file for the mechanism/symptom you're about to propose or
   debug. If it appears with status **SETTLED** or **REJECTED**, do not
   reopen it without *new evidence* — and take new evidence to the owner,
   not into a PR.
2. If it appears as **DEFERRED**, check the reactivation trigger before
   building anything.
3. If it's not here, dig yourself (all commands run in `memory/`):

```bash
git log --format=full --oneline            # the full narrative, PR-per-phase
git log -S 'search-term' --oneline         # which commit introduced/removed a string
git show <hash> --no-patch --format='%B'   # the commit body — findings are documented there
```

The fix-batch commit bodies (5b8b5fe, 0cd7adf, 35d75e1, d454edd — and for
the 2026-07 deep audit, every commit in `61ddbd2..f1b168a` plus
`plans/README.md`) are the primary sources: each enumerates its findings
by name. `docs/HISTORY.md` is the canonical phase log.

**Status legend:** SETTLED (decided, don't reopen) · FIXED (bug closed,
pinned by test/scenario) · REJECTED (mechanism refused on principle) ·
DEFERRED (stated, with a reactivation trigger) · OPEN (unresolved) ·
DO-NOT-TOUCH (owner-gated).

## Timeline skeleton (verified against git log, 2026-07-08)

Built 2026-07-05 → 2026-07-07 in PR-per-phase discipline. PR → merge
commit: #1 `adbff60` (Go scaffold), #2 `27944ee` (Bun pivot), #3–#7
spine/recall/consent/lifecycle/doctor, #8 `e36cbdc` (hardening 1), #9–#13
entities arc, #14 standalone, #15 `9d49871` (hardening 2, tag v0.2.3),
#16–#18 temporal arc, #19–#20 planning arc (tag v0.4.0), #21 FIELD survey,
#22 `12dd8a5` (hardening 3), #23 abandoned (see Process failures), #24
`99771dd` (ergonomics), #25 HOSTING, #26 `bdc0f7b` (publishability), then
four direct-to-main commits ending at `9182b14` — followed by the
**2026-07 deep audit** (§11): 14 linear direct-to-main commits
`61ddbd2..f1b168a`, landed 2026-07-08. HEAD `f1b168a` is UNRELEASED —
no tag past `v0.4.3` (64c0542); consumers still get v0.4.3.

**Git tags** (re-verified 2026-07-08 via `git tag -l` +
`git ls-remote --tags origin`): the release-day tags are `v0.2.3`,
`v0.4.0`, `v0.4.3`. Annotated tags `v0.3.0`, `v0.3.1`, `v0.4.1`, `v0.4.2`
were **backfilled on 2026-07-07** (their tag messages say
"backfilled 2026-07-07"), point at the historically correct commits, and
have since been pushed to origin. `[v0.1.1]` remains a
commit-message-only label. Before assuming a version is installable as a
tag pin, verify it on the remote: `git ls-remote --tags origin`.

---

## 1. The Go pivot (phase 0 → 0.5)

- **Symptom:** phase 0 scaffolded the library in Go (five files: `go.mod`,
  `doc.go`, `types.go`, `consent.go`, `contract.go`, committed 2026-07-05
  23:16–23:17, merged as PR #1).
- **Root cause:** wrong reviewer-language bet. The owner's working language
  is TypeScript; in an agent-assisted workflow the owner's job is
  *reviewing*, and — ADR-0001's words — **"you can only adjudicate what
  you read fluently."** A consent-gated project whose owner cannot audit
  its own code contradicts its own philosophy.
- **Evidence:** PR #2 (merge `27944ee`) deleted all five Go files at 23:33
  the same evening — ~16 minutes after they landed (deletion commits
  `c687024`, `e1e2ce2`, `626a276`, `581b7ee`, `0917c92`) — and shipped
  `docs/adr/0001-bun-typescript.md` plus the full TS design in `fee2709`.
- **The costs were named, not waved away:** (1) Go can't import a TS
  module — no host inherits the library for free; (2) Bun is a young
  VC-funded runtime (the Kuzu shutdown is the standing cautionary tale,
  see External lessons). Three guardrails contain them: the schema is the
  contract (any language can open `memory.db`); `bun:sqlite` is confined
  to `src/storage/bun.ts` behind an adapter; conformance is data-level so
  any future port proves parity mechanically.
- **Status: SETTLED.** The documented revisit trigger is *Bun's health
  degrading* — and the exit ramp is porting `src/storage/` to
  `node:sqlite` behind the same adapter, i.e. **a storage port, never a
  language revisit**. Do not propose rewriting in Go/Rust/anything.
- **Rides along:** even the `Embedder` interface left the library here —
  "vectors in, never models"; hosts embed asynchronously outside and hand
  in `Float32Array`s. The whole library is synchronous as a result.

## 2. Hardening 1 — the adversarial-review batch (PR #8, labeled v0.1.1)

Merge `e36cbdc`, fix commit `5b8b5fe` (full finding list in its body).
73 tests at close. All FIXED and pinned (conformance scenario
`I2-consent-surfaces`).

| Finding | Symptom → fix | One-line verdict |
|---|---|---|
| exists_active oracle | `propose()` on a duplicate of a **never-surfaced** node revealed that node's existence → a covered duplicate now becomes a fresh proposal | FIXED — the consent gate obeys I2 exactly; never means invisible even to the gate |
| Conflict-hint leak | pending-queue conflict hints named never-surfaced nodes → hints filtered by the recall rule (`titleNamed` exported and reused verbatim) | FIXED — "a hint IS unprompted surfacing" |
| ask-node naming | corollary ruling: `exists_active` on an **ask** node stays revealable when literally named — a normalized-title match is naming | SETTLED — I2-consistent by definition |
| Corrupt index.db | unreadable `index.db` crashed open → treated like *missing*: drop, recreate, rebuild, audit `index.recover`. `memory.db` NEVER gets this treatment | FIXED — "the record is precious"; the index is disposable (I13) |
| Lenient dates | `Date.parse` on `reviewAt` was timezone-shifting human dates → strict ISO-8601 everywhere | FIXED — one shared strict-ISO rule ever since |
| NUL-term crash | a NUL byte in search terms crashed FTS → NUL terms dropped, not crashed | FIXED |
| Orphaned parked edits | a node leaving `active` stranded its parked edit envelopes → leaving active clears parked edits | FIXED |
| Guard set | `touch` active-only; `born_status` flip refused while nodes of the type exist; integer `importance` enforced on both write paths; day anchors excluded from ambient recall | FIXED |
| parseProps | malformed props cells bricked whole result sets → degrade to `{}` on every read path; doctor tolerates malformed audit meta | FIXED |
| Audit-leak sentinel | CODING.md promised a structural test that no verb leaks content into audit rows; it didn't exist → sentinel content driven through every verb, whole-log scan | FIXED — the test now exists and runs |

## 3. Hardening 2 — cold-review batch two, F1–F12 (PR #15, tag v0.2.3)

Merge `9d49871`, fix commit `0cd7adf`. 97 → 102 tests. All FIXED.

| # | Symptom → fix | Verdict |
|---|---|---|
| **F1** (critical, I9) | `decideIdentity` merge **transplanted `no_match` edges** from the duplicate onto the survivor — rewiring one *manufactured a permanent verdict between a pair the owner never ruled on* → a pre-rewire DELETE removes every `no_match` edge incident to the dup; identity assertions retire with the node that carried them | FIXED — pinned by `merge-adversarial-edges` scenario |
| F2 (I2/I3) | `neighborhood()` surfaced never-surfaced neighbors and day anchors → excluded (never means never — reachable only by `getNode`); ask neighbors stay, documented | FIXED |
| **F3** (I5) | the consent **decide path skipped `props_schema` validation** — the consent boundary could mint a schema-violating node. Verdict fields arrive as strings, so declared number/boolean props are coerced first; bad values refuse with `props_invalid` | FIXED — `consent-schema-enforcement` scenario |
| F4 | dup self-loops became keep-to-keep loops on merge → die in F1's DELETE | FIXED |
| F5 (I6) | forget cascade left `identity_pending` rows — questions about a tombstone → cleared in cascade | FIXED |
| **F6** (I13) | **rebuilt FTS alias text differed byte-wise** from the incrementally-maintained text (alias concatenation order) → rebuild is `ORDER BY alias`, matching the incremental path byte-for-byte | FIXED — I13 pins byte-exact `extra` |
| F7 | retitling a node onto one of its own aliases kept the now-shadowing alias → the rule `addAlias` enforces survives the back door | FIXED |
| F8 | doctor duplicate lens included never-surfaced nodes (unlike `suggestIdentities`) → excluded | FIXED |
| F9 | `decide()` on a node awaiting an identity question gave a generic error → now says so and points at `decideIdentity` | FIXED |
| **F10** (I11) | **ULID ordering was non-deterministic within a millisecond** — queue/order ties shuffled → monotonic ULIDs within the ms; queue ordering tie-breaks on id | FIXED |
| F11/F12 | doc reconciliations: SCHEMA I2 ask wording covers alias resolution; UTC day-anchor boundary documented | FIXED |

## 4. Hardening 3 — the perpetuity batch, A1–A5 + backup (PR #22, labeled v0.4.1)

Merge `12dd8a5`, fix commit `35d75e1`. 121 → 128 tests. "The deep review
found the one place the decades-bet could silently lose data."

**The backup arc (the headline):** raw-copying `memory.db` while open
**loses un-checkpointed WAL writes** (the `-wal` trap). `backup(toPath)`
is the one sanctioned backup — `VACUUM INTO` under the hood: a consistent
snapshot *including* WAL content, read-lock only, never blocks the writer,
compacted. Refuses an existing target (backups never overwrite); audited
content-free (no path in the meta). Restore = place the file as
`memory.db` in a fresh dir, open, `rebuildIndex` — round-tripped by test
including a fresh WAL write surviving into the copy. `index.db` is never
backed up (I13). Operational runbook: see **memory-cli-and-hosting**.
`doctor().integrityOk` (PRAGMA `integrity_check`) rode along — file health
distinct from every content lens.

| # | Symptom → fix | Verdict |
|---|---|---|
| **A1** (I6) | `forget` kept `when_at` — a tombstone with an appointment → cleared in cascade: "a scheduled moment is content, and **a tombstone keeps no appointment**" | FIXED — pinned in the I6 scenario |
| **A2** | `link` on an already-CLOSED `(source, target, type)` triple **silently returned the stale closed edge** with stale validity → throws a loud conflict naming the closed edge. Reopen/multi-window semantics remain a stated open question (see Deferral ledger) | FIXED — pinned in the Siemens scenario |
| **A3** | a `memory.db` from the FUTURE (schema_version above the build, or corrupt) opened anyway → refuses to open: "upgrade the library, never downgrade the file" (`src/storage/schema.ts`, `SCHEMA_VERSION = 4`) | FIXED |
| **A4** | a host re-`registerType`-ing **`day`** (the reserved episodic anchor) **bricked every `createNode`** → `day` is reserved from `registerType` | FIXED |
| **A5** | `dueCandidates` lacked the `type != 'day'` filter every other lens had | FIXED |

## 5. The ergonomics batch (PR #24, labeled v0.4.2)

Merge `99771dd`, commit `d454edd`. 128 → 136 tests. Rebuilt on post-#22
main — replaces the conflicted #23 branch (see Process failures).

- **The dayAnchor-walk trap (the batch's origin bug):** before
  `episode()`, reading "what happened in March" meant walking dates
  through `dayAnchor(date)` — which is **get-or-create** — so *reading a
  range CREATED empty day nodes as a side effect*. `episode(from, to)` is
  a PURE read over CREATED timestamps; the trap is closed **by
  construction** and pinned (`src/ergonomics.test.ts`: "no side-effect
  day creation (the dayAnchor-walk trap, closed)"). Verdict: FIXED — if
  you need a past window, use `episode()`, never a dayAnchor walk.
- **G7 owner fast path:** `updateNode` now works on consent-gated types —
  the host is the authenticator (I1): **the queue protects the owner from
  the AGENT, not from themselves.** Snooze = one call; agent changes still
  route through `proposeEdit`/`decide`; history still captures. SETTLED.
- **The in-doc retraction:** an earlier revision of PLANNING.md claimed
  verdict fields were a direct owner path — **retracted inside the doc
  itself** (`docs/PLANNING.md`, the `task` row: "verdicts require a
  pending item. Corrected."). Precedent: when a design doc was wrong, the
  correction is written into the doc, visibly, not silently rewritten.
- Also landed: `propsPatch` (RFC 7386-style shallow merge; `null` removes
  a key; passing both patch and whole-replace refuses), `children()`
  dashboard read. Semantics: **memory-domain-reference**.

## 6. Process failures (meta-level lessons)

| Incident | What happened | Lesson / current rule |
|---|---|---|
| Silent version-bump misses | v0.2.0 and v0.2.1 (and v0.1.1) were announced in commit messages but **never landed in `package.json`** — caught in PR #13: commit `d8118e5` corrects the manifest 0.1.0 → 0.2.2 ("the 0.2.0/0.2.1 bumps had silently never landed in the manifest") | A version label in a commit message is not a release. The release runbook (`docs/RELEASE.md`) is owned by **memory-change-control** |
| PR #23 stale fork | #23 branched before the #22 merge; its fork point predated main → **abandoned**, and the work was rebuilt from scratch on fresh post-#22 main as PR #24 | SETTLED POLICY: stale-fork conflicts are handled by REBUILDING the branch on fresh post-merge main — never by conflict resolution |
| Post-#26 direct-to-main drift | after merge `bdc0f7b` (PR #26), four commits landed directly on main: `c57348b` (the upload, see §10), `8c853c8`, `64c0542`, `9182b14` — and then the deep-audit chain (§11) also landed direct-to-main, but per-plan-reviewed with `plans/README.md` as the ratification record | Owner ratified 2026-07-07: the four were expedience, not policy. **PR-per-phase remains the rule** — branch from fresh main, check green, PR, "the merge is the ratification"; a reviewed plan chain is the sanctioned substitute |
| Ghost tags | at release time only `v0.2.3`, `v0.4.0`, `v0.4.3` were tagged; `v0.3.0`/`v0.3.1`/`v0.4.1`/`v0.4.2` were backfilled as annotated tags on 2026-07-07 and later pushed (all seven on origin, re-verified 2026-07-08); `[v0.1.1]` is still commit-message-only | Don't assume a tag exists (or is installable) because HISTORY.md names a version; check `git tag` AND `git ls-remote --tags origin` |

## 7. Rejected mechanisms — settled battles, do NOT reopen without new evidence

| Mechanism | Verdict + rationale | Evidence |
|---|---|---|
| cognee-style `improve()` (post-hoc self-correction verb) | **REJECTED as a verb** — auto-acting violates "reports, never acts". The sanctioned residue — a doctor *metric*, `reproposedAfterForget30d` — was DELIVERED at HEAD in `005da77` (content-free salted title footprints; the rejection of the verb stands) | FIELD.md steal ledger; `src/doctor.ts` |
| Fellegi–Sunter auto-merge zone | **REJECTED** — the classical three-zone threshold model loses its auto-merge zone entirely; everything above the floor goes to the owner queue. Models may annotate a card (in hosts); they never decide | ENTITIES.md research basis + principle 1 |
| Node-level validity windows | **REJECTED** — a node's lifecycle is the status FSM; a second time axis on nodes = two competing lifecycle vocabularies. **"One mechanism each"**: edges got validity windows, nodes got supersede chains + history | TEMPORAL.md "What stays out" |
| Scheduler / daemon / timers / notifications | **REJECTED, forever** — "the hard line": the library is a pure function of its data and the clock argument. The HOST is the thing that ticks | PLANNING.md hard line; DESIGN.md ("No server, daemon, scheduler, or network I/O of any kind") |
| `Embedder` interface | **REJECTED** — even the interface left the library in ADR-0001; "vectors in, never models". Hosts embed async outside | docs/adr/0001-bun-typescript.md |
| Edge history / edge versioning | **REJECTED** — closing + relinking already preserves every state; rows-about-rows adds a meta-level with no user question behind it | TEMPORAL.md "What stays out" |
| Retention policies / history caps | **REJECTED** — unbounded at personal scale; if a store measures a problem, the doctor *reports* first, the owner decides | TEMPORAL.md "What stays out" |
| Mention detection in prose; LLM-assisted matching; cross-type identity ("Ana" person vs project) | **OUT** — host/model concerns; the library's rules stay deterministic; types are identity domains by design | ENTITIES.md "What stays out" |
| Agent-tool wrappers, recap/summary generation, caching layers, sync/multi-device | **OUT OF SCOPE** — host glue / model work / re-earn with a benchmark / a future layer on top of the schema, never inside | HISTORY.md "Deliberately out of scope" |

## 8. The deferral ledger — parked, with reactivation triggers

| Item | Status + why | Reactivation trigger | Stated in |
|---|---|---|---|
| **unmerge** | DEFERRED — "No unmerge verb in v1, stated not implied." The husk preserves every byte (manual recovery always possible), but mechanical unmerge is ambiguous for edges created *after* the merge (whose are they?). Google Contacts uses a 30-day window; this repo chose honest deferral | "until real demand defines the semantics" — `merged` stays terminal | ENTITIES.md |
| **undo-from-history** | DEFERRED — history is read-only evidence in v1; mechanical undo shares unmerge's ambiguity (index, edges, derivations have moved on). The owner restores deliberately via `updateNode` with the snapshot open in front of them | "Revisit with demand" | TEMPORAL.md |
| **multi-interval edge validity** (a history of windows per triple) | Design spike DELIVERED and RATIFIED (plan 017, `plans/design/multiwindow-validity.md`, Design B = schema v5) — but the BUILD (plan 022) is DEFERRED. Interim behavior since A2 unchanged: `link` on a closed triple refuses loudly | plan 022's stated trigger: "the first host commit that routes around the CLOSED-triple refusal" | TEMPORAL.md; plans/README.md |
| **identity-queue doctor fields** | ~~DEFERRED~~ **DELIVERED** at HEAD (unreleased): `pendingByKind` landed in the `005da77` DoctorReport revision, exactly as the deferral predicted ("revisit with the next DoctorReport revision") | closed | ENTITIES.md; `src/contract.ts` |
| **MCP server / pi.dev extension / Agent Skills satellites** | DEFERRED — INTEGRATIONS.md is a preserved design sketch, status DEFERRED; "nothing here is built or tracked". Since `3ddb84b` the ONE supported surface is the in-process library (the CLI itself was dropped — §11; INTEGRATIONS.md now says every process-boundary surface incl. a CLI is deferred/out of scope) | "when satellite work is back on the roadmap". Note: the ACTIVE campaign (wiring memory into the web chat agent) goes through the consent gate in-process — see **balaur-memory-web-campaign**, not INTEGRATIONS.md | INTEGRATIONS.md, HISTORY.md |
| **Export** (jsonl/ics/vcard) + restore | Superseded the old "Export CLI" sketch: redesigned as LIBRARY verbs (plan 016 spike, ratified) — build plan 021 is TODO in the second wave | plan 021 executes (stacked after 019) | plans/design/export-restore.md; plans/README.md |
| **Read-only open** (`ReadStore.openReadOnly`) | Spike delivered and ratified (plan 015); BUILD (plan 020) DEFERRED | "the first real second-reader process — a dashboard/analytics host" | plans/design/readonly-open.md; plans/README.md |

## 9. External lessons encoded (why the invariants look like this)

| Outside event | Lesson taken | Where it landed |
|---|---|---|
| **Apple Photos** silent re-merge failure (the canonical anti-pattern) | "Answered means answered": a `different` verdict writes a permanent `no_match` edge; no candidate rule may resurrect the pair; merge across `no_match` refuses; closing a `no_match` edge is refused (would reopen I9 through the side door) | **I9** — pinned by `test/conformance/I9-apple-photos.scenario.json`; SCHEMA.md: "Answered means answered — the Apple Photos lesson" |
| **Graphiti issue #1492** — LLM temporal extraction hallucinating "today" on ~56% of historical backfills | dates are **arguments, never inferences**: validity and appointments are declared by the caller; the library never derives a date from content, context, or clock heuristics | **I15** (validity declared) + **I17** (scheduled time declared); TEMPORAL.md, PLANNING.md, FIELD.md steal ledger |
| **Kuzu shutdown** — a VC-funded embedded database that shut down and archived in 2025 | runtimes and vendors die; the project plans in decades → the schema is the durable contract, the runtime bet is contained in one file (`src/storage/bun.ts`), conformance is data-level | **ADR-0001's three guardrails** |
| **Letta `BlockHistory`** — actor-attributed content versioning with undo, kept forever | adopted *with a fix*: every surveyed system keeps snapshots forever, but here "**a history table that survives forgetting would make `forget` a lie**" — `forget` deletes `memory_history` rows in the same cascade transaction; content-free audit rows survive | **I16** — history dies with the tombstone; TEMPORAL.md Phase B |
| **txtai** — SQLite content store + disposable sidecar, proven for years | cited as precedent validating the two-file split (`memory.db` precious, `index.db` disposable) | the architecture itself; FIELD.md |

## 10. The upload strays — RESOLVED (was: DO-NOT-TOUCH)

- **Commit `c57348b` "Add files via upload"** (2026-07-06, GitHub web
  upload, direct to main): two unrelated files at repo root —
  `ANSI Braille System.dc.html` (3,589 lines) and `support.js` (1,581
  lines), apparently generated by an absent `dc-runtime` repo. Long held
  as OPEN/do-not-touch. **Status update (2026-07-08): REMOVED at HEAD in
  `79a0a6e` (the packaging-truth batch, plan 009)** — the commit calls
  them "unreferenced stray files from commit c57348b" and deletes them
  alongside adding `.gitattributes` export-ignore rules. Their original
  purpose was never explained; the removal was owner-sanctioned via the
  ratified plan chain, so the do-not-touch fence is lifted. NOTE: they
  still exist inside any `#v0.4.3` (or earlier) tag install — web's
  `node_modules/balaur-memory/` contains both (verified 2026-07-08).

## 11. The 2026-07 deep audit (plans 001–022) — the fifth hardening wave

The largest single batch since the repo began: a multi-agent audit at
`9182b14` produced ~45 vetted findings; the owner selected 17 plans
(11 fixes + the doctor revision + 5 design spikes), executed on advisor
worktree branches, reviewed per-plan, and landed as 14 linear
direct-to-main commits `61ddbd2..f1b168a` on 2026-07-08. The ledger of
record is `plans/README.md` (status table + considered-and-rejected
ledger); each commit body enumerates its findings. **All of it is
UNRELEASED at HEAD** — consumers on v0.4.3 have none of these fixes.

### The CLI removal — SETTLED (do not propose reviving it)

`3ddb84b` "feat!: drop the balaur CLI". Explicit owner decision, stated
2026-07-07 and quoted in the commit body: *"We can drop the CLI and we
won't handle any integrations except direct bun library."* Removed:
`cli/` (~1,200 lines), `docs/CLI.md`, the `bin` entry, the
`build`/`build:cross` standalone-binary scripts. Costs accepted BY NAME
in the commit: (1) the repo loses its only reference host; (2)
`cli/index.test.ts`'s full parse→Store→render coverage (18 of 155 tests)
is gone; (3) ADR-0001's `bun build --compile` deployment story has no
target (the ADR text stays as historical record). The CLI lives on in
≤v0.4.3 tag pins (web's install works — see **memory-cli-and-hosting**)
and in history (`git show v0.4.3:cli/index.ts`).

### The landed fixes — symptom → root cause → fix → where pinned

| Commit (plan) | Symptom → root cause → fix | Pinned by |
|---|---|---|
| `61ddbd2` (001) | CI workflow parked in docs/, unarmed → moved to `.github/workflows/ci.yml` + native `.githooks/pre-push` running `bun run check` | the workflow itself; AGENTS.md hook doc |
| `1219dcd` (003) | store files world-readable; `Store.open` docstring promised 0700 dirs it never created → create dir 0700, chmod db/WAL/SHM/backups 0600 on open and backup | unit tests in the batch |
| `91996a7` (004) | probe showed `forget()`'d content surviving in WAL, free pages, FTS segments — row-level honesty, not byte-level → `secure_delete=ON` both DBs, FTS5 secure-delete, `wal_checkpoint(TRUNCATE)` post-cascade; SCHEMA.md I6 now discloses the exact byte-level contract | raw-byte canary test (`src/hardening.test.ts`), negative-verified |
| `5cfc581` (005) | four write/verdict-boundary holes: merge-branch proposals skipped schema/importance validation; unknown `Decision.kind` fell through yet audited ok:true; `decideIdentity` accepted junk verdicts; `setSurfacing` died as raw CHECK error → validate + whitelist all four | `consent-merge-validation.scenario.json` (I4) + unit tests |
| `fda09e5` (006) | a crash between a migration's ALTER and its version-bump UPDATE stranded a half-migrated memory.db ("duplicate column name" forever) → each delta + bump in ONE transaction; committed v1/v2/v3 fixture DBs prove v1→v4 | `src/perpetuity.test.ts` incl. fault-injection (fails pre-fix, passes post-fix) |
| `190b6e0` (007) | 60 `never` rows + 1 `always` match → zero recall results: ineligible rows consumed the whole candidate cap before filtering → `surfacing` column in nodes_fts, SQL-side exclusion before the cap; vector stage same shape fixed; index self-heals 5-column files | `I2-recall-starvation.scenario.json` |
| `7c51c3f` (008) | corrupt registry JSON bricked writes/queue (raw SyntaxError); template re-merge resurrected propsPatch-removed keys; backup could target the live store dir / wedge on a partial file → `parseJsonObject` degrade-to-`{}`, birth-only template fill, backup guards | 8 tests (hardening + ergonomics suites) |
| `79a0a6e` (009) | tag installs shipped test/, plans/, AGENTS.md, and two stray upload files; RELEASE.md claimed `files` governs tags (it doesn't — git-archive does) → `.gitattributes` export-ignore, strays deleted (§10), RELEASE.md corrected + consumer-view verify step, HISTORY.md "(v0.2.0)" ghost-version row corrected | `git archive` inspection; RELEASE.md step 7 |
| `5b0a7bb` (010) | five doc/code drifts (I1–I14 counts, `currently "2"` schema comment, DESIGN.md module map missing entities/contract, MemoryError codes not in a shipped doc) → synced | grep re-checks (see Known-stale doc pointers) |
| `b76a971` (011) | `expectError` accepted ANY throw — a scenario could "pass" on the wrong failure → runner asserts `MemoryError.code` equals the declared value (all 25 then-scenarios needed zero reconciliations); shared `freshStore` fixture extracted to `test/helpers.ts` | the strict runner itself; docs/CONFORMANCE.md |
| `005da77` (014) | three documented IOUs against "the next DoctorReport revision" → paid in one breaking change: `pendingByKind`, `historyRows`, `reproposedAfterForget30d` (salted `titleFootprint`, content-free by construction) | `doctor-revision.scenario.json` (I7/I12) + 4 doctor.test.ts cases |

(`9182b14`, the net-worth HOSTING pattern + probe, predates the audit
chain but rode the same direct-to-main window.)

### The five design spikes — delivered, ratified, building

All five spike docs live under `plans/design/` ("design only — no
production code changed"), were **ratified 2026-07-08 with their
recommended options**, and spawned a second wave of build plans
(`plans/README.md`, owner-ratified sequencing: do 018 → 019 → 021; defer
020 and 022):

| Spike (plan) | Design doc | Build status (2026-07-08) |
|---|---|---|
| Task arc: deadlines, real task management (012) | `task-arc.md` | plan 018 **IN PROGRESS** (the locked `advisor/018-task-arc` worktree) |
| Long-form MD + tabular life data (013) | `life-documents.md` | plan 019 TODO (docs-only, HOSTING §12/§13) |
| Read-only open mode (015) | `readonly-open.md` | plan 020 **DEFERRED** — trigger: first real second-reader process |
| Export/portability + restore as library verbs (016) | `export-restore.md` | plan 021 TODO (stacked after 019) |
| Multi-window edge validity, Design B / schema v5 (017) | `multiwindow-validity.md` | plan 022 **DEFERRED** — trigger: first host commit routing around the closed-triple refusal |

## Known-stale doc pointers (archaeology-adjacent)

Ledger of record: **balaur-docs-and-writing** §3. The memory
README/AGENTS/SCHEMA drift rows ("I1–I14", "13 of 14",
`currently "2"`) were repaired in the repo (verified 2026-07-08 — only a
historical HISTORY.md milestone row still says "I1–I14", accurately).
Re-check: `grep -n 'I1–I14\|13 of 14' README.md AGENTS.md; grep -n
'currently "2"' docs/SCHEMA.md` (empty = repaired). Invariants run
I1–**I17**; 16/17 conformance-pinned (I14 by construction) — docs/SCHEMA.md
+ docs/CONFORMANCE.md are the source of truth.

## Provenance and maintenance

Facts below were verified on 2026-07-08 in `/home/alex/projects/balaur/memory`
(machine-specific path; the repo is github.com/balaur-software/memory).
Re-verify before relying on any of them.

| Drift-prone fact | Re-verification one-liner (run in `memory/`) |
|---|---|
| HEAD = `f1b168a`, 14 unreleased commits past v0.4.3 | `git log --oneline -2 && git describe --tags` |
| 169 tests pass, 0 fail | `bun test 2>&1 \| tail -4` |
| 26 conformance scenarios | `ls test/conformance/*.scenario.json \| wc -l` |
| Tag set (7 tags incl. the four 2026-07-07 backfills, all on origin; none past v0.4.3) | `git tag && git ls-remote --tags origin` |
| SCHEMA_VERSION = 4 | `grep -n 'SCHEMA_VERSION =' src/storage/schema.ts` |
| Fix-batch finding lists (F1–F12, A1–A5, …) | `git show 5b8b5fe 0cd7adf 35d75e1 d454edd --no-patch --format='%B'` |
| Deep-audit chain + plan ledger (§11) | `git log --format='%h %p %s' 64c0542..HEAD; sed -n '1,80p' plans/README.md` |
| README/AGENTS "I1–I14" drift repaired in `5b0a7bb`; ledger of record: balaur-docs-and-writing §3 | `grep -n 'I1–I14\|13 of 14' README.md AGENTS.md` (empty = repaired) |
| dc-runtime strays REMOVED at HEAD (still inside v0.4.3 installs) | `ls 'ANSI Braille System.dc.html' support.js 2>&1` (fails); `ls ../web/node_modules/balaur-memory/support.js` (exists) |
| CLI gone at HEAD, present at v0.4.3 | `ls cli 2>&1` (fails); `git show v0.4.3:cli/index.ts \| head -3` |
| Build-wave status (018 in progress; 020/022 deferred) | `sed -n '/Build plans/,/Dependency notes/p' plans/README.md; git worktree list` |
| Deferral wording unchanged | `grep -n -i 'unmerge\|revisit with demand\|deferred' docs/ENTITIES.md docs/TEMPORAL.md docs/INTEGRATIONS.md` |

## Related skills

- **memory-change-control** — the live rules this history produced.
- **memory-domain-reference** — what the invariants and verbs *mean*.
- **memory-validation-and-qa** — how findings get pinned (tests + conformance in the same PR).
- **memory-cli-and-hosting** — the backup/restore runbook that §4's backup arc feeds.
- **balaur-memory-web-campaign** — the active integration work (in-process, not the deferred satellites).
- **balaur-external-positioning** — the FIELD.md survey behind §9's lessons.
