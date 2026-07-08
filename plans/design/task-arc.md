# Design spike: deadlines and real task management on the planning arc

> **Type**: design spike (plan 012). No production code changed by this
> document — it is a proposal + evidence for the owner to ratify. All
> `file:line` references are to the **approved worktree**
> (`.claude/worktrees/agent-ad93112a64c4916e7`), the post-fix tree, not the
> main repo tree. The CLI has been removed (plan 002); nothing below
> proposes a CLI verb — every recommendation is a library API delta and/or
> a `HOSTING.md` host-pattern recipe.

## 0. The ask and the doctrine it triggers

The owner stated (2026-07-07, verbatim): *"for tasks I want to be able to
put deadlines and have proper task management."*

`docs/PLANNING.md` shipped exactly one time axis, `when_at`, and named it
deliberately **not** `due_at`: "Column named `when_at` (not `when` — an SQL
keyword; not `due_at` — events happen, they aren't due)."
(`docs/PLANNING.md:72-73`). It also pre-committed the doctrine that governs
this exact situation, stated about priority but declared to generalize
("the same doctrine applies", plan 012's own framing): *"a second axis
needs a demonstrated failure of the first"* (`docs/PLANNING.md:174-175`).

Section 1 below is that demonstration, produced against a probe store
using the worktree's own `Store` class. It is real evidence, not
assertion: a task with a do-date and a due-date genuinely cannot be
represented without a false-positive overdue flag, an invisible do-date,
or a raw-SQL escape hatch — confirmed by running the code.

## 1. Probe evidence — what breaks with one axis today

**Probe script**: `/tmp/claude-1000/-home-alex-projects-balaur-memory/abfef91e-d2fb-43a8-8e26-754fd479d3d3/scratchpad/task-arc-probe/probe.ts`
(plus a follow-up `lineage_probe.ts` and `check_created_updated.ts` in the
same directory — see §1.6/§1.3). All probes import
`Store` directly from the worktree's `src/store.ts` and run against a
scratch store dir under the scratchpad; nothing outside the scratchpad or
this doc was written. Full transcripts are reproduced inline below because
they are the evidence this design rests on.

### 1.1 One column, two dates: "do Saturday, due the 15th"

Scenario: the owner plans to *work on* a Q3 report on Saturday July 11,
2026, but it is *due* Wednesday July 15. Two nodes were created representing
the two ways a host is forced to choose today:

```
doctor().dueCandidates on July 12 (do-date passed, due-date NOT):
  Q3-report(do-date-in-when) IS flagged overdue | Q3-report(due-date-in-when) not flagged
```

- **If `when` holds the do-date** (props.due holds the real deadline):
  `doctor().dueCandidates` — which fires on `when_at <= now`
  (`src/doctor.ts:120-127`) — flags the report **overdue on July 12**, three
  days before it is actually due. This is a false-positive urgency signal
  the owner never asked for; `dueCandidates`' own contract text says
  "reports, never acts" and "the host decides what overdue means"
  (`src/doctor.ts:116-119`, `docs/PLANNING.md:89-92`) — but the host has no
  way to make that judgment correctly, because the only signal it's given
  (`when_at`) does not carry deadline semantics.
- **If `when` holds the due-date** (props.doDate holds the plan): the task
  is **invisible on the week the owner intended to work on it**:
  ```
  agenda(week of July 6-13) titles: [ "Q3 report (do-date in when)" ]
  ```
  (`src/recall.ts:334-358`, filters strictly on `when_at`). Only the node
  that *kept* its do-date in `when` shows up; the due-date node — the one
  representing what a host would naturally build if told "track deadlines"
  — does not appear on the planning board for its own do-week at all.

- **"What's due this week" is answerable via `agenda()` only for the node
  that sacrificed its do-date.** For the node that kept the do-date in
  `when`, the real deadline lives in `props.due` and is invisible to both
  `agenda()` and `doctor().dueCandidates`:
  ```
  agenda() cannot see reportDoDate's props.due=2026-07-15 in a due-window query: CONFIRMED — 0 results (invisible)
  ```
  Recovering it requires raw SQL over `json_extract(props,'$.due')` — the
  exact "every host reinvents the same column" failure mode `PLANNING.md`
  names for undated props in general (`docs/PLANNING.md:32-34`).

**This is the demonstrated failure `PLANNING.md:174-175`'s doctrine asks
for.** One axis forces a choice between an honest agenda and an honest
overdue lens; it cannot deliver both for the same node.

### 1.2 Blocked chain: unblocking needs an `EdgeId` nobody kept

```
link() returned edge id at creation time: 01kxane700qzn0ja1tth46d7ey (a real host may not persist this)
Store prototype methods matching /edge/i (excluding link/closeEdge): [ "closeEdge" ]
FINDING: CONFIRMED — no public method returns Edge objects/ids for a node.
neighborhood(implement.id) returns Node[] only (no edge id): [ "Design the API" ]
```

`closeEdge(id, until?)` (`src/contract.ts:97`, `src/spine.ts:668-680`) is
the only verb that can "unblock" a task by closing its `blocked_by` edge,
and it requires an `EdgeId` that **only `link()`'s own return value ever
supplies** (`src/spine.ts:610-658`). `neighborhood()` returns `Node[]`, not
edges (`src/spine.ts:385-399`, `src/contract.ts:100`); `children()` is the
same shape (`src/spine.ts:339-368`, `src/contract.ts:84`). A host that
persisted a task and its `blocked_by` link, then (realistically) did not
also persist the `EdgeId` returned at `link()`-time in its own local state,
has no way to look that id back up through the public contract. The only
workaround is a raw read-only connection to the `edges` table — the same
"open your own read-only connection" escape hatch `docs/HOSTING.md` uses
deliberately for analytics (§3, `docs/HOSTING.md:109-127`; §11,
`docs/HOSTING.md:258-352`) — except here every host must reimplement the
same "find my `blocked_by` edge" query by hand, because there is no
supported read for it. This matches the recorded finding in plan 012's own
"Current state" section and is confirmed, not merely asserted.

### 1.3 Completion queries: `episode()`'s time axis is creation, not completion

```
completion: TWO calls (propsPatch outcome + transition archived) — OK, matches HOSTING.md §5.
episode(week window, type:task) over the window 'File the tax form' was BOTH created and completed in — returns: []
FINDING: episode()'s WHERE clause hardcodes status='active' AND surfacing='always'
(src/recall.ts episode(), the query at 'AND status = ... AND surfacing = ...').
```

`episode(from, to, opts)`'s SQL is `WHERE created >= ? AND created < ? AND
status = 'active' AND surfacing = 'always'` (`src/recall.ts:316-318`). A
task created **and** completed inside the same week still returns empty,
because `transition(id, "archived")` (the second of the two documented
completion calls, `docs/HOSTING.md:161-162`) moves it out of
`status='active'` before the read runs. A follow-up raw-SQL check against
the probe store confirms the sharper case — a task **created before** the
query window but **completed inside** it:

```
$ bun check_created_updated.ts
[
  { title: "Design the API", status: "archived",
    created: "2026-07-12T08:00:00.000Z", updated: "2026-07-20T10:00:00.000Z",
    outcome: "done" },
  { title: "File the tax form", status: "archived",
    created: "2026-07-20T10:00:00.000Z", updated: "2026-07-20T10:00:00.000Z",
    outcome: "done" }
]
```

"Design the API" was created July 12 (one day before a July 13–27 query
window) and completed July 20 (inside it). **No `statuses` option on
`episode()` could recover this row** — the window filter is on `created`,
not `updated`, and `episode()`'s own doc comment confirms this is
intentional design, not a bug: "the episodic-past window... by CREATED in
[from, to)" (`src/recall.ts:292-298`). "What did I finish this week" is a
*completion-time* question; `episode()` answers a *creation-time* question.
Widening `episode()`'s status filter (mirroring `children()`'s `statuses`
option, `src/spine.ts:339-368`, default `["active"]` at line 347) answers
"of what was created this week, what status is it in now" — a real and
useful query, but not the one the owner is likely to actually want when
they ask "what did I finish this week." See §3.3 for the recommendation.

### 1.4 Recurrence materialization — the documented pattern works (control case)

```
recurrence materialization pattern: OK — host mints the next instance, links instance_of.
```

`docs/HOSTING.md` §4's pattern (`docs/HOSTING.md:129-149`) — a rule node
with `props.rrule`, a host-materialized instance node with `when` set, and
a host-chosen edge type (`instance_of` in the doc's own example, line 142)
— worked exactly as documented. This is **not** a gap; it is confirmed
correct and is the baseline §3.4 builds on.

### 1.5 Snooze and ordering — both confirmed sufficient

```
snooze: ONE updateNode call, history captures the pre-change when (I16) — OK.
children(project, part_of) + client-side props.seq sort: [
  { title: "Pick tiles", seq: 1, importance: 0 },
  { title: "Order cabinets", seq: 2, importance: 4 }
]
FINDING: importance(0-5) + props.seq (client-sorted) sufficiently orders a project's steps — no gap found here.
```

Snooze (`updateNode(id, { when })`, one call, `docs/HOSTING.md:160`) and
project-step ordering (`importance` + `props.seq`, client-sorted after
`children()`, `docs/HOSTING.md:178-179`) both worked exactly as
documented against the probe store. No gap found in either.

### 1.6 Bonus finding: `derived_from` is not what it looks like for host recurrence lineage

Not asked for by Step 1, but surfaced while probing §3.4's recurrence
question (`lineage_probe.ts` in the same scratch dir):

```
store.link(..., 'derived_from') SUCCEEDED — created edges row: { id: ..., type: "derived_from", ... }
staleDerivations() before recordDerivation: []
staleDerivations() after editing the rule node (link-only lineage, NOT recordDerivation-tracked): []
staleDerivations() right after recordDerivation (nothing changed yet): []
staleDerivations() after forget(rule) — recordDerivation-tracked source went away: [ "01kweb2a00j6k09behtqxgvmw3" ]
```

`SYSTEM_EDGE_TYPES` (`src/types.ts:72`) lists `derived_from` as a
library-written system edge type, and `docs/SCHEMA.md`'s system-edge table
describes it as "written by: library (recordDerivation)"
(`docs/SCHEMA.md:188`). But `recordDerivation()` writes to a **separate**
`derivations` table (`src/lineage.ts:15-30`, `docs/SCHEMA.md:90-96`), never
to `edges`. Nothing in `insertEdge()` (`src/spine.ts:610-658`) refuses a
host calling `store.link(a, b, "derived_from")` outright — the
`SYSTEM_EDGE_TYPES` check there only blocks a *validity window* on system
types (`src/spine.ts:626-627`), not the type string itself as an argument
to `link()`. A host that used `link(instance, rule, "derived_from")`
thinking it was registering lineage would get a normal, silent `edges` row
that **never** appears in `staleDerivations()` and is **never** flagged by
the `forget()` cascade the way `docs/SCHEMA.md`'s I6 promises for tracked
derivations (`docs/SCHEMA.md:235-252`, "marks `derivations` rows with it as
`source` stale"). This is a real trap for exactly the recurrence-lineage
question §3.4 asks about — the fix is a documentation-only recommendation,
folded into §3.4's answer below (no code changes proposed).

## 2. Deadline designs — costed

### Option A — schema v5 `due_at` column (first-class, typed)

Mirrors `when_at`'s v4 shape (`docs/SCHEMA.md:59-70`,
`src/storage/schema.ts:150-159` `V4_DDL`) exactly.

| Delta | Cost |
|---|---|
| `src/storage/schema.ts` | new `V5_DDL`: `ALTER TABLE nodes ADD COLUMN due_at TEXT; ALTER TABLE memory_history ADD COLUMN due_at TEXT; CREATE INDEX idx_nodes_due ON nodes(due_at) WHERE due_at IS NOT NULL;` appended inside `migrateMemoryDb`'s existing `db.transaction(() => {...})` wrap (the shape plan 006 landed, confirmed live at `src/storage/schema.ts:193-207`); bump `SCHEMA_VERSION` (`src/storage/schema.ts:11`) to 5. Mechanically safe — deltas are already transactional per-version (plan 006, landed). |
| `docs/SCHEMA.md` | new nodes column doc, a "Version 5" section, a new **I18** invariant mirroring I17 verbatim (`docs/SCHEMA.md:297-305`) |
| `src/types.ts` | `Node.due: string \| null` (mirrors `when`, `src/types.ts:46-49`) |
| `src/spine.ts` | `CreateInput.due?` (mirrors `when` field, `src/spine.ts:211-222`); `insertNode` due-at parse+insert (mirrors line 237, 244-260); `updateNode` patch.due (mirrors lines 403-407, 444-446, 456-463); `snapshotHistory`/`HistorySnapshot` gain `due` (mirrors lines 532-542, 548-569) |
| `src/consent.ts` | `Proposal.due?`; **`applyFields`'s verdict-field whitelist needs a new `else if (key === "due")` branch** (mirrors the existing `when` branch at `src/consent.ts:377-380`) — a *second* string-literal case to keep in sync by hand. This whitelist is exactly the mechanism the post-fix tree hardened (decide/decideIdentity/setSurfacing inputs are now explicitly whitelisted) — a missed branch here is a silent no-op field, the same regression class already fixed once. |
| `src/doctor.ts` | **naming decision required** — see below |
| `src/contract.ts` / `src/store.ts` | thread `due` through `createNode`/`updateNode`/`propose`/`decide` signatures; `DoctorReport` gains a field |
| `test/conformance/` + `test/fixtures/` | new/extended scenario pinning I18; a `v4.db` legacy fixture (plan 006's generator is "the canonical way to add a new legacy fixture when v5 ships" per its own maintenance note) + an upgrade test in `src/perpetuity.test.ts` |
| `docs/HOSTING.md` §5 | task-loop sample gains a `due` param + the new doctor field |
| `docs/PLANNING.md` | phase table amendment (`docs/PLANNING.md:187-195`); the naming-rationale line (`docs/PLANNING.md:72-73`) needs a caveat clarifying `due_at` is a *new, distinct* column, not a renaming of the `when_at` decision it explains |

**The naming collision Option A creates, unprompted:** `doctor.ts`'s
`dueCandidates` field **already exists** and is `when_at`-based
(`src/doctor.ts:120-127`), and the owner already ratified its shape under
that meaning — Q5 in `docs/PLANNING.md:213-215`: *"`dueCandidates` shape —
cap 20, oldest-due first, no age cutoff. Confirm."* A real `due_at` column
makes "due" ambiguous inside the same file. Silently repurposing
`dueCandidates` to mean `due_at` would re-litigate an already-ratified
answer without asking — the exact thing plan 012's STOP condition warns
against. **Recommendation if A ships: leave `dueCandidates` bound to
`when_at` untouched, and add a distinctly-named `overdueCandidates` lens
reading `due_at <= now`** (the plan's own suggested name, plan
012 step 2). This avoids re-opening Q5 but does mean the doctor report ends
up with two "lateness" lenses whose names must be learned individually — a
real, if small, cost of A specifically.

**Total touch**: ~9 files, 1 new invariant, 1 new schema version + fixture,
1 new conformance scenario. **Risk: MED** — mechanically safe (the v4
shape is proven and migrations are transactional post-plan-006), but wide
surface and carries a naming decision that needs explicit owner sign-off.

### Option B — blessed `props.due` convention (+ two small library reads)

Zero schema change. Plan 012 step 2 specifies: "the doctor gains a lens
that reads `json_extract(props,'$.due')`... agenda stays `when_at`-only."
The probe in §1.1 shows that a **doctor lens alone is not sufficient** to
match what `when_at` already offers: `dueCandidates` only ever answers
"already passed *now*" (`src/doctor.ts:120-127`); the forward-window
question ("what's due **this week**", not yet passed) is exactly what
`agenda()` answers for `when_at` (`src/recall.ts:334-358`) and nothing
in Option B's minimal form answers for `props.due`. Matching the full
capability of the `when_at` axis therefore costs **two** small reads, not
one:

| Delta | Cost |
|---|---|
| `src/doctor.ts` | new `deadlineCandidates` lens (~10 lines, mirrors `dueCandidates` at `src/doctor.ts:120-127` exactly — same `CANDIDATE_CAP` = 20 [`src/doctor.ts:20`], oldest-first, `never`-excluded — but sourced from `json_extract(props,'$.due')`) |
| `src/recall.ts` | new `deadlines(from, to, opts)` read (~15 lines, mirrors `agenda()` at `src/recall.ts:334-358` exactly, same half-open window / I2 `always`-only rule, sourced from `json_extract(props,'$.due')` instead of `when_at`) |
| `src/contract.ts` / `src/store.ts` | two new method declarations + delegations |
| `docs/HOSTING.md` §5 | convention documented: `props: { due: "..." }`, `doctor().deadlineCandidates`, `store.deadlines(from, to)` |
| `docs/PLANNING.md` | a "Hosting conventions" addendum (not a schema section — no invariant, no migration), explicitly flagging the weaker guarantee below |
| `test/conformance/` | one new scenario — the two reads are library code, so `docs/CONFORMANCE.md`'s own rule applies ("a behavior change without its scenario change... is wrong by definition") |

**The honest cost of B: weaker typing.** `applyTemplateAndValidate`
(`src/spine.ts:183-207`) only checks a declared prop's *primitive* type
(`string`/`number`/`boolean`), never calls `parseStrictIso` on it — that
function is reserved for the columns the library special-cases
(`when`/verdict `when`/edge validity, `src/types.ts:105-114`). A malformed
`props.due` (e.g. `"next Tuesday"`) is **not refused at write time** the
way a malformed `when` is (`insertNode`'s `parseStrictIso(input.when,
"when")`, `src/spine.ts:237`) — it silently fails to appear in
`deadlineCandidates`/`deadlines()` instead. This is the same tradeoff
already accepted for `props.rrule` and `props.seq` (host grammar,
unchecked) — consistent with precedent, not sloppy, but it is a real,
statable difference from Option A's I18 guarantee and must be named to the
owner as such.

**Total touch**: ~4-5 files, zero schema/migration, zero new invariant (a
props convention, like `rrule`/`seq` already are), fully backward
compatible. **Risk: LOW.**

### Option C — per-type semantics (`when_at` MEANS "due" for `task`)

Zero schema/API change; purely a `HOSTING.md` convention where, for
`type="task"` only, `when` is always written as the deadline (never the
do-date), inverting B's convention while keeping the `when_at` column name.

**Argued against.** Three independent reasons:

1. It overloads `when_at`'s single declared meaning — "the appointment
   with the future" (`docs/PLANNING.md:31`, "everything durable is a
   node... the one thing they lack: a relationship with future time") —
   with type-dependent semantics. `agenda()` has no per-type awareness
   (`src/recall.ts:334-358` filters only on `type` as an equality, never
   changes the *meaning* it applies); a single `agenda(from, to)` call
   spanning tasks and events would silently mix "when this is due" and
   "when this happens" in one ordered list with no way to tell which is
   which without inspecting `type` on every row.
2. It does not even solve the original problem — a task under Option C
   *still* needs a second field for the do-date (now in props), so it
   fails the exact same "one axis, two dates" test in §1.1, just with the
   privileged column swapped.
3. It contradicts the doc's own stated principle for `when_at`'s naming:
   the deliberate choice *against* `due_at` for events was "events happen,
   they aren't due" (`docs/PLANNING.md:72-73`) — Option C reintroduces
   exactly the semantic PLANNING.md rejected, just scoped to one type
   instead of applied globally, which makes the inconsistency worse (two
   types, two meanings, one column) rather than better.

**Recommendation: reject Option C.**

## 3. "Proper task management" gap inventory

Ordered per plan 012 step 3.

### 3.1 Deadlines

Decided by §2. **Recommend Option B (extended: `deadlineCandidates` +
`deadlines()`)** as the primary package (§4); Option A stays available as
an owner-selectable alternative given the typing/guarantee tradeoff stated
above — see Decision 1.

### 3.2 Unblocking — `edgesOf(id)`

§1.2 confirms the gap precisely: no public read returns `Edge` objects or
ids for a node. Recommend a new read, id-gated like `history()`
(`src/spine.ts:575-604`, "Id-gated like getNode — I2's strongest naming"):

```ts
edgesOf(id: NodeId, opts?: { type?: string; asOf?: string }): Edge[];
```

**Shape**: both directions (`source = id OR target = id`), mirroring
`neighborhood()`'s bidirectional join (`src/spine.ts:385-399`) but
returning `Edge` rows (`EDGE_COLS`, `src/spine.ts:507`) instead of `Node`
rows. Currently-valid by default (`valid_from`/`valid_until` window check,
mirrors `src/spine.ts:394-395`), `asOf` time-travels (same precedent as
`neighborhood`/`children`).

**I2/I3 stance**: exclude edges whose *other* endpoint node is
`surfacing='never'` — this is exactly `neighborhood()`'s existing rule
(`n.surfacing != 'never'`, `src/spine.ts:393`, justified as "never means
never, reachable only by `getNode`; review-2 F2"). Returning an edge whose
other end is a `never` node would leak that node's *id* (its existence) to
a caller who does not otherwise have it — the same discovery-prevention
`neighborhood` already protects. Include edges to `ask`-surfaced
endpoints (traversal from a *named*, already-known `id` is not ambient
matching, the same reasoning `neighborhood()`'s doc comment gives:
"traversal is an owner-facing read of a named subject, not ambient
matching," `src/spine.ts:381-384`). Do **not** exclude system edge types
(`on_day`, `derived_from`, etc.) by default — unlike `children()`'s `day`
*node* exclusion (plumbing hidden from a dashboard, `src/spine.ts:361`),
`edgesOf`'s purpose is precisely to let a host recover an edge id it lost,
and `closeEdge` already refuses system types on its own
(`src/spine.ts:671-672`) — filtering them out of `edgesOf` too would just
be a second place to keep that rule in sync for no safety benefit.

**Cost**: one new `spine.ts` function (~15 lines, direct precedent from
`neighborhood`), one `contract.ts` declaration, one `store.ts` delegation,
one new conformance op (`edgesOf`) + scenario. No schema change, no
migration. **This is independently valuable and ships alone if the task
arc stalls** (plan 012's own maintenance note agrees).

### 3.3 Completion queries — a `statuses` option on `episode()`?

§1.3's evidence answers the plan's own question precisely: **partially,
and the gap is subtler than "add an option."** A `statuses` option on
`episode()` (mirroring `children()`'s, default `["active"]` to stay
backward compatible) answers *"of what was created in this window, what
status is it in now"* — a real, useful query (e.g., "how many of this
week's captures are still open"). But it does **not** answer "what did I
finish this week" for anything created before the window, because
`episode()`'s window is explicitly, deliberately keyed on `created`
(`src/recall.ts:292-298`'s own doc comment: "by CREATED in [from, to)" —
this is `episode`'s one clean time axis, the same discipline `agenda()`
applies to `when_at` and `episode` itself applies in contrast to it).
Redefining `episode()` to filter on `updated` when `statuses` is widened
would silently mix two different time semantics in one function — exactly
the kind of "second axis creeping into an existing read" the project's own
minimalism argues against.

**Recommendation**: ship the `statuses` option on `episode()` (cheap,
consistent with `children()`, answers a real subset of the question) *and*
document a `HOSTING.md` raw-SQL recipe for "completed in `[from, to)`
regardless of creation date" — `WHERE status='archived' AND updated
BETWEEN ? AND ? AND json_extract(props,'$.outcome') IS NOT NULL`, the same
"open your own read-only connection" pattern §3 of `HOSTING.md` already
uses (`docs/HOSTING.md:109-127`). This keeps `episode()`'s semantics
single-axis and honest rather than growing a third meaning into it, and
matches Step 3's own instruction to prefer a host pattern where the library
change would blur an existing contract.

### 3.4 Recurrence — where does the materializer live, and what lineage convention

§1.4 confirms the documented pattern (`docs/HOSTING.md:129-149`) already
works with no library changes needed. With the CLI gone, there is no
process for a host to invoke on a schedule except its own script — so the
recommendation is a **documented ~30-line `tick.ts` recipe** (see §3.5,
which subsumes this) that a host crons directly, composing the existing
materialization pattern with the rest of the daily loop. No new library
surface.

**Lineage convention**: §1.6's finding settles the plan's open question.
`link(instance, ruleHolder, "derived_from")` looks like the "obviously
right" convention but is a trap — it writes a plain `edges` row that never
participates in `staleDerivations()` or the `forget()` cascade's stale-flag
sweep (`docs/SCHEMA.md:235-252`). **Recommend
`store.recordDerivation(instance.id, [ruleHolder.id])` instead** — the
mechanism that is actually wired to `staleDerivations()`
(`src/lineage.ts:32-40`) and to `forget()`'s cascade (per I6). This is a
documentation-only recommendation (a `HOSTING.md` §4 correction/addendum),
not a library change — `recordDerivation` already exists and does exactly
this.

### 3.5 The daily tick without a CLI

`docs/HOSTING.md`'s closing section (`docs/HOSTING.md:354-362`) already
states the five-call sequence in prose but has no code sample (unlike every
other numbered section). With no CLI to hide the wiring behind, recommend
making it concrete as a `HOSTING.md` recipe:

```ts
// tick.ts — a host script the owner crons once a day. Five calls, in order
// (docs/HOSTING.md's own closing paragraph, now made runnable).
import { Store } from "balaur-memory";

const store = Store.open({ dir: process.env.MEMORY_DIR! });
const todayUtc = new Date().toISOString().slice(0, 10);
const plus1d = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

// 1. materialize due recurrence instances (host pattern, docs/HOSTING.md §4)
for (const rule of dueRecurrences(store)) materializeNext(store, rule);

// 2. the board
const board = store.agenda(`${todayUtc}T00:00:00.000Z`, `${plus1d}T00:00:00.000Z`);

// 3. health + deadlines (whichever deadline option the owner ratifies — §4)
const report = store.doctor();
console.log({ board: board.length, overdue: report.dueCandidates.length, pending: report.pendingCount });

// 4. render the consent queue if non-empty
if (store.pendingQueue().length > 0) renderQueue(store.pendingQueue());

// 5. backup (docs/HOSTING.md §10)
store.backup(`${process.env.BACKUP_DIR}/memory-${todayUtc}.db`);

store.close();
```

This is a doc-only recommendation (no library change) — `agenda`,
`doctor`, `pendingQueue`, `backup` already exist exactly as used above.

### 3.6 Ordering/priority

§1.5 confirms `importance` (0–5) + `props.seq` (client-sorted) is
sufficient — no gap, no change recommended. This satisfies
`docs/PLANNING.md:174-175`'s own bar in the other direction: no
demonstrated failure of the first axis here, so no second one is
warranted.

## 4. Recommended package

**B (extended: `deadlineCandidates` + `deadlines()`) + `edgesOf(id)` +
`episode()` `statuses` option + two `HOSTING.md` recipes (tick.ts,
recurrence lineage correction).**

This is the "host-pattern first, library-change only where the pattern
demonstrably can't deliver" package the plan's own Step 3 preamble asks
for: every item above that a pure host convention *can* deliver (recurrence
materialization, the daily tick, ordering) stays a `HOSTING.md` recipe with
**zero** library change; every item a pure convention demonstrably
*cannot* deliver (§1.1's forward-window deadline query, §1.2's edge-id
recovery, §1.3's `statuses`-widened creation-time board) gets the smallest
library surface that closes the gap, each one mirroring an existing,
proven pattern (`agenda`/`dueCandidates`'s own shape, `children`'s
`statuses`, `neighborhood`'s bidirectional join) rather than inventing a
new one.

**Combined cost of the recommendation**:
- **Schema/migration**: none. No `SCHEMA_VERSION` bump, no new invariant,
  no migration fixture.
- **New library surface**: `doctor().deadlineCandidates`, `store.deadlines(from, to, opts)`, `store.edgesOf(id, opts)`, `episode()`'s `statuses` option. Four small, precedented additions.
- **Conformance**: three new scenarios (deadlines/deadlineCandidates,
  edgesOf, episode statuses) or extensions to existing ones
  (`planning-tuesday.scenario.json`, `project-dashboard.scenario.json`);
  `docs/CONFORMANCE.md`'s coverage map and op vocabulary
  (`docs/CONFORMANCE.md:37-41`) both need the new ops listed.
- **Docs**: `docs/PLANNING.md` gains a "Hosting conventions" addendum for
  `props.due` (not a schema section); `docs/HOSTING.md` §4 gets the
  `recordDerivation` correction, §5 gets the deadline/edgesOf examples, and
  a new closing-section code sample (§3.5's `tick.ts`).
- **Risk**: LOW across the board — every delta is a pure read or a
  documentation change; nothing touches the three write paths, the verdict
  whitelist, history capture, or the migration runner.

If the owner instead wants Option A's typed, invariant-backed guarantee
(accepting its MED risk and ~9-file touch), the follow-up build plan MUST
land after — and follow the shape of — plan 006's transactional migration
work (already true in the main tree), per plan 012's own maintenance note.

## 5. Decisions for the owner

Mirroring `docs/PLANNING.md`'s "Open questions for the owner" style
(`docs/PLANNING.md:197-215`) — numbered, each with a recommendation to
confirm or override.

1. **Deadline design: A (typed `due_at` column + I18) or B-extended
   (`props.due` convention + `deadlineCandidates` + `deadlines()`)?**
   Recommend **B-extended** — it closes every gap §1.1 demonstrated with
   zero schema/migration risk, at the honest cost of weaker write-time
   typing (a malformed `props.due` silently fails to surface rather than
   being refused, unlike `when_at`). If reliability/typing matters more to
   the owner than surface area, choose **A** instead — it is fully
   specified in §2 with its full cost, including the `dueCandidates`
   naming-collision resolution (a new `overdueCandidates` field, leaving
   the existing `dueCandidates` — and the owner's already-ratified Q5 shape
   for it, `docs/PLANNING.md:213-215` — untouched). **Confirm B-extended,
   or select A.**
2. **`edgesOf(id)` — ship it regardless of the deadline decision?**
   Recommend **yes** — it is a recorded, independently-valuable gap
   (§1.2, confirmed empirically) with no schema cost, and plan 012's own
   maintenance note already flags it as shippable alone. **Confirm.**
3. **`episode()` `statuses` option — ship it, with the `HOSTING.md`
   raw-SQL recipe for the completion-time case documented alongside it
   (rather than trying to make `episode()` itself answer "completed in
   this window")?** Recommend **yes to both** — widening `episode()`'s time
   axis to `updated` would blur its one clean semantic (§3.3); the
   `statuses` option plus a documented recipe covers the real question
   without that cost. **Confirm.**
4. **Recurrence lineage: bless `recordDerivation()` over
   `link(..., "derived_from")` in `HOSTING.md` §4, and correct the existing
   `instance_of` example to also call `recordDerivation`?** Recommend
   **yes** — §1.6 shows `link(..., "derived_from")` is a live trap that
   silently doesn't do what its name implies. This is a docs-only fix.
   **Confirm.**
5. **The daily tick: publish `tick.ts` (§3.5) as a `HOSTING.md` code
   sample, matching every other numbered section's pattern, now that no
   CLI exists to demonstrate the wiring implicitly?** Recommend **yes**.
   **Confirm.**
6. **Ordering/priority: no change — `importance` + `props.seq` stands,
   per `docs/PLANNING.md:174-175`'s own "no second axis without
   demonstrated failure" rule, since §1.5 found no failure?** Recommend
   **confirm as-is, no action**.

## 6. Appendix — process notes

- **No STOP condition was triggered.** §1's probes did not reveal
  `agenda`/`dueCandidates` behavior contradicting their documentation —
  both behave exactly as `docs/PLANNING.md` and the code comments describe;
  the *gaps* found are gaps of scope (one axis cannot serve two purposes),
  not bugs. The one place this spike surfaces genuine tension with an
  already-ratified answer is the `dueCandidates` naming collision under
  Option A (§2, §5 Decision 1) — presented explicitly rather than resolved
  silently, per the STOP-condition instruction's spirit, but it did not
  rise to a full spike-halting conflict because the recommended package (B)
  does not touch `dueCandidates` at all.
- **Scope discipline**: this document and the probe scripts under
  `/tmp/claude-1000/-home-alex-projects-balaur-memory/abfef91e-d2fb-43a8-8e26-754fd479d3d3/scratchpad/task-arc-probe/`
  are the only artifacts written by this spike. No file under `src/`,
  `test/`, `docs/`, or `plans/*.md` (including `plans/README.md`) was
  modified — the executor's governing instructions for this run restrict
  writes to this file and the scratchpad specifically, which is a tighter
  constraint than plan 012's own text (which asks for a `plans/README.md`
  status-row update); that update is left for the owner/dispatcher to make.
- **Repo drift check**: `git diff --stat 9182b14..HEAD -- docs/PLANNING.md
  docs/HOSTING.md src/doctor.ts src/recall.ts src/contract.ts` (main tree
  HEAD vs. this worktree) shows real drift in `docs/HOSTING.md`,
  `src/contract.ts`, and `src/recall.ts` — confirming this spike correctly
  read the **post-fix** worktree rather than the main tree, as instructed.
