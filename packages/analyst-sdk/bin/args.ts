// Command-line edge helpers shared by bin/regime.ts and bin/inputs.ts: strict
// argument parsing and caller-directory path resolution. This is edge code
// (bin/, not src/), so it may read the environment.
import { delimiter, isAbsolute, resolve, sep } from "node:path";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

// Every option at most once; a value option needs a value that is not itself
// an option; an unknown option is an error; at most `maxPositionals` operands.
export function parseArgs(argv: readonly string[], spec: { flags: readonly string[]; values: readonly string[]; maxPositionals: number }): ParsedArgs {
  const out: ParsedArgs = { positionals: [], flags: new Set(), values: new Map() };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      if (seen.has(a)) throw new UsageError(`${a} given more than once`);
      seen.add(a);
      if (spec.flags.includes(a)) out.flags.add(a);
      else if (spec.values.includes(a)) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
        out.values.set(a, v);
        i++;
      } else {
        const hint = a === "--panels" ? " (--panels was replaced by --factor)" : "";
        throw new UsageError(`unknown option ${a}${hint}`);
      }
    } else {
      out.positionals.push(a);
      if (out.positionals.length > spec.maxPositionals) throw new UsageError(`unexpected extra argument ${JSON.stringify(a)}`);
    }
  }
  return out;
}

// The folder the analyst ran the command in. `bun run <script>` changes into the
// package folder before it starts the script. It records where it started in
// two ways: npm_config_local_prefix, which it does NOT reset when an outer
// `bun run` already set it (so it can name the outer caller), and the
// node_modules/.bin entries it prepends to PATH, which it builds walking up
// from the folder it was started in, on every run (the package scripts start
// `bun bin/<x>.ts`, not `bun run`, so no second walk from the package folder
// comes in front of it; tests/cli.test.ts holds both). The PATH walk is read first;
// both apply only inside the script process itself (its lifecycle event is this
// script and its cwd is this package), so a direct `bun bin/<x>.ts` always
// resolves from its own cwd.
const PACKAGE_DIR = resolve(import.meta.dir, "..");

export function callerDir(script: string): string {
  const env = process.env;
  const cwd = process.cwd();
  if (env.npm_lifecycle_event !== script || resolve(cwd) !== PACKAGE_DIR) return cwd;
  const bin = `${sep}node_modules${sep}.bin`;
  const first = (env.PATH ?? "").split(delimiter).find((p) => p.endsWith(bin));
  if (first) {
    // The first entry is the start of the walk: the caller's folder.
    const dir = first.slice(0, -bin.length) || sep;
    if (isAbsolute(dir)) return dir;
  }
  return env.npm_config_local_prefix || cwd;
}

export function resolveFromCaller(path: string, script: string): string {
  return isAbsolute(path) ? path : resolve(callerDir(script), path);
}
