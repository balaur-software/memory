/**
 * Generates the committed legacy fixture databases in this directory
 * (v1.db, v2.db, v3.db) — a one-time build script, NEVER run in CI.
 *
 * The historical DDL below is written out explicitly rather than derived
 * by string-editing src/storage/schema.ts's current constants at runtime:
 * that file's header rule is "never edit an applied migration", and this
 * script exists specifically to freeze what "v1", "v2", and "v3" meant so
 * a future change to the live constants can never quietly rewrite what
 * these fixtures represent. Each block below cites the docs/SCHEMA.md
 * section it was transcribed from.
 *
 * Regenerate only if the historical-DDL reconstruction itself is revised
 * (plan 006). Run with: bun test/fixtures/make-fixtures.ts
 */
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "../../src/storage/ulid.ts";

const DIR = import.meta.dir;

// --- baseline: docs/SCHEMA.md "## memory.db" fenced block, minus every
// column/index annotated (v2)/(v3)/(v4) in that same block — i.e. no
// `nodes.when_at` / `idx_nodes_when` (v4), no `edges.valid_from` /
// `edges.valid_until` (v3). This is the v1 shape in full. ---
const BASELINE_DDL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE node_types (
  name          TEXT PRIMARY KEY,
  born_status   TEXT NOT NULL DEFAULT 'active'
                CHECK (born_status IN ('active','proposed')),
  props_schema  TEXT NOT NULL DEFAULT '{}',
  template      TEXT NOT NULL DEFAULT '{}',
  created       TEXT NOT NULL
) STRICT;

CREATE TABLE nodes (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL REFERENCES node_types(name),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL
             CHECK (status IN ('proposed','active','archived','rejected',
                               'quarantined','forgotten','merged')),
  surfacing  TEXT NOT NULL DEFAULT 'always'
             CHECK (surfacing IN ('always','ask','never')),
  importance INTEGER NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 5),
  props      TEXT NOT NULL DEFAULT '{}',
  origin     TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT '',
  use_count  INTEGER NOT NULL DEFAULT 0,
  last_used  TEXT,
  review_at  TEXT,
  created    TEXT NOT NULL,
  updated    TEXT NOT NULL
) STRICT;
CREATE INDEX idx_nodes_type_status ON nodes(type, status);
CREATE INDEX idx_nodes_status_imp  ON nodes(status, importance DESC);

CREATE TABLE edges (
  id      TEXT PRIMARY KEY,
  source  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type    TEXT NOT NULL DEFAULT 'links',
  context TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  UNIQUE (source, target, type)
) STRICT;
CREATE INDEX idx_edges_target ON edges(target);

CREATE TABLE pending_edits (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  fields  TEXT NOT NULL DEFAULT '{}',
  archive INTEGER NOT NULL DEFAULT 0 CHECK (archive IN (0,1)),
  origin  TEXT NOT NULL DEFAULT '',
  author  TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL
) STRICT;

CREATE TABLE derivations (
  artifact TEXT NOT NULL,
  source   TEXT NOT NULL,
  stale    INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
  created  TEXT NOT NULL,
  PRIMARY KEY (artifact, source)
) STRICT;

CREATE TABLE audit_log (
  id     TEXT PRIMARY KEY,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL CHECK (actor IN ('owner','agent','system')),
  action TEXT NOT NULL,
  ref    TEXT NOT NULL DEFAULT '',
  ok     INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
  meta   TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX idx_audit_at ON audit_log(at);
`;

// --- v2 additive: docs/SCHEMA.md "### Version 2 — identity resolution"
// fenced block, `aliases` + `identity_pending` only. `memory_history` in
// that same fenced block is explicitly commented "(v3)" in the doc and
// belongs to the v3 shape below, not here. ---
const V2_ADDITIVE_DDL = `
CREATE TABLE aliases (
  alias   TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source  TEXT NOT NULL CHECK (source IN ('owner','merge')),
  created TEXT NOT NULL,
  PRIMARY KEY (alias, node_id)
) STRICT;
CREATE INDEX idx_aliases_node ON aliases(node_id);

CREATE TABLE identity_pending (
  a        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  b        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  evidence TEXT NOT NULL CHECK (evidence IN ('title_match','token_subset','alias_match')),
  created  TEXT NOT NULL,
  PRIMARY KEY (a, b)
) STRICT;
`;

// --- v3 additive: docs/SCHEMA.md edges.valid_from / edges.valid_until
// (both annotated "(v3)"), plus the memory_history table from the
// Version-2-headed fenced block (annotated "(v3)" there). Its `when_at`
// column is annotated "(v4)" in the same doc block and is deliberately
// left out of this v3 shape. ---
const V3_ADDITIVE_DDL = `
ALTER TABLE edges ADD COLUMN valid_from  TEXT;
ALTER TABLE edges ADD COLUMN valid_until TEXT;

CREATE TABLE memory_history (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  title   TEXT NOT NULL,
  body    TEXT NOT NULL,
  props   TEXT NOT NULL,
  actor   TEXT NOT NULL CHECK (actor IN ('owner','agent','system')),
  action  TEXT NOT NULL,
  origin  TEXT NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (node_id, seq)
) STRICT;
`;

/** One node type, two nodes, one edge, one audit row — enough to prove
 * data survives an in-place upgrade without being a real corpus. */
function seedRows(db: Database, at: string): { a: string; b: string } {
  const atMs = Date.parse(at);
  db.run("INSERT INTO node_types (name, born_status, created) VALUES ('note', 'active', ?)", [at]);
  const a = ulid(atMs);
  const b = ulid(atMs);
  db.run(
    "INSERT INTO nodes (id, type, title, body, status, origin, created, updated) VALUES (?, 'note', ?, ?, 'active', 'fixture', ?, ?)",
    [a, "Fixture A", "the first row", at, at],
  );
  db.run(
    "INSERT INTO nodes (id, type, title, body, status, origin, created, updated) VALUES (?, 'note', ?, ?, 'active', 'fixture', ?, ?)",
    [b, "Fixture B", "the second row", at, at],
  );
  const edgeId = ulid(atMs);
  db.run("INSERT INTO edges (id, source, target, type, created) VALUES (?, ?, ?, 'links', ?)", [
    edgeId,
    a,
    b,
    at,
  ]);
  const auditId = ulid(atMs);
  db.run("INSERT INTO audit_log (id, at, actor, action, ref) VALUES (?, ?, 'owner', 'node.create', ?)", [
    auditId,
    at,
    a,
  ]);
  return { a, b };
}

function build(version: "1" | "2" | "3"): void {
  const path = join(DIR, `v${version}.db`);
  if (existsSync(path)) rmSync(path);
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(BASELINE_DDL);
  if (version === "2" || version === "3") db.exec(V2_ADDITIVE_DDL);
  if (version === "3") db.exec(V3_ADDITIVE_DDL);

  const at = "2024-01-01T00:00:00.000Z";
  seedRows(db, at);

  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [version]);
  db.run("INSERT INTO meta (key, value) VALUES ('store_id', ?)", [ulid(Date.parse(at))]);
  db.run("INSERT INTO meta (key, value) VALUES ('created', ?)", [at]);

  db.close();
  console.log(`wrote ${path}`);
}

build("1");
build("2");
build("3");
