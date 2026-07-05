# balaur-memory — design

The memory layer of a personal life OS, as a standalone Go library. This file
records the architecture and the decided tradeoffs. If code and prose
disagree, code wins and this file gets fixed.

## The bet

Memory quality does not live in the storage engine. It lives in the write
path (adjudication), lineage, ranking, lifecycle, and consent — the layers
above storage. So storage stays deliberately boring, and this library is the
layer above.

Evidence behind the bet (from the extraction research, mid-2026):
write-time conflict adjudication beats recall-time reconciliation by a wide
margin on stale-memory benchmarks; every field anti-pattern list starts with
"vector-DB-as-memory"; and the production systems that endure converge on
metadata-only self-measurement, human-adjudicated identity, and
append-then-supersede lifecycles. The parent repo's plans 259–267 and
`docs/superpowers/` research carry the full citations.

## Architecture

```
host app (Balaur, a CLI, anything)
  │  renders the consent queue, calls models, schedules jobs
  ▼
memory (this library — deterministic, model-free)
  ├── spine: nodes + edges + status FSM + type registry
  ├── consent: proposals, adjudication gate, decisions
  ├── recall: FTS5 + ranking blend + optional embedder fusion
  ├── lineage: derived_from sources, staleness propagation
  ├── lifecycle: supersede, surfacing policy, quarantine, forget
  └── doctor: metadata-only health signals
  ▼
memory.db (source of truth)  +  index.db (disposable, rebuildable)
```

### Storage

- **Two SQLite files.** `memory.db` is the record; `index.db` (FTS5 tables +
  embedding vectors) is a disposable sidecar — deleting it is always safe,
  it rebuilds from source. This split is inherited from Balaur where it is
  proven; it also makes the hardest part of index-erasure trivial (rebuild
  IS the guarantee).
- **Driver:** `github.com/ncruces/go-sqlite3` (wazero) — CGO-free with FTS5
  included, one driver for both files. Decided; revisit only with a
  benchmark.
- **No ANN index, no graph engine.** At personal scale (≤100k nodes),
  brute-force cosine is milliseconds and recursive CTEs cover traversal.
  Adopting ChromaDB/Kuzu-class engines trades the library's whole pitch
  (one file, no services, decades-stable format) for capacity nobody's life
  needs. Re-open only if a measured workload says otherwise.

### The model-free rule

The library NEVER calls an LLM. No exceptions. Extraction, summarization,
reflection, and composition belong to hosts; the library provides:
- deterministic places for model outputs to land (proposals, derivations),
- the consent boundary they must cross,
- and the provenance they must carry.

The one model-adjacent seam is `Embedder` — an optional, host-supplied,
local-only embedding function. Absent an embedder, every behavior is
deterministic, offline, and free. That is the default and it is not a
degraded mode.

### The consent boundary

Statuses enforce it in the data layer: agent writes are born `proposed`;
recall and traversal filter to `active` + surfaceable. The queue
(`PendingQueue` / `Decide`) is the library's UI contract — hosts own pixels,
the library owns the ledger. Compound decisions (approve-superseding) commit
their full sequence and audit each step.

### The three axes of a node

1. **Status** — where in the lifecycle (proposed → active ⇄ archived,
   quarantined, forgotten, merged, rejected).
2. **Importance** — how much ambient budget it deserves (host semantics).
3. **Surfacing** — whether it may appear unasked (`always/ask/never`).
   Storage consent is not usage consent; this axis is what makes
   facts-about-others and painful memories storable without being ambient.

### Forgetting, honestly

`Forget` is erasure, `Quarantine` is suppression, and the API never
conflates them. The cascade: tombstone content in place (row survives for
referential integrity), drop edges, scrub indexes (rebuild-backed), flag
derived artifacts stale via lineage, write a **content-free** audit entry.
What the cascade cannot honestly reach — prose mentions in host-owned
transcripts, exports already written — comes back in `ForgetReport.NeedsOwner`
instead of being silently claimed. Lazy regeneration of stale derivations is
the host's job on its own schedule.

### Self-measurement

`Doctor` computes only from metadata the library already keeps — decision
rates, touch counts, ages, queue depth. It reports candidates and never
acts: dead-weight detection is Missing-Not-At-Random (a dormant memory may
be a rare-critical fact), so auto-archiving from usage signals is forbidden
by design, not by configuration.

## Non-goals

- No server, no daemon, no network listener.
- No scheduler — hosts own cron.
- No multi-tenant anything; one owner per store.
- No opaque state: both files open in any SQLite tool.

## License

AGPL-3.0-or-later today, matching the parent project, while the sole author
retains trivial relicensing freedom. Decide deliberately before accepting
external contributions: AGPL on a *library* extends copyleft to consumers —
right for sovereignty software, wrong for maximum adoption. If adoption ever
becomes the goal, Apache-2.0 is the conventional switch and must happen
while the contributor set is small enough to consent.

## Naming

Module `github.com/alexradunet/balaur-memory`, package `memory` (hosts may
alias, e.g. `bmem "github.com/alexradunet/balaur-memory"`). Subpackages
appear only when a seam earns one (spine/recall/lineage/doctor per doc.go),
never speculatively.
