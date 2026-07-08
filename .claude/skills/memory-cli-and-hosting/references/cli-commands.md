# balaur CLI — full command reference (39 commands, ≤v0.4.3 only)

**The CLI was removed at memory HEAD in `3ddb84b` (2026-07-07).** This
reference documents the CLI as it ships in tag `v0.4.3` — the version
consumers pin (web does; its copy at
`/home/alex/projects/balaur/web/node_modules/balaur-memory/cli/` runs
today). Originally verified against `cli/commands.ts` at `9182b14`, whose
cli/ content is identical to v0.4.3; view source via
`git -C /home/alex/projects/balaur/memory show v0.4.3:cli/commands.ts`.
Every command calls exactly one `Store` method; the "Backs onto" column is
that method (`src/contract.ts`) — which also makes this table the CLI→
library translation map for HEAD work. Conventions used below:

- `<x>` = required positional, `[x]` = optional. Multi-word positionals
  marked "rest-joined" are `positionals.slice(n).join(" ")` — no quoting
  needed for spaces after that point.
- Flags take `--flag value` or `--flag=value`; a value may never START
  with `--` unless you use the `=` form (parser quirk, SKILL.md §2).
- "repeatable" = values collect (`--prop a=1 --prop b=2`).
- All dates the LIBRARY stores are strict ISO-8601 UTC: `YYYY-MM-DD`
  (→ midnight UTC) or `YYYY-MM-DDTHH:MM:SS[.mmm]Z`. Anything else →
  `error: props_invalid` (exit 1). Only the global `--now` is lenient.
- Text output is compact human lines; `--json` is the raw contract return
  value. Ack-only commands print `{"ok":true,...}` in both modes.

## Global flags (before or after the subcommand — position is irrelevant)

| Flag | Default | Notes |
|---|---|---|
| `--dir PATH` | `$BALAUR_DIR`, else `~/.local/share/life` | mkdir'd if missing — THE TRAP (SKILL.md §1) |
| `--now ISO` | real clock | lenient `new Date()` parse; unparseable → exit 2 |
| `--json` | off (text) | `JSON.stringify(value, null, 2)` |
| `--help`, `-h` | | global help only; no per-command help exists |

## Reads / recall

| Command | Backs onto | Flags (default) | Notes |
|---|---|---|---|
| `get <id>` | `getNode` | — | any status; unknown id → `not_found` (exit 1) |
| `recall [terms...]` | `recall` | `--type T`, `--limit N` (8), `--model M` + `--vector 0.1,0.2,...` (both or neither) | ranked lexical (+ optional vector) recall |
| `search [terms...]` | `search` | `--limit N` (8) | cross-type recall over all active knowledge |
| `context <id>` | `entityContext` | `--limit N` (8) | the bounded peer card for prompts |
| `children <id> <edgeType>` | `children` | `--statuses a,b` (library default: active only) | nodes whose `<edgeType>` edge points AT id |
| `neighborhood <id>` | `neighborhood` | — | 1-hop active set, currently-valid edges |
| `pending` | `pendingQueue` | — | everything awaiting the owner: proposals, edits, identity questions |
| `doctor` | `doctor` | — | metadata-only health report; fields listed in SKILL.md §3 |
| `conflicts <id>` | `conflictsFor` | — | advisory duplicate/contradiction hints for one pending item |
| `stale` | `staleDerivations` | — | derived artifacts whose sources changed or were forgotten |

## Temporal

| Command | Backs onto | Flags (default) | Notes |
|---|---|---|---|
| `agenda <from> <to>` | `agenda` | `--type T`, `--limit N` (8) | scheduled window: `when_at` in `[from, to)` — half-open |
| `episode <from> <to>` | `episode` | `--type T`, `--limit N` (8) | episodic past: `created` in `[from, to)` — a pure read |
| `day-anchor <YYYY-MM-DD>` | `dayAnchor` | — | **get-or-CREATE** the UTC day node — never loop it over a range to read; use `episode` |

## Spine writes (owner)

| Command | Backs onto | Flags (default) | Notes |
|---|---|---|---|
| `register-type <name>` | `registerType` | `--born-status active\|proposed` (**active**; any non-`proposed` value silently → active) | I1: bornStatus is the consent split. propsSchema is library-only — not settable from the CLI |
| `create` | `createNode` | `--type`\*, `--title`\*, `--body`, `--importance N`, `--when ISO`, `--surfacing always\|ask\|never`, `--origin` (`cli`), `--author`, `--prop k=v` repeatable | owner write — born active; provenance mandatory (I10) |
| `edit <id>` | `updateNode` | `--title`, `--body`, `--when ISO`, `--clear-when` (wins over `--when`), `--prop k=v` repeatable (propsPatch MERGE), `--clear-prop k` repeatable | ACTIVE nodes only; owner path, works on consent-gated types too |
| `link <source> <target>` | `link` | `--type` (`links`), `--context` (`""`), `--valid-from ISO`, `--valid-until ISO` | idempotent on open triples |
| `close-edge <edgeId>` | `closeEdge` | `--until ISO` (now) | "this fact stopped being true" — closes validity, keeps the row |

\* = required; missing → `error: create requires --type and --title` (exit 1).

## Consent (agent verbs + the owner's verdict)

| Command | Backs onto | Flags (default) | Notes |
|---|---|---|---|
| `propose` | `propose` | `--type`\*, `--title`\*, `--body` (`""`), `--importance N`, `--when ISO`, `--origin` (`cli`), `--author`, `--prop k=v` repeatable | agent-shaped write, gated at write time; returns created/merged/exists outcome. No `--surfacing` (unlike `create`) |
| `propose-edit <id>` | `proposeEdit` | `--field k=v` repeatable, `--archive` (bool), `--origin` (`cli`), `--author` | parks a change to an active consent-gated node; owner applies later |
| `decide <id>` | `decide` | `--kind approve\|reject\|approve_edited\|approve_superseding` (**approve**), `--supersedes ID` (with approve_superseding), `--field k=v` (with approve_edited) | the owner's verdict on a pending item |

## Lifecycle

| Command | Backs onto | Flags (default) | Notes |
|---|---|---|---|
| `forget <id>` | `forget` | — | the honest erasure cascade (I6/I7); reports tombstoned/edgesDropped/indexScrubbed/flaggedStale/needsOwner |
| `transition <id> <status>` | `transition` | — | status FSM move (owner action) |
| `quarantine <id>` | `quarantine` | `--review-at ISO` (strict) | suppress everywhere, ask-twice to view |
| `set-surfacing <id> <always\|ask\|never>` | `setSurfacing` | — | |
| `touch <id>` | `touch` | — | record that recalled knowledge was used (feeds ranking + doctor) |

## Identity

| Command | Backs onto | Flags (default) | Notes |
|---|---|---|---|
| `who <type> <name...>` | `resolveRef` | — | name is rest-joined; returns candidates — YOU pick, never the library |
| `alias <id> <alias...>` | `addAlias` | — | alias is rest-joined |
| `unalias <id> <alias...>` | `removeAlias` | — | |
| `aliases <id>` | `aliasesOf` | — | all names the node answers to |
| `merge <keep> <other>` | `decideIdentity` | `--verdict same\|different` (**same** — always pass explicitly!) | same = compound merge, survivor by ARGUMENT ORDER; different = permanent no_match (I9) |
| `survivor <id>` | `survivorOf` | — | walk `merged_into` to the living end |
| `suggest-identities <type>` | `suggestIdentities` | `--cap N` (**0 = no-op!** library default 20 is bypassed) | writes deterministic identity questions to the queue; prints `{"added":N}` |

## Lineage / history

| Command | Backs onto | Flags (default) | Notes |
|---|---|---|---|
| `history <id>` | `history` | — | pre-mutation snapshots (what the node used to say) |
| `record-derivation <artifact> [sources...]` | `recordDerivation` | — | register a derived artifact's source nodes |

## Vectors / index

| Command | Backs onto | Flags (default) | Notes |
|---|---|---|---|
| `put-vector <id> <model> <0.1,0.2,...>` | `putVector` | — | vector is a comma-joined positional; host-computed vectors only (vectors in, never models) |
| `delete-vectors` | `deleteVectors` | `--model M` (absent = ALL vectors) | |
| `rebuild-index` | `rebuildIndex` | — | rebuild index.db from memory.db — I13, always safe, always exact |

## Backup

| Command | Backs onto | Flags (default) | Notes |
|---|---|---|---|
| `backup <toPath>` | `backup` | — | `VACUUM INTO`: WAL-safe, compacted, refuses an existing target (exit 1, `error: conflict: ...`). Path resolves against process cwd. index.db is never included |

## Prop value coercion (`--prop k=v`, `--field k=v`)

| Input | Stored as |
|---|---|
| `true` / `false` | boolean |
| matches `-?\d+(\.\d+)?` | number |
| anything else | string |

The type's props schema (set via the library's `registerType` propsSchema)
is the authoritative validator at the write choke point — coercion is just
a convenience heuristic.
