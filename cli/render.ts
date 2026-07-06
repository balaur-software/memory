/**
 * Output formatters. `--json` prints `JSON.stringify` of the raw value
 * (the library's data shapes are all JSON-safe — see types.ts). The text
 * mode is a compact human view; it never invents fields, only selects.
 *
 * The renderer is a pure function of (value, mode) — no Store access,
 * no clock — so tests assert against stable strings.
 */

import type { Conflict, EditEnvelope, Outcome, Pending } from "../src/consent.ts";
import type { DoctorReport } from "../src/contract.ts";
import type { EntityContext, Peer } from "../src/entities.ts";
import type { ForgetReport } from "../src/lifecycle.ts";
import type { HistorySnapshot } from "../src/spine.ts";
import type { Edge, Node } from "../src/types.ts";

export type Mode = "text" | "json";

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

export function render(value: unknown, mode: Mode): string {
  return mode === "json" ? `${JSON.stringify(value, null, 2)}\n` : text(value);
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "\n";
  if (typeof v === "string") return `${v}\n`;
  if (typeof v === "number" || typeof v === "boolean") return `${String(v)}\n`;
  if (Array.isArray(v)) {
    if (v.length === 0) return "(none)\n";
    return v.map((item) => renderOne(item)).join("");
  }
  return renderOne(v);
}

function renderOne(v: unknown): string {
  if (v === null || v === undefined) return "\n";
  if (typeof v === "object") {
    if (isNode(v)) return nodeText(v);
    if (isEdge(v)) return edgeText(v);
    if (isPending(v)) return pendingText(v);
    if (isDoctor(v)) return doctorText(v);
    if (isEntityContext(v)) return entityContextText(v);
    if (isHistory(v)) return historyText(v);
    if (isForget(v)) return forgetText(v);
    if (isOutcome(v)) return outcomeText(v);
    if (isConflict(v)) return conflictText(v);
  }
  return `${JSON.stringify(v)}\n`;
}

function isNode(v: object): v is Node {
  return "id" in v && "type" in v && "title" in v && "status" in v;
}
function isEdge(v: object): v is Edge {
  return "source" in v && "target" in v && "validFrom" in v;
}
function isPending(v: object): v is Pending {
  return "kind" in v && (v.kind === "proposal" || v.kind === "edit" || v.kind === "identity");
}
function isDoctor(v: object): v is DoctorReport {
  return "activeCount" in v && "pendingCount" in v && "integrityOk" in v;
}
function isEntityContext(v: object): v is EntityContext {
  return "node" in v && "peers" in v && "aliases" in v;
}
function isHistory(v: object): v is HistorySnapshot {
  return "seq" in v && "action" in v && "at" in v;
}
function isForget(v: object): v is ForgetReport {
  return "tombstoned" in v && "edgesDropped" in v && "indexScrubbed" in v;
}
function isOutcome(v: object): v is Outcome {
  return "kind" in v && "node" in v;
}
function isConflict(v: object): v is Conflict {
  return "nodeId" in v && "reason" in v;
}

export function nodeText(n: Node): string {
  const head = `${n.id}  [${n.status}]  (${n.type})  ${n.title}`;
  const meta = `  importance=${n.importance} surfacing=${n.surfacing} when=${n.when ?? "-"}`;
  const tail = n.body !== "" ? `\n    ${n.body.replace(/\n/g, "\n    ")}` : "";
  return `${head}${meta}${tail}\n`;
}

function edgeText(e: Edge): string {
  const valid =
    e.validFrom === null && e.validUntil === null
      ? ""
      : `  valid=${e.validFrom ?? "−∞"}..${e.validUntil ?? "now"}`;
  return `${e.id}  ${e.source} ${arrow(e.type)} ${e.target}  (${e.type})${valid}\n`;
}

function arrow(type: string): string {
  return type === "supersedes" ? "==>" : type === "merged_into" ? "=merge=>" : "-->";
}

function pendingText(p: Pending): string {
  switch (p.kind) {
    case "proposal":
      return `[proposal] ${p.node.id} (${p.node.type}) ${p.node.title}${conflictsBlock(p.conflicts)}\n`;
    case "edit": {
      const env: EditEnvelope = p.edit;
      const fields = Object.entries(env.fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      return `[edit] ${p.node.id} (${p.node.type}) ${p.node.title}\n    ${env.archive ? "archive " : ""}${fields}  (origin: ${env.origin})${conflictsBlock(p.conflicts)}\n`;
    }
    case "identity":
      return `[identity] ${p.a.id} ~ ${p.b.id}  (${p.a.title} / ${p.b.title})  evidence=${p.evidence}\n`;
  }
}

function conflictsBlock(conflicts: readonly Conflict[]): string {
  if (conflicts.length === 0) return "";
  return `\n    conflicts: ${conflicts.map((c) => `${c.nodeId}(${c.reason})`).join(", ")}`;
}

function doctorText(r: DoctorReport): string {
  return [
    `active=${r.activeCount}  pending=${r.pendingCount}  accept30d=${r.acceptRate30d ?? "n/a"}`,
    `queueOldestDays=${r.queueOldestDays ?? "n/a"}  integrityOk=${r.integrityOk}`,
    `due=${r.dueCandidates.length}  stale=${r.staleCandidates.length}  deadWeight=${r.deadWeightCandidates.length}  duplicates=${r.duplicateCandidates.length}`,
    r.dueCandidates.length > 0 ? `due ids: ${r.dueCandidates.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .concat("\n");
}

function entityContextText(c: EntityContext): string {
  const aliases = c.aliases.length > 0 ? `  aka: ${c.aliases.join(", ")}` : "";
  const peers = c.peers
    .map((p: Peer) => `  ${nodeText(p.node).trimEnd()}    via: ${p.edges.map((e) => e.type).join(", ")}`)
    .join("");
  return `${nodeText(c.node).trimEnd()}${aliases}\n${peers}`;
}

function historyText(h: HistorySnapshot): string {
  return `#${h.seq}  ${h.at}  ${h.action} (by ${h.actor})  title=${JSON.stringify(h.title)}\n`;
}

function forgetText(r: ForgetReport): string {
  return `forgot ${r.tombstoned}  edges=${r.edgesDropped}  scrubbed=${r.indexScrubbed}  stale=${r.flaggedStale.length}  needsOwner=${r.needsOwner.length}\n`;
}

function outcomeText(o: Outcome): string {
  return `${o.kind}  ${o.node.id}  (${o.node.type}) ${o.node.title}\n`;
}

function conflictText(c: Conflict): string {
  return `${c.nodeId}  ${c.title}  (${c.reason})\n`;
}
