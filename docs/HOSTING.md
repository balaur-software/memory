# HOSTING.md — building a life on this library

The host-integration guide: the patterns a personal-life host needs, each
one validated by live probes during the v0.4.x ergonomics audit. Nothing
here is enforced by the library — these are the conventions that make the
API read like a life instead of a database session. Code samples are real
against v0.4.2.

**The division of labor, restated once:** the library is a pure function
of its data and the clock argument — no scheduler, no daemon, no
notifications, no models. The HOST is the thing that ticks (a cron, a
live agent, an app in the foreground), authenticates the owner, converts
time zones, renders the queue, and calls models. Everything below follows
from that split.

## The type registry for a life

```ts
store.registerType({ name: "journal",  bornStatus: "active" });
store.registerType({ name: "person",   bornStatus: "active" });
store.registerType({ name: "project",  bornStatus: "active" });
store.registerType({ name: "event",    bornStatus: "active" });
store.registerType({ name: "habit",    bornStatus: "active" });
store.registerType({ name: "checkin",  bornStatus: "active" });
store.registerType({
  name: "measurement", bornStatus: "active",
  propsSchema: { metric: { type: "string", required: true },
                 value:  { type: "number", required: true } },
});
store.registerType({ name: "task",     bornStatus: "proposed" }); // agents propose; you decide
store.registerType({ name: "memory",   bornStatus: "proposed" }); // agent-inferred facts, gated
store.registerType({ name: "preference", bornStatus: "proposed" });
```

`proposed`-born types are the consent surface: agents can only `propose()`
into them. Owner writes are always direct — `createNode` births active
and `updateNode` edits in place on ANY type (the host is the
authenticator; the queue protects the owner from the agent, not from
themselves).

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

## 1 · The journal

An entry is a node; the day anchor is automatic (`on_day` at creation).

```ts
// capture
const entry = store.createNode({
  type: "journal", title: "Tuesday evening", body: text,
  props: { mood: 4 }, origin: `journal:${sessionId}`,
});
for (const p of people) store.link(entry.id, p.id, "mentions");

// "what happened in March" — the lived-past window (created-time, half-open)
const march = store.episode("2026-03-01", "2026-04-01", { type: "journal" });

// "everything on day X" — the day is the traversal SUBJECT, so this works
const day = store.dayAnchor("2026-03-03");           // get-or-create is fine here: you're about to use it
const thatDay = store.neighborhood(day.id);           // every node filed that UTC day
```

Rules of thumb: `episode` for ranges (a pure read — walking an empty month
creates nothing), `neighborhood(dayAnchor(d))` for a single day you are
actually rendering, `recall` for "that time we talked about the lake
house". Never loop `dayAnchor` over a range just to read — that is what
`episode` is for.

## 2 · Habits and streaks

A habit is a node; each completion is a `checkin` node with `when` = the
moment it happened, linked `check_of` → habit. Existence IS completion —
no `done` prop needed.

```ts
const habit = store.createNode({ type: "habit", title: "Meditate", origin: "setup" });
// on completion:
const c = store.createNode({ type: "checkin", title: "Meditated", when: isoNow, origin: "app:habit" });
store.link(c.id, habit.id, "check_of");

// history: all check-ins, oldest first (created order)
const checkins = store.children(habit.id, "check_of", { statuses: ["active"] });
```

**Streak math is host date-arithmetic** — the library hands you the
ordered `when` values; you count the run:

```ts
const days = [...new Set(checkins.map((c) => c.when?.slice(0, 10)))].sort().reverse();
let streak = 0;
for (let d = today; days[streak] === d; d = prevDay(d)) streak++;
// completion rate = days.length / daysSince(habit.created)
```

## 3 · Measurements and stats

One `measurement` node per reading: `props.metric` + `props.value`
(schema-validated numbers — a string sneaks in nowhere), `when` = the
reading's moment. Aggregation is host SQL over the read-only file — at
the library's 100k-node design ceiling a full scan is milliseconds:

```sql
SELECT MIN(CAST(json_extract(props,'$.value') AS REAL)) AS lo,
       MAX(CAST(json_extract(props,'$.value') AS REAL)) AS hi,
       AVG(CAST(json_extract(props,'$.value') AS REAL)) AS avg
FROM nodes
WHERE type = 'measurement' AND status = 'active'
  AND json_extract(props,'$.metric') = 'weight'
  AND when_at >= ? AND when_at < ?;
```

Open your own read-only connection for this (WAL permits concurrent
readers, I14) — analytics never goes through the Store's writer.

## 4 · Recurrence and birthdays (the materialization pattern)

The library never creates nodes unbidden, so **recurrence = a rule in
props + host-materialized instances**:

```ts
// the rule lives on the definition node
const ruleNode = store.createNode({ type: "task", title: "Water the plants",
  props: { rrule: "FREQ=WEEKLY;BYDAY=MO" }, origin: "setup" });

// on completion (or on the daily tick), the HOST mints the next instance:
const next = store.createNode({ type: "task", title: "Water the plants",
  when: nextOccurrence(rule, now), origin: "recur:water-the-plants" });
store.link(next.id, ruleNode.id, "instance_of");        // host vocabulary: findable via children()/edgesOf()
store.recordDerivation(next.id, [ruleNode.id]);          // REAL lineage: wired to staleDerivations() + forget()
```

**Lineage correction:** do **not** use `link(instance, ruleHolder,
"derived_from")` for this — `derived_from` LOOKS like the obviously-right
edge type (it is even listed as a library-written system edge type in
SCHEMA.md), but `link()` only ever writes a plain `edges` row. Real
lineage tracking — `staleDerivations()` and the `forget()` cascade's
stale-flag sweep (I6) — reads a **separate** `derivations` table that only
`recordDerivation()` writes. A host that used `link(..., "derived_from")`
thinking it registered lineage gets a normal edge that silently never
participates in either. Use `instance_of` (or your own host edge type) for
the *findable* relationship — `children()`/`edgesOf()` traverse it — and
`recordDerivation()` alongside it for the *tracked* one. They are not
substitutes for each other.

Birthdays are the annual case of the same move: the source of truth is
`props.birthday` on the person; each year the host materializes one
`event` node (`when` = this year's date, linked `celebrates` → person).
The rule grammar (`rrule` here) is yours — the library stores what you
declare (I17) and never parses it.

## 5 · The task loop (with the fast path)

```ts
// agent proposes — waits in the queue until you decide
store.propose({ type: "task", title: "Book flights", when: "2026-07-08", origin: "turn:214" });
store.decide(id, { kind: "approve" });                    // or approve_edited / reject

// owner acts — direct, no queue theater:
store.createNode({ type: "task", title: "Call Ana", when: "2026-07-07T10:00:00.000Z", origin: "quick-add" });
store.updateNode(id, { when: "2026-07-10T09:00:00.000Z" });          // snooze: ONE call
store.updateNode(id, { propsPatch: { outcome: "done" } });           // done: TWO calls —
store.transition(id, "archived");                                     //   an archived memory with an outcome
store.updateNode(id, { propsPatch: { outcome: "dropped" } });        // dropped: same shape
// waiting on someone / blocked:
store.link(task.id, ana.id, "waiting_on");
store.link(task.id, other.id, "blocked_by");

// the board:
const week    = store.agenda(todayUtc, plus7dUtc, { type: "task" }); // scheduled, always-surfaced
const overdue = store.doctor().dueCandidates;                        // slipped past now — ids, oldest first
```

`propsPatch` merges (a `null` value removes a key); `props` replaces
wholesale — reach for `props` only when you mean it.

### Deadlines — the `props.due` convention

`when` is one moment: a do-date or an appointment, not a deadline
(PLANNING.md: "events happen, they aren't due"). A task that needs BOTH —
"do Saturday, due the 15th" — carries the do-date in `when` and the
deadline in `props.due` (a blessed convention, not a schema column): two
parallel, independent axes on the same node.

```ts
store.createNode({ type: "task", title: "Q3 report",
  when: "2026-07-11T00:00:00.000Z",                     // do-date: work on it Saturday
  props: { due: "2026-07-15T00:00:00.000Z" },            // deadline: due Wednesday
  origin: "quick-add" });

const dueThisWeek     = store.deadlines(todayUtc, plus7dUtc, { type: "task" }); // window — mirrors agenda()
const slippedDeadline = store.doctor().deadlineCandidates;                      // mirrors dueCandidates
```

`props.due` is unchecked at write time (unlike `when`'s strict-ISO
validation, I17) — a malformed value (`"next Tuesday"`) simply never
surfaces in `deadlines()`/`deadlineCandidates` rather than being refused.
That is the honest, stated cost of a props convention over a schema
column; write `due` as strict ISO-8601 UTC the same way you write `when`.

### Unblocking — recovering a lost `EdgeId`

`closeEdge(id)` needs the `EdgeId` `link()` returned at creation time. If
your host didn't persist it, `edgesOf(id)` recovers it — both directions,
`never`-endpoints excluded, `asOf` time-travels (design task-arc.md §3.2):

```ts
const blockers = store.edgesOf(task.id, { type: "blocked_by" });
for (const e of blockers) store.closeEdge(e.id); // unblocked — the id nobody kept
```

## 6 · Project dashboards

Steps point at their project: `link(step.id, project.id, "part_of")`,
ordering in `props.seq` (edges are unordered — sort client-side).

```ts
const open = store.children(project.id, "part_of");                          // default: active
const all  = store.children(project.id, "part_of", { statuses: ["active", "archived"] });
const progress = `${all.length - open.length}/${all.length}`;               // done steps COUNT when asked
const card = store.entityContext(project.id);                                // people, notes, recent context
const team2022 = store.children(project.id, "member_of", { asOf: "2022-06-01" }); // time travel
```

## 7 · The capture-wrapper vocabulary (human-centric by construction)

The API is a schema; your app should speak in verbs. Write the thin
domain layer ONCE — the audit measured raw capture at 3–5 calls per
thought; your wrappers make it one:

```ts
const journal = (text: string, people: Node[] = []) => { /* createNode + mentions links */ };
const remember = (fact: string) => store.createNode({ type: "memory", title: fact, origin: src() });
const snooze  = (id: NodeId, until: string) => store.updateNode(id, { when: until });
const done    = (id: NodeId, outcome = "done") => {
  store.updateNode(id, { propsPatch: { outcome } });
  return store.transition(id, "archived");
};
const met = (a: NodeId, b: NodeId, where?: string) => store.link(a, b, "met", where ?? "");
const who = (name: string) => store.resolveRef("person", name); // candidates — YOU pick, never the library
```

**Content conventions worth adopting** (the two field-survey grammars):
write facts as observation-shaped prose with a category in brackets —
`"[health] allergic to penicillin"` — and give episodic memories the
four-part shape `observation / thoughts / action / result` in the body,
so future recall carries *why it worked*, not just what happened. Both
are pure convention: they cost nothing and pay at prompt-composition time.

## 8 · Changing a preference (two mechanisms, two evidence trails)

- **The fact itself changed** ("moved from Brasov to Cluj") →
  `propose` the new + `decide({ kind: "approve_superseding", supersedes })`.
  The old node archives; the `supersedes` edge is the record; `history()`
  of the new node is empty — the CHAIN is the story.
- **The wording was wrong** ("it's Cluj-Napoca, not Cluj") →
  `updateNode` / `approve_edited`. Same node, and `history()` replays
  every prior wording — the SNAPSHOTS are the story.

Pick by asking: did the world change, or did the record? Hosts that
conflate the two lose either the timeline or the paper trail.

## 9 · The UTC day warning

All library time is UTC (I11). Day anchors are **UTC calendar days**: a
01:30 Bucharest capture files under *yesterday's* UTC day. If your owner
thinks in local days (they do), convert at the edge — compute the local
day, then `dayAnchor(localDayAsUtcDate)` and pass `agenda`/`episode`
windows built from local-midnight converted to UTC. The library will
never guess a timezone for you; that is a feature.

## 10 · Backup, export, and restore (the procedure, not a suggestion)

```ts
store.backup(`${backupDir}/memory-${stamp}.db`);   // VACUUM INTO: WAL-safe, compacted, never overwrites
```

- Run it on a schedule the host owns (the daily tick is fine).
- **Never raw-copy `memory.db` while the store is open** — the WAL holds
  recent writes your copy would silently lose. Raw copy is safe only
  after `close()`.
- `index.db` is never backed up — it is disposable (I13).
- Keep generations (daily/weekly/monthly) on separate media; the file is
  small (personal scale) and `VACUUM INTO` output compresses well.
- Backups are private by default: `backup()` chmods its output to 0600
  (POSIX; a no-op on Windows), matching the store directory (0700) and
  `memory.db`/`index.db` themselves — check your backup media's own
  permissions too.

**Restore is one verb**, not a manual recipe — `Store.restore(backupPath,
dir)` places the backup as `memory.db` in a fresh directory, opens it,
`rebuildIndex()`s, then runs `PRAGMA integrity_check` itself and THROWS
(`conflict`) rather than handing back a corrupt store — an untested
backup is a hope, not a backup, so restore verifies for you instead of
leaving it as a separately-scheduled habit:

```ts
const restored = Store.restore(`${backupDir}/memory-${stamp}.db`, "/path/to/fresh-dir");
// restored.doctor().integrityOk is already true here — restore() throws otherwise
restored.close();
```

- Refuses a missing `backupPath` (`not_found`) and a non-empty target
  `dir` (`conflict`) — an absent or empty `dir` is fine, restore creates
  it (mode 0700) and the restored `memory.db` lands at mode 0600.
- Still worth doing periodically even so: restoring into a scratch dir on
  a schedule exercises the whole path (not just the file), catching
  problems `PRAGMA integrity_check` alone can't (a stale/wrong backup
  file, a media failure short of corruption).

**Export** is portability, not backup — a consent-filtered, human/
external-tool-readable copy, never a substitute for `backup()` (which
captures everything, `never`-surfaced rows included, with zero
filtering):

```ts
store.export(`${exportDir}/memory.jsonl`, { format: "jsonl" });      // archival: nodes+edges+aliases+derivations
store.export(`${exportDir}/agenda.ics`, { format: "ics" });          // when_at-bearing appointments, active+always
store.export(`${exportDir}/contacts.vcf`, { format: "vcard" });      // type='person' nodes as vCards
```

- Same refusal shape as `backup()`: the target must not exist and must
  not live inside the store directory.
- Consent-filtered by default (SCHEMA.md "Export"): `active`+`archived`
  status, `always`+`ask` surfacing. `surfacing='never'` and
  `status='quarantined'` rows need explicit opt-in
  (`{ includeNever: true }` / `{ includeQuarantined: true }`) — export is
  an owner-only verb (never agent-reachable, same tier as `backup`), but
  the sensitive tiers still require a deliberate flag, not a default.
  `memory_history`/`audit_log` are JSONL-only opt-ins
  (`includeHistory`/`includeAuditLog`), default off.
- `ExportReport.counts` gives per-stream row counts (JSONL:
  node/edge/alias/derivation/…; ICS: event; vCard: card) — log it or
  show it to the owner as a receipt.
- Every successful export is one content-free `store.export` audit row;
  `forget()`'s report counts them honestly (`external:exports:<n>`, only
  present once this store has actually exported something — HOSTING.md's
  Errors table and SCHEMA.md's I6 both apply as usual).

## 11 · Net worth (point-in-time holdings)

Money is the measurement pattern (§3) with two twists: you sum the
**latest** reading per account (not every reading), and a **liability is a
negative balance** — so one `SUM` nets assets against debts. The library
stores the declared number and the declared moment; the arithmetic, the
currency, and the FX are yours. This is tracking, not budgeting: point-in-
time state, no categories, no forecasts.

Register once. Use integer **minor units** (cents) — never floats: money
in JSON floats is the drift bug you don't want, and the schema pins
`number`. Snapshots are born `surfacing: "ask"` so a balance never turns
up in ambient recall — only when you name the account.

```ts
store.registerType({ name: "account", bornStatus: "active" });
store.registerType({
  name: "holding", bornStatus: "active",
  propsSchema: { balance_minor: { type: "number", required: true },
                 currency:      { type: "string", required: true } },
});
```

One `account` node per real account — **assets and liabilities alike** (a
mortgage is an account whose balances are negative). Each statement is one
`holding` snapshot, `when` = the balance's as-of moment, linked
`snapshot_of` → account. Correcting an account's history means adding a
snapshot, never mutating one: the series is append-only, and
`children(account, "snapshot_of")` replays it.

```ts
const checking = store.createNode({ type: "account", title: "ING · current", origin: "setup" });
const card     = store.createNode({ type: "account", title: "Visa", origin: "setup" });

const mint = (acct: Node, when: string, balance_minor: number, currency = "EUR", src = "import") =>
  store.link(
    store.createNode({
      type: "holding", title: acct.title, when, surfacing: "ask",
      props: { balance_minor, currency }, origin: src,
    }).id,
    acct.id, "snapshot_of",
  );

mint(checking, "2026-07-01", 421_000);   // €4,210.00 asset
mint(card,     "2026-07-01", -89_000);   // −€890.00 liability
```

**Net worth as of a date = the newest snapshot per account, summed per
currency.** The honest read is a single SQL statement over the read-only
file (§3's rule — analytics never goes through the writer):

```sql
WITH ranked AS (
  SELECT e.target AS account,
         json_extract(n.props,'$.currency')                      AS currency,
         CAST(json_extract(n.props,'$.balance_minor') AS INTEGER) AS bal,
         ROW_NUMBER() OVER (PARTITION BY e.target ORDER BY n.when_at DESC) AS rn
  FROM nodes n
  JOIN edges e ON e.source = n.id AND e.type = 'snapshot_of'
  WHERE n.type = 'holding' AND n.status = 'active' AND n.when_at <= :asof
)
SELECT currency, SUM(bal) AS net_minor FROM ranked WHERE rn = 1 GROUP BY currency;
```

`when_at <= :asof` gives you any historical moment for free; drop it for
"right now". The result is per-currency minor units — a single headline
number is an FX decision the library will not make for you.

Without SQL, the same read is `children` per account and a JS reduce
(fine at personal scale, and it is exactly what the probe test asserts):

```ts
function netWorth(accounts: Node[], asOf: string): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const acct of accounts) {
    const latest = store.children(acct.id, "snapshot_of")
      .filter((n) => n.when && n.when <= asOf)
      .sort((a, b) => (a.when! < b.when! ? 1 : -1))[0];   // newest wins
    if (!latest) continue;
    const { balance_minor, currency } = latest.props as { balance_minor: number; currency: string };
    totals[currency] = (totals[currency] ?? 0) + balance_minor;
  }
  return totals;
}
```

Rules of thumb: **minor units, always** (a `"1,200"` string is refused by
the schema, a float would drift); **liabilities are negative accounts**
(no separate type, `SUM` does the netting); **`ask` surfacing** keeps
balances out of ambient recall (use `never` if even a named search must
not surface them — but then `children` skips them too, so you aggregate
over SQL or held ids); **`when` is the as-of moment, `created` is when you
imported it** — correcting last month's figure keeps both straight; and
**assets you sold get an `owns` edge with `valid_until`** (§8 / I15) so
`neighborhood(asOf)` reconstructs what you held on any past date.

**Rebuying a sold asset does not reopen the old edge.** A closed
`(source, target, type)` triple stays closed — `link` refuses to
re-open it; this is a deliberate deferral, not a bug ("Re-opening a
closed triple," `docs/TEMPORAL.md:239-244`: "closing + relinking already
preserves every state... multi-interval validity... is deferred,
stated"). If the owner re-acquires the same asset (or returns to a
former employer), the sanctioned interim pattern is to reify the stint
as its own node — the same row-per-fact shape this section already uses
for holdings — e.g. an `ownership` node with `when` = the reacquisition
date, linked to both parties with plain edge types. A fresh node id
every time means no `(source, target, type)` triple ever repeats, so the
UNIQUE constraint never engages.

## 12 · Long-form documents (journals, essays, life notes)

A document is a node like any other: `title` is the short, greppable
label (recommend: the doc's own H1 text, extracted by the host at
capture time — the library never infers content from content, I17's
spirit, but a host reading its own input and pulling a heading is the
host's own choice, same as rrule-parsing in §4); `body` is the *raw
markdown, in full* — round-tripping the whole document back out
losslessly matters more than deduplicating the title line.
`props.format: "markdown"` is a convention flag (unenforced — `body` is
opaque TEXT regardless) that tells a host renderer which way to
interpret the bytes.

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
holdings-pattern case (§11) — content the owner wants *findable by name
or term*, not ambient. `always` remains available per-node for documents
a host wants proactively surfaced (a running project brief); `never` if
even a named search must stay silent (then `children`/`recall` skip it
too — retrieve by id only).

**History cost — measured, not guessed.** `memory_history` stores a
full, undiffed snapshot of `title`/`body`/`props` on every
owner-authority edit (I16) — for a document type that means storage
grows `O(edits × body size)`, unbounded. A probe against this library:
one 205.6 KB note, edited repeatedly, each edit appending one line:

| edits | `memory_history` rows | `memory.db`+WAL | × single-body size |
|---:|---:|---:|---:|
| 0 (create only) | 0 | 458.7 KB | 2.2× |
| 1 | 1 | 1,102.4 KB | 5.4× |
| 10 | 10 | 3,222.8 KB | 15.7× |
| 30 | 30 | 10,740.7 KB | 52.3× |
| 50 | 50 | 14,464.8 KB | 70.4× |

50 edits of one 206 KB document costs ~14 MB, for one node. This is
architectural (I16's "exactly three owner-authority capture moments"
snapshotting the full record, not a diff), not a bug — but it means the
edit-vs-revise split (§8) matters more for documents than for anything
else in this guide.

**Editing vs. revising — reuse the §8 split.** A typo fix or a
paragraph tightened is a wording change: `updateNode({ body })` in
place, and `history()` replays it — appropriate for occasional small
edits (a handful of edits on a personal note costs kilobytes, not
megabytes). A substantial rewrite (a new draft of a whole essay, a
journal entry rewritten after further thought) is closer to "the fact
itself changed" (§8): **create a new node**, link it to the old one with
a host edge (e.g. `revises`), and `transition(old.id, "archived")`.
This keeps `memory_history`'s per-edit full-copy cost bounded to the
*wording-tweak* case it was designed for, while the *rewrite* case pays
for exactly one new body, not an accumulating snapshot chain. If a
store's `doctor().historyRows` climbs because one document type
dominates it, that is the owner's signal to revisit — the library
reports, it does not act (`docs/TEMPORAL.md:248-250`).

```ts
const v2 = store.createNode({
  type: "document", title: "Lisbon trip — what I'd do differently (v2)",
  body: rewrittenMarkdownText, props: { format: "markdown" },
  surfacing: "ask", origin: `journal:${sessionId}`,
});
store.link(v2.id, note.id, "revises");
store.transition(note.id, "archived");
```

**Recall shape for very long documents (optional).** Plain full-body
FTS still finds a long document by any distinctive phrase — bm25's
length normalization means a long document can rank behind a short note
sharing the same term, but the document is still returned, well inside
`recall`'s default limit. Fine for personal notes nobody else's content
competes with in a given query. For documents the owner actually wants
findable *by sub-topic* (a long reference doc, a multi-section life
plan), bless the same shape §6 already uses for projects: **one node
per `##` section**, `part_of` → the document node, `props.seq` for
order.

```ts
const doc = store.createNode({ type: "document", title: "Estate planning notes", body: fullMarkdownText, props: { format: "markdown" }, origin: "setup" });
for (const section of splitByH2(fullMarkdownText)) {
  const s = store.createNode({
    type: "document_section", title: section.heading, body: section.body,
    props: { seq: section.index }, surfacing: "ask", origin: doc.origin,
  });
  store.link(s.id, doc.id, "part_of");
}
```

This is opt-in per document, not a blanket recommendation — most
personal notes are short enough that full-body indexing is exactly
right, and splitting adds bookkeeping (`children(doc.id, "part_of")` +
client sort) a host should only pay for when the size or "find that one
section" complaint actually shows up.

## 13 · Tables (CSV / spreadsheet-shaped life data)

Generalizes §11's holdings pattern beyond money: **one type per sheet,
one node per row, props = columns** (typed via `propsSchema` where the
columns are genuinely `string`/`number`/`boolean` — the common case),
and every row `part_of` → one collection node representing the imported
table/sheet. Corrections are append-only, exactly like holdings: never
mutate a historical row's figures in place — add a new row (or a
`supersedes`-style host convention if a row needs replacing) so "what
did the June statement say" stays answerable.

```ts
store.registerType({ name: "table",   bornStatus: "active" });
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
  free-form JSON, no column-count cost) but a `props_invalid` schema
  error only names one bad key at a time — a wide, dirty CSV import
  means many one-at-a-time failures. Host recipe: validate/normalize
  each row BEFORE calling `createNode` (a plain JS check against your
  own column list), not after.
- **>10k rows**: `createNode` per row keeps working — measured at
  0.287 ms/row for a 2,000-row import (574 ms total, linear, ~3 s
  projected at 10k rows) — but the **`episode()` pollution is the real
  ceiling, not create latency**. The same 2,000-row import measured a
  `memory.db`+WAL growth of 6,102.6 KB (~3,125 bytes/row — mostly audit
  and `on_day`-edge overhead, since these rows carry empty bodies).
  Immediately after that import, a same-day `journal` entry created
  right after (the 2,002nd node of the day) **did not appear** in a
  default-limit (`DEFAULT_AGENDA_LIMIT = 100`) `episode()` call for that
  day at all — buried behind 2,000 import rows in `created ASC` order.
  A **typed** call, `episode(from, to, { type: 'expense', limit:
  10000 })`, correctly returned all 2,000 rows in 4.57 ms. This is a
  known, accepted gap for v1, not a silently-solved one: **always call
  `episode()`/`agenda()` typed** (`{ type: 'expense' }`) once a table has
  been imported — the mitigation is real and available today with zero
  library change, but `episode()`'s untyped default on a bulk-import day
  will still surprise a host that forgets to type its query.
- **Retrieval at scale**: `children(sheet.id, "part_of")` has no
  query-side cap — it returns everything currently active/valid. For
  >10k rows, aggregate over the read-only file with hand-written SQL
  instead (§3's rule — analytics never goes through the writer), the
  same move §11's net-worth query already makes.
- **Actual spreadsheet files (.xlsx) stay out of scope.** The store
  holds declared, row-shaped data (above), never an opaque binary blob —
  `nodes.body` is `TEXT`, and an `.xlsx` blob in a column would violate
  the library's "no opaque state: both files open in any SQLite tool"
  non-goal outright (nobody can `SELECT` their way to meaning inside a
  zipped-XML blob). If a host wants to record that a set of row-nodes
  was derived from a re-parseable source file, `origin` names the file
  (as above) and `recordDerivation()` (§4) records re-derivable lineage
  if the source changes — no schema or library change needed.

## The daily tick (putting it together)

A host's once-a-day job, in order: materialize due recurrence instances →
`agenda(today, +1d)` for the board → `doctor()` for `dueCandidates`,
`deadlineCandidates`, `pendingCount`, `reviewDue`-flavored `staleCandidates`,
`integrityOk` → render the consent queue if `pendingQueue()` is non-empty →
`backup()`. Five calls and a loop — the library holds the life; the tick
just looks at the clock. With the CLI gone (plan 002), no process invokes
this on a schedule except the host's own script, so here it is, runnable:

```ts
// tick.ts — a host script the owner crons once a day. Five calls, in order.
import { Database } from "bun:sqlite";
import { Store, type Node } from "balaur-memory";

const store = Store.open({ dir: process.env.MEMORY_DIR! });
const todayUtc = new Date().toISOString().slice(0, 10);
const plus1d = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

// 1. materialize due recurrence instances (§4's pattern). Finding "due"
// rule-holders is host logic — this stub reads them via a read-only
// connection (the §3 idiom); a real host evaluates its own rrule grammar.
function dueRecurrences(memDir: string): { id: string; title: string }[] {
  const db = new Database(`${memDir}/memory.db`, { readonly: true });
  try {
    return db
      .query(
        "SELECT id, title FROM nodes WHERE type = 'task' AND status = 'active' AND json_extract(props,'$.rrule') IS NOT NULL",
      )
      .all() as { id: string; title: string }[];
  } finally {
    db.close();
  }
}
function materializeNext(s: Store, rule: { id: string; title: string }): void {
  const instance = s.createNode({
    type: "task", title: rule.title,
    when: new Date(Date.now() + 7 * 86_400_000).toISOString(), // host rrule math goes here — yours, not the library's
    origin: `recur:${rule.id}`,
  });
  s.link(instance.id, rule.id as Node["id"], "instance_of"); // findable: children()/edgesOf()
  s.recordDerivation(instance.id, [rule.id]);                // TRACKED: staleDerivations() + forget() (§4)
}
function renderQueue(pending: ReturnType<Store["pendingQueue"]>): void {
  for (const p of pending) console.log(`  pending: ${p.node.title}`);
}

for (const rule of dueRecurrences(process.env.MEMORY_DIR!)) materializeNext(store, rule);

// 2. the board
const board = store.agenda(`${todayUtc}T00:00:00.000Z`, `${plus1d}T00:00:00.000Z`);

// 3. health + both deadline lenses (props.due convention alongside when_at)
const report = store.doctor();
console.log({
  board: board.length,
  overdue: report.dueCandidates.length,
  deadlines: report.deadlineCandidates.length,
  pending: report.pendingCount,
});

// 4. render the consent queue if non-empty
if (store.pendingQueue().length > 0) renderQueue(store.pendingQueue());

// 5. backup (§10) — BACKUP_DIR must already exist; backup() does not mkdir
store.backup(`${process.env.BACKUP_DIR}/memory-${todayUtc}.db`);

store.close();
```
