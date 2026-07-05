# CONFORMANCE.md — proving an implementation honors the contract

The conformance suite tests the **schema contract** (SCHEMA.md), not this
codebase's internals. Any implementation — this TypeScript one, a future
Node port, a Go reader — passes the same suite or it is not balaur-memory.

## Shape

`test/conformance/*.scenario.json` — declarative scenarios executed by a
thin runner (`test/conformance/runner.test.ts` here; ~150 lines any language
can reimplement):

```jsonc
{
  "name": "I4-dedup-gate-routes-duplicate-title",
  "invariants": ["I4"],           // SCHEMA.md invariant numbers this pins
  "clock": "2026-07-05T12:00:00.000Z",
  "steps": [
    { "op": "registerType", "name": "memory", "bornStatus": "proposed" },
    { "op": "propose", "as": "p1",
      "proposal": { "type": "memory", "title": "Lives in Brasov",
                     "body": "Moved 2019", "importance": 4,
                     "origin": "turn:t1" } },
    { "op": "decide", "ref": "p1", "decision": { "kind": "approve" } },
    { "op": "propose", "as": "p2",
      "proposal": { "type": "memory", "title": "lives in  BRASOV",
                     "body": "dup", "importance": 3, "origin": "turn:t2" } }
  ],
  "expect": [
    { "outcome": "p2", "equals": "exists_active" },
    { "sql": "SELECT COUNT(*) FROM nodes WHERE status='proposed'", "equals": 0 },
    { "sql": "SELECT COUNT(*) FROM nodes WHERE status='active'",  "equals": 1 }
  ]
}
```

- `steps` use a small op vocabulary mapping 1:1 to the public API
  (`registerType, createNode, propose, proposeEdit, decide, link, recall,
  search, touch, transition, setSurfacing, quarantine, forget,
  recordDerivation, putVector, rebuildIndex, deleteIndexDb`).
- `as` binds returned ids/outcomes to names later steps and expectations
  reference.
- `expect` entries are either bound-value assertions or **raw SQL against
  memory.db** — the contract is the database, so the assertions read the
  database.
- `clock` (plus optional per-step `advance`) makes time-dependent behavior
  (recency decay, review_at, staleness) deterministic.

## Coverage map (grows with the phases)

| Area | Scenarios pin | Invariants |
|---|---|---|
| Consent | born statuses, gate routing, decide verbs incl. approve-superseding order | I1, I4, I5, I12 |
| Recall | surfacing filter, ranking-blend order with pinned defaults, vector fusion with a literal query vector, empty-result honesty | I2 |
| Graph | traversal filters, system edges, no_match permanence | I3, I9 |
| Lifecycle | quarantine reachability, forget tombstone + edge drop + index scrub + stale flags, terminality | I6, I7, I8 |
| Lineage | derivation staleness propagation | I10 |
| Store | id/timestamp formats, index disposability (delete index.db → rebuild → identical recall results) | I11, I13 |

Golden recall fixtures (the believable personal set from balaur plan 261 —
owner, sister Ana, dog Rex, employer, constraints) live here as the recall
scenarios: seed N memories, assert query X surfaces memory Y and not Z.

## Rules

- A behavior change without its scenario change in the same commit is wrong
  by definition — reviewers reject it.
- Scenario files never contain real personal data; fixtures are fictional.
- The runner may not import from `src/` internals — public API + raw SQLite
  reads only. That is what keeps the suite portable to other
  implementations.
