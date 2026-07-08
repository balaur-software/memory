# Design spike: export/portability and one-command restore, as library verbs

> **Type**: design spike (plan 016). No production code changed by this
> document — it is a proposal + evidence for the owner to ratify. All
> `file:line` references are to the **approved worktree**
> (`.claude/worktrees/agent-ad93112a64c4916e7`, HEAD `5b0a7bb`), the
> post-fix tree, not the main repo tree (HEAD `9182b14`). Drift check run:
> `git diff --stat 9182b14 5b0a7bb -- docs/INTEGRATIONS.md docs/HOSTING.md
> docs/SCHEMA.md src/contract.ts src/lifecycle.ts` shows real drift in all
> five files, confirming this spike correctly read the post-fix tree. The
> CLI is removed (plan 002); every verb below is a library API delta —
> `Store.prototype.export(...)` and `Store.restore(...)` — never a CLI flag.

## 0. Probes (evidence, not assertion)

All probes live under
`/tmp/claude-1000/-home-alex-projects-balaur-memory/abfef91e-d2fb-43a8-8e26-754fd479d3d3/scratchpad/export-restore-probe/`
and import `Store` directly from the worktree's `src/store.ts`. Nothing
outside that scratchpad directory and this file was written.

| Probe | What it proves |
|---|---|
| `fixture.ts` | Builds a scratch store covering every status (`proposed`/`active`/`archived`/`rejected`/`quarantined`/`merged`/`forgotten`) × every surfacing (`always`/`ask`/`never`), plus edges crossing a `never` boundary, aliases, a merge (husk), a `derivations` row, and a `memory_history` row (via `updateNode`). |
| `jsonl_probe.ts` | Hand-rolled JSONL exporter implementing §2's consent matrix. Confirmed: default output (both opt-in flags off) contains **zero** occurrences of the `never`, `quarantined`, `proposed`, `rejected`, `forgotten`, or `merged`-husk node ids; the edge from a public node to the `never` node is silently dropped (not just the node); flipping both flags surfaces everything including the `memory_history` row when `includeHistory` is also set. |
| `ics_probe.ts` | Hand-rolled RFC 5545 VEVENT emitter. Confirmed: default output (agenda-style: `status='active' AND surfacing='always'`) includes only the one qualifying event; `includeArchived`/`includeAsk` widen it correctly; comma/semicolon/newline escaping verified against a title containing all three (`Lunch\, then\; a note\nsecond line`). |
| `vcard_probe.ts` | Hand-rolled RFC 6350 VCARD emitter over `person` nodes. Confirmed: the merge survivor's card carries **both** aliases (`ana`, `ana t.` — the second alias is `source='merge'`, written by `decideIdentity`); the merged husk itself never gets a card (status filter excludes `merged`). |
| `forget_report_probe.ts` | Contrasts today's `forget()` — `needsOwner` always contains the literal string `"external:prior-exports"`, even on a store that has *never* exported anything — against the proposed replacement: a `COUNT(*) FROM audit_log WHERE action='store.export' AND ok=1` query, correctly counting 3 (excluding a simulated failed export), and correctly omitting the line entirely on a store with zero exports. |
| `restore_probe.ts` | Prototypes `Store.restore(backupPath, dir)` against a real `store.backup()` output (named with a timestamp, not `memory.db`, per `HOSTING.md` §10's generational-backup convention). Confirmed: full recall/content parity after restore; refuses a non-empty target dir (`"conflict: restore target directory is not empty"`); refuses a nonexistent backup path (`"not_found: ..."`); and — the key finding — **the schema-version future-guard requires zero new code**, because `Store.open()`'s existing `migrateMemoryDb` (`src/storage/schema.ts:184-192`) already throws `"memory.db is schema v99; this build supports up to v4 — upgrade the library, never downgrade the file"` on a doctored future-version file, and `restore()` calls `Store.open()` internally. |

## 1. MIF — verified, then dropped

`grep -in "mif" docs/*.md` across the worktree returns exactly **one**
hit, in `docs/INTEGRATIONS.md:77-78`:

> `balaur-memory export --mif | --ics | --vcard | --jsonl` — MIF for
> cross-tool memory portability, ...

`docs/FIELD.md` — the file plan 016's own text points to for "MIF ... from
FIELD.md's landscape" — was read in full (111 lines) and **never mentions
MIF at all**, under that name or any expansion of it. No competitor in
FIELD.md's landscape table (Mem0, Zep/Graphiti, Letta, LangMem, cognee,
txtai, basic-memory, Khoj/Reor, MemOS/A-MEM/HippoRAG, the sqlite-vec
micro-ecosystem, Second-Me, memobase) ships or references a format called
"MIF." There is no version, no schema, no external spec — the bullet is a
placeholder acronym invented for the CLI sketch with zero backing
definition anywhere in the repo.

**Verdict: dropped.** This does not rise to the STOP condition ("FIELD.md/
INTEGRATIONS.md turn out to define MIF concretely enough that it IS a real
spec with a version") — there is nothing to read deeply; it is simply
absent. The remaining three formats (JSONL, ICS, vCard) are all concrete,
externally real specs and are assessed below. If a real cross-tool memory
interchange format gains traction later (there is no current industry
standard for this — FIELD.md's survey confirms every competitor's storage
is proprietary), it can be added as a fourth format under the same
`export()` verb with no signature change (see §4).

## 2. The consent-surface question (decision #1)

### The evidence for each option

Plan 016 frames two options:

- **(a)** exports are an OWNER verb — `active`+`archived` by default,
  `never`/quarantined only with an explicit opt-in flag.
- **(b)** surfacing-filtered by default (I2-shaped).

Two precedents in the worktree point in different directions:

- **`getNode(id)`** (`src/contract.ts:64-65`, doc comment: "Fetch by id
  regardless of status — hosts gate display") makes **no** status or
  surfacing distinction at all — the host is the trust boundary, not the
  library.
- **`entityContext`** (`src/entities.ts:404,415-416`) explicitly refuses
  `surfacing='never'` nodes (`throw new MemoryError("conflict",
  "never-surfaced nodes do not take peer cards (I2)")`) — **more**
  conservative than I2's literal text requires (I2 governs *ambient
  recall*: `recall`/`search`/`agenda`; `entityContext` is an owner-facing
  named-subject read, the same category `neighborhood`'s doc comment
  calls out at `src/entities.ts:381-384` — "traversal is an owner-facing
  read of a named subject, not ambient matching").

The reconciling fact: `entityContext` backs the MCP tool `memory_context`
(`docs/INTEGRATIONS.md:39` — "`memory_context` | `entityContext()` | the
peer card for prompts"), which is **agent-reachable**. Its conservatism
exists because a peer card can leak into an agent's context window.
`export()`/`Store.restore()` are not agent-reachable by design — they
belong on the same deliberately-excluded list as `backup`
(`docs/INTEGRATIONS.md:41-44`: "Deliberately NOT exposed to agents:
`decide`, `decideIdentity`, `forget`, `closeEdge`, `updateNode`,
`transition`, `backup`" — this spike recommends `export`/`restore` join
that list, a doc delta noted in §8). Since export sits in the same
owner-only tier as `backup()` (a raw `VACUUM INTO` snapshot that already
includes literally everything, `never` rows included, with zero
filtering), `getNode`'s "host is the gate" precedent is the more relevant
one for an *owner*-invoked bulk read than `entityContext`'s
*agent-surface-adjacent* conservatism.

### Recommendation: (a), refined into two independent opt-in flags

Default export includes:
- **Status**: `active` + `archived` only. Excludes `proposed` (an
  agent's unconsented draft — I1 has not yet run on it), `rejected`
  (the owner said no; exporting a "no" is nonsensical and mildly
  leaky), `forgotten` (tombstoned — `title`/`body`/`props` are already
  `''`/`''`/`'{}'` by I6, so there is no content left to export; emitting
  an empty-content row would be noise, not fidelity), and `merged` (a
  husk still holds real content per the I8 amendment, but it is a
  *duplicate* of the survivor — default export describes the record's
  *current* shape, where the survivor is canonical; see the
  `includeMerged` extension flag below).
- **Surfacing**: `always` and `ask` — **not** `never` by default.
  `ask`'s restriction is specifically about *ambient matching* (I2's own
  text, `docs/SCHEMA.md:214-220`: "returned only when the query names
  them"); a bulk owner-initiated export is not ambient matching, the
  identical reasoning `neighborhood`/`entityContext` already use to admit
  `ask` neighbors. `never` requires `includeNever: true` — mirroring
  option (a) exactly, and matching `entityContext`'s conservative
  precedent for the one surfacing tier the schema calls "the owner's most
  sensitive rows" (plan 016's own framing).
- **Quarantine**: excluded by default, `includeQuarantined: true` opts
  in. Quarantine is "actively suppressed everywhere... ask-twice"
  (`docs/SCHEMA.md:204`) — a default bulk export would be a silent third
  ask that bypasses the friction quarantine exists to add.

**Probed** (`jsonl_probe.ts`): confirmed exactly this behavior — default
output has zero sensitive ids; the two flags surface them; edges whose
*other* endpoint fails the filter are dropped even when the edge's own
row would otherwise qualify (the `neighborhood`/`edgesOf`-style
discovery-prevention rule, applied to export's edge stream).

**Extension flag noted, not required for v1**: `includeMerged: boolean`
(default false) — a husk still holds owner content (I8 amendment); a
"complete archival dump including folded duplicates" is a legitimate
future ask, cheap to add later (one more status in the `IN (...)`
clause), not required to ship v1. Listed as decision #1b below.

## 3. Stream × format × consent matrix

| Stream | JSONL | ICS | vCard | Consent gate |
|---|---|---|---|---|
| `nodes` | yes, all types | yes, `when_at IS NOT NULL` only | yes, `type='person'` only | status: active+archived (+quarantined if `includeQuarantined`); surfacing: always+ask (+never if `includeNever`) |
| `edges` | yes | no (ICS has no edge concept) | no | only if **both** `source` and `target` passed the node filter |
| `aliases` | yes | no | yes, as `NICKNAME` | only if the aliased `node_id` passed the node filter (aliases are content per `docs/SCHEMA.md:151-152`) |
| `derivations` | yes | no | no | include if each side that *is* a node id passed the filter; opaque host refs (`"host:recap:..."`) pass through unfiltered — they aren't node ids and carry no node content |
| `memory_history` | opt-in (`includeHistory`), default **off** | no | no | content-bearing by design (I16); arguably *more* sensitive than current state (may hold since-edited/since-redacted text) — same opt-in tier as `never` |
| `audit_log` | opt-in (`includeAuditLog`), default **off** | no | no | content-free (I7) but not "memory" in the portability sense — operational/forensic, and exporting it by default would make export's own audit row of itself circular noise in the common case |

ICS's status/surfacing default is **tighter** than the general JSONL
default: it follows `agenda()`'s own I17 filter exactly
(`status='active' AND surfacing='always'`, `docs/SCHEMA.md:301-304` —
"an agenda pull names nothing") rather than the general export baseline,
because an ICS dump is structurally an agenda dump for an external
calendar app. `includeArchived`/`includeAsk` widen it per-call. `never`
is never reachable from `export({format:"ics"})` regardless of flags —
there is no legitimate reason to hand a `never`-surfaced appointment to a
third-party calendar app; if the owner truly wants that, JSONL with
`includeNever` is the honest path.

vCard's default mirrors the general JSONL surfacing default (always+ask,
`never` opt-in) since it is a general-purpose identity export, not an
agenda-shaped one.

## 4. Format drafts

### 4.1 JSONL (archival/interchange — full fidelity)

One JSON object per line, a `"stream"` discriminator first, then the
**SCHEMA.md column names verbatim** (snake_case, matching the SQL DDL
exactly — no camelCase translation, so the file is diffable against the
schema doc by a human without a decoder):

```
{"stream":"node","id":...,"type":...,"title":...,"body":...,"status":...,
 "surfacing":...,"importance":...,"props":...,"origin":...,"author":...,
 "use_count":...,"last_used":...,"review_at":...,"when_at":...,
 "created":...,"updated":...}
{"stream":"edge","id":...,"source":...,"target":...,"type":...,
 "context":...,"created":...,"valid_from":...,"valid_until":...}
{"stream":"alias","alias":...,"node_id":...,"source":...,"created":...}
{"stream":"derivation","artifact":...,"source":...,"stale":...,"created":...}
{"stream":"history","node_id":...,"seq":...,"title":...,"body":...,
 "props":...,"when_at":...,"actor":...,"action":...,"origin":...,"at":...}
```

`props` is emitted as its **raw JSON string** (matching the column's own
storage form, `docs/SCHEMA.md:54` — "JSON columns hold canonical JSON
objects... `{}` when empty") rather than parsed/re-nested, so a line is a
byte-for-byte reconstructible row modulo the `stream` tag. This schema
belongs as a `docs/SCHEMA.md` appendix ("JSONL export shape") if/when
built — not a new invariant, since export is a read, not a write
contract.

**Probed** (`jsonl_probe.ts`, full output reproduced in the probe's own
stdout): confirmed real output shape against the fixture for every
stream, both under the default filter and the full-owner-dump flags.

### 4.2 ICS (RFC 5545 VEVENT)

Confirms `docs/PLANNING.md:171-172`'s claim ("trivially exportable:
`when_at` + title is already an ICS VEVENT") — probed, not just asserted:

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//balaur-memory//export//EN
BEGIN:VEVENT
UID:<node.id>@balaur-memory
DTSTAMP:<node.updated, ISO -> ICS UTC form>
DTSTART:<node.when_at, ISO -> ICS UTC form>
SUMMARY:<node.title, RFC5545-escaped>
DESCRIPTION:<node.body, RFC5545-escaped>        ; omitted if body is ''
STATUS:<archived -> COMPLETED, else CONFIRMED>
END:VEVENT
...
END:VCALENDAR
```

ISO→ICS conversion is a pure string transform (`2026-07-20T14:30:00.000Z`
→ `20260720T143000Z`) — no timezone math, since I11 pins everything UTC.
Escaping (backslash, comma, semicolon, newline) and 75-octet line folding
are both ~10-line hand-rolled functions, probed against a title
containing all three special characters (`ics_probe.ts`).

**Not attempted**: a real calendar-app import test (plan's "if
convenient" caveat) — no calendar client was available in this
environment; the output was validated against RFC 5545's own grammar by
hand (required VEVENT properties UID/DTSTAMP/DTSTART/SUMMARY all present)
rather than round-tripped through a specific app. Flagged as a gap for
the build phase, not a blocker for the design.

### 4.3 vCard (RFC 6350, person nodes)

```
BEGIN:VCARD
VERSION:4.0
UID:urn:balaur:<node.id>
FN:<node.title, RFC6350-escaped>
N:;;;;                                    ; schema has no name parts; FN only
NICKNAME:<alias, RFC6350-escaped>         ; one line per alias
NOTE:<node.body, RFC6350-escaped>         ; omitted if body is ''
END:VCARD
```

**Probed** (`vcard_probe.ts`): confirmed a merge survivor's card carries
both its own alias and the alias inherited from the merged husk (the
`source='merge'` alias row `decideIdentity` writes), and that the husk
itself produces no card of its own.

## 5. The verbs

### 5.1 One verb with a format option, not three per-format verbs

```ts
export type ExportFormat = "jsonl" | "ics" | "vcard";

export interface ExportOptions {
  readonly format: ExportFormat;
  readonly includeNever?: boolean;        // default false (decision #1)
  readonly includeQuarantined?: boolean;  // default false
  readonly includeHistory?: boolean;      // JSONL only; default false
  readonly includeAuditLog?: boolean;     // JSONL only; default false
  readonly includeArchived?: boolean;     // ICS only; default false (agenda-style baseline)
  readonly includeAsk?: boolean;          // ICS only; default false (agenda-style baseline)
}

export interface ExportReport {
  readonly format: ExportFormat;
  readonly counts: Readonly<Record<string, number>>; // e.g. {node: 42, edge: 11, alias: 3}
}

// Store.prototype
export(toPath: string, opts: ExportOptions): ExportReport;
```

**Argued over three verbs (`exportJsonl`/`exportIcs`/`exportVcard`)**
because:

1. **One place for the shared refusal logic.** Target-exists and
   in-store-target refusals (§5.3) would otherwise be copy-pasted three
   times, the exact kind of "keep two places in sync by hand" risk
   `docs/DESIGN.md`'s own coding doctrine (`src/consent.ts` verdict
   whitelist commentary in `plans/design/task-arc.md:226`) already flags
   as a real regression class in this codebase.
2. **One audit action.** `store.export` with `format` in `meta`
   (content-free: a format string + counts, per `docs/SCHEMA.md:105`'s
   "ids, counts, flags — never quoted text") is simpler to query for the
   forget-report integration (§6) than summing across three action
   names.
3. **A discriminated-union options object gives the same TypeScript
   safety as separate signatures** — `opts.format === "ics"` narrows
   `includeArchived`/`includeAsk` into scope exactly the way three
   separate function signatures would, so there is no real type-safety
   loss, only a surface-area win (one `contract.ts` entry, one
   `store.ts` delegation instead of three of each).

Three per-format verbs remain defensible (marginally clearer call sites:
`store.exportIcs(path, opts)` vs `store.export(path, {format:"ics",
...})`) — noted as decision #2 for the owner, with a lean recommendation
toward the single verb.

**Module placement**: mirrors `lifecycle.ts`'s shape
(`docs/DESIGN.md:112` — "surfacing, quarantine, forget cascade"). A new
`src/export.ts` holds the three emitters + a dispatcher; `store.ts`
imports it (like it already imports `lifecycle.ts`,
`src/store.ts:16-17`) and its `export()` method does the file-write +
refusal + audit wrapper, mirroring `backup()`'s own shape
(`src/store.ts:334-349`) almost line for line.

### 5.2 `Store.restore(backupPath, dir): Store` — static

```ts
static restore(backupPath: string, dir: string): Store;
```

Mechanizes `docs/HOSTING.md` §10's existing prose recipe ("place the
backup file as `memory.db` in a fresh directory, open, `rebuildIndex()`")
into the one-verb shape `backup()` already set as precedent. Internally:

1. Refuse if `backupPath` does not exist (`MemoryError("not_found", ...)`).
2. Refuse if `dir` exists **and is non-empty**
   (`MemoryError("conflict", "restore target directory is not empty —
   restore never overwrites")`) — the restore-shaped mirror of
   `backup()`'s "target already exists" refusal; "non-empty" rather than
   "exists" because `mkdirSync(dir, {recursive:true})` making the dir
   itself is fine, an empty dir is fine, files already in it are not.
3. `mkdirSync(dir, {recursive:true, mode:0o700})` (matches `Store.open`'s
   own directory-creation call, `src/store.ts:55`).
4. `copyFileSync(backupPath, join(dir,"memory.db"))`, `chmodSync(...,
   0o600)` (matches the store-file privacy rule, `src/store.ts:78-83`).
5. `Store.open({dir})` — **this alone already enforces the
   schema-version future-guard for free** (`src/storage/schema.ts:184-192`,
   probed live in `restore_probe.ts`: a doctored `schema_version='99'`
   file throws `"upgrade the library, never downgrade the file"` on
   `Store.open`, with zero new code needed in `restore()` for this part).
6. `rebuildIndex()` — `index.db` is never backed up (I13); this is the
   one mandatory step `backup()`'s own doc comment already names
   (`src/contract.ts:192-194`).
7. Check `doctor().integrityOk`; if false, `close()` the store and throw
   `MemoryError("conflict", "restored file failed PRAGMA integrity_check
   — refusing to hand back a corrupt store")`. **This is new behavior
   beyond today's manual recipe** — `docs/SCHEMA.md:320-322` currently
   frames the integrity check as a *recommended separate habit* ("Verify
   backups by opening them... run it on a restored copy too"), not a hard
   gate restore itself enforces. Flagged as decision #3 below: throw
   (fail loud, matches the "an untested backup is a hope, not a backup"
   ethos already in the doc) vs. return the `Store` regardless and let
   the host inspect `doctor().integrityOk` itself (more flexible, avoids
   a surprising exception on a still-partially-readable file).
   **Recommend throw** — restore is explicitly reconstructing a store
   from an external, previously-unverified file; this is closer in kind
   to `migrateMemoryDb`'s hard future-schema throw than to `doctor()`'s
   soft, owner-reviewed reporting.
8. Write a content-free audit row: `store.restore`, `meta:
   {activeCount, integrityOk}` — no path, matching every other audit
   row's "no paths, no content" convention (`backup()`'s own row is
   literally `{}`, `src/store.ts:349`).
9. Return the opened `Store`.

**Probed** (`restore_probe.ts`): full parity confirmed (`getNode`,
`recall` both work post-restore); both refusal paths confirmed; the
free schema-guard inheritance confirmed live against a doctored file.

**Zero new `MemoryError` codes.** Every case above (`not_found`,
`conflict`) already exists in the code union
(`src/types.ts:148-155`) — no change to that literal type.

### 5.3 `export()`'s own refusals — mirror `backup()` exactly

```ts
if (dirname(resolved) === resolve(this.dir_))
  throw new MemoryError("props_invalid", "export target cannot live inside the store directory");
if (existsSync(resolved))
  throw new MemoryError("conflict", "export target already exists — export never overwrites");
```

Identical codes, identical shape to `backup()`
(`src/store.ts:336-339`) — including reusing `props_invalid` for the
in-store-target case (not `conflict`), matching the existing precedent
exactly rather than inventing a new convention.

## 6. The forget-report integration (the honesty hook)

**Today** (`src/lifecycle.ts:90`): `needsOwner.push("external:prior-exports")`
unconditionally — every `forget()` call reports this line, even on a
store that has never once called an export verb (because none exists
yet). Probed live (`forget_report_probe.ts`): confirmed the boilerplate
fires on a completely fresh store with zero export history.

**Proposed**: replace the unconditional push with a real count:

```ts
const exportCount = ctx.mem.get<{ c: number }>(
  "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'store.export' AND ok = 1",
)?.c ?? 0;
if (exportCount > 0) needsOwner.push(`external:exports:${exportCount}`);
```

Probed (`forget_report_probe.ts`): the query correctly counts 3
successful exports while excluding a simulated failed one (`ok=0`), and
correctly produces **zero** entries — not a `"external:exports:0"` noise
line — on a store that never exported. This is strictly more honest than
today's line: it distinguishes "this store's content may be sitting in N
export files somewhere" from "nothing has ever left this store via the
sanctioned verb," which today's boilerplate cannot express.

**Scope note, deliberately not done here**: `backup()` writes its own
audit action (`store.backup`, already true today) and is subject to the
exact same "standing truth" framing in `docs/SCHEMA.md:331-337`
("Backups outlive forgetting... same as any other
`external:prior-exports`"). The identical real-accounting treatment
(`external:backups:<n>`) is a natural next step but is **out of scope for
this spike** (plan 016 is export/restore, not a `forget()` rewrite) —
noted as decision #4 for a follow-up build plan, not bundled here to keep
this spike's blast radius to what it was asked to design.

**Unavoidable remaining honesty gap** (both today and after this change):
neither the current boilerplate nor the proposed count can account for a
copy that left via `cp`/`rsync`/a filesystem snapshot outside the
library's own verbs — `docs/SCHEMA.md:248-251` names this explicitly as
"out of contract." The proposed line is honest about what the *library*
knows, not omniscient about the filesystem.

## 7. Owner decisions

1. **Consent default for `export()`: option (a) as refined in §2** —
   status baseline `active+archived`, `includeNever`/`includeQuarantined`
   as independent opt-in flags, `ask` included by default (not gated).
   **Recommend confirm.**
   - **1b.** Ship `includeMerged` (folded-duplicate husks) in v1, or defer
     to a follow-up? **Recommend defer** — no demonstrated need yet, cheap
     to add later (one more status in a `WHERE status IN (...)` clause).
2. **One `export(toPath, opts)` verb with a `format` option, vs three
   per-format verbs (`exportJsonl`/`exportIcs`/`exportVcard`)?**
   **Recommend the single verb** (§5.1) — shared refusal logic, one audit
   action, no real type-safety loss from the discriminated union.
3. **`Store.restore()`: throw on failed `PRAGMA integrity_check`, or
   return the `Store` anyway with `doctor().integrityOk` left for the
   host to check?** **Recommend throw** (§5.2 step 7) — matches the
   project's existing "fail loud on a file from an untrustworthy state"
   pattern (the schema future-guard), not the "report, never act"
   pattern reserved for the owner's own live record.
4. **Give `backup()` the same real-accounting treatment in `forget()`'s
   report (`external:backups:<n>`) as this spike proposes for exports?**
   **Recommend yes, but as a separate follow-up build plan** — same
   mechanism, but bundling it here widens this spike's already-decided
   scope (plan 016 names exports, not backups) without new evidence
   requiring it.
5. **MIF: confirmed dropped (§1), not deferred-with-a-flag** — no
   `mif` value should appear in `ExportFormat` at all, since there is
   nothing behind it to implement. **Recommend confirm** (this is the
   spike's own finding, not really an open question — listed for
   explicit sign-off per the plan's done-criteria).
6. **Document `export`/`restore` in `docs/INTEGRATIONS.md`'s
   "Deliberately NOT exposed to agents" list (`docs/INTEGRATIONS.md:41-44`)
   alongside `backup`, when that doc is next touched?** **Recommend yes**
   — a docs-only follow-up, not required to ship the verbs themselves
   (the doc is already marked DEFERRED/no-op).

## 8. Appendix — process notes

- **No STOP condition triggered.** MIF was checked and found to be
  unbacked (§1) — the STOP condition ("MIF turns out to be a real
  versioned spec... report scope before spending it") explicitly does
  *not* apply to the opposite finding, which is what happened here.
- **Scope discipline**: this document and the probe scripts under
  `/tmp/claude-1000/-home-alex-projects-balaur-memory/abfef91e-d2fb-43a8-8e26-754fd479d3d3/scratchpad/export-restore-probe/`
  are the only artifacts this spike wrote. `git status` on both the main
  repo and the worktree shows no changes outside this file.
- **Unrelated anomaly noticed, not touched**: while citing line numbers,
  `src/doctor.ts` (in the approved worktree) was found to contain one
  literal NUL byte (offset 4490, inside the `duplicateCandidates` grouping
  key's template literal, where a space separator is intended:
  `` `${r.type} ${r.title...}` ``) — confirmed via `python3 -c
  "open('src/doctor.ts','rb').read().count(b'\x00')"` → `1`. This is
  functionally harmless (the byte is used consistently as the join
  character on both sides of every key, so grouping still works) but is
  genuine source-file corruption unrelated to export/restore — flagged
  for the owner/dispatcher to investigate separately; not fixed here
  (out of this spike's write scope, and not an export/restore concern).
  Note for future greps in this worktree: standard `grep`/the sandboxed
  `ugrep` wrapper silently reports zero matches against this file
  (binary-file misdetection, `-I` skip) — use the `Read` tool or
  `grep -a`/`grep -Uz` to see its real content.
