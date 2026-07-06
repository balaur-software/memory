/**
 * Subcommand implementations — one function per CLI verb, each calling
 * exactly one `Store` method (the contract is 1:1 with the surface in
 * src/contract.ts). The CLI is a host (HOSTING.md): it owns arg reading
 * and rendering; it never imports `bun:sqlite` (ADR-0001 containment).
 *
 * Prop values use heuristic coercion (bool/number/string) — the schema
 * validator at the write choke points is the real authority, same as
 * any other host.
 */

import type { Decision } from "../src/consent.ts";
import type { Store } from "../src/store.ts";
import type { Node, NodeId, Status, Surfacing } from "../src/types.ts";
import { MemoryError } from "../src/types.ts";
import { flag, flagAll, flagInt, type ParsedArgs, parseArgs } from "./args.ts";
import type { Io, Mode } from "./render.ts";
import { render } from "./render.ts";

export interface Command {
  readonly summary: string;
  readonly usage: string;
  run(store: Store, a: ParsedArgs, io: Io, mode: Mode): void;
}

/** Parse `key=value` pairs into a props object with heuristic typing. */
function parseKv(pairs: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 0) throw new Error(`expected key=value, got ${JSON.stringify(p)}`);
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    out[k] = coerce(v);
  }
  return out;
}

function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v) && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

/** Brand a string id — the library's branded ids are structurally strings. */
function nid(s: string): NodeId {
  return s as NodeId;
}

function emit(io: Io, mode: Mode, value: unknown): void {
  io.out(render(value, mode));
}

// --- reads / queue ---

const get: Command = {
  summary: "fetch one node by id",
  usage: "balaur get <id>",
  run: (store, a, io, mode) => emit(io, mode, store.getNode(nid(a.positionals[0] ?? ""))),
};

const recall: Command = {
  summary: "ranked lexical (+ optional vector) recall",
  usage: "balaur recall [terms...] [--type T] [--limit N] [--model M --vector 0.1,0.2,...]",
  run: (store, a, io, mode) => {
    const opts: Record<string, unknown> = {};
    const t = flag(a, "type");
    if (t !== undefined) opts.type = t;
    opts.limit = flagInt(a, "limit", 8);
    const model = flag(a, "model");
    const vec = flag(a, "vector");
    if (model !== undefined && vec !== undefined) {
      opts.model = model;
      opts.queryVector = Float32Array.from(vec.split(",").map((n) => Number(n)));
    }
    emit(io, mode, store.recall(a.positionals, opts));
  },
};

const search: Command = {
  summary: "cross-type recall over all active knowledge",
  usage: "balaur search [terms...] [--limit N]",
  run: (store, a, io, mode) => emit(io, mode, store.search(a.positionals, flagInt(a, "limit", 8))),
};

const agenda: Command = {
  summary: "scheduled window (when_at in [from, to))",
  usage: "balaur agenda <from> <to> [--type T] [--limit N]",
  run: (store, a, io, mode) => {
    const from = a.positionals[0] ?? "";
    const to = a.positionals[1] ?? "";
    const opts: { type?: string; limit?: number } = {};
    const t = flag(a, "type");
    if (t !== undefined) opts.type = t;
    opts.limit = flagInt(a, "limit", 8);
    emit(io, mode, store.agenda(from, to, opts));
  },
};

const episode: Command = {
  summary: "episodic-past window (created in [from, to))",
  usage: "balaur episode <from> <to> [--type T] [--limit N]",
  run: (store, a, io, mode) => {
    const from = a.positionals[0] ?? "";
    const to = a.positionals[1] ?? "";
    const opts: { type?: string; limit?: number } = {};
    const t = flag(a, "type");
    if (t !== undefined) opts.type = t;
    opts.limit = flagInt(a, "limit", 8);
    emit(io, mode, store.episode(from, to, opts));
  },
};

const who: Command = {
  summary: "who is <name>? candidates within one type (you pick)",
  usage: "balaur who <type> <name>",
  run: (store, a, io, mode) => {
    const type = a.positionals[0] ?? "";
    const name = a.positionals.slice(1).join(" ");
    emit(io, mode, store.resolveRef(type, name));
  },
};

const context: Command = {
  summary: "the bounded peer card for prompts",
  usage: "balaur context <id> [--limit N]",
  run: (store, a, io, mode) =>
    emit(io, mode, store.entityContext(nid(a.positionals[0] ?? ""), flagInt(a, "limit", 8))),
};

const pending: Command = {
  summary: "everything awaiting the owner",
  usage: "balaur pending",
  run: (store, _a, io, mode) => emit(io, mode, store.pendingQueue()),
};

const doctor: Command = {
  summary: "metadata-only health report (reports, never acts)",
  usage: "balaur doctor",
  run: (store, _a, io, mode) => emit(io, mode, store.doctor()),
};

const children: Command = {
  summary: "nodes whose <edgeType> edge points AT id",
  usage: "balaur children <id> <edgeType> [--statuses active,archived]",
  run: (store, a, io, mode) => {
    const id = nid(a.positionals[0] ?? "");
    const edgeType = a.positionals[1] ?? "";
    const s = flag(a, "statuses");
    const opts: { statuses?: readonly Status[] } = {};
    if (s !== undefined) opts.statuses = s.split(",").filter(Boolean) as Status[];
    emit(io, mode, store.children(id, edgeType, opts));
  },
};

const neighborhood: Command = {
  summary: "1-hop active set (currently-valid edges)",
  usage: "balaur neighborhood <id>",
  run: (store, a, io, mode) => emit(io, mode, store.neighborhood(nid(a.positionals[0] ?? ""))),
};

const history: Command = {
  summary: "what the node used to say (pre-mutation snapshots)",
  usage: "balaur history <id>",
  run: (store, a, io, mode) => emit(io, mode, store.history(nid(a.positionals[0] ?? ""))),
};

const aliases: Command = {
  summary: "all names the node answers to",
  usage: "balaur aliases <id>",
  run: (store, a, io, mode) => emit(io, mode, store.aliasesOf(nid(a.positionals[0] ?? ""))),
};

const survivor: Command = {
  summary: "walk merged_into to the living end",
  usage: "balaur survivor <id>",
  run: (store, a, io, mode) => emit(io, mode, store.survivorOf(nid(a.positionals[0] ?? ""))),
};

const conflicts: Command = {
  summary: "advisory duplicate/contradiction hints for one pending item",
  usage: "balaur conflicts <id>",
  run: (store, a, io, mode) => emit(io, mode, store.conflictsFor(nid(a.positionals[0] ?? ""))),
};

const stale: Command = {
  summary: "derived artifacts whose sources changed or were forgotten",
  usage: "balaur stale",
  run: (store, _a, io, mode) => emit(io, mode, store.staleDerivations()),
};

// --- writes ---

const registerType: Command = {
  summary: "register or update a node type (I1: bornStatus is the consent split)",
  usage: "balaur register-type <name> [--born-status active|proposed]",
  run: (store, a, io, mode) => {
    const name = a.positionals[0] ?? "";
    const bs = flag(a, "born-status");
    const spec: { name: string; bornStatus: "active" | "proposed" } = {
      name,
      bornStatus: bs === "proposed" ? "proposed" : "active",
    };
    store.registerType(spec);
    emit(io, mode, { ok: true, name, bornStatus: spec.bornStatus });
  },
};

const create: Command = {
  summary: "owner-authored write — born active (provenance mandatory)",
  usage:
    "balaur create --type T --title X [--body B] [--importance N] [--when ISO] [--surfacing always|ask|never] [--origin O] [--author A] [--prop k=v ...]",
  run: (store, a, io, mode) => {
    const type = flag(a, "type");
    const title = flag(a, "title");
    if (type === undefined || title === undefined) throw new Error("create requires --type and --title");
    const origin = flag(a, "origin") ?? "cli";
    const body = flag(a, "body");
    const importance = flag(a, "importance");
    const when = flag(a, "when");
    const surfacing = flag(a, "surfacing") as Surfacing | undefined;
    const author = flag(a, "author");
    const props = parseKv(flagAll(a, "prop"));
    const input: Parameters<Store["createNode"]>[0] = {
      type,
      title,
      origin,
      ...(body !== undefined ? { body } : {}),
      ...(importance !== undefined ? { importance: Number(importance) } : {}),
      ...(when !== undefined ? { when } : {}),
      ...(surfacing !== undefined ? { surfacing } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(Object.keys(props).length > 0 ? { props } : {}),
    };
    emit(io, mode, store.createNode(input));
  },
};

const edit: Command = {
  summary: "edit an ACTIVE node in place (propsPatch merges; --clear-prop removes)",
  usage: "balaur edit <id> [--title X] [--body B] [--when ISO] [--clear-when] [--prop k=v] [--clear-prop k]",
  run: (store, a, io, mode) => {
    const id = nid(a.positionals[0] ?? "");
    const patch: Record<string, unknown> = {};
    const title = flag(a, "title");
    if (title !== undefined) patch.title = title;
    const body = flag(a, "body");
    if (body !== undefined) patch.body = body;
    if (a.bools.has("clear-when")) patch.when = null;
    else {
      const when = flag(a, "when");
      if (when !== undefined) patch.when = when;
    }
    const propsPatch = parseKv(flagAll(a, "prop"));
    for (const k of flagAll(a, "clear-prop")) propsPatch[k] = null;
    if (Object.keys(propsPatch).length > 0) patch.propsPatch = propsPatch;
    emit(io, mode, store.updateNode(id, patch as Parameters<Store["updateNode"]>[1]));
  },
};

const propose: Command = {
  summary: "agent-authored write — gated at write time (created/merged/exists)",
  usage:
    "balaur propose --type T --title X [--body B] [--importance N] [--when ISO] [--origin O] [--author A] [--prop k=v]",
  run: (store, a, io, mode) => {
    const type = flag(a, "type");
    const title = flag(a, "title");
    if (type === undefined || title === undefined) throw new Error("propose requires --type and --title");
    const origin = flag(a, "origin") ?? "cli";
    const body = flag(a, "body") ?? "";
    const importance = flag(a, "importance");
    const when = flag(a, "when");
    const author = flag(a, "author");
    const props = parseKv(flagAll(a, "prop"));
    const p: Parameters<Store["propose"]>[0] = {
      type,
      title,
      body,
      origin,
      ...(importance !== undefined ? { importance: Number(importance) } : {}),
      ...(when !== undefined ? { when } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(Object.keys(props).length > 0 ? { props } : {}),
    };
    emit(io, mode, store.propose(p));
  },
};

const proposeEdit: Command = {
  summary: "park a change to an active consent-gated node (owner applies later)",
  usage: "balaur propose-edit <id> [--field k=v] [--archive] [--origin O] [--author A]",
  run: (store, a, io, mode) => {
    const fields = parseKv(flagAll(a, "field")) as Record<string, string>;
    const author = flag(a, "author");
    const change: Parameters<Store["proposeEdit"]>[1] = {
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
      archive: a.bools.has("archive"),
      origin: flag(a, "origin") ?? "cli",
      ...(author !== undefined ? { author } : {}),
    };
    store.proposeEdit(nid(a.positionals[0] ?? ""), change);
    emit(io, mode, { ok: true });
  },
};

const decide: Command = {
  summary: "apply the owner's verdict to a pending item",
  usage:
    "balaur decide <id> --kind approve|reject|approve_edited|approve_superseding [--supersedes ID] [--field k=v]",
  run: (store, a, io, mode) => {
    const id = nid(a.positionals[0] ?? "");
    const kind = flag(a, "kind") ?? "approve";
    const decision: Decision =
      kind === "approve_superseding"
        ? { kind: "approve_superseding", supersedes: nid(flag(a, "supersedes") ?? "") }
        : kind === "approve_edited"
          ? { kind: "approve_edited", fields: parseKv(flagAll(a, "field")) as Record<string, string> }
          : { kind: kind as "approve" | "reject" };
    emit(io, mode, store.decide(id, decision));
  },
};

const link: Command = {
  summary: "link source → target (idempotent on open triples)",
  usage: "balaur link <source> <target> [--type T] [--context C] [--valid-from ISO] [--valid-until ISO]",
  run: (store, a, io, mode) => {
    const source = nid(a.positionals[0] ?? "");
    const target = nid(a.positionals[1] ?? "");
    const type = flag(a, "type") ?? "links";
    const context = flag(a, "context") ?? "";
    const vf = flag(a, "valid-from");
    const vu = flag(a, "valid-until");
    const validity: { from?: string; until?: string } = {};
    if (vf !== undefined) validity.from = vf;
    if (vu !== undefined) validity.until = vu;
    emit(
      io,
      mode,
      store.link(source, target, type, context, Object.keys(validity).length > 0 ? validity : undefined),
    );
  },
};

const closeEdge: Command = {
  summary: "this fact stopped being true (closes validity, keeps the row)",
  usage: "balaur close-edge <edgeId> [--until ISO]",
  run: (store, a, io, mode) => {
    const id = a.positionals[0] ?? "";
    const until = flag(a, "until");
    emit(io, mode, store.closeEdge(id as Parameters<Store["closeEdge"]>[0], until));
  },
};

const forget: Command = {
  summary: "the honest erasure cascade (I6/I7)",
  usage: "balaur forget <id>",
  run: (store, a, io, mode) => emit(io, mode, store.forget(nid(a.positionals[0] ?? ""))),
};

const transition: Command = {
  summary: "move through the status FSM (owner action)",
  usage: "balaur transition <id> <status>",
  run: (store, a, io, mode) =>
    emit(io, mode, store.transition(nid(a.positionals[0] ?? ""), a.positionals[1] as Status)),
};

const quarantine: Command = {
  summary: "suppress everywhere, ask-twice to view",
  usage: "balaur quarantine <id> [--review-at ISO]",
  run: (store, a, io, mode) => {
    store.quarantine(nid(a.positionals[0] ?? ""), flag(a, "review-at"));
    emit(io, mode, { ok: true });
  },
};

const setSurfacing: Command = {
  summary: "set the surfacing policy (always|ask|never)",
  usage: "balaur set-surfacing <id> <always|ask|never>",
  run: (store, a, io, mode) => {
    store.setSurfacing(nid(a.positionals[0] ?? ""), a.positionals[1] as Surfacing);
    emit(io, mode, { ok: true });
  },
};

const alias: Command = {
  summary: "record a name the node also answers to",
  usage: "balaur alias <id> <alias>",
  run: (store, a, io, mode) => {
    store.addAlias(nid(a.positionals[0] ?? ""), a.positionals.slice(1).join(" "));
    emit(io, mode, { ok: true });
  },
};

const unalias: Command = {
  summary: "remove an alias",
  usage: "balaur unalias <id> <alias>",
  run: (store, a, io, mode) => {
    store.removeAlias(nid(a.positionals[0] ?? ""), a.positionals.slice(1).join(" "));
    emit(io, mode, { ok: true });
  },
};

const merge: Command = {
  summary: "owner's identity verdict (same = compound merge, different = permanent no_match)",
  usage: "balaur merge <keep> <other> --verdict same|different",
  run: (store, a, io, mode) =>
    emit(
      io,
      mode,
      store.decideIdentity(
        nid(a.positionals[0] ?? ""),
        nid(a.positionals[1] ?? ""),
        (flag(a, "verdict") ?? "same") as "same" | "different",
      ),
    ),
};

const suggestIdentities: Command = {
  summary: "write deterministic identity questions to the queue",
  usage: "balaur suggest-identities <type> [--cap N]",
  run: (store, a, io, mode) =>
    emit(io, mode, { added: store.suggestIdentities(a.positionals[0] ?? "", flagInt(a, "cap", 0)) }),
};

const touch: Command = {
  summary: "record that recalled knowledge was used (feeds ranking + doctor)",
  usage: "balaur touch <id>",
  run: (store, a, io, mode) => {
    store.touch(nid(a.positionals[0] ?? ""));
    emit(io, mode, { ok: true });
  },
};

const recordDerivation: Command = {
  summary: "register a derived artifact's sources",
  usage: "balaur record-derivation <artifact> [sources...]",
  run: (store, a, io, mode) => {
    const artifact = a.positionals[0] ?? "";
    store.recordDerivation(artifact, a.positionals.slice(1));
    emit(io, mode, { ok: true, artifact });
  },
};

const putVector: Command = {
  summary: "maintain the vector sidecar (host-computed vectors only)",
  usage: "balaur put-vector <id> <model> 0.1,0.2,...",
  run: (store, a, io, mode) => {
    const id = nid(a.positionals[0] ?? "");
    const model = a.positionals[1] ?? "";
    const raw = a.positionals[2] ?? "";
    store.putVector(id, model, Float32Array.from(raw.split(",").map((n) => Number(n))));
    emit(io, mode, { ok: true });
  },
};

const deleteVectors: Command = {
  summary: "drop vectors (all, or one model's)",
  usage: "balaur delete-vectors [--model M]",
  run: (store, a, io, mode) => {
    store.deleteVectors(flag(a, "model"));
    emit(io, mode, { ok: true });
  },
};

const dayAnchor: Command = {
  summary: "get-or-create the day node for a UTC date",
  usage: "balaur day-anchor <YYYY-MM-DD>",
  run: (store, a, io, mode) => emit(io, mode, store.dayAnchor(a.positionals[0] ?? "")),
};

const rebuildIndex: Command = {
  summary: "rebuild index.db from memory.db (I13 — always safe, always exact)",
  usage: "balaur rebuild-index",
  run: (store, _a, io, mode) => {
    store.rebuildIndex();
    emit(io, mode, { ok: true });
  },
};

const backup: Command = {
  summary: "snapshot the record via VACUUM INTO (WAL-safe, never overwrites)",
  usage: "balaur backup <toPath>",
  run: (store, a, io, mode) => {
    store.backup(a.positionals[0] ?? "");
    emit(io, mode, { ok: true, path: a.positionals[0] });
  },
};

export const COMMANDS: Readonly<Record<string, Command>> = {
  get,
  recall,
  search,
  agenda,
  episode,
  who,
  context,
  pending,
  doctor,
  children,
  neighborhood,
  history,
  aliases,
  survivor,
  conflicts,
  stale,
  "register-type": registerType,
  create,
  edit,
  propose,
  "propose-edit": proposeEdit,
  decide,
  link,
  "close-edge": closeEdge,
  forget,
  transition,
  quarantine,
  "set-surfacing": setSurfacing,
  alias,
  unalias,
  merge,
  "suggest-identities": suggestIdentities,
  touch,
  "record-derivation": recordDerivation,
  "put-vector": putVector,
  "delete-vectors": deleteVectors,
  "day-anchor": dayAnchor,
  "rebuild-index": rebuildIndex,
  backup,
};

export type { Node };
/** Re-exported for the entry point's help text. */
export { MemoryError, parseArgs };
