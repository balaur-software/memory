/**
 * Lineage (SCHEMA.md derivations, I10's sibling): every derived artifact
 * records its sources at creation time, because provenance cannot be
 * retrofitted. This is what makes the forget cascade able to answer "what
 * must change if this goes away?" as a query instead of archaeology.
 *
 * `artifact` and `source` are node ids OR host refs (e.g.
 * "host:recap:2026-07-04") — the library treats them as opaque.
 */

import { audit, type Ctx } from "./spine.ts";
import { MemoryError } from "./types.ts";

/** Register a derived artifact's sources. Idempotent per (artifact, source). */
export function recordDerivation(ctx: Ctx, artifact: string, sources: readonly string[]): void {
  const a = artifact.trim();
  if (a === "") throw new MemoryError("props_invalid", "artifact ref is required");
  if (sources.length === 0) throw new MemoryError("props_invalid", "at least one source is required");
  const at = ctx.now().toISOString();
  ctx.mem.transaction(() => {
    for (const s of sources) {
      ctx.mem.run(
        `INSERT INTO derivations (artifact, source, stale, created) VALUES (?, ?, 0, ?)
         ON CONFLICT(artifact, source) DO NOTHING`,
        [a, s.trim(), at],
      );
    }
  });
  audit(ctx, "system", "lineage.record", a, true, { sources: sources.length });
}

/** Derived artifacts whose sources changed or were forgotten — the host
 * regenerates (or re-flags) on its own schedule; the library only marks. */
export function staleDerivations(ctx: Ctx): string[] {
  return ctx.mem
    .query<{ artifact: string }>(
      "SELECT DISTINCT artifact FROM derivations WHERE stale = 1 ORDER BY artifact",
    )
    .map((r) => r.artifact);
}

/** Mark every artifact derived from `source` stale; returns the artifact
 * refs flagged. Called by the forget cascade (and future content edits). */
export function flagStaleBySource(ctx: Ctx, source: string): string[] {
  const artifacts = ctx.mem
    .query<{ artifact: string }>("SELECT DISTINCT artifact FROM derivations WHERE source = ? AND stale = 0", [
      source,
    ])
    .map((r) => r.artifact);
  if (artifacts.length > 0) ctx.mem.run("UPDATE derivations SET stale = 1 WHERE source = ?", [source]);
  return artifacts;
}
