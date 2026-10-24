// `bun run regime <input.csv|input.json> [--full] [--start D] [--asof D] [--factor] [--replay] [--provenance]`
// Prints the regime report as JSON on stdout. Reads one local file (and, with
// --provenance, its manifest sidecar); no network. A relative path resolves
// from the folder the command was run in, also under `bun run`.
//
// Exit status: 0 on success; 2 for a usage error (bad, repeated or unknown
// option, a missing value, a second input file, a rejected option value);
// 1 for a runtime failure (unreadable file, malformed input, a manifest that
// does not match its input).
import { basename } from "node:path";
import { parseInput } from "../src/input/load.ts";
import { manifestPathFor, provenanceEnvelope, validateManifest, type InputManifest } from "../src/input/manifest.ts";
import { buildReport, runRegime } from "../src/run.ts";
import { parseArgs, resolveFromCaller, UsageError } from "./args.ts";

const USAGE =
  "usage: bun run regime <input.csv|input.json> [--full] [--start YYYY-MM-DD] [--asof YYYY-MM-DD] [--factor] [--replay] [--provenance]";

function fail(e: unknown, code: number): never {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  if (code === 2) console.error(USAGE);
  process.exit(code);
}

let args;
try {
  args = parseArgs(process.argv.slice(2), {
    flags: ["--full", "--factor", "--replay", "--provenance"],
    values: ["--start", "--asof"],
    maxPositionals: 1,
  });
  if (args.positionals.length === 0) throw new UsageError("an input file is required");
} catch (e) {
  fail(e, 2);
}

const file = resolveFromCaller(args.positionals[0]!, "regime");
try {
  const bytes = await Bun.file(file).bytes();
  const text = new TextDecoder().decode(bytes);
  const input = parseInput(text, { replay: args.flags.has("--replay") });
  // Provenance is read and validated here, at the edge, before the run: the
  // computation never sees it, and it never changes the report.
  let manifest: InputManifest | null = null;
  if (args.flags.has("--provenance")) {
    const sidecar = Bun.file(manifestPathFor(file));
    if (await sidecar.exists()) {
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      manifest = validateManifest(await sidecar.text(), { name: basename(file), sha256, rows: input.rows });
    }
  }
  const report = buildReport(
    runRegime(input.history, { start: args.values.get("--start"), asof: args.values.get("--asof"), factor: args.flags.has("--factor") }),
    { full: args.flags.has("--full") },
  );
  console.log(JSON.stringify(args.flags.has("--provenance") ? provenanceEnvelope(report, manifest) : report, null, 2));
} catch (e) {
  // A rejected option value (RangeError from runRegime) is a usage error like a
  // missing value or an unknown flag: exit 2. Anything else is a runtime failure.
  fail(e, e instanceof RangeError ? 2 : 1);
}
