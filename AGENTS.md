# balaur-memory project instructions

This repository is the memory layer of a personal life OS as a standalone Go
library, extracted from Balaur. Keep this file lean and high-signal.

## Working style

- KISS, YAGNI, suckless. Deterministic, offline, free is the default
  behavior — anything model-adjacent hides behind an optional host-supplied
  interface.
- **The model-free rule is absolute: this library never calls an LLM.** If a
  feature seems to need one, the feature belongs in a host, and this library
  grows the deterministic seam it lands on.
- Pure Go, CGO_ENABLED=0 always. SQLite via `github.com/ncruces/go-sqlite3`
  (wazero, FTS5 included) — the only allowed driver.
- Two files: `memory.db` is the record; `index.db` is disposable and must
  ALWAYS be safely deletable — any feature that breaks rebuild-from-source
  is wrong by definition.
- The consent boundary lives in the data layer (status FSM + queue), never
  in documentation or caller discipline.
- Audit entries are content-free: ids, actions, counts, flags — never quoted
  text, never payload snapshots. Forget-class operations especially.
- No server, no scheduler, no goroutine leaks: the host owns lifecycle.

## Commands

- `gofmt -l .` (must be empty) · `go vet ./...` · `go test ./... -count=1`
- `CGO_ENABLED=0 go build ./...` must always pass.

## Migration discipline

- `docs/MIGRATION.md` is the phase map and its Status table is canonical —
  update it in the same change that lands a phase.
- Phases are redesigns informed by Balaur's code, not mechanical ports; port
  the TESTS alongside and keep them green.
- API changes are free before Phase 1 ships and deliberate after; breaking
  changes to `contract.go`'s shape get a line in the commit body explaining
  what consumer need forced them.

## Landing changes

- Never commit or push unless the owner explicitly asks. When they do:
  conventional-commit subjects (`feat`/`fix`/`docs`/`refactor`/`test`),
  straight to `main`, gated on the full command set above.
