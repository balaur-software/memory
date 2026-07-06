/**
 * Identity resolution, Phase A — names (docs/ENTITIES.md). Aliases record
 * what a node also answers to; resolveRef answers "who is 'Ana'?" with
 * CANDIDATES, never a winner; survivorOf walks merged_into chains so hosts
 * never reimplement chain-walking wrong. Candidates and questions (Phase B)
 * and the merge itself (Phase C) build on these names.
 *
 * I2 applies to resolution: `never`-surfaced nodes are invisible to
 * resolveRef; `ask` nodes resolve — the text IS their name. Audit rows for
 * alias verbs carry the node id and the source only, never the alias text
 * (I7: an alias is content — usually a person's name).
 */

import { audit, type Ctx, mustGet, reindexNode } from "./spine.ts";
import { MemoryError, type Node, type NodeId, normalizeText } from "./types.ts";

/** Owner verb: record a name the node also answers to. Idempotent; the
 * node must be active; an alias equal to the node's own title is refused
 * as noise. Reindexes the node so alias hits surface in recall (the FTS
 * `extra` column). */
export function addAlias(ctx: Ctx, id: NodeId, alias: string): void {
  const node = mustGet(ctx, id);
  if (node.status !== "active")
    throw new MemoryError("invalid_transition", `cannot alias ${id} (status=${node.status})`);
  const norm = normalizeText(alias);
  if (norm === "") throw new MemoryError("props_invalid", "alias is required");
  if (norm === normalizeText(node.title))
    throw new MemoryError("props_invalid", "alias equals the node's own title");
  const res = ctx.mem.run(
    `INSERT INTO aliases (alias, node_id, source, created) VALUES (?, ?, 'owner', ?)
     ON CONFLICT(alias, node_id) DO NOTHING`,
    [norm, id, ctx.now().toISOString()],
  );
  if (res.changes === 0) return; // idempotent no-op: no audit row, no reindex
  audit(ctx, "owner", "alias.add", id, true, { source: "owner" });
  reindexNode(ctx, mustGet(ctx, id));
}

/** Owner verb: remove an alias. No-op when absent. */
export function removeAlias(ctx: Ctx, id: NodeId, alias: string): void {
  mustGet(ctx, id); // not_found for ghosts, any status otherwise (cleanup is allowed)
  const res = ctx.mem.run("DELETE FROM aliases WHERE node_id = ? AND alias = ?", [id, normalizeText(alias)]);
  if (res.changes === 0) return;
  audit(ctx, "owner", "alias.remove", id, true, {});
  reindexNode(ctx, mustGet(ctx, id));
}

/** All names the node answers to (normalized), alphabetical. */
export function aliasesOf(ctx: Ctx, id: NodeId): string[] {
  mustGet(ctx, id);
  return ctx.mem
    .query<{ alias: string }>("SELECT alias FROM aliases WHERE node_id = ? ORDER BY alias", [id])
    .map((r) => r.alias);
}

/**
 * Who is "Ana"? Exact-normalized match on titles and aliases within one
 * type, ACTIVE nodes only, candidates ordered oldest-first — the caller
 * (owner or host UI) picks; the library never does. I2: `never` is
 * invisible; `ask` resolves (the text is its name).
 */
export function resolveRef(ctx: Ctx, type: string, text: string): Node[] {
  const wanted = normalizeText(text);
  if (wanted === "") return [];
  const ids = new Set<string>();
  // alias hits (indexed lookup)
  for (const r of ctx.mem.query<{ node_id: string }>("SELECT node_id FROM aliases WHERE alias = ?", [
    wanted,
  ])) {
    ids.add(r.node_id);
  }
  // title hits (normalized in JS — same rule as the gate)
  for (const r of ctx.mem.query<{ id: string; title: string }>(
    "SELECT id, title FROM nodes WHERE type = ? AND status = 'active'",
    [type],
  )) {
    if (normalizeText(r.title) === wanted) ids.add(r.id);
  }
  const out: Node[] = [];
  for (const id of ids) {
    const node = mustGet(ctx, id as NodeId);
    if (node.type !== type || node.status !== "active") continue;
    if (node.surfacing === "never") continue; // I2
    out.push(node);
  }
  out.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  return out;
}

const CHAIN_CAP = 32;

/** Walk merged_into chains to the living end. A non-merged node returns
 * itself; a corrupt cycle stops at the cap and returns the last node seen
 * (cycles are damaged data — the walk must never hang). */
export function survivorOf(ctx: Ctx, id: NodeId): Node {
  let node = mustGet(ctx, id);
  const seen = new Set<string>([node.id]);
  for (let hops = 0; hops < CHAIN_CAP && node.status === "merged"; hops++) {
    const next = ctx.mem.get<{ target: string }>(
      "SELECT target FROM edges WHERE source = ? AND type = 'merged_into' LIMIT 1",
      [node.id],
    );
    if (next === null || seen.has(next.target)) break;
    seen.add(next.target);
    node = mustGet(ctx, next.target as NodeId);
  }
  return node;
}
