/**
 * Portable export (design `plans/design/export-restore.md`): three
 * hand-rolled, zero-dependency emitters — JSONL (archival, full
 * fidelity), ICS (RFC 5545 VEVENTs), vCard (RFC 6350, person nodes) —
 * behind one dispatcher. Consent filtering happens in the row SELECTs
 * (§3's stream × format × consent matrix), never post-hoc in the
 * emitter: a row that fails the filter is never read into the output.
 *
 * `store.ts`'s `export()` method owns the refusal/write/chmod/audit
 * wrapper (mirroring `backup()`); this module only builds content + counts.
 */

import type { Ctx } from "./spine.ts";
import type { SqlRow } from "./storage/adapter.ts";
import { MemoryError } from "./types.ts";

export type ExportFormat = "jsonl" | "ics" | "vcard";

export interface ExportOptions {
  readonly format: ExportFormat;
  /** The owner's most sensitive rows — default false (design §2). */
  readonly includeNever?: boolean;
  /** Quarantine's ask-twice friction, honored by default — default false. */
  readonly includeQuarantined?: boolean;
  /** JSONL only. `memory_history` is content-bearing (I16) — default false. */
  readonly includeHistory?: boolean;
  /** JSONL only. Operational/forensic, not "memory" — default false. */
  readonly includeAuditLog?: boolean;
  /** ICS only. Agenda-style baseline widened to include archived — default false. */
  readonly includeArchived?: boolean;
  /** ICS only. Agenda-style baseline widened to include ask — default false. */
  readonly includeAsk?: boolean;
}

export interface ExportReport {
  readonly format: ExportFormat;
  /** Per-stream row counts (JSONL: node/edge/alias/derivation/history/audit;
   * ICS: event; vCard: card). */
  readonly counts: Readonly<Record<string, number>>;
}

// --- row shapes (SCHEMA.md column names verbatim) ---

interface NodeExportRow extends SqlRow {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  surfacing: string;
  importance: number;
  props: string;
  origin: string;
  author: string;
  use_count: number;
  last_used: string | null;
  review_at: string | null;
  when_at: string | null;
  created: string;
  updated: string;
}

interface EdgeExportRow extends SqlRow {
  id: string;
  source: string;
  target: string;
  type: string;
  context: string;
  created: string;
  valid_from: string | null;
  valid_until: string | null;
}

interface AliasExportRow extends SqlRow {
  alias: string;
  node_id: string;
  source: string;
  created: string;
}

interface DerivationExportRow extends SqlRow {
  artifact: string;
  source: string;
  stale: number;
  created: string;
}

interface HistoryExportRow extends SqlRow {
  node_id: string;
  seq: number;
  title: string;
  body: string;
  props: string;
  when_at: string | null;
  actor: string;
  action: string;
  origin: string;
  at: string;
}

interface AuditExportRow extends SqlRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  ref: string;
  ok: number;
  meta: string;
}

// --- the consent filter (design §2/§3): status baseline + two opt-in flags ---

interface NodeFilter {
  readonly statuses: readonly string[];
  readonly surfacings: readonly string[];
}

/** JSONL + vCard baseline: active+archived, always+ask; never/quarantined
 * are independent opt-ins. */
function generalFilter(opts: ExportOptions): NodeFilter {
  return {
    statuses: opts.includeQuarantined ? ["active", "archived", "quarantined"] : ["active", "archived"],
    surfacings: opts.includeNever ? ["always", "ask", "never"] : ["always", "ask"],
  };
}

/** ICS baseline mirrors agenda()'s own I17 filter (active + always only);
 * `includeArchived`/`includeAsk` widen it. `never` and `quarantined` are
 * structurally unreachable — neither flag ever adds them to these lists. */
function icsFilter(opts: ExportOptions): NodeFilter {
  return {
    statuses: opts.includeArchived ? ["active", "archived"] : ["active"],
    surfacings: opts.includeAsk ? ["always", "ask"] : ["always"],
  };
}

function inClause(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function selectNodes(ctx: Ctx, filter: NodeFilter, extraWhere = ""): NodeExportRow[] {
  return ctx.mem.query<NodeExportRow>(
    `SELECT id, type, title, body, status, surfacing, importance, props, origin, author,
            use_count, last_used, review_at, when_at, created, updated
     FROM nodes
     WHERE status IN (${inClause(filter.statuses.length)})
       AND surfacing IN (${inClause(filter.surfacings.length)})
       ${extraWhere}
     ORDER BY id`,
    [...filter.statuses, ...filter.surfacings],
  );
}

function allNodeIds(ctx: Ctx): Set<string> {
  return new Set(ctx.mem.query<{ id: string }>("SELECT id FROM nodes").map((r) => r.id));
}

/** Edges: only if BOTH endpoints passed the node filter (the
 * neighborhood/edgesOf discovery-prevention rule, applied to export). */
function selectEdgesFiltered(ctx: Ctx, ids: ReadonlySet<string>): EdgeExportRow[] {
  const rows = ctx.mem.query<EdgeExportRow>(
    "SELECT id, source, target, type, context, created, valid_from, valid_until FROM edges ORDER BY id",
  );
  return rows.filter((r) => ids.has(r.source) && ids.has(r.target));
}

/** Aliases are content (SCHEMA.md) — only if the aliased node passed the filter. */
function selectAliasesFiltered(ctx: Ctx, ids: ReadonlySet<string>): AliasExportRow[] {
  const rows = ctx.mem.query<AliasExportRow>(
    "SELECT alias, node_id, source, created FROM aliases ORDER BY alias, node_id",
  );
  return rows.filter((r) => ids.has(r.node_id));
}

/** Derivations: each side that IS a node id must pass the filter; opaque
 * host refs (not present in `nodes` at all) pass through unfiltered. */
function selectDerivationsFiltered(
  ctx: Ctx,
  ids: ReadonlySet<string>,
  allIds: ReadonlySet<string>,
): DerivationExportRow[] {
  const rows = ctx.mem.query<DerivationExportRow>(
    "SELECT artifact, source, stale, created FROM derivations ORDER BY artifact, source",
  );
  const passes = (ref: string) => !allIds.has(ref) || ids.has(ref);
  return rows.filter((r) => passes(r.artifact) && passes(r.source));
}

function selectHistoryFiltered(ctx: Ctx, ids: ReadonlySet<string>): HistoryExportRow[] {
  const rows = ctx.mem.query<HistoryExportRow>(
    "SELECT node_id, seq, title, body, props, when_at, actor, action, origin, at FROM memory_history ORDER BY node_id, seq",
  );
  return rows.filter((r) => ids.has(r.node_id));
}

function selectAllAuditLog(ctx: Ctx): AuditExportRow[] {
  return ctx.mem.query<AuditExportRow>(
    "SELECT id, at, actor, action, ref, ok, meta FROM audit_log ORDER BY id",
  );
}

// --- JSONL (§4.1): one object per line, "stream" discriminator first,
// SCHEMA.md column names verbatim, props as its raw stored JSON string. ---

function jsonlLine(stream: string, row: SqlRow): string {
  return JSON.stringify({ stream, ...row });
}

function buildJsonl(ctx: Ctx, opts: ExportOptions): { content: string; counts: Record<string, number> } {
  const filter = generalFilter(opts);
  const nodes = selectNodes(ctx, filter);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = selectEdgesFiltered(ctx, ids);
  const aliases = selectAliasesFiltered(ctx, ids);
  const derivations = selectDerivationsFiltered(ctx, ids, allNodeIds(ctx));

  const lines: string[] = [];
  for (const n of nodes) lines.push(jsonlLine("node", n));
  for (const e of edges) lines.push(jsonlLine("edge", e));
  for (const a of aliases) lines.push(jsonlLine("alias", a));
  for (const d of derivations) lines.push(jsonlLine("derivation", d));
  const counts: Record<string, number> = {
    node: nodes.length,
    edge: edges.length,
    alias: aliases.length,
    derivation: derivations.length,
  };

  if (opts.includeHistory) {
    const history = selectHistoryFiltered(ctx, ids);
    for (const h of history) lines.push(jsonlLine("history", h));
    counts.history = history.length;
  }
  if (opts.includeAuditLog) {
    const audit = selectAllAuditLog(ctx);
    for (const a of audit) lines.push(jsonlLine("audit", a));
    counts.audit = audit.length;
  }

  return { content: lines.length > 0 ? `${lines.join("\n")}\n` : "", counts };
}

// --- ICS (§4.2, RFC 5545): escaping + 75-octet line folding, hand-rolled. ---

/** Backslash, comma, semicolon, newline — RFC 5545 §3.3.11 / RFC 6350 §3.4
 * share the same ESCAPED-CHAR grammar, so both emitters reuse this. */
function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** RFC 5545 §3.1 line folding: >75 octets wraps at CRLF + a single leading
 * space on the continuation line (which itself counts toward that line's
 * 75-octet budget). Byte-aware so a multi-byte UTF-8 char is never split. */
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const dec = new TextDecoder();
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length) {
      const b = bytes[end];
      if (b === undefined || (b & 0xc0) !== 0x80) break; // back off mid-codepoint
      end--;
    }
    parts.push(dec.decode(bytes.slice(start, end)));
    start = end;
    limit = 74; // continuation lines: the leading space eats one octet
  }
  return parts.join("\r\n ");
}

/** `2026-07-20T14:30:00.000Z` -> `20260720T143000Z` — a pure string
 * transform (I11 pins everything UTC; no timezone math). */
function toIcsStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function buildIcs(ctx: Ctx, opts: ExportOptions): { content: string; counts: Record<string, number> } {
  const filter = icsFilter(opts);
  const nodes = selectNodes(ctx, filter, "AND when_at IS NOT NULL");
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//balaur-memory//export//EN"];
  for (const n of nodes) {
    lines.push("BEGIN:VEVENT");
    lines.push(foldLine(`UID:${n.id}@balaur-memory`));
    lines.push(foldLine(`DTSTAMP:${toIcsStamp(n.updated)}`));
    lines.push(foldLine(`DTSTART:${toIcsStamp(n.when_at as string)}`)); // guaranteed by the WHERE clause
    lines.push(foldLine(`SUMMARY:${escapeText(n.title)}`));
    if (n.body !== "") lines.push(foldLine(`DESCRIPTION:${escapeText(n.body)}`));
    lines.push(foldLine(`STATUS:${n.status === "archived" ? "COMPLETED" : "CONFIRMED"}`));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return { content: `${lines.join("\r\n")}\r\n`, counts: { event: nodes.length } };
}

// --- vCard (§4.3, RFC 6350): person-type nodes + aliases as NICKNAME. ---

function buildVcard(ctx: Ctx, opts: ExportOptions): { content: string; counts: Record<string, number> } {
  const filter = generalFilter(opts);
  const nodes = selectNodes(ctx, filter, "AND type = 'person'");
  const lines: string[] = [];
  for (const n of nodes) {
    const aliases = ctx.mem.query<{ alias: string }>(
      "SELECT alias FROM aliases WHERE node_id = ? ORDER BY alias",
      [n.id],
    );
    lines.push("BEGIN:VCARD");
    lines.push("VERSION:4.0");
    lines.push(foldLine(`UID:urn:balaur:${n.id}`));
    lines.push(foldLine(`FN:${escapeText(n.title)}`));
    lines.push("N:;;;;"); // schema has no name parts — FN only
    for (const a of aliases) lines.push(foldLine(`NICKNAME:${escapeText(a.alias)}`));
    if (n.body !== "") lines.push(foldLine(`NOTE:${escapeText(n.body)}`));
    lines.push("END:VCARD");
  }
  return { content: nodes.length > 0 ? `${lines.join("\r\n")}\r\n` : "", counts: { card: nodes.length } };
}

// --- dispatcher ---

export function buildExport(
  ctx: Ctx,
  opts: ExportOptions,
): { content: string; counts: Record<string, number> } {
  switch (opts.format) {
    case "jsonl":
      return buildJsonl(ctx, opts);
    case "ics":
      return buildIcs(ctx, opts);
    case "vcard":
      return buildVcard(ctx, opts);
    default:
      throw new MemoryError(
        "props_invalid",
        `format must be jsonl|ics|vcard, got ${JSON.stringify(opts.format)}`,
      );
  }
}
