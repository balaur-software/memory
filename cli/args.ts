/**
 * Hand-rolled argument parser — the zero-dep rule (CODING.md) means no
 * commander/yargs. Personal-scale CLI: one subcommand, repeatable string
 * flags, boolean flags, positional rest. ~40 lines of real logic.
 *
 * Forms accepted: `--flag value`, `--flag=value`, `--bool`. The first
 * positional is the subcommand. Everything after the subcommand that is
 * not a flag is a positional. Flag values are collected per-key into
 * arrays so commands can read repeats (`--prop k=v --prop k2=v2`).
 */

export interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, readonly string[]>>;
  readonly bools: ReadonlySet<string>;
}

/** Parse `argv` (the slice AFTER the binary name). Never throws — a
 * missing value lands as an empty array and the caller reports usage. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string[]> = {};
  const bools = new Set<string>();
  let i = 0;
  let command = "";
  while (i < argv.length) {
    const a = argv[i];
    if (a === undefined) {
      i++;
      continue;
    }
    if (a === "--") {
      i++;
      while (i < argv.length) {
        const rest = argv[i];
        if (rest !== undefined) positionals.push(rest);
        i++;
      }
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        pushFlag(flags, a.slice(2, eq), a.slice(eq + 1));
        i++;
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        bools.add(key);
        i++;
      } else {
        pushFlag(flags, key, next);
        i += 2;
      }
      continue;
    }
    if (command === "") command = a;
    else positionals.push(a);
    i++;
  }
  return { command, positionals, flags, bools };
}

function pushFlag(flags: Record<string, string[]>, key: string, val: string): void {
  const existing = flags[key];
  if (existing === undefined) flags[key] = [val];
  else existing.push(val);
}

/** First value for a flag, or undefined. */
export function flag(a: ParsedArgs, key: string): string | undefined {
  const v = a.flags[key];
  return v === undefined ? undefined : v[0];
}

/** All values for a flag (empty array if absent). */
export function flagAll(a: ParsedArgs, key: string): readonly string[] {
  return a.flags[key] ?? [];
}

/** Parse an integer flag with a fallback default. */
export function flagInt(a: ParsedArgs, key: string, fallback: number): number {
  const v = flag(a, key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`--${key} must be an integer, got ${JSON.stringify(v)}`);
  return n;
}
