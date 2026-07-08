# StoreContract — the full API surface

Source of truth: `src/contract.ts` (`class Store implements StoreContract`
in `src/store.ts` is compiler-checked, so this surface and the shipped one
cannot drift). Everything is SYNCHRONOUS: bun:sqlite is sync, personal scale
is sub-millisecond, and the one truly async concern — embedding text — lives
in hosts ("vectors in, never models").

Describes HEAD `f1b168a` (2026-07-08, UNRELEASED). The 39-method surface
is identical at the released v0.4.3 tag except where marked **HEAD-only**
(the DoctorReport revision is the one signature-visible difference).

Public package entry: `src/index.ts` exports `Store`, `StoreOptions`,
`DEFAULT_RANKING`, `termsFromText`, `SCHEMA_VERSION`, `ulid`, `MemoryError`,
`normalizeText`, `SYSTEM_EDGE_TYPES`, and the types.

## Opening a store

```ts
import { Store } from "balaur-memory";
const store = Store.open({ dir: "/path/to/data" }); // creates memory.db + index.db
// StoreOptions: { dir: string; now?: () => Date; openDb?: OpenDb }
```

`Store.open` self-heals a corrupt `index.db` (drop, recreate, rebuild —
I13); a corrupt `memory.db` is fatal by design. A `memory.db` with a
schema_version NEWER than the build throws on open ("upgrade the library,
never downgrade the file"). Injectable clock `now` is how tests and the CLI
`--now` flag freeze time.

## The spine

| Method | Signature | Semantics |
|---|---|---|
| `registerType` | `(spec: NodeTypeSpec) => void` | Register/update a node type; `bornStatus` is the consent split (I1). Refuses the reserved name `"day"`; refuses a `bornStatus` flip while nodes of the type exist. |
| `createNode` | `({type, title, body?, props?, importance?, surfacing?, when?, origin, author?}) => Node` | Owner-authored write — born `active` (I1); `origin` mandatory (I10); `when` strict ISO (I17); template fill + props-schema validation. |
| `getNode` | `(id: NodeId) => Node` | Fetch by id regardless of status/surfacing — hosts gate display. The ONLY read that reaches `surfacing='never'` and non-active nodes. |
| `updateNode` | `(id, {title?, body?, props?, propsPatch?, when?}) => Node` | Edit an ACTIVE node — the OWNER path, works on consent-gated types too. `props` REPLACES wholesale; `propsPatch` merges shallowly, null removes a key (RFC 7386 style); passing both throws. `when`: undefined = unchanged, null = clear, string = validated set. Snapshots history (I16 moment 1). A retitle landing on one of the node's own aliases drops that alias. HEAD-only (`7c51c3f`): template fill is birth-only, so a propsPatch null-removal of a templated key stays removed (at v0.4.3 the template re-merge resurrects it). |
| `children` | `(id, edgeType, {statuses?, asOf?}?) => Node[]` | Dashboard read: nodes whose `edgeType` edge points AT id, caller-stated statuses (default `["active"]` — pass `["active","archived"]` so done work counts). Excludes `never`-surfaced and `day`; currently-valid edges, `asOf` time-travels. Ordered created ASC, id ASC. |
| `history` | `(id: NodeId) => HistorySnapshot[]` | Pre-mutation snapshots, oldest first, actor/origin-attributed. Id-gated like getNode; EMPTY after forget (I16). Read-only — evidence, not an undo stack. |
| `link` | `(source, target, type?, context?, validity?) => Edge` | Typed edge; default type `links`. Idempotent on (source, target, type) while OPEN — duplicate returns the existing edge, existing validity wins, no second audit row. A CLOSED triple refuses loudly (`conflict`). Validity declared-never-inferred (I15); system edge types refuse it. |
| `closeEdge` | `(id: EdgeId, until?) => Edge` | "This fact stopped being true": sets `valid_until` (default: store clock now), KEEPS the row. Refuses system edge types (I15), already-closed edges (loud, not idempotent), and `until <= valid_from`. |
| `neighborhood` | `(id, asOf?) => Node[]` | 1-hop ACTIVE set (I3), `never` excluded, `ask` included, `day` excluded; currently-valid edges by default, `asOf` time-travels. |

## The consent boundary

| Method | Signature | Semantics |
|---|---|---|
| `propose` | `(p: Proposal) => Outcome` | The write-time AUDN gate (I4): `created` \| `merged_pending` \| `exists_active`. Only works on types with `bornStatus:"proposed"`. |
| `proposeEdit` | `(id, {fields?, archive?, origin, author?}) => void` | Park a change to an ACTIVE gated node without applying it. Latest proposal wins (PK on node_id). Throws when there is nothing to propose. |
| `pendingQueue` | `() => Pending[]` | Everything awaiting the owner: proposals, then parked edits, then identity questions — each kind oldest-first. Each item carries conflict hints. |
| `decide` | `(id, decision: Decision) => Node` | Apply the owner's verdict to a proposal or a parked edit. Compound verdicts run ordered + audited (I5); mid-sequence failure stops and surfaces. A node awaiting a pair-keyed identity verdict gets a pointer to `decideIdentity` instead of "nothing pending". |
| `conflictsFor` | `(id) => Conflict[]` | Advisory duplicate/contradiction hints among ACTIVE same-type nodes: exact normalized-title match first, then bm25 lexical overlap. Capped at 2; obeys I2 (never invisible, ask only when the item's own words name its title). |

Key types (`src/consent.ts`):

```ts
type Outcome =
  | { kind: "created"; node: Node }
  | { kind: "merged_pending"; node: Node }   // folded into an existing PENDING proposal; latest wins
  | { kind: "exists_active"; node: Node };   // nothing written; points at the active cover

type Pending =   // the tagged union a host renders as "the queue"
  | { kind: "proposal"; node: Node; conflicts: readonly Conflict[] }
  | { kind: "edit"; node: Node; edit: EditEnvelope; conflicts: readonly Conflict[] }
  | { kind: "identity"; a: Node; b: Node; evidence: IdentityEvidence; created: string };

type Decision =
  | { kind: "approve" }                                   // proposal → active; parked edit → apply (or archive)
  | { kind: "approve_edited"; fields: Record<string, string> }  // owner-corrected fields, then activate/apply
  | { kind: "approve_superseding"; supersedes: NodeId }   // proposals only: activate new → archive old → supersedes edge → audit (I5)
  | { kind: "reject" };                                   // proposal → rejected (terminal); parked edit → envelope clears, node untouched
```

Verdict `fields` arrive as strings; `title`/`body`/`importance`/`when` are
columns (`when`: strict ISO sets, `""` clears), everything else lands in
props — coerced to the type schema's declared primitive, then validated
(the consent boundary cannot mint a schema-violating node).

## Recall and time windows

| Method | Signature | Semantics |
|---|---|---|
| `recall` | `(terms, {type?, limit?, queryVector?, model?}?) => Node[]` | Ranked retrieval over active, surfaceable nodes (I2): bm25 × recency × importance × reinforcement; RRF-fused with cosine when a queryVector+model is supplied. Default limit 8. Deterministic without a vector — and that is NOT a degraded mode. Untyped recall excludes `day` plumbing; `type:"day"` reaches it. HEAD-only fix (`190b6e0`): ineligible (`never`) rows no longer consume the candidate cap — at v0.4.3 a never/ask-dense store can starve eligible matches. |
| `search` | `(terms, limit?) => Node[]` | Cross-type recall (delegates to `recall` with default limit 10). |
| `agenda` | `(from, to, {type?, limit?}?) => Node[]` | The scheduled future: active, always-surfaced nodes with `when_at` in the half-open `[from, to)`, ordered when_at ASC, id ASC (I17/I2). Strict ISO bounds; `to` must be after `from`; default limit 100. |
| `episode` | `(from, to, {type?, limit?}?) => Node[]` | The lived past: active, always-surfaced nodes by CREATED in `[from, to)` — "what happened in March". Day anchors excluded when untyped. Pure read. |
| `dayAnchor` | `(date: string) => Node` | Get-or-create the `type=day` node for a UTC date (the same node the creation `on_day` anchor uses). Idempotent. Scheduling onto it is the host's explicit `link`. |
| `touch` | `(id) => void` | Record actual use: bumps `use_count` + `last_used` (feeds ranking + doctor). Active nodes only. Deliberately does NOT bump `updated`. |

Ranking defaults (`DEFAULT_RANKING` in `src/recall.ts`, conformance-pinned):
`{ lambda: 0.02, reinforcement: 0.2, rrfK: 60 }`; `RECENCY_FLOOR = 0.05`;
candidate over-fetch `limit × 4 + 16`. See SKILL.md for the formula.

## Lifecycle

| Method | Signature | Semantics |
|---|---|---|
| `transition` | `(id, to: Status) => Node` | Move through the owner FSM; validates I8. `forgotten`/`merged` are NOT reachable here — dedicated verbs only. Leaving `active` clears any parked edit; leaving `quarantined` clears `review_at`. |
| `setSurfacing` | `(id, s: Surfacing) => void` | Set the always/ask/never axis. Audited with from/to. |
| `quarantine` | `(id, reviewAt?) => void` | Suppress everywhere (from `active` only), optional strict-ISO re-review date. Reversible via `transition(id, "active")`. |
| `forget` | `(id) => ForgetReport` | The honest erasure cascade (I6/I7). Legal from active, archived, quarantined, merged. HEAD-only (`91996a7`): erasure is byte-level too — secure_delete pragmas, FTS secure-delete, post-cascade WAL truncate (at v0.4.3 forgotten bytes can linger in WAL/free pages/FTS segments). |

```ts
interface ForgetReport {
  tombstoned: NodeId;
  edgesDropped: number;
  indexScrubbed: boolean;          // false = scrub failed; audited, rebuildIndex() heals
  flaggedStale: readonly string[]; // derived artifacts now stale
  needsOwner: readonly string[];   // "mention:<id>" prose-mention candidates,
                                   // "husk:<id>" merged husks that lost their survivor,
                                   // "external:prior-exports" always present
}
```

## Identity (docs/ENTITIES.md)

| Method | Signature | Semantics |
|---|---|---|
| `addAlias` | `(id, alias) => void` | Owner verb: a name the node also answers to. Active nodes only; normalized; idempotent (no audit row on no-op); alias equal to the node's own title refused as noise. Reindexes so alias hits surface in recall (FTS `extra`). Audit rows NEVER carry the alias text (I7). |
| `removeAlias` | `(id, alias) => void` | Remove; no-op when absent; any status (cleanup allowed). |
| `aliasesOf` | `(id) => string[]` | All names (normalized), alphabetical. |
| `resolveRef` | `(type, text) => Node[]` | Who is "Ana"? Exact-normalized candidates (title or alias) within one type, ACTIVE only, oldest-first — the caller picks, the library never does. I2: `never` invisible, `ask` resolves (the text IS its name). |
| `survivorOf` | `(id) => Node` | Walk `merged_into` chains to the living end; non-merged returns itself; cycle-capped at 32 hops. |
| `suggestIdentities` | `(type, cap?) => number` | Deterministic candidate generation (R1 > R2 > R3), owner/host-scheduled, NEVER ambient. Writes new questions to `identity_pending`; skips pending, no_match (I9), and merged pairs. Returns questions added (≤ cap, default 20). |
| `decideIdentity` | `(keep, other, verdict: "same"\|"different") => Node` | The owner's verdict. Both nodes ACTIVE, same type, neither `never`-surfaced; refuses a no_match pair (I9). `"different"` = permanent no_match edge. `"same"` = the compound merge (see SKILL.md). Survivor = `keep`, chosen by ARGUMENT ORDER, never a heuristic. |
| `entityContext` | `(id, limit?, asOf?) => EntityContext` | The bounded peer card: node + aliases + capped 1-hop peers (default 6) ranked by recency desc. Subject must be ACTIVE (a husk is refused with a pointer to survivorOf; `never` refused, `ask` allowed — an id is the strongest naming). Peers: active, `always`-surfaced only, no `day`, no `no_match` edges. Pure read. |

Candidate rules (ENTITIES.md; evidence priority R1 > R2 > R3 per pair):

| Rule | Evidence | Example |
|---|---|---|
| R1 `title_match` | Equal normalized titles | "ana popescu" = " Ana  POPESCU " |
| R2 `token_subset` | One title's full token set is a STRICT subset of the other's (tokens ≥ 2 chars) | "Ana" ⊂ "Ana Popescu" |
| R3 `alias_match` | An alias of one equals the title or an alias of the other | alias "sis" on Ana = title "Sis" |

Exclusions in every rule: self-pairs, non-active nodes, `never`-surfaced
nodes, closed pairs (pending / no_match / merged_into). Pairs are stored
unordered with `a < b`. **No unmerge verb in v1** — stated, not implied: the
husk preserves every byte, so manual recovery is possible, but mechanical
unmerge is deliberately absent.

## Lineage, vectors, measurement

| Method | Signature | Semantics |
|---|---|---|
| `recordDerivation` | `(artifact, sources) => void` | Register a derived artifact's sources; ids OR host refs (`"host:recap:2026-07-04"`). |
| `staleDerivations` | `() => string[]` | Artifacts whose sources changed or were forgotten. |
| `putVector` | `(id, model, vec: Float32Array) => void` | Maintain the vector sidecar — HOST-computed vectors only; `model` is the vector-space identity (vectors from different models never mix). Upserts on (id, model). |
| `deleteVectors` | `(model?) => void` | Drop one model's space, or all. |
| `rebuildIndex` | `() => void` | Rebuild index.db from memory.db (I13 — always safe, always exact). |
| `backup` | `(toPath) => void` | `VACUUM INTO`: WAL-safe consistent snapshot, compacted, without blocking the writer. Target MUST NOT exist — backups never overwrite. index.db is never backed up. HEAD-only (`7c51c3f`/`1219dcd`): refuses a target inside the live store dir, cleans up a mid-write failure, chmods output 0600. |
| `doctor` | `(now?) => DoctorReport` | Metadata-only health report — reports, NEVER acts. |

`DoctorReport` fields (the nine every version has): `activeCount`
(excludes `day`), `pendingCount` (proposals + live edits + live identity
questions), `acceptRate30d` (null = no decisions in window),
`deadWeightCandidates` (active, never recalled, ≥90 days — dormant ≠
dead: an allergy looks identical to dead weight), `staleCandidates`
(important-but-unused ∪ quarantine review due), `duplicateCandidates`
(same type + normalized title; `never`-surfaced excluded — the F8 rule),
`dueCandidates` (active, `when_at` passed, oldest-due first, `never`
excluded), `queueOldestDays`, `integrityOk` (`PRAGMA integrity_check` —
the health of the FILE itself). Candidate lists cap at 20. Auto-archiving
from these signals is forbidden by design.

**HEAD-only (unreleased) — the `005da77` `feat(doctor)!` revision** adds
three fields, paying the three documented "next DoctorReport revision"
IOUs in one breaking change (`src/contract.ts:50-58`, `src/doctor.ts`):

- `pendingByKind: { proposals; edits; identities }` — `pendingCount`
  broken out (ENTITIES.md's deferred identity-queue fields, delivered).
- `historyRows: number` — total `memory_history` rows, the retention
  instrument TEMPORAL.md names (visibility first; policy is the owner's).
- `reproposedAfterForget30d: number` — proposals in the last 30 days whose
  normalized title matches a forgotten fact, matched by a salted
  sha256 **title footprint** (`titleFootprint` in `src/spine.ts`; first 16
  hex chars stored as audit meta key `tf` on forget cascades and all
  propose outcomes) — never by stored text, so I7/I12 hold by
  construction. Excludes the forgotten fact's own birth proposal (matched
  by audit `ref`). The sanctioned residue of the rejected `improve()`
  verb (FIELD.md). Reports, never acts.

Consumers on the v0.4.3 tag (web) see only the nine-field shape; code
written against HEAD's fields breaks under a v0.4.3 pin. Pinned by
`doctor-revision.scenario.json` (I7/I12) + four `src/doctor.test.ts`
cases (breakdown, history count, reproposal window/matching, and a
content-leak sentinel).

## Errors vs outcomes

`MemoryError` (in `src/types.ts`) is for broken invariants and programmer
error; DOMAIN forks are return values, never exceptions (DESIGN.md "Errors
and outcomes"). E.g. a duplicate proposal is an `Outcome`
(`exists_active`), not a throw; a forget's loose ends are a `ForgetReport`,
not a throw.

`MemoryError.code` — exactly six values:

| code | thrown when |
|---|---|
| `not_found` | no such node/edge; nothing pending on a node |
| `invalid_transition` | FSM violation; verb on wrong status; gated-type misuse |
| `type_unknown` | node type not registered |
| `props_invalid` | schema violation, bad ISO string, bad importance/limit, empty title |
| `store_closed` | verb after `close()` |
| `conflict` | closed-triple relink, system-edge validity, no_match re-litigation, backup target exists, born_status flip, reserved type name, future schema_version |
