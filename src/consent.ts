/**
 * The consent boundary as data: proposals enter, the owner decides, every
 * step is audited. Hosts render this queue however they like (cards, CLI,
 * TUI) — the ledger lives here (SCHEMA.md I1, I4, I5).
 */

import type { Node, NodeId, Props } from "./types.ts";

/** An agent-authored write awaiting the owner. */
export interface Proposal {
  readonly type: string; // must be a registered bornStatus="proposed" type
  readonly title: string;
  readonly body: string;
  readonly importance?: number; // 1..5; omit when not applicable
  readonly props?: Props;
  readonly origin: string; // provenance is mandatory at birth (I10)
  readonly author?: string; // set when the content carries a third party's words
}

/**
 * How the write-time gate routed a proposal (I4) — resolved BEFORE anything
 * is written, never left for recall time.
 */
export type Outcome =
  | { readonly kind: "created"; readonly node: Node }
  | { readonly kind: "merged_pending"; readonly node: Node }
  | { readonly kind: "exists_active"; readonly node: Node };

/** Advisory hint on a pending item: an active node it may duplicate or
 * contradict. The owner adjudicates; the library never auto-resolves. */
export interface Conflict {
  readonly nodeId: NodeId;
  readonly title: string;
  readonly reason: "title_match" | "lexical_overlap";
}

/** A parked, agent-proposed change to an ACTIVE node. The approved content
 * is untouched until the owner applies it. */
export interface EditEnvelope {
  readonly fields: Readonly<Record<string, string>>;
  readonly archive: boolean;
  readonly origin: string;
  readonly author: string;
  readonly created: string;
}

/** One reviewable item in the consent queue. */
export interface Pending {
  readonly node: Node;
  /** non-null: a parked edit to an active node rather than a new proposal. */
  readonly edit: EditEnvelope | null;
  readonly conflicts: readonly Conflict[];
}

/**
 * The owner's verdict. approve_superseding is compound and ordered (I5):
 * activate new → archive old → supersedes edge → audit.
 */
export type Decision =
  | { readonly kind: "approve" }
  | { readonly kind: "approve_edited"; readonly fields: Readonly<Record<string, string>> }
  | { readonly kind: "approve_superseding"; readonly supersedes: NodeId }
  | { readonly kind: "reject" };
