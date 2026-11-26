// `bun run regime <input.csv|input.json> [--full] [--start D] [--asof D] [--factor] [--replay] [--provenance] [--methodology V] [--panels P,P]`
// Prints the regime report as JSON on stdout. --methodology picks the regime
// methodology version (default the current one): a published run replays under
// the version it was stamped with, e.g. --methodology v3 (issue 1652). --methodology v5 (issue 1753) computes
// the methodology published beside the main line: every day from its own day's inputs, walked forward from
// this input (it reads the five raw series of its derived indicators when the input carries them). Reads one local file (and, with
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
import type { RegimeVersion } from "../src/analyze/regime-versions.ts";
import type { Panel } from "../src/analyze/indicators.ts";
import { sha256 } from "../node/hash.ts";
import { parseArgs, resolveFromCaller, UsageError } from "./args.ts";

const USAGE =
  "usage: bun run regime <input.csv|input.json> [--full] [--start YYYY-MM-DD] [--asof YYYY-MM-DD] [--factor] [--replay] [--provenance] [--methodology v3|v4|v5] [--panels macro,onchain,...]";

function fail(e: unknown, code: number): never {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  if (code === 2) console.error(USAGE);
  process.exit(code);
}

let args;
try {
  args = parseArgs(process.argv.slice(2), {
    flags: ["--full", "--factor", "--replay", "--provenance"],
    values: ["--start", "--asof", "--methodology", "--panels"],
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
      manifest = validateManifest(await sidecar.text(), { name: basename(file), sha256: sha256(bytes), rows: input.rows });
    }
  }
  const run = runRegime(input.history, {
      start: args.values.get("--start"),
      asof: args.values.get("--asof"),
      factor: args.flags.has("--factor"),
      version: args.values.get("--methodology") as RegimeVersion | undefined,
      ...(args.values.has("--panels") ? { panels: args.values.get("--panels")!.split(",") as Panel[] } : {}),
    });
  // An incomplete as-of day (issue 1655) has no figure: the typed result is
  // printed as is, and the command exits 1.
  if (run.kind === "incomplete") {
    console.log(JSON.stringify(run, null, 2));
    process.exit(1);
  }
  const report = buildReport(run, { full: args.flags.has("--full") });
  console.log(JSON.stringify(args.flags.has("--provenance") ? provenanceEnvelope(report, manifest) : report, null, 2));
} catch (e) {
  // A rejected option value (RangeError from runRegime) is a usage error like a
  // missing value or an unknown flag: exit 2. Anything else is a runtime failure.
  fail(e, e instanceof RangeError ? 2 : 1);
}
