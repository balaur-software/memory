package memory

import "time"

// Status is a node's lifecycle state. The FSM is the consent boundary:
//
//	proposed → active | rejected        (owner decision)
//	active   ⇄ archived                 (reversible soft retire)
//	active   → quarantined              (suppressed everywhere; ask-twice to view)
//	quarantined → active | forgotten    (owner re-decision, possibly at a review date)
//	active | archived | quarantined → forgotten   (content tombstoned, row survives)
//	merged   (terminal alias state for entity-resolution survivors' duplicates)
//
// rejected and forgotten are terminal. "Forgotten" is honest: content is
// destroyed (tombstoned), not hidden — suppression is what quarantine is for.
type Status string

const (
	StatusProposed    Status = "proposed"
	StatusActive      Status = "active"
	StatusArchived    Status = "archived"
	StatusRejected    Status = "rejected"
	StatusQuarantined Status = "quarantined"
	StatusForgotten   Status = "forgotten"
	StatusMerged      Status = "merged"
)

// Surfacing is the third axis besides status and importance: whether an
// active node may be surfaced without being explicitly asked for. Storage
// consent is not usage consent — a fact can be legitimately kept and still
// not be warranted in every context.
type Surfacing string

const (
	SurfaceAlways Surfacing = "always" // eligible for ambient recall/injection
	SurfaceAsk    Surfacing = "ask"    // surfaced only on explicit query
	SurfaceNever  Surfacing = "never"  // surfaced only by direct id lookup
)

// Node is one row of the spine. Everything durable is a node: a memory, a
// skill, a note, a person, a day, an owner-defined record. Type semantics
// live in the type registry, not in the schema.
type Node struct {
	ID        string
	Type      string
	Title     string
	Body      string
	Status    Status
	Surfacing Surfacing
	Props     map[string]any
	Created   time.Time
	Updated   time.Time
}

// Edge links two nodes with a typed, optionally annotated relation.
// System edge types the library itself writes and understands:
//
//	on_day      node → its creation-day node (episodic anchor)
//	supersedes  new fact → the fact it replaced (validity chain)
//	derived_from derived artifact → source (lineage; cascade root)
//	merged_into  duplicate entity → survivor (resolution chain)
//	no_match     two entities the owner ruled distinct (never re-propose)
type Edge struct {
	ID      string
	Source  string
	Target  string
	Type    string
	Context string
	Created time.Time
}

// Provenance records where a write came from: the host-defined origin of the
// content (a conversation turn, a capture channel, a reflection job) and,
// when the content carries a third party's words, who authored them.
type Provenance struct {
	Origin     string // host-defined, e.g. "turn:abc123", "telegram:fwd", "reflection:2026-07-05"
	Author     string // "" = owner; otherwise a third-party attribution
	CapturedAt time.Time
}

// Embedder is the optional semantic-recall seam. Implementations must be
// local; the library never requires one and behaves deterministically
// without it.
type Embedder interface {
	Embed(texts []string) ([][]float32, error)
	// Identity distinguishes vector spaces: vectors from different
	// identities are never compared.
	Identity() string
}

// AuditEntry is one content-free audit row. Forget-class operations MUST NOT
// carry payloads — the log proves what happened without remembering what was
// forgotten.
type AuditEntry struct {
	At     time.Time
	Actor  string // "owner", "agent", "system"
	Action string // e.g. "node.create", "consent.approve", "forget.cascade"
	Ref    string // node/edge id; never content
	OK     bool
	Meta   map[string]any // ids, counts, flags — never quoted text
}
