#!/usr/bin/env bun
/**
 * The `balaur` CLI — a thin host over the in-process library (HOSTING.md).
 * The library is the primary surface; this is the command-line one. Two
 * delivery paths:
 *
 *   - `bunx balaur …` after `bun add balaur-memory` (package.json `bin`),
 *   - a `bun build --compile` standalone binary (ADR-0001 deployment story).
 *
 * `run` is exported so tests exercise the full parse → dispatch → render
 * path in-process (deterministic, no process spawn). The bootstrap below
 * wires `run` to stdout/stderr when this file is the entry module.
 *
 * The CLI never imports `bun:sqlite` (ADR-0001 containment); it goes
 * through `Store`. Global flags: `--dir`, `--now` (freeze the clock),
 * `--json`, `--help`.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { COMMANDS, MemoryError, parseArgs } from "./commands.ts";
import type { Io, Mode } from "./render.ts";

function defaultDir(): string {
  const env = process.env.BALAUR_DIR;
  if (env !== undefined && env !== "") return env;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".local/share/life");
}

function helpText(): string {
  const cmds = Object.entries(COMMANDS)
    .map(([name, c]) => `  ${name.padEnd(20)} ${c.summary}`)
    .join("\n");
  return `balaur — the memory layer CLI

usage: balaur <command> [flags] [positionals]
       balaur <command> --help
       balaur --help

global flags:
  --dir PATH      directory holding memory.db + index.db (default: $BALAUR_DIR or ~/.local/share/life)
  --now ISO       freeze the store clock at this moment (testing)
  --json          emit JSON (default: human-readable text)
  --help, -h      show this help

commands:
${cmds}
`;
}

/** Run the CLI against `argv` (the slice after the binary name). Returns
 * the process exit code; never throws — errors render to `io.err`. */
export function run(argv: string[], io: Io): number {
  const a = parseArgs(argv);
  if (a.command === "" || a.bools.has("help") || a.bools.has("h")) {
    io.out(helpText());
    return 0;
  }
  const cmd = COMMANDS[a.command];
  if (cmd === undefined) {
    io.err(`unknown command: ${a.command}\n\n${helpText()}`);
    return 2;
  }
  const dir = a.flags.dir?.[0] ?? defaultDir();
  const mode: Mode = a.bools.has("json") ? "json" : "text";
  let now: (() => Date) | undefined;
  const nowIso = a.flags.now?.[0];
  if (nowIso !== undefined) {
    const fixed = new Date(nowIso);
    if (Number.isNaN(fixed.getTime())) {
      io.err(`--now must be ISO-8601, got ${JSON.stringify(nowIso)}\n`);
      return 2;
    }
    now = () => fixed;
  }
  let store: Store | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    store = Store.open({ ...(now !== undefined ? { now } : {}), dir });
    cmd.run(store, a, io, mode);
    return 0;
  } catch (e) {
    if (e instanceof MemoryError) io.err(`error: ${e.code}: ${e.message}\n`);
    else if (e instanceof Error) io.err(`error: ${e.message}\n`);
    else io.err(`error: ${String(e)}\n`);
    return 1;
  } finally {
    store?.close();
  }
}

// --- bootstrap (only when this file is the entry module) ---

if (import.meta.main) {
  const code = run(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exit(code);
}

export { parseArgs };
