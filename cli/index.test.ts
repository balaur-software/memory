import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./index.ts";
import type { Io } from "./render.ts";

const NOW = "2026-07-05T12:00:00.000Z";

interface Capture {
  out: string;
  err: string;
}

function captureIo(): { io: Io; cap: Capture } {
  const cap: Capture = { out: "", err: "" };
  const io: Io = {
    out: (s) => {
      cap.out += s;
    },
    err: (s) => {
      cap.err += s;
    },
  };
  return { io, cap };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function balaur(...a: string[]): { code: number; out: string; err: string } {
  const { io, cap } = captureIo();
  const code = run([...a, "--dir", dir, "--now", NOW], io);
  return { code, out: cap.out, err: cap.err };
}

function balaurJson(...a: string[]): { code: number; value: unknown; err: string } {
  const { io, cap } = captureIo();
  const code = run([...a, "--dir", dir, "--now", NOW, "--json"], io);
  return { code, value: cap.out === "" ? null : JSON.parse(cap.out), err: cap.err };
}

function firstId(value: unknown): string {
  if (Array.isArray(value)) {
    const first = value[0];
    if (first !== undefined && typeof first === "object" && first !== null && "id" in first) {
      return (first as { id: string }).id;
    }
  }
  if (typeof value === "object" && value !== null && "id" in value) {
    return (value as { id: string }).id;
  }
  throw new Error(`no id in ${JSON.stringify(value)}`);
}

describe("cli: help + dispatch", () => {
  test("no command prints help, exits 0", () => {
    const r = balaur();
    expect(r.code).toBe(0);
    expect(r.out).toContain("balaur — the memory layer CLI");
    expect(r.out).toContain("register-type");
  });

  test("--help short-circuits any command", () => {
    const r = balaur("doctor", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("commands:");
  });

  test("unknown command exits 2 with usage", () => {
    const r = balaur("frobnicate");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command: frobnicate");
  });
});

describe("cli: register-type + create (owner path)", () => {
  test("register-type then create births an active node", () => {
    expect(balaur("register-type", "note", "--born-status", "active").code).toBe(0);
    const r = balaurJson(
      "create",
      "--type",
      "note",
      "--title",
      "First note",
      "--body",
      "hello",
      "--origin",
      "test",
    );
    expect(r.code).toBe(0);
    const node = r.value as { status: string; title: string; type: string };
    expect(node.status).toBe("active");
    expect(node.title).toBe("First note");
    expect(node.type).toBe("note");
  });

  test("create with --prop coerces numbers and booleans", () => {
    balaur("register-type", "measurement", "--born-status", "active");
    const r = balaurJson(
      "create",
      "--type",
      "measurement",
      "--title",
      "Weight",
      "--origin",
      "scale",
      "--prop",
      "metric=weight",
      "--prop",
      "value=72.5",
      "--prop",
      "fasted=true",
    );
    expect(r.code).toBe(0);
    const props = (r.value as { props: Record<string, unknown> }).props;
    expect(props.metric).toBe("weight");
    expect(props.value).toBe(72.5);
    expect(props.fasted).toBe(true);
  });
});

describe("cli: consent gate (propose/decide/pending)", () => {
  test("propose queues; pending shows it; decide approve activates", () => {
    balaur("register-type", "memory", "--born-status", "proposed");
    const p = balaurJson(
      "propose",
      "--type",
      "memory",
      "--title",
      "Allergic to penicillin",
      "--origin",
      "turn:1",
    );
    expect(p.code).toBe(0);
    expect((p.value as { kind: string }).kind).toBe("created");

    const pending = balaurJson("pending");
    expect((pending.value as unknown[]).length).toBe(1);

    const items = pending.value as { kind: string; node: { id: string } }[];
    const id = items[0]?.node.id;
    if (id === undefined) throw new Error("no pending id");
    const d = balaurJson("decide", id, "--kind", "approve");
    expect(d.code).toBe(0);
    expect((d.value as { status: string }).status).toBe("active");

    expect((balaurJson("pending").value as unknown[]).length).toBe(0);
  });

  test("propose on an owner-authored type is refused with exit 1", () => {
    balaur("register-type", "note", "--born-status", "active");
    const r = balaur("propose", "--type", "note", "--title", "x", "--origin", "t");
    expect(r.code).toBe(1);
    expect(r.err).toContain("invalid_transition");
  });
});

describe("cli: recall + search + episode + agenda", () => {
  test("recall ranks by term match; --type filters", () => {
    balaur("register-type", "note", "--born-status", "active");
    balaur(
      "create",
      "--type",
      "note",
      "--title",
      "Alpine trip",
      "--body",
      "the zaffre mountains",
      "--origin",
      "t",
    );
    balaur("create", "--type", "note", "--title", "Zaffre ledger", "--body", "numbers", "--origin", "t");
    const r = balaurJson("recall", "zaffre", "--limit", "5");
    expect(r.code).toBe(0);
    const titles = (r.value as { title: string }[]).map((n) => n.title);
    expect(titles).toContain("Zaffre ledger");
    expect(titles).toContain("Alpine trip");
  });

  test("episode returns nodes created in the window", () => {
    balaur("register-type", "note", "--born-status", "active");
    balaur("create", "--type", "note", "--title", "March note", "--origin", "t");
    const march = balaurJson("episode", "2026-03-01", "2026-04-01");
    expect((march.value as unknown[]).length).toBe(0);
    const july = balaurJson("episode", "2026-07-01", "2026-08-01");
    expect((july.value as unknown[]).length).toBe(1);
  });

  test("agenda surfaces when_at-bearing nodes", () => {
    balaur("register-type", "task", "--born-status", "active");
    balaur(
      "create",
      "--type",
      "task",
      "--title",
      "Call Ana",
      "--when",
      "2026-07-05T14:00:00.000Z",
      "--origin",
      "t",
    );
    const r = balaurJson("agenda", "2026-07-05T00:00:00.000Z", "2026-07-06T00:00:00.000Z", "--type", "task");
    expect((r.value as unknown[]).length).toBe(1);
  });
});

describe("cli: link + children + neighborhood + close-edge", () => {
  test("link creates an edge; children lists the inbound set", () => {
    balaur("register-type", "project", "--born-status", "active");
    balaur("register-type", "task", "--born-status", "active");
    const proj = balaurJson("create", "--type", "project", "--title", "Site", "--origin", "t");
    const task = balaurJson("create", "--type", "task", "--title", "Draft", "--origin", "t");
    const l = balaurJson("link", firstId(task.value), firstId(proj.value), "--type", "part_of");
    expect(l.code).toBe(0);
    expect((l.value as { type: string }).type).toBe("part_of");

    const kids = balaurJson("children", firstId(proj.value), "part_of");
    expect((kids.value as unknown[]).length).toBe(1);
    expect((kids.value as { title: string }[])[0]?.title).toBe("Draft");

    const nb = balaurJson("neighborhood", firstId(proj.value));
    expect((nb.value as unknown[]).length).toBe(1);
  });
});

describe("cli: edit (updateNode) + history", () => {
  test("edit mutates title; history records the prior wording", () => {
    balaur("register-type", "note", "--born-status", "active");
    const n = balaurJson("create", "--type", "note", "--title", "Cluj", "--origin", "t");
    const id = firstId(n.value);
    const e = balaurJson("edit", id, "--title", "Cluj-Napoca");
    expect((e.value as { title: string }).title).toBe("Cluj-Napoca");
    const h = balaurJson("history", id);
    const snaps = h.value as { title: string }[];
    expect(snaps.length).toBe(1);
    expect(snaps[0]?.title).toBe("Cluj");
  });

  test("edit --clear-prop removes a prop; --prop merges (propsPatch)", () => {
    balaur("register-type", "note", "--born-status", "active");
    const n = balaurJson("create", "--type", "note", "--title", "N", "--origin", "t", "--prop", "k=v");
    const id = firstId(n.value);
    expect((balaurJson("get", id).value as { props: Record<string, unknown> }).props.k).toBe("v");
    balaur("edit", id, "--clear-prop", "k");
    expect((balaurJson("get", id).value as { props: Record<string, unknown> }).props.k).toBeUndefined();
  });
});

describe("cli: alias + who + context (entities)", () => {
  test("alias is recorded; who resolves by name or alias", () => {
    balaur("register-type", "person", "--born-status", "active");
    const p = balaurJson("create", "--type", "person", "--title", "Ana", "--origin", "t");
    const id = firstId(p.value);
    expect(balaur("alias", id, "Ana-Maria").code).toBe(0);
    const byName = balaurJson("who", "person", "ana");
    expect((byName.value as unknown[]).length).toBe(1);
    const byAlias = balaurJson("who", "person", "ana-maria");
    expect((byAlias.value as unknown[]).length).toBe(1);
    const ctx = balaurJson("context", id);
    expect((ctx.value as { aliases: string[] }).aliases).toContain("ana-maria");
  });
});

describe("cli: lifecycle (transition/quarantine/forget)", () => {
  test("transition archives; forget cascades and reports", () => {
    balaur("register-type", "note", "--born-status", "active");
    const n = balaurJson("create", "--type", "note", "--title", "Ephemeral", "--origin", "t");
    const id = firstId(n.value);
    const t = balaurJson("transition", id, "archived");
    expect((t.value as { status: string }).status).toBe("archived");
    const f = balaurJson("forget", id);
    expect((f.value as { tombstoned: string; indexScrubbed: boolean }).indexScrubbed).toBe(true);
    // getNode returns regardless of status (hosts gate display) — the
    // tombstoned row is still there, now "forgotten".
    expect((balaurJson("get", id).value as { status: string }).status).toBe("forgotten");
  });
});

describe("cli: doctor + backup + rebuild-index", () => {
  test("doctor reports integrityOk=true on a fresh store", () => {
    balaur("register-type", "note", "--born-status", "active");
    const r = balaurJson("doctor");
    expect((r.value as { integrityOk: boolean; activeCount: number }).integrityOk).toBe(true);
    expect((r.value as { activeCount: number }).activeCount).toBe(0);
  });

  test("backup writes a new file; refuses to overwrite", () => {
    balaur("register-type", "note", "--born-status", "active");
    const target = join(dir, "snap.db");
    expect(balaur("backup", target).code).toBe(0);
    const again = balaur("backup", target);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already exists");
    expect(balaur("rebuild-index").code).toBe(0);
  });
});

describe("cli: merge (decideIdentity) + suggest-identities", () => {
  test("merge same verdict turns one into a merged husk", () => {
    balaur("register-type", "person", "--born-status", "active");
    const a = balaurJson("create", "--type", "person", "--title", "Ana", "--origin", "t");
    const b = balaurJson("create", "--type", "person", "--title", "Ana M.", "--origin", "t");
    const keep = balaurJson("merge", firstId(a.value), firstId(b.value), "--verdict", "same");
    expect((keep.value as { status: string }).status).toBe("active");
    const survivor = balaurJson("survivor", firstId(b.value));
    expect((survivor.value as { id: string }).id).toBe(firstId(a.value));
  });
});
