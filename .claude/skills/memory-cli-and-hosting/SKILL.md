---
name: memory-cli-and-hosting
description: Use when operating or hosting balaur-memory — the balaur CLI (removed at HEAD; live in <=v0.4.3 pins such as web), running balaur commands (recall, propose, decide, doctor, backup), choosing --dir/BALAUR_DIR, "where did my data go" confusion, backing up or restoring memory.db, WAL safety, index.db rebuilds, host patterns (journal, habits, tasks, measurements, recurrence, net worth, daily tick), or whether an agent may touch the CLI or owner verbs.
---

# memory-cli-and-hosting — operating balaur-memory

The `balaur` CLI reference, data-safety runbooks, and the HOSTING.md
host-pattern digest for **balaur-memory** (the consent-gated memory
library at `/home/alex/projects/balaur/memory`).

**Read this first (2026-07-08): the CLI was REMOVED at memory HEAD** —
commit `3ddb84b` "feat!: drop the balaur CLI", an explicit owner decision
("direct bun library" is the only supported surface; rationale and
accepted costs: **memory-failure-archaeology** §11). HEAD is unreleased;
the last tag is `v0.4.3`, which still ships the CLI — so everything
CLI-shaped below is **version-pinned to ≤v0.4.3 consumers**. On this box
that means web (`balaur-memory` pinned `#v0.4.3`): `bunx balaur --help`
run inside `web/` works (verified live 2026-07-08, exit 0). The hosting
patterns (§5) are library-API guidance and remain fully current —
`docs/HOSTING.md` ships at HEAD and its samples are TypeScript, not CLI.
Library-first is the default for anything new; reach for the pinned CLI
only as an owner convenience against an existing store.

**Scope boundary — when NOT to use this skill:**

| You need | Go to |
|---|---|
| Schema, the 17 invariants, consent/lifecycle theory, ranking math, library API semantics | `memory-domain-reference` |
| Changing the library itself, release runbook, non-negotiable rules | `memory-change-control` |
| Why something is designed this way / past dead ends | `memory-failure-archaeology` |
| Conformance suite, adding test evidence | `memory-validation-and-qa` |
| Wiring memory into the web chat agent | `balaur-memory-web-campaign` (workspace root) |

Jargon, defined once:
- **Store** — the library's single class (`src/store.ts`); the CLI is a thin host over it.
- **memory.db** — the one SQLite record file. The data. Sacred.
- **index.db** — the disposable derived search index (invariant I13: always rebuildable, always exact).
- **WAL** — SQLite write-ahead log; recent writes live in `memory.db-wal` until checkpointed, which is why raw file copies of an open store lose data.
- **owner vs agent** — the human is the *owner* (full trust); an LLM/automation is an *agent* and only ever gets the propose/recall verbs, gated by the consent queue.

## 1 · CLI anatomy (as of v0.4.3 — the last version that has one)

The CLI was `cli/index.ts` (entry + global flags), `cli/args.ts`
(hand-rolled parser), `cli/commands.ts` (the `COMMANDS` map),
`cli/render.ts` (text/JSON output). It never imports `bun:sqlite`;
everything goes through `Store`. At HEAD these files exist only in
history: `git show v0.4.3:cli/index.ts` (etc.), or in web's pinned
install at `/home/alex/projects/balaur/web/node_modules/balaur-memory/cli/`.

**39 subcommands** (counted in the `COMMANDS` map, `cli/commands.ts` at
v0.4.3), each mapping 1:1 to a `StoreContract` method. Full grouped
table with every flag and default: [references/cli-commands.md](references/cli-commands.md).
Digest:

| Group | Commands |
|---|---|
| Reads / recall | `get`, `recall`, `search`, `context`, `children`, `neighborhood`, `pending`, `doctor`, `conflicts`, `stale` |
| Temporal | `agenda`, `episode`, `day-anchor` |
| Spine writes | `register-type`, `create`, `edit`, `link`, `close-edge` |
| Consent | `propose`, `propose-edit`, `decide` |
| Lifecycle | `forget`, `transition`, `quarantine`, `set-surfacing`, `touch` |
| Identity | `who`, `alias`, `unalias`, `aliases`, `merge`, `survivor`, `suggest-identities` |
| Lineage / history | `history`, `record-derivation` |
| Vectors / index | `put-vector`, `delete-vectors`, `rebuild-index` |
| Backup | `backup` |

**Global flags** (`cli/index.ts`):

| Flag | Meaning |
|---|---|
| `--dir PATH` | directory holding `memory.db` + `index.db` |
| `--now ISO` | freeze the store clock (testing / reproducible scripts) |
| `--json` | raw `JSON.stringify` of the contract's return value (default: compact text) |
| `--help`, `-h` | global help. There is NO per-command help: `balaur get --help` prints the same global text (verified) — per-command usage strings live only in `cli/commands.ts` and `docs/CLI.md` |

**Exit codes** (verified live 2026-07-07): `0` success (including `--help`),
`1` any runtime error (`error: <code>: <message>` on stderr, e.g.
`error: conflict: backup target already exists`), `2` unknown command or
unparseable `--now`.

**Two ways to run it (both version-pinned, verified 2026-07-08):**

```bash
# in a consumer repo pinned to a CLI-bearing tag (≤v0.4.3 ships bin "balaur"):
cd /home/alex/projects/balaur/web && bunx balaur --help   # exit 0, works today

# from history (the memory checkout no longer has cli/ at HEAD):
git -C /home/alex/projects/balaur/memory show v0.4.3:cli/index.ts   # read it
# to RUN it from history, check out the tag in a scratch worktree first
```

An unpinned `bun add github:balaur-software/memory` follows the default
branch — which has NO CLI and no `bin` entry. Pin `#v0.4.3` if you need
the CLI.

> **⚠️ MACHINE-SPECIFIC TRAP (verified 2026-07-08): on this box, bare
> `balaur` on PATH is `/home/alex/.local/bin/balaur` — the LEGACY
> balaur-life Go binary, a DIFFERENT application** with overlapping
> command names (`doctor`, `search`, `memory`) and different exit-code
> semantics (e.g. it exits 0 on a `--dir` permission error). Even
> `bunx balaur` from the memory checkout resolves to it. **Never run bare
> `balaur` here.** Check with `which balaur` before following any runbook.
>
> Also as of 2026-07-08: `memory/cli/` no longer exists at memory HEAD —
> the CLI was **removed** by owner decision in commit `3ddb84b`
> ("feat!: drop the balaur CLI", 2026-07-07); this skill documents it as
> of v0.4.3, where it still ships. The working v0.4.3 CLI on this box is
> web's pinned install: `/home/alex/projects/balaur/web/node_modules/.bin/balaur`
> (or `bunx balaur` run inside `web/`, where the local bin wins). The
> `balaur ...` snippets below assume you have shadowed the legacy binary
> first:
>
> ```bash
> alias balaur='/home/alex/projects/balaur/web/node_modules/.bin/balaur'
> ```
>
> Doctrine note: "never hand an agent shell access to the balaur CLI"
> (§4) fences BOTH binaries — the legacy one also mutates a data store.

### Data-dir resolution and THE TRAP

Resolution chain (`defaultDir()` in `cli/index.ts` at v0.4.3):

1. `--dir PATH`
2. `$BALAUR_DIR` (if set and non-empty)
3. `$HOME/.local/share/life` (falls back to `$USERPROFILE`, then `.`)

**THE TRAP: the CLI `mkdirSync(dir, { recursive: true })`s whatever
directory it resolves and opens a fresh, empty store there.** A typo'd
`--dir`, an unset `BALAUR_DIR` in a cron environment, or running from the
wrong user never errors — it silently creates a new empty `memory.db`.
"Where did my data go" is almost always *wrong directory*, not data loss.
Locate real stores:

```bash
find ~ -name memory.db -not -path '*/node_modules/*' 2>/dev/null
# a real store is the one with size >> 40KB and content:
balaur --dir <candidate-dir> doctor        # activeCount tells you
```

As of 2026-07-08 (re-verified) **no live store exists on this box**
(`~/.local/share/life` does not exist) — machine-specific fact; if a
`balaur doctor` shows a store there, someone created it after this was
written. Note the mkdir trap is a ≤v0.4.3 CLI behavior; HEAD's library
`Store.open` also creates a missing dir (0700 since `1219dcd`) — the
"wrong directory, not data loss" diagnosis applies to both.

## 2 · Parser quirks (cli/args.ts at v0.4.3 — verified when it was live)

Accepted forms: `--flag value`, `--flag=value`, bare `--bool`. First
positional is the subcommand; later non-flags are positionals.

| Quirk | Consequence |
|---|---|
| A `--flag` whose next token starts with `--` silently becomes a **boolean** | Flag values can NEVER begin with `--`. `balaur create --type note --title --body "x"` loses the title and `--title` becomes a meaningless bool → `error: create requires --type and --title` (verified). Use `--title="--weird"` (the `=` form) if a value must start with dashes |
| Repeated flags **collect** into arrays | `--prop k=v --prop k2=v2` works; commands that read one value take the first |
| `--` ends flag parsing | everything after is positional |
| Missing value at end of argv → boolean, never an error | the command's own validation catches it (or doesn't) |
| `--now` uses **lenient** `new Date(...)` parsing | `--now "July 5 2026"` is accepted (verified), while every date the *library* stores (`--when`, `--valid-from`, `--review-at`, window bounds) goes through strict `parseStrictIso` (`src/types.ts`): only `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS[.mmm]Z`. This inconsistency is known — do NOT "fix" it casually; see `memory-change-control` before touching |

Prop value coercion (`--prop k=v`): `true`/`false` → boolean, integer/decimal
strings → number, everything else → string. The type's props schema at the
write choke point is the real validator.

### Sharp-edged defaults (all verified in cli/commands.ts at v0.4.3)

| Command | Default | Sharp edge |
|---|---|---|
| `merge <keep> <other>` | `--verdict` defaults to **`same`** | omitting `--verdict` silently performs the irreversible-ish compound merge. Always pass `--verdict` explicitly |
| `suggest-identities <type>` | `--cap` defaults to **0** | without `--cap N` it is a **no-op** returning `{"added":0}` (verified live; the library's own default is 20 but the CLI overrides it with 0) |
| `register-type` | `--born-status` anything other than the literal `proposed` → **`active`** | a typo (`--born-status propsed`) silently registers an ungated type — check the echoed `bornStatus` in the output |
| `decide <id>` | `--kind` defaults to `approve` | fine, but be aware a bare `decide` approves |
| `link <s> <t>` | `--type` defaults to `links`, `--context` to `""` | |
| `create`/`propose` | `--origin` defaults to `cli` | provenance is mandatory (I10) — pass a real origin from scripts |
| `recall`/`search`/`agenda`/`episode`/`context` | `--limit` defaults to **8** | |

## 3 · Data-safety runbooks

These runbooks are LIBRARY semantics; the `balaur ...` command forms are
the ≤v0.4.3 convenience wrapper (shadow the legacy binary first — §1
warning). **Library-first equivalent** (works against HEAD or any pin;
run where `balaur-memory` is installed, e.g. `web/`):

```bash
cd /home/alex/projects/balaur/web && bun -e '
  import { Store } from "balaur-memory";
  const s = Store.open({ dir: process.env.DIR });
  s.backup(process.env.OUT);          // or: s.rebuildIndex(); console.log(s.doctor());
  s.close();'
```

HEAD-only behavior differences (unreleased; the v0.4.3-pinned CLI does
NOT have them): backup refuses a target inside the live store dir and
cleans up after a mid-write failure; backups and store files are chmod
0600, store dirs 0700 (`7c51c3f`, `1219dcd`).

### Backup

`balaur backup <toPath>` = SQLite `VACUUM INTO` (`src/store.ts`): WAL-safe
(captures un-checkpointed writes), compacted output, **refuses an existing
target** — backups never overwrite.

```bash
balaur --dir "$DIR" backup /backups/memory-$(date -u +%F).db
# → {"ok":true,"path":"/backups/memory-2026-07-07.db"}
# second run same day:
# → error: conflict: backup target already exists — backups never overwrite   (exit 1)
```

Rules:
- `index.db` is NEVER backed up — disposable (I13).
- **NEVER raw-copy `memory.db` while any process has the store open** — the
  WAL holds recent writes your copy silently loses. Raw copy is safe only
  when nothing has it open.
- The target path is resolved relative to the process cwd, not `--dir`.
- Keep daily/weekly/monthly generations; an untested backup is a hope, not
  a backup (see verify below).

### Restore

```bash
mkdir -p /path/to/fresh-dir
cp /backups/memory-2026-07-07.db /path/to/fresh-dir/memory.db
balaur --dir /path/to/fresh-dir rebuild-index     # → {"ok":true}
balaur --dir /path/to/fresh-dir doctor
# expect: active=<your count>  ...  integrityOk=true
```

Verified end-to-end 2026-07-07 (backup → copy as memory.db → rebuild-index
→ doctor `integrityOk=true` → recall finds the content).

### Verify

```bash
balaur --dir "$DIR" doctor --json
```

Fields (from `DoctorReport`, `src/contract.ts`): `activeCount`,
`pendingCount`, `acceptRate30d`, `deadWeightCandidates`, `staleCandidates`,
`duplicateCandidates`, `dueCandidates`, `queueOldestDays`, **`integrityOk`**
(SQLite `PRAGMA integrity_check` — file health, distinct from content
health). Doctor reports, never acts. That nine-field shape is what the
v0.4.3-pinned CLI prints; library HEAD (unreleased, `005da77` breaking)
adds `pendingByKind`, `historyRows`, `reproposedAfterForget30d` — see
memory-domain-reference references/api.md.

### Rebuild index

```bash
balaur --dir "$DIR" rebuild-index
```

Always safe, always exact (I13: `index.db` is a pure derivation of
`memory.db`). If search results look wrong or `index.db` is missing/corrupt,
this is the fix — never a risk.

## 4 · The owner-surface doctrine (read before automating anything)

The (≤v0.4.3) CLI maps 1:1 to the **FULL** `StoreContract` — including
`decide`, `forget`, `edit`, `transition`, `merge` — because the human
running it IS the authenticated owner. The consent queue protects the
owner from agents, not from themselves (docs/HOSTING.md;
`git show v0.4.3:docs/CLI.md` — CLI.md was removed with the CLI). The
doctrine outlives the CLI: it applies identically to any owner-verb
surface a host exposes.

**Therefore: NEVER hand an agent shell access to the `balaur` CLI as a
tool.** An agent with the CLI holds every owner verb — it can approve its
own proposals (`decide`), erase history (`forget`), and rewrite records
(`edit`). That is the wire-shaped hole the whole consent design exists to
close. Agent access goes through:

- the **deferred** MCP server sketch (docs/INTEGRATIONS.md — status
  DEFERRED, nothing built): agent verbs only — `memory_propose`,
  `memory_propose_edit`, `memory_recall`/`memory_search` and bounded reads;
  "No agent-reachable owner verbs, ever, on any surface";
- or a host's own gated tools — the live plan for the web chat agent; see
  `balaur-memory-web-campaign` at the workspace root.

Scripting the CLI *on the owner's explicit behalf* (cron backup, daily
tick) is fine — that is the human delegating, not an agent deciding.

## 5 · Host patterns (docs/HOSTING.md digest)

The division of labor: the library is a pure function of its data and the
clock — no scheduler, no daemon, no models. The HOST ticks, authenticates
the owner, converts time zones, renders the queue, calls models. Each
pattern below: the key call sequence + its trap. Full prose with code:
`docs/HOSTING.md` — which **ships at HEAD** (in the package `files` list
and not export-ignored; verified 2026-07-08) and whose code samples are
library-API TypeScript. These patterns are fully current guidance. The
`balaur ...` command forms below are the ≤v0.4.3 CLI TRANSCRIPTION of
those calls — kept because that CLI still runs on this box (web's pin);
translate 1:1 to `store.*` methods for HEAD work (command → method map:
references/cli-commands.md).

### Type registry for a life
```bash
balaur register-type journal  --born-status active
balaur register-type person   --born-status active
balaur register-type task     --born-status proposed   # agents propose; you decide
balaur register-type memory   --born-status proposed
balaur register-type preference --born-status proposed
```
Owner types born `active`; agent-writable types (`task`, `memory`,
`preference`) born `proposed` — that IS the consent surface (I1). Trap:
the born-status typo edge (§2 table).

### Journal + episode-vs-neighborhood
Capture: `create --type journal ... --prop mood=4` (day anchor is automatic
via `on_day`). Read a RANGE with `episode <from> <to> --type journal` — a
pure read; walking an empty month creates nothing. Read ONE day you are
rendering with `neighborhood $(day-anchor <date> id)`. **Trap: never loop
`day-anchor` over a range just to read — it CREATES a node per day** (this
is exactly why `episode` exists).

### Habits
A habit is a node; each completion is a `checkin` node with `when` = the
moment, linked `check_of` → habit. **Existence IS completion** — no `done`
prop. Read: `children <habitId> check_of`. Trap: streak/completion math is
HOST date arithmetic over the `when` values; the library will not count for
you.

### Measurements
One `measurement` node per reading, `props.metric` + `props.value`
(props-schema-validated numbers), `when` = the reading's moment. Trap:
aggregation (min/max/avg SQL over `json_extract(props,...)`) runs on a
**separate read-only SQLite connection** — WAL permits concurrent readers
(I14); analytics never goes through the Store's writer.

### Recurrence and birthdays
The rule lives in props (e.g. `--prop rrule='FREQ=WEEKLY;BYDAY=MO'`); the
HOST materializes each next instance (`create` + `link <instance> <rule>
--type instance_of`) on completion or the daily tick. Trap: the library
stores what you declare (I17) and **never parses rrule** — the grammar is
yours.

### Task loop + owner fast path
Agent path: `propose --type task ...` → owner `pending` → `decide <id>
--kind approve|approve_edited|reject`. Owner path is DIRECT, no queue
theater: `create`; snooze = `edit <id> --when <iso>` (one call); done =
`edit <id> --prop outcome=done` + `transition <id> archived` (two calls).
Board: `agenda <today> <+7d> --type task`; overdue = `doctor`'s
`dueCandidates`. Trap: `--prop` patches merge (`propsPatch`); the library's
`props` replaces wholesale — the CLI only exposes the merge form.

### Project dashboards
Steps `link <step> <project> --type part_of`; ordering in `props.seq`
(edges are unordered). Open = `children <project> part_of` (default:
active); progress = compare against `--statuses active,archived`; the
prompt card = `context <project>` (`entityContext`).

### Capture wrappers + the two content grammars
The API is a schema; your app should speak in verbs — write the thin
wrapper layer ONCE (raw capture measured at 3–5 calls per thought;
wrappers make it one). Content conventions that pay at prompt time:
facts as `"[health] allergic to penicillin"` (category in brackets);
episodic bodies in the four-part `observation / thoughts / action /
result` shape.

### Supersede vs edit
Ask: **did the world change, or did the record?** World changed ("moved to
Cluj") → `propose` the new + `decide --kind approve_superseding
--supersedes <oldId>`: old node archives, the `supersedes` edge is the
story, `history` of the new node is empty. Record was wrong ("it's
Cluj-Napoca") → `edit` / `--kind approve_edited`: same node, `history`
replays every prior wording. Conflating the two loses either the timeline
or the paper trail.

### The UTC-day warning
All library time is UTC (I11); day anchors are UTC calendar days. A 01:30
Bucharest (east-of-UTC) capture files under *yesterday's* UTC day. Hosts
convert at the edge: compute the local day, then `day-anchor` that date,
and build `agenda`/`episode` windows from local-midnight-converted-to-UTC.
The library never guesses a timezone.

### Net worth
Measurement pattern with two twists: one `account` node per real account
(**liabilities are negative-balance accounts**, no separate type — `SUM`
nets); each statement is a `holding` snapshot (`props.balance_minor` as
**integer minor units, never floats**; `props.currency`), `when` = the
as-of moment, linked `snapshot_of` → account, born `--surfacing ask` so
balances stay out of ambient recall. Net worth as of a date = the **newest
snapshot per account, summed per currency** (read-only SQL with
`ROW_NUMBER() OVER (PARTITION BY account ORDER BY when_at DESC)`, or
`children` + a JS reduce). Series is append-only: correct history by adding
a snapshot, never mutating one.

### The daily tick
A host's once-a-day job, in order — "five calls and a loop":
1. materialize due recurrence instances (host mints `create` + `instance_of` links),
2. `agenda <today> <+1d>` for the board,
3. `doctor` (`dueCandidates`, `pendingCount`, `staleCandidates`, `integrityOk`),
4. render the consent queue if `pending` is non-empty,
5. `backup <dated-path>`.

The library holds the life; the tick just looks at the clock. Scheduling
belongs to cron/the host, never the library.

## 6 · The standalone binary — GONE at HEAD

The `build`/`build:cross` `bun build --compile` scripts were removed with
the CLI in `3ddb84b` (verified 2026-07-08: no `"build"` scripts, no `bin`
in `package.json` at HEAD); ADR-0001's standalone-binary deployment story
has no target anymore — an accepted cost named in the commit. If you ever
truly need the binary, the v0.4.3 pin still carries the scripts
(`web/node_modules/balaur-memory/package.json` has `build`/`build:cross`;
the ~90 MB size figure came from the removed docs/CLI.md) — but building
one is re-opening a settled owner decision: see
**memory-failure-archaeology** §11 first.

## Related skills

- `memory-domain-reference` — schema, invariants I1–I17, consent/identity/temporal theory behind every verb here.
- `memory-change-control` — before changing CLI or library code (incl. the `--now` leniency inconsistency).
- `memory-validation-and-qa` — test evidence conventions (the CLI's own in-process tests, `cli/index.test.ts`, were removed with it).
- `memory-failure-archaeology` — why patterns look the way they do (e.g. the dayAnchor-loop incident).
- `balaur-run-and-operate` (workspace root) — this box's services, ports, systemd.
- `balaur-memory-web-campaign` (workspace root) — the sanctioned agent-access path into memory.

## Provenance and maintenance

CLI facts were originally verified live 2026-07-07 against `9182b14` (the
last pre-removal HEAD, CLI content identical to tag v0.4.3); refreshed
2026-07-08 against HEAD `f1b168a`, where the CLI is REMOVED (`3ddb84b`)
and everything CLI-shaped is version-pinned to ≤v0.4.3. Drift-prone facts:

| Fact (as of 2026-07-08) | Re-verify with |
|---|---|
| CLI gone at HEAD; present in the v0.4.3 tag | `ls /home/alex/projects/balaur/memory/cli 2>&1` (fails); `git -C /home/alex/projects/balaur/memory show v0.4.3:cli/index.ts \| head -3` |
| web's pinned CLI works | `cd /home/alex/projects/balaur/web && bunx balaur --help; echo $?` (expect 0) |
| 39 commands in the COMMANDS map (v0.4.3) | count the keys: `bun -e 'import("/home/alex/projects/balaur/web/node_modules/balaur-memory/cli/commands.ts").then(m=>console.log(Object.keys(m.COMMANDS).length))'` |
| Per-command flags/defaults (limit 8, kind approve, verdict same, cap 0, type links, born-status active) | read the command's block: `git -C /home/alex/projects/balaur/memory show v0.4.3:cli/commands.ts` (or web's pinned copy) |
| Data-dir chain `--dir` → `$BALAUR_DIR` → `~/.local/share/life` → `.` | `git -C /home/alex/projects/balaur/memory show v0.4.3:cli/index.ts \| grep -n -A8 'function defaultDir'` |
| No live store on this box (machine-specific, re-verified 2026-07-08) | `ls ~/.local/share/life` |
| Bare `balaur` on PATH = legacy balaur-life binary, NOT this CLI (machine-specific, as of 2026-07-08) | `which balaur` (if it prints `/home/alex/.local/bin/balaur`, the trap is live) |
| Exit codes 0/1/2 | `cd /home/alex/projects/balaur/web && bunx balaur nope >/dev/null 2>&1; echo $?` (expect 2) |
| `--now` lenient vs strict library dates | `git -C /home/alex/projects/balaur/memory show v0.4.3:cli/index.ts \| grep -n 'new Date(nowIso)'` and `grep -n 'parseStrictIso' /home/alex/projects/balaur/memory/src/types.ts` |
| backup = VACUUM INTO, refuses existing target (+ HEAD-only in-store-dir guard) | `grep -n -A4 'backup(toPath' /home/alex/projects/balaur/memory/src/store.ts` |
| No build scripts / no bin at HEAD | `grep -n '"build\|"bin"' /home/alex/projects/balaur/memory/package.json` (empty) |
| HOSTING.md ships at HEAD (files list; not export-ignored) | `grep -n 'HOSTING' /home/alex/projects/balaur/memory/package.json /home/alex/projects/balaur/memory/.gitattributes` |
| MCP integration still DEFERRED; library = the only supported surface | `head -8 /home/alex/projects/balaur/memory/docs/INTEGRATIONS.md` |
| HEAD / tag state (expect v0.4.3-14-gf1b168a or later) | `git -C /home/alex/projects/balaur/memory describe --tags` |
