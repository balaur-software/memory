# Plan 007: Stop ineligible rows from starving recall's candidate cap

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9182b14..HEAD -- src/recall.ts src/indexdb/fts.ts src/spine.ts src/storage/schema.ts src/recall.test.ts test/conformance docs/SCHEMA.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches the ranked-recall hot path pinned by conformance)
- **Depends on**: plans/001-arm-the-gates.md
- **Category**: bug
- **Planned at**: commit `9182b14`, 2026-07-07

## Why this matters

Probe-confirmed 2026-07-07: with 60 active `never`-surfaced nodes matching
"zebra" and exactly one eligible `always`-surfaced match,
`recall(["zebra"])` returns **zero results**. The FTS index contains every
ACTIVE node regardless of surfacing; `lexicalCandidates` takes the top
`limit*4+16` rows by bm25 and only afterwards does `loadEligible` filter
out `never` and non-title-named `ask` rows — with no refill. A store dense
with private (`never`/`ask`) rows — the exact usage surfacing exists for —
silently loses ambient recall of eligible content. The same
truncate-before-filter shape exists in the vector stage (cap slice before
the `opts.type` filter).

The fix: make the FTS query universe carry surfacing, so ineligible rows
never consume the cap; and move the vector stage's type filter before its
cap slice.

## Current state

- `src/storage/schema.ts:94-97` — the FTS table (index.db, disposable I13):
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id UNINDEXED, kind UNINDEXED, title, content, extra
  );
  ```
- `src/indexdb/fts.ts:15-49` — `FtsDoc` interface + `upsertFts`
  (delete-then-insert; skips non-active docs). The doc already carries
  `status` but NOT `surfacing`.
- `src/indexdb/fts.ts:59-86` — `rebuildFts` refills from memory.db
  (`WHERE n.status = 'active'`), selecting `id/type/title/body/props` +
  aliases; does not select surfacing.
- `src/recall.ts:108-125` — `lexicalCandidates`:
  ```ts
  const sql =
    kind === undefined
      ? "SELECT id, -rank AS rel FROM nodes_fts WHERE nodes_fts MATCH ? AND kind != 'day' ORDER BY rank LIMIT ?"
      : "SELECT id, -rank AS rel FROM nodes_fts WHERE nodes_fts MATCH ? AND kind = ? ORDER BY rank LIMIT ?";
  ```
- `src/recall.ts:148-165` — `loadEligible` filters
  `status = 'active' AND surfacing IN ('always','ask')` from memory.db and
  applies the `ask`-titleNamed rule (I2) in JS. THIS FILTER REMAINS — it is
  the authority; the FTS-side filter is an optimization of the candidate
  universe, and memory.db remains the source of truth (index.db rows can be
  stale, I13).
- `src/recall.ts:238-250` — the vector stage:
  ```ts
  const vecs = allVectors(ctx.idx, opts.model);
  ...
  const vecIds = sims.slice(0, cap).map((s) => s.id);
  const vecNodes = loadEligible(ctx, vecIds, []); // no terms → 'ask' rows drop (I2)
  if (opts.type !== undefined) {
    for (const [id, n] of vecNodes) if (n.type !== opts.type) vecNodes.delete(id);
  }
  ```
  The `slice(0, cap)` happens BEFORE the type filter — other-type vectors
  consume the cap in typed vector recall.
- Callers of `upsertFts`: `src/spine.ts` `fanOut` (line ~273) and
  `reindexNode` (line ~468) — both build the doc from a `Node`, so
  `node.surfacing` is available. `setSurfacing` (`src/spine.ts:697-701`)
  currently does NOT reindex — once surfacing lives in FTS, it MUST.
- I2 semantics to preserve exactly (`src/recall.ts:14-19`): `always` →
  ambient-eligible; `ask` → returned only when a term literally names a
  title word; `never` → unreachable in recall.
- Consumers of `lexicalCandidates` beyond recall: `conflictsFor`
  (`src/consent.ts:313`) and the forget mention-scan
  (`src/lifecycle.ts:79`). The forget scan WANTS candidates regardless of
  ask-vs-always (it's owner-facing "needsOwner" hints over ambient rules,
  but it currently inherits whatever recall's universe is). Excluding
  `never` from FTS entirely would change forget's mention hints and
  conflictsFor semantics — so DO NOT exclude rows from the index; add a
  column and filter per-query (recall filters `surfacing != 'never'`;
  conflictsFor/forget keep the unfiltered universe and their existing JS
  I2 handling).
- index.db is disposable (I13): schema changes to it need NO migration —
  `rebuildIndex()` reconstructs; but an existing index.db with the old
  5-column shape must be handled (see Step 1).
- Conformance pins recall ordering: `test/conformance/I2-recall-surfacing.scenario.json`
  and golden fixtures assume `DEFAULT_RANKING`.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Full gate | `bun run check`      | exit 0              |
| Suites    | `bun test src/recall.test.ts test/conformance/runner.test.ts` | all pass |

## Scope

**In scope**:
- `src/storage/schema.ts` (INDEX_DDL: add `surfacing UNINDEXED` column)
- `src/indexdb/fts.ts` (doc shape, upsert, rebuild)
- `src/recall.ts` (lexical filter + vector-stage ordering)
- `src/spine.ts` (ONLY: `setSurfacing` gains a reindex call; the `FtsDoc`
  construction sites gain the surfacing field)
- `src/recall.test.ts`, one new conformance scenario
- `docs/SCHEMA.md` (index.db section: document the new column)

**Out of scope** (do NOT touch):
- `loadEligible`'s memory.db filter — it stays the authority.
- Ranking constants / blend math — nothing about scoring changes.
- Refill/pagination loops — the SQL-side filter makes them unnecessary;
  do not add iterative refill logic.

## Git workflow

- Branch: `advisor/007-recall-starvation`
- Suggested commit: `fix(recall): surfacing joins the FTS universe — ineligible rows no longer starve the candidate cap`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the surfacing column to the FTS table

In `src/storage/schema.ts` INDEX_DDL:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id UNINDEXED, kind UNINDEXED, surfacing UNINDEXED, title, content, extra
);
```

Because `CREATE VIRTUAL TABLE IF NOT EXISTS` will NOT upgrade an existing
5-column table, extend `migrateIndexDb` to self-heal the shape mismatch
(index.db is disposable — I13):

```ts
export function migrateIndexDb(db: SqlDb): void {
  db.exec(INDEX_DDL);
  // Pre-surfacing index files have a 5-column nodes_fts; the sidecar is
  // disposable (I13) — drop and recreate, the caller rebuilds.
  const cols = db.query<{ name: string }>("SELECT name FROM pragma_table_info('nodes_fts')");
  if (!cols.some((c) => c.name === "surfacing")) {
    db.exec("DROP TABLE nodes_fts;");
    db.exec(INDEX_DDL);
  }
}
```

Then in `src/store.ts` `Store.open`, the existing `recovered` path already
calls `rebuildFts` — extend the condition: after `migrateIndexDb(idx)`
succeeds, detect emptiness-after-recreate by checking
`SELECT COUNT(*) FROM nodes_fts` vs `SELECT COUNT(*) FROM nodes WHERE status='active'`
— simpler and acceptable: ALWAYS `rebuildFts` when the surfacing column was
just added. Implementation choice: have `migrateIndexDb` return a boolean
`recreated` and let `Store.open` rebuild when true. Keep it minimal.

**Verify**: `bun test` → suite passes (fresh stores get the 6-column table;
the I13 conformance scenario `I13-index-disposability.scenario.json` still
passes).

### Step 2: Carry surfacing through the doc pipeline

- `src/indexdb/fts.ts`: add `readonly surfacing: string;` to `FtsDoc`;
  include it in `upsertFts`'s INSERT (6 columns now); in `rebuildFts`,
  select `n.surfacing` and insert it.
- `src/spine.ts`: both `FtsDoc` construction sites (`fanOut`,
  `reindexNode`) add `surfacing: node.surfacing`.
- `src/spine.ts` `setSurfacing`: after the UPDATE, add
  `reindexNode(ctx, mustGet(ctx, id));` — surfacing now gates index
  membership metadata, so the row must be rewritten on change (mirror the
  comment style of `transition`'s "status gates index membership").

**Verify**: `bunx tsc --noEmit` → exit 0; `bun test` → green.

### Step 3: Filter in SQL for recall only

In `src/recall.ts` `lexicalCandidates`, add a `surfacingFilter` parameter
(default OFF so `conflictsFor` and the forget scan keep today's universe):

```ts
export function lexicalCandidates(
  ctx: Ctx,
  terms: readonly string[],
  kind: string | undefined,
  cap: number,
  excludeNever = false,
): Candidate[] {
  ...
  const nf = excludeNever ? " AND surfacing != 'never'" : "";
  const sql =
    kind === undefined
      ? `SELECT id, -rank AS rel FROM nodes_fts WHERE nodes_fts MATCH ?${nf} AND kind != 'day' ORDER BY rank LIMIT ?`
      : `SELECT id, -rank AS rel FROM nodes_fts WHERE nodes_fts MATCH ?${nf} AND kind = ? ORDER BY rank LIMIT ?`;
  ```

In `recall()` pass `true`; `conflictsFor` and `lifecycle.forget` call sites
stay as they are (two-argument-compatible via the default).

`ask` rows stay IN the universe (they are eligible when title-named — the
JS rule in `loadEligible` still decides). Only `never` is excluded, because
it is never eligible in recall.

**Verify**: `bun test src/recall.test.ts` → green.

### Step 4: Fix the vector-stage cap ordering

In `recall()`'s vector stage, apply the type restriction BEFORE the cap
slice. `allVectors` has no type knowledge, so filter after `loadEligible`
but restructure so the cap applies to eligible rows: load eligibility for
ALL sims (they're already computed), filter, THEN slice:

```ts
sims.sort((a, b) => b.sim - a.sim);
const vecNodes = loadEligible(ctx, sims.map((s) => s.id), []); // 'ask' drops (I2)
if (opts.type !== undefined) {
  for (const [id, n] of vecNodes) if (n.type !== opts.type) vecNodes.delete(id);
}
const vecRanked = sims.map((s) => s.id).filter((id) => vecNodes.has(id)).slice(0, cap);
```

(Loading all sim ids instead of `cap` ids is a bounded cost: one IN-list
query over ids already in memory — personal scale, and `loadEligible`
already takes arbitrary id lists.)

**Verify**: `bun test src/recall.test.ts test/conformance/runner.test.ts` →
green (vector fusion scenarios unchanged — RRF math untouched).

### Step 5: Pin the regression

- `src/recall.test.ts`: the probe as a test — 60 active `never` nodes
  matching a term + 1 `always` match; `recall([term], {limit: 1})` returns
  the eligible node. Add the `ask` variant: 60 `ask` rows (not title-named
  by the term) + 1 `always` → eligible node returned (ask rows remain in
  the universe but the JS filter drops them — this documents that the cap
  can still be consumed by ask rows ONLY when they contain the term in
  body; if this variant fails, see STOP conditions).
- New conformance scenario `I2-recall-starvation.scenario.json`
  (invariants: `["I2"]`), modeled on `I2-recall-surfacing.scenario.json`:
  a handful of never rows + one always row, recall returns the always row.
- `setSurfacing` reindex: test that flipping a node `always → never` makes
  it vanish from recall WITHOUT `rebuildIndex()`, and `never → always`
  brings it back.

**Verify**: `bun run check` → exit 0.

## Test plan

Step 5's three regression tests + one conformance scenario; the existing
recall/vector/conformance suites are the no-regression net.

## Done criteria

- [ ] Probe scenario passes: 60 never + 1 always → 1 hit
- [ ] `setSurfacing` flip is immediately reflected in recall
- [ ] `grep -n "surfacing UNINDEXED" src/storage/schema.ts` → 1
- [ ] `bun run check` exits 0; conformance suite green
- [ ] Old index.db files self-heal (covered by the migrate/rebuild path; the
      I13 disposability scenario passes)
- [ ] `git status` clean outside in-scope paths
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any golden/conformance recall ordering changes — the fix must not alter
  scoring of already-eligible rows; if orderings shift, something beyond
  the universe filter changed. Stop and report the diff.
- The `ask`-dense variant in Step 5 still starves: that requires a design
  decision (indexing title-tokens for the ask rule in SQL is a bigger
  change) — report it as a follow-up rather than improvising.
- `pragma_table_info` is unavailable through the adapter's `query` (older
  SQLite) — report; do not switch to parsing `sqlite_master` SQL text
  without sign-off.

## Maintenance notes

- The FTS row now carries `surfacing` — any future code changing surfacing
  by raw SQL (none exists today; `setSurfacing` is the choke point) would
  silently skip the reindex. Keep surfacing changes behind the verb.
- `rebuildFts` and `upsertFts` must stay column-compatible; the I13
  "reconstructs exactly" rule now includes surfacing.
- Deferred: ask-row cap pressure (see STOP #2) — only matters for stores
  where ask-surfaced rows dominate AND share vocabulary with queries.
