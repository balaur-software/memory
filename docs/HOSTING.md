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
store.createNode({ type: "task", title: "Water the plants",
  props: { rrule: "FREQ=WEEKLY;BYDAY=MO" }, origin: "setup" });

// on completion (or on the daily tick), the HOST mints the next instance:
const next = store.createNode({ type: "task", title: "Water the plants",
  when: nextOccurrence(rule, now), origin: "recur:water-the-plants" });
store.link(next.id, ruleNode.id, "instance_of");
```

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

## 10 · Backup (the procedure, not a suggestion)

```ts
store.backup(`${backupDir}/memory-${stamp}.db`);   // VACUUM INTO: WAL-safe, compacted, never overwrites
```

- Run it on a schedule the host owns (the daily tick is fine).
- **Never raw-copy `memory.db` while the store is open** — the WAL holds
  recent writes your copy would silently lose. Raw copy is safe only
  after `close()`.
- `index.db` is never backed up — it is disposable (I13). Restore =
  place the backup as `memory.db` in a fresh dir, `Store.open`,
  `rebuildIndex()`.
- Verify by opening: restore into a temp dir on a schedule and check
  `doctor().integrityOk` — an untested backup is a hope, not a backup.
- Keep generations (daily/weekly/monthly) on separate media; the file is
  small (personal scale) and `VACUUM INTO` output compresses well.
- Backups are private by default: `backup()` chmods its output to 0600
  (POSIX; a no-op on Windows), matching the store directory (0700) and
  `memory.db`/`index.db` themselves — check your backup media's own
  permissions too.

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

## The daily tick (putting it together)

A host's once-a-day job, in order: materialize due recurrence instances →
`agenda(today, +1d)` for the board → `doctor()` for `dueCandidates`,
`pendingCount`, `reviewDue`-flavored `staleCandidates`, `integrityOk` →
render the consent queue if `pendingQueue()` is non-empty → `backup()`.
Five calls and a loop — the library holds the life; the tick just looks
at the clock.
