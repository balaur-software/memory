# balaur-memory

> **A consent-gated, lineage-tracked, forgettable memory layer for personal AI.**
> One SQLite file. One Go module. No services.

`balaur-memory` is the memory layer of a personal life OS, extracted from
[Balaur](https://github.com/alexradunet/balaur) as a standalone library. It is
the layer *above* storage — the part no existing memory library ships:

- **Consent-gated writes** — an agent proposes; the owner decides. The
  proposal/adjudication queue is a data-layer contract, not prompt wording.
  Hosts render it however they like (cards, CLI, TUI).
- **Write-time adjudication** — duplicate and conflicting memories are routed
  at the moment of writing (add / update / no-op / supersede), not left for a
  model to untangle at recall time. Field evidence says this is where memory
  systems fail; this library makes it the front door.
- **Provenance and lineage** — every memory knows the turn it came from; every
  derived artifact knows its sources. "Where did this come from?" and "what
  must change if this goes away?" are queries, not archaeology.
- **A real memory lifecycle** — supersede chains, surfacing policy
  (always / ask / never), quarantine for the painful cases, and true
  forgetting with honest cascade semantics. "Forgotten" never secretly means
  "suppressed".
- **Self-measurement** — a doctor that reads quality signals from metadata the
  library already keeps (acceptance rates, utilization, staleness, dead
  weight) and reports to the owner. It never auto-acts.
- **Recall as fusion** — FTS5 lexical recall with a deterministic ranking
  blend (relevance × recency × importance × reinforcement), and an optional
  `Embedder` interface for local semantic recall. Brute-force cosine is a
  feature: at personal scale it is milliseconds, exact, and dependency-free.

## What it is not

- **Not a vector database.** Embeddings are one optional retrieval signal,
  never the memory system.
- **Not a server.** It is a library over SQLite files you own and can open
  with any SQLite tool.
- **Not intelligent.** The library never calls a model. Extraction,
  summarization, and reflection belong to the host; the library gives them
  deterministic, auditable places to land.
- **Not a framework.** Small packages, plain `database/sql`, no annotations,
  no magic.

## Design principles

1. The deterministic substrate decides; models advise.
2. The owner is the only actuator — the library reports and proposes, never
   auto-acts on its own signals.
3. Provenance before features — lineage is written at creation time, because
   it cannot be retrofitted.
4. Verbatim and derived are two artifacts. Sources are never summarized away.
5. Storage is boring on purpose: SQLite, CGO-free, one file to back up,
   one format frozen for decades.

## Status

**Phase 0 — contract.** The API surface in this repo is a reviewed draft
(`contract.go`); implementation lands piece by piece, migrated and redesigned
from Balaur's in-tree memory layer. See [docs/MIGRATION.md](docs/MIGRATION.md)
for the phase map and [docs/DESIGN.md](docs/DESIGN.md) for the architecture.

Balaur remains the first consumer and the proving ground: each phase ships
here only after its shape survived real use there.

## License

AGPL-3.0-or-later, matching the parent project. **Note for library adopters:**
this is a deliberate early default while the sole author retains full
relicensing freedom; see the license note in
[docs/DESIGN.md](docs/DESIGN.md#license) before depending on it in non-AGPL
work.
