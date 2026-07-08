# Design spike: long-form Markdown notes and tabular (CSV/spreadsheet) life data

Status: **design only — no production code changed.** This document is the
deliverable for plan 013. Probe evidence is measured against the reviewed,
post-fix worktree (`agent-ad93112a64c4916e7`); all `src/`/`docs/` line
references below are paths in that worktree. Probe scripts live in the
scratchpad (`/tmp/claude-1000/.../scratchpad/probes/`) and are not part of
the repository.

Owner requirement (verbatim, 2026-07-07): *"I want also this schema to be
able to hold in the future long-form-notes in md format and also csv or
spreadsheet data. I will want to have it to store information about my
life."* Also decided: the CLI is dropped; there are no integrations besides
the direct Bun library. Every recommendation below assumes a **host**
(library-only, no CLI verbs) drives capture and rendering.

---

## Part 1 — Probe results, with numbers

All probes ran against `Store` opened from the worktree's `src/store.ts`,
store dirs under the scratchpad, `bun 1.3.14`.

### Probe A — history amplification, extended to 50 edits

Setup: one `note` created with a 205.6 KB markdown body (a needle buried
mid-body), then edited repeatedly via `updateNode({ body })` — each edit is
the same body plus one appended line, so the pre-edit snapshot is
essentially the full 205.6 KB every time.

| edits | `memory_history` rows | `memory.db`+WAL | × single-body size |
|---:|---:|---:|---:|
| 0 (create only) | 0 | 458.7 KB | 2.2× |
| 1 | 1 | 1,102.4 KB | 5.4× |
| 5 | 5 | 2,047.9 KB | 10.0× |
| 10 | 10 | 3,222.8 KB | 15.7× |
| 20 | 20 | 6,895.9 KB | 33.5× |
| 30 | 30 | 10,740.7 KB | 52.3× |
| 50 | 50 | 14,464.8 KB | 70.4× |

Create itself: 5.13 ms. Deep-needle FTS hit after create: 0.87 ms. This
confirms and extends the prior baseline (10 edits ≈ 14×, here 15.7× — the
gap is WAL checkpoint noise, not a behavior change) — growth stays
**linear in edit count** because `memory_history` stores a **full,
undiffed** content snapshot per edit (`src/storage/schema.ts:136-147`,
`title`/`body`/`props` all `TEXT NOT NULL`), not a delta. 50 edits of one
206 KB document costs ~14 MB — for one node. This is architectural, not a
bug: `snapshotHistory` (`src/spine.ts:548-569`) copies `node.title`,
`node.body`, `node.props` verbatim into a new row on every owner-authority
mutation (`src/spine.ts:455` inside `updateNode`).

### Probe B — does bm25 length normalization bury a long doc?

Three nodes, same rare single-occurrence term ("xylophone"): a 206 KB doc
with the term buried mid-body, a 404 KB doc with the term at the very top,
and a 43-byte short note that is *only* the term's sentence.

```
recall(['xylophone']) rank order:
  1. Short note
  2. Long doc (term buried mid-body)
  3. Long doc (term at top)
```

Recall is **not broken** — all three are returned, correctly, well inside
the default limit of 8 (`RecallOptions.limit`, `src/contract.ts:26`). But
ranking is real: the 43-byte note that says nothing but the search term
outranks a 206 KB document containing the identical term, **even when the
term sits at the top of the long document** (top-of-body placement did not
recover rank — it stayed 3rd of 3). This matches the documented ranking
formula (`docs/DESIGN.md:57-68`, `score = bm25 × recency × importanceBoost
× reinforcement`) — bm25's length normalization penalizes long fields by
design; nothing here is a defect, but the failure mode a host will see in
practice is "the 40-page journal entry I wrote about the Lisbon trip loses
to a two-word note that happens to share a term."

### Probe C — FTS index size share for long bodies

200 short `memory`-shaped nodes (`[category] fact ...`, ~65 bytes body
each) → `index.db` = 77,824 bytes (389 bytes/node). Adding **one** 205.6 KB
note on top → `index.db` jumps to 319,488 bytes: **+236.0 KB from a single
node**, which is **75.6% of the whole index** for 1 of 201 nodes (0.5% of
node count). `nodes_fts` indexes `content` (= `node.body`) with no
truncation (`CREATE VIRTUAL TABLE nodes_fts ... content, ...` —
`src/storage/schema.ts:96-98`; `upsertFts` passes `content: node.body`
whole — `src/spine.ts:284`, `src/spine.ts:485`). Index disposability (I13)
still holds — `index.db` rebuilds from `memory.db` — but a handful of
long documents can dominate the sidecar's size and rebuild cost.

### Probe D — 2,000-row CSV import via the only bulk path that exists (a `createNode` loop)

Registered `expense` type (`propsSchema: { amount_minor: number,
currency: string, category: string }`), imported 2,000 rows, one
`createNode` call per row, `when: "2026-06-01"` (the transaction's
declared moment), all created within the same UTC clock day
(`2026-07-07`, since `on_day` anchors at **creation** time, not `when`).

- **Time**: 574 ms total, 0.287 ms/row. Not a performance emergency at
  this row count.
- **Size**: `memory.db`+WAL grew 6,102.6 KB for 2,000 rows (~3,125
  bytes/row — mostly *not* body, since these rows have empty bodies: each
  row also mints an `on_day` edge (`src/spine.ts:291`) and at least two
  audit rows (`node.create` + `edge.create`, `src/spine.ts:262`,
  `src/spine.ts:654`), each with index maintenance overhead
  (`idx_nodes_type_status`, `idx_edges_target`, `idx_audit_at`). `index.db`
  grew only 232.0 KB (short titles, empty bodies — cheap to index).
- **The real cost is on the read side, confirmed empirically**:
  `episode('2026-07-07','2026-07-08')` with the **default** limit
  (`DEFAULT_AGENDA_LIMIT = 100`, `src/recall.ts:289`) returned exactly
  **100 nodes — all rows from the import**, none of anything else.
  Immediately after the import, a same-day `journal` entry was created (the
  2,002nd node of the day); it **does not appear** in that default-limit
  `episode()` call at all — buried behind 2,000 import rows in
  `created ASC` order (`src/recall.ts:319`). A **typed** call,
  `episode(..., { type: 'expense', limit: 10000 })`, correctly returns all
  2,000 rows in 4.57 ms — the mitigation is real and available today, it
  just isn't the default. The day node for `2026-07-07` now anchors 2,002
  `on_day` edges.

This is the "gaps" note from the plan brief, now measured: a 2,000-row
import doesn't hurt performance, but it silently drowns the owner's own
same-day capture in any **untyped** `episode()`/day view unless the host
knows to always type its queries after a bulk import.

### Probe E — do arrays/objects already round-trip as *undeclared* props?

Yes. `propsSchema` only ever declares `{ type: "string"|"number"|"boolean";
required?: boolean }` per key (`src/types.ts:79-81`), and
`applyTemplateAndValidate` only type-checks keys that are **declared**
(`src/spine.ts:196-205`) — undeclared keys pass straight through
(`src/spine.ts:177` doc comment: "Undeclared keys pass through — an empty
schema allows any props"). A probe `createNode` with an undeclared
`tags: string[]`, an undeclared nested `meta: {...}` object, and an
undeclared ISO-string date all **round-tripped exactly** through
`getNode().props`. Separately, `registerType` does not validate the shape
of the `propsSchema` object it's given at the type level
(`src/spine.ts:150-163` just `JSON.stringify`s it) — declaring a
non-existent type literal like `"array"` is accepted at *registration*
time (TypeScript would reject it at the call site under the real
`NodeTypeSpec` type, but nothing at runtime stops a dynamically-built
schema from saying it) — but it would be **self-defeating** at validation
time: `typeof v !== def.type` (`src/spine.ts:203`) can never equal
`"array"` for any JS value (`typeof [1,2,3] === "object"`, never
`"array"`), so a `required: true, type: "array"` field would reject every
value, including actual arrays. Bottom line: array/object props already
work fine **unchecked**; there is no way to *declare* (and therefore
validate `required`/shape on) one today.

None of these probes broke recall or contradicted the plan's prior
baseline — Probe A extended it (confirmed linear amplification), Probe B
found real-but-non-catastrophic ranking cost (not "recall broken"), so no
STOP condition was triggered.

---

## Part 2 — HOSTING.md §12 draft: long-form Markdown documents

```markdown
## 12 · Long-form documents (journals, essays, life notes)

A document is a node like any other: `title` is the short, greppable
label (recommend: the doc's own H1 text, extracted by the host at
capture time — the library never infers content from content, I17's
spirit, but a host reading its own input and pulling a heading is the
host's own choice, same as rrule-parsing in §4); `body` is the *raw
markdown, in full* — round-tripping the whole document back out losslessly
matters more than deduplicating the title line. `props.format: "markdown"`
is a convention flag (unenforced — `body` is opaque TEXT regardless) that
tells a host renderer which way to interpret the bytes.

```ts
store.registerType({ name: "document", bornStatus: "active" });

const note = store.createNode({
  type: "document",
  title: "Lisbon trip — what I'd do differently",   // the doc's own H1
  body: fullMarkdownText,                             // includes the H1
  props: { format: "markdown" },
  surfacing: "ask",            // journals are ask/never material (§7, §11)
  origin: `journal:${sessionId}`,
});
```

**Surfacing default: `ask`.** Long-form personal writing is exactly the
holdings-pattern case (§11) — content the owner wants *findable by name or
term*, not ambient. `always` remains available per-node for documents a
host wants proactively surfaced (a running project brief); `never` if even
a named search must stay silent (then `children`/`recall` skip it too —
retrieve by id only).

**Editing vs. revising — reuse the §8 split.** A typo fix or a paragraph
tightened is a wording change: `updateNode({ body })` in place, and
`history()` replays it — appropriate for occasional small edits (Probe A:
a handful of edits on a personal note costs kilobytes, not megabytes).
A substantial rewrite (new draft of a whole essay, a journal entry
rewritten after further thought) is closer to "the fact itself changed"
(§8): **create a new node**, link it to the old one with a host edge
(e.g. `revises`), and `transition(old.id, "archived")`. This keeps
`memory_history`'s per-edit full-copy cost (Probe A) bounded to the
*wording-tweak* case it was designed for, while the *rewrite* case pays
for exactly one new body, not an accumulating snapshot chain. See the
history-policy matrix (Part 3) for why this recipe, not a library change,
is the v1 recommendation.

**Recall shape for very long documents (optional).** Plain full-body FTS
still finds a long document by any distinctive phrase (Probe B: recall
wasn't broken, only out-ranked by shorter co-matches) — fine for personal
notes nobody else's content competes with in a given query. For documents
the owner actually wants findable *by sub-topic* (a long reference doc, a
multi-section life plan), bless the same shape §6 already uses for
projects: **one node per `##` section**, `part_of` → the document node,
`props.seq` for order.

```ts
const doc = store.createNode({ type: "document", title: "Estate planning notes", ... });
for (const section of splitByH2(fullMarkdownText)) {
  const s = store.createNode({
    type: "document_section", title: section.heading, body: section.body,
    props: { seq: section.index }, surfacing: "ask", origin: doc.origin,
  });
  store.link(s.id, doc.id, "part_of");
}
```

This is opt-in per document, not a blanket recommendation — most personal
notes are short enough that full-body indexing is exactly right, and
splitting adds bookkeeping (`children(doc.id, "part_of")` + client sort)
a host should only pay for when the size or "find that one section"
complaint actually shows up.
```

---

## Part 3 — HOSTING.md §13 draft: tabular life data (CSV/spreadsheet)

```markdown
## 13 · Tables (CSV / spreadsheet-shaped life data)

Generalizes §11's holdings pattern beyond money: **one type per sheet, one
node per row, props = columns** (typed via `propsSchema` where the columns
are genuinely `string`/`number`/`boolean` — the common case), and every row
`part_of` → one collection node representing the imported table/sheet.
Corrections are append-only, exactly like holdings: never mutate a
historical row's figures in place — add a new row (or a `supersedes`-style
host convention if a row needs replacing) so "what did the June statement
say" stays answerable.

```ts
store.registerType({ name: "table",        bornStatus: "active" });
store.registerType({
  name: "expense", bornStatus: "active",
  propsSchema: { amount_minor: { type: "number", required: true },
                 currency:     { type: "string",  required: true },
                 category:     { type: "string",  required: true } },
});

const sheet = store.createNode({
  type: "table", title: "Bank export — June 2026",
  props: { source: "bank-csv-2026-06.csv", rowCount: rows.length },
  origin: "import:bank-csv-2026-06.csv",
});

for (const row of rows) {
  const r = store.createNode({
    type: "expense", title: row.description,
    props: { amount_minor: row.amountMinor, currency: "EUR", category: row.category },
    when: row.date,                       // the transaction's own moment
    origin: "import:bank-csv-2026-06.csv",
  });
  store.link(r.id, sheet.id, "part_of");
}
```

**Where it breaks:**

- **Wide sheets** (dozens of columns): `propsSchema` scales fine (it's
  free-form JSON, no column-count cost — SCHEMA.md's `props_schema` is
  `TEXT NOT NULL DEFAULT '{}'`, `src/storage/schema.ts:27`/
  `docs/SCHEMA.md:38`) but a `props_invalid` schema error only names one
  bad key at a time (`src/spine.ts:204`) — a wide, dirty CSV import means
  many one-at-a-time failures. Host recipe: validate/normalize each row
  BEFORE calling `createNode` (a plain JS check against your own column
  list), not after.
- **>10k rows**: `createNode` per row keeps working (Probe D measured
  0.287 ms/row — linear, ~3 s at 10k rows), but the **`episode()`
  pollution is the real ceiling**, not create latency (see Probe D and
  the bulk-import discussion in Part 5). Always call `episode()`/`agenda()`
  **typed** (`{ type: 'expense' }`) after a large import — an untyped call
  on the import day will be dominated by the import for as long as the
  default limit (100) fits inside the row count.
- **Retrieval at scale**: `children(sheet.id, "part_of")` has no query-side
  cap — it returns everything currently active/valid (`src/spine.ts:339-368`).
  For >10k rows, aggregate over the read-only file with hand-written SQL
  instead (§3's rule — analytics never goes through the writer), the same
  move §11's net-worth query already makes.
```

---

## Part 4 — History policy: the real decision

Root cause (Probe A): `memory_history` stores a **full, undiffed** snapshot
of `title`/`body`/`props` on every owner-authority mutation
(`src/storage/schema.ts:136-147`; `src/spine.ts:548-569`). This is by
design (I16, `docs/SCHEMA.md:291-297`: "History dies with the tombstone" —
content-bearing, scrubbed on forget) and it is NOT a bug — but for a
document type it means storage cost is `O(edits × body size)`, unbounded,
where for short structured nodes (a `task`, a `checkin`) it's negligible.

| Option | Mechanism | Cost | Composes with I16? | Composes with TEMPORAL.md's retention deferral? |
|---|---|---|---|---|
| **(i) Status quo + doctor `historyRows` + owner recipe** | No library change. Plan 014 adds a `historyRows` metric to `doctor()`. Document the "wording edit vs. new-node revision" recipe (Part 2, §12). | Zero engineering cost now. Owner sees the number and decides case-by-case (per plan 014). | Unchanged — I16's "exactly three owner-authority moments" (`updateNode`, `approve_edited`, parked-edit application) still holds for every type, no exceptions to reason about. | **Exact match.** `docs/TEMPORAL.md:248-250`: *"Retention policies / history caps — unbounded at personal scale; if a store measures a problem, the doctor reports it first (a future `historyRows` metric), and the owner decides. Reports, never acts."* This is that plan, already scoped, already deferred here on purpose. |
| **(ii) Per-type snapshot opt-out** (`history: "none" \| "full"` at `registerType`) | New `node_types` column → **DDL change, `SCHEMA_VERSION` bump, migration** (unlike propsSchema richness, this is not free — `props_schema`/`template` are free-form JSON columns already; a `history_mode` column is not). `snapshotHistory` becomes conditional per type. | Real engineering cost (schema migration, conformance scenario, an `I16` amendment). | **Needs rewording.** I16 currently states three moments *unconditionally* for every type. An opted-out type would need I16 to read "...for every type not registered `history: 'none'`" — a live loophole to reason about at every future audit of I16, and the amendment would have to say what `forget()`'s cascade DELETE does for a type with no history rows to begin with (answer: no-op, but it's now a case to state, not a case that falls out for free). | **Tension, not a match.** The library *enacting* a per-type retention rule via registration is the library taking an action on the owner's behalf where TEMPORAL.md's stated posture is "reports, never acts." A host could of course choose NOT to register `document` with the consent-gated shape and instead just follow the edit-vs-revise recipe (Part 2) — which gets the same outcome with zero library change. |
| **(iii) Size-threshold snapshots** (skip/truncate the body in `memory_history` above N bytes) | Snapshot writer inspects body length and silently changes what it captures. | Cheapest to build, but... | **Breaks it.** I16's promise is that `history()` replays "what the node used to say" — a silent size cutoff means some snapshots in the *same node's own history list* have a real prior body and others (post-threshold edits) don't, with no signal in the `HistorySnapshot` shape (`src/spine.ts:532-542`) that a truncation happened. That is exactly the "silent hole in 'what did this used to say'" the plan brief warned against. | Also a library-enacted policy, same tension as (ii), with a worse property: it's *invisible* at the type-registration level, unlike (ii) which is at least declared. |

**Recommendation: (i).** It costs nothing today, it is the literal
scenario `docs/TEMPORAL.md:248-250` already named and deferred to plan
014's `historyRows` metric, and it composes cleanly with the §12 recipe
(new node for a rewrite, in-place edit for a wording fix) that a host can
adopt with zero library changes. (ii) is not rejected outright — if
`historyRows` in practice shows one document type dominating a store's
`memory_history` table, a scoped per-type opt-out becomes a much better-
informed, measured decision instead of a speculative one. (iii) is
recommended against on I16-honesty grounds, per the plan brief's own
steer.

---

## Part 5 — propsSchema richness and bulk-import ergonomics

### propsSchema: leave the type union as-is (string | number | boolean)

Probe E showed arrays/objects/date-strings already round-trip fine as
**undeclared** props — the gap is only that you cannot declare
`required: true` or get a type-check on a `tags: string[]` or a nested
object, and ISO dates already work as plain `type: "string"` (no format
check, same as everywhere else non-`when`/`valid_*` in the schema — dates
outside of `when_at`/`valid_from`/`valid_until` have never had library-
level format validation).

If richer validation is wanted later, it is genuinely cheap: `props_schema`
is stored as free-form JSON (`docs/SCHEMA.md:38`, `src/storage/schema.ts:27`)
so extending the type union is **not a database migration** — it's a
`NodeTypeSpec.propsSchema` type-union edit (`src/types.ts:79-81`), a few
more branches in `applyTemplateAndValidate` (`src/spine.ts:196-205`,
e.g. `Array.isArray(v)` for `"array"`, `typeof v === "object" &&
!Array.isArray(v)` for `"object"`), and a `docs/SCHEMA.md` contract-text
update plus a conformance scenario update
(`test/conformance/consent-schema-enforcement.scenario.json` is the
existing test of this exact code path).

**Recommendation:** don't build it now. The owner's stated need (long-form
notes + tabular data) is fully served by the string/number/boolean +
convention approach — money already proved the pattern (minor-units
integers, ISO strings, §11). Revisit only if a real type hits friction
(e.g., "I want `tags: string[]` to be `required` and type-checked"),
consistent with the library's standing minimalism posture (`docs/CODING.md`
"zero runtime dependencies"; `docs/DESIGN.md` non-goals: "No opaque state:
both files open in any SQLite tool," `docs/DESIGN.md:141`).

### Bulk import: a documented host recipe for v1, not a new library verb — with one honest caveat

The candidate library verb (`importNodes(rows, opts)`) would need to change
the fan-out that causes Probe D's read-side pollution: skip per-row
`linkOnDay` (`src/spine.ts:291`) and instead link the *batch* node to the
day, so `episode()` of an import day shows one collection node, not 2,000
rows. That's a real, scoped, `spine.ts` choke-point change — not "planning-
specific machinery" in the sense `docs/PLANNING.md:129` uses the term (no
new state, no new inference), but it IS new **import**-specific machinery,
and the library has consistently pushed exactly this shape of concern to
hosts elsewhere (recurrence/materialization in §4, streak math in §2,
netWorth aggregation in §11). It would still satisfy I12 (audit coverage)
the same way `approve_superseding` does — "compound decisions: one per
step plus one summary" (`docs/SCHEMA.md:271-275`) — one `node.create` audit
row per row plus one `import.batch` summary row, all content-free per I7.

Weighed against that: unlike planning (which had `when_at`/`agenda` as
existing primitives to redirect through), a CSV import has **no existing
primitive that avoids the pollution** — `linkOnDay` fires unconditionally
inside `insertNode` for every non-`day` type (`src/spine.ts:291`), so a
purely documentation-level host recipe genuinely cannot prevent the
`on_day` flood; only a library change can.

The mitigation that **is** available today, with zero library change,
fully closes the practical harm Probe D found: **always call
`episode()`/`agenda()` typed** (`{ type: 'expense' }`) once a table has
been imported. Probe D confirmed this works cleanly (2,000/2,000 rows
back in 4.57 ms). The harm is specifically in **untyped** cross-type reads
("what happened that whole day", mixing a CSV import with a journal
entry) — a narrower, less common query shape than "show me my June
expenses."

**Recommendation:** ship v1 with the documented recipe (row-per-node +
one `table` collection node + always-typed post-import reads, per Part 3's
draft §13) and no new verb. Flag the untyped-`episode()`-after-bulk-import
gap explicitly to the owner as a known, accepted rough edge (Decision 6
below) rather than silently declaring it solved — the recipe closes the
*practical* harm (the owner's own same-day journal entry is retrievable
via a typed `episode(..., {type:'journal'})` call) but does not make
`episode()`'s **default**, untyped behavior on a bulk-import day
non-surprising. If that surprise proves costly in practice, the scoped
`spine.ts` verb above is the fix, and it composes with I12/I7 cleanly when
that day comes.

### Blob reality check: actual spreadsheet files (.xlsx) stay out

Confirmed, not contradicted by anything read: `docs/DESIGN.md`'s non-goals
state "No opaque state: both files open in any SQLite tool" (`docs/DESIGN.md:141`)
— an `.xlsx` binary blob in a column would violate that outright (nobody
can `SELECT` their way to meaning inside a zipped-XML blob), and nothing in
`docs/SCHEMA.md` ("Deliberate schema choices", `docs/SCHEMA.md:339-346`)
or the DDL offers a BLOB column for node content (`nodes.body` is `TEXT`,
`src/storage/schema.ts:36`). The pattern that already exists is exactly
right for this: the store holds the **declared, row-shaped data** (Part 3);
`origin` (a plain host-defined string, `src/types.ts:39`) points at the
source file the way Probe D's import used `origin:
"import:bank-csv-2026-06.csv"`; and `derived_from` (`artifact → source`,
`docs/SCHEMA.md:188`, written via `recordDerivation`) is available if a
host wants to record that a set of row-nodes was derived from a
re-parseable file and should be flagged stale if that file changes. No
schema or library change is needed to ratify this — it's already how the
primitives compose.

---

## Decisions for the owner

1. **§12 pattern (long-form documents)**: `title` = the document's own H1
   text (host-extracted at capture), `body` = full raw markdown,
   `props.format: "markdown"` (unenforced convention), `surfacing: "ask"`
   by default (journals/personal writing, matching §11's precedent).
   **Recommend: adopt as drafted in Part 2.** Confirm.
2. **History policy for edited long-form docs**: status quo (full
   per-edit snapshot) + wait for plan 014's `historyRows` doctor metric +
   adopt the "wording edit → `updateNode`, substantial rewrite → new node
   + `revises` edge + archive old" recipe. **Recommend option (i)** from
   the Part 4 matrix; (ii) a per-type history opt-out is not rejected but
   should wait for `historyRows` evidence; (iii) size-threshold snapshots
   is recommended against (silently breaks I16's "what did this used to
   say" promise). Confirm.
3. **Recall shape for very long documents**: bless the optional
   section-node convention (one node per `##`, `part_of` the doc,
   mirroring §6's project/step shape) for documents the owner wants
   findable by sub-topic; NOT a default for everyday notes.
   **Recommend: adopt as an opt-in pattern, not a mandate.** Confirm.
4. **§13 pattern (tabular data)**: one type per sheet, one node per row,
   `propsSchema`-typed columns, rows `part_of` a `table` collection node,
   corrections append-only (never mutate a historical row).
   **Recommend: adopt as drafted in Part 3.** Confirm.
5. **propsSchema richness**: do NOT extend the `type` union
   (`string`/`number`/`boolean` stays it) for v1 — undeclared
   arrays/objects/ISO-date-strings already round-trip fine (Probe E);
   convention (minor-units, ISO strings) already covers the owner's
   stated needs. **Recommend: no change**, revisit only on demonstrated
   friction (cheap later: no DB migration, just a validation-code +
   SCHEMA.md contract change). Confirm.
6. **Bulk-import ergonomics**: no new library verb for v1. Document the
   row-per-node + collection-node recipe (Part 3), and **explicitly accept**
   the known gap that an untyped `episode()`/`agenda()` call on an
   import day will be dominated by the import (Probe D: a same-day journal
   entry was invisible in the default-limit call) — the mitigation
   (always query typed post-import) is real and available today, but the
   untyped-default surprise remains. **Recommend: accept the gap for v1**,
   revisit as a scoped `spine.ts` choke-point change (skip per-row
   `on_day`, anchor the batch node instead) only if it proves costly in
   practice. Confirm.
7. **Spreadsheet files (.xlsx) as blobs**: out of scope, by the library's
   existing "no opaque state" doctrine (`docs/DESIGN.md:141`) — the store
   holds declared row data, `origin` references the source file,
   `derived_from` covers re-derivable lineage if wanted.
   **Recommend: ratify as a boundary**, not a gap. Confirm.
