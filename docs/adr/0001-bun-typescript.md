# ADR-0001: Bun + TypeScript, with the schema as the real contract

- **Date:** 2026-07-05
- **Status:** Accepted (ratified by merging the phase-0.5 PR)

## Context

Phase 0 scaffolded this library in Go, assuming a Go host application would
import it directly. The owner's working language is TypeScript; Bun
ships native, synchronous SQLite (`bun:sqlite`). In an agent-assisted
workflow the owner's job is *reviewing* code — and you can only adjudicate
what you read fluently. A consent-gated project whose owner cannot fluently
audit its own code contradicts its own philosophy.

The costs of leaving Go are real and named, not waved away:

1. **Go code cannot import a TypeScript module.** The library becomes a
   fresh implementation, not an extraction — no host inherits it for free.
2. **Bun is a young, VC-funded runtime** (Oven). Runtimes die; this project
   plans in decades. (Kuzu — a VC-funded embedded database that shut down
   and archived in 2025 — is this repo's standing cautionary tale.)

## Decision

Implement in **TypeScript on Bun**, with three guardrails that contain both
costs:

1. **The schema is the contract.** `docs/SCHEMA.md` (DDL + semantics +
   numbered invariants) is the durable API, versioned via `meta.schema_version`.
   Any language, any decade, can open `memory.db`. The TypeScript is the
   replaceable part, which is what code should be.
2. **The runtime bet is contained in one file.** Only `src/storage/bun.ts`
   may import `bun:sqlite`, behind a ~dozen-method adapter interface. The
   exit ramp is documented: Node's `node:sqlite` is converging, and Bun
   itself is MIT (survives its company).
3. **Conformance is data-level.** Fixtures are scenario files against the
   schema (operations in, expected rows/results out), so a future port — any
   runtime, any language — proves parity mechanically.

One contract improvement rides along: the library goes from "model-free" to
**"vectors in, never models"** — even the `Embedder` interface leaves the
library. Hosts embed queries/content themselves (async, outside) and hand in
`Float32Array`s; the library stores and fuses them synchronously. The entire
library is synchronous as a result.

## Consequences

- **No host coupling**: the library stands alone. Interop with any other
  process, if ever wanted, is that process mounting the schema — read paths
  first. No import, no IPC.
- Go scaffold files (`go.mod`, `*.go`) are deleted; their content lives on
  as the TS contract (`src/*.ts`), largely shape-for-shape.
- Deployment story: `bun build --compile` for a standalone binary (~90 MB,
  embeds the runtime) — acceptable for a personal tool; the runtime install
  is the normal dev path.
- Revisit trigger: if Bun's health degrades (release cadence stalls,
  `bun:sqlite` regressions accumulate), port `src/storage/` to `node:sqlite`
  behind the same adapter — a bounded, conformance-verified job.
