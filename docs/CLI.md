# CLI.md — the `balaur` command-line interface

The `balaur` CLI is the second of the two supported surfaces for now
(the in-process library is the first — see the [README](../README.md)).
It is a thin **host** over `Store`: it owns argument parsing, rendering,
and the clock; it calls the library and nothing else. It never imports
`bun:sqlite` (ADR-0001 containment holds).

## Two ways to run it

**1. Via `bunx` (after `bun add balaur-memory`)** — the package ships a
`bin` entry, so the CLI is available alongside the import:

```bash
bun add github:balaur-software/memory
bunx balaur --help
bunx balaur doctor
```

**2. As a standalone binary (`bun build --compile`)** — ADR-0001's
deployment story: a single ~90 MB executable that embeds the Bun runtime,
for machines without Bun installed.

```bash
bun run build                 # → dist/balaur
./dist/balaur --help
```

Cross-platform builds (one command, four targets):

```bash
bun run build:cross           # darwin/linux × arm64/x64 → dist/balaur-*
```

## Where the data lives

`--dir` selects the directory holding `memory.db` + `index.db` (created
if missing). The default is `$BALAUR_DIR`, falling back to
`~/.local/share/life`. All library time is UTC (I11); `--now ISO` freezes
the store clock at that moment (primarily for testing / reproducible
scripts).

```bash
balaur doctor                                      # uses ~/.local/share/life
balaur --dir /mnt/life doctor                      # explicit location
BALAUR_DIR=/srv/life balaur doctor                 # via env
balaur --now 2026-07-05T12:00:00.000Z recall x     # frozen clock
```

## Output

Human-readable text by default; `--json` for piping / scripting. Every
value the library returns is JSON-safe (plain data — `src/types.ts`), so
`--json` is the raw `JSON.stringify` of the contract's return type.

```bash
balaur recall zaffre --json | jq '.[0].id'
balaur pending --json
```

## The command list

Each subcommand maps 1:1 to a `StoreContract` method
([src/contract.ts](../src/contract.ts)). The CLI exposes the **full**
surface — the human running it is the authenticated owner (the queue
protects the owner from agents, not from themselves; see
[HOSTING.md](HOSTING.md) "The type registry for a life"). Agent-restricted
access is the deferred MCP server's job, not the CLI's.

### Reads / queue

| Command | Backs onto | Notes |
|---|---|---|
| `get <id>` | `getNode` | fetch one node, any status |
| `recall [terms...]` | `recall` | `--type T`, `--limit N`, `--model M --vector 0.1,0.2,...` |
| `search [terms...]` | `search` | cross-type; `--limit N` |
| `agenda <from> <to>` | `agenda` | `when_at` window; `--type T`, `--limit N` |
| `episode <from> <to>` | `episode` | created-time window; `--type T`, `--limit N` |
| `who <type> <name...>` | `resolveRef` | candidates, you pick |
| `context <id>` | `entityContext` | bounded peer card; `--limit N` |
| `pending` | `pendingQueue` | proposals, edits, identity questions |
| `doctor` | `doctor` | metadata-only health report |
| `children <id> <edgeType>` | `children` | `--statuses active,archived` |
| `neighborhood <id>` | `neighborhood` | 1-hop active set |
| `history <id>` | `history` | pre-mutation snapshots |
| `aliases <id>` | `aliasesOf` | all names the node answers to |
| `survivor <id>` | `survivorOf` | walk `merged_into` to the living end |
| `conflicts <id>` | `conflictsFor` | advisory duplicate/contradiction hints |
| `stale` | `staleDerivations` | derived artifacts with changed sources |

### Writes (owner verbs)

| Command | Backs onto | Notes |
|---|---|---|
| `register-type <name>` | `registerType` | `--born-status active\|proposed` |
| `create` | `createNode` | `--type`, `--title`, `--body`, `--importance N`, `--when ISO`, `--surfacing`, `--origin`, `--author`, repeatable `--prop k=v` |
| `edit <id>` | `updateNode` | `--title`, `--body`, `--when ISO` / `--clear-when`, `--prop k=v` (propsPatch merge), `--clear-prop k` (removes a key) |
| `propose` | `propose` | same flags as `create`; gated at write time |
| `propose-edit <id>` | `proposeEdit` | `--field k=v`, `--archive`, `--origin`, `--author` |
| `decide <id>` | `decide` | `--kind approve\|reject\|approve_edited\|approve_superseding`, `--supersedes ID`, `--field k=v` |
| `link <source> <target>` | `link` | `--type T`, `--context C`, `--valid-from ISO`, `--valid-until ISO` |
| `close-edge <edgeId>` | `closeEdge` | `--until ISO` |
| `forget <id>` | `forget` | the honest erasure cascade |
| `transition <id> <status>` | `transition` | status FSM move |
| `quarantine <id>` | `quarantine` | `--review-at ISO` |
| `set-surfacing <id> <s>` | `setSurfacing` | `always` / `ask` / `never` |
| `alias <id> <alias...>` | `addAlias` | |
| `unalias <id> <alias...>` | `removeAlias` | |
| `merge <keep> <other>` | `decideIdentity` | `--verdict same\|different` |
| `suggest-identities <type>` | `suggestIdentities` | `--cap N` |
| `touch <id>` | `touch` | mark recalled knowledge as used |
| `record-derivation <artifact> [sources...]` | `recordDerivation` | |
| `put-vector <id> <model> 0.1,0.2,...` | `putVector` | host-computed vectors only |
| `delete-vectors` | `deleteVectors` | `--model M` to drop one model's |
| `day-anchor <YYYY-MM-DD>` | `dayAnchor` | get-or-create the UTC day node |
| `rebuild-index` | `rebuildIndex` | I13 — always safe, always exact |
| `backup <toPath>` | `backup` | VACUUM INTO; refuses to overwrite |

### Global flags

`--dir PATH`, `--now ISO`, `--json`, `--help` / `-h`. Run `balaur --help`
for the full list.

## The HOSTING.md patterns, from the shell

The verbs in [HOSTING.md](HOSTING.md) map directly onto CLI subcommands.
A few worked examples:

```bash
# the type registry for a life
balaur register-type journal  --born-status active
balaur register-type person   --born-status active
balaur register-type task     --born-status proposed
balaur register-type memory   --born-status proposed

# the journal
balaur create --type journal --title "Tuesday evening" --body "..." --prop mood=4 --origin journal:1
balaur episode 2026-03-01 2026-04-01 --type journal     # "what happened in March"

# the consent gate (agent proposes, owner decides)
balaur propose --type memory --title "Allergic to penicillin" --origin turn:214
balaur pending                                          # review the queue
balaur decide 01kww1z9... --kind approve                # owner's verdict

# the task loop
balaur create --type task --title "Call Ana" --when 2026-07-07T10:00:00.000Z --origin quick-add
balaur edit 01kww1z9... --when 2026-07-10T09:00:00.000Z       # snooze: one call
balaur agenda 2026-07-05T00:00:00.000Z 2026-07-06T00:00:00.000Z --type task
balaur doctor | grep due                                       # slipped past now

# backup (the procedure, not a suggestion)
balaur backup /backups/memory-$(date -u +%F).db
```

## The daily tick, scripted

A host's once-a-day job (HOSTING.md) becomes a short shell loop over
`balaur` subcommands: materialize due recurrence instances → `agenda` →
`doctor` → render `pending` → `backup`. Five calls and a loop — the
library holds the life; the tick just looks at the clock.

## What the CLI deliberately is not

- **Not an agent surface.** It exposes owner verbs. Agent-restricted
  access (propose/recall only) is the deferred MCP server — see
  [INTEGRATIONS.md](INTEGRATIONS.md) (DEFERRED).
- **Not a scheduler.** Recurrence, notifications, and the daily tick
  belong to a cron / foreground app that calls the CLI.
- **Not a model.** Vectors come from the host (`put-vector`); the CLI
  never calls an LLM or embedder (vectors in, never models).
