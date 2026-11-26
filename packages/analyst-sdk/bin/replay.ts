// `bun run replay --archive <local copy> --run <run_key> [--print-row] [--json] [--included macro,onchain] [--version <tag>]`
// Replays one published regime run from a format 1 local copy and compares the
// as-of row the SDK computes with the one the run published (issue 1765). One
// command for what took three: `bun run inputs`, `bun run regime --replay` with
// the right methodology, and a comparison. The work is replayRun
// (src/replay/replay.ts): the version from the run's methodology label, the
// inputs from its vintage, the kept days its report names, the published rows
// from its line's artifact kind, and compareRows over the compared fields.
// This file only parses arguments, opens the copy and prints.
//
//   --print-row        print the SDK's as-of row as JSON and compare nothing.
//   --json             print the result as one JSON object.
//   --included <list>  the panels the composite averages (default: the version's published panels).
//   --version <tag>    replay under this version, not the run's label.
//
// Exit status: 0 when the rows are equal; 1 when they differ, a side is
// missing, a payload hash does not match, the label is one this SDK does not
// compute, or the copy is corrupt or incomplete; 2 for a usage error: a missing
// --run or --archive, a bad option, or a run key that is not in the copy.
import { ALL_PANELS, type Panel } from "../src/analyze/indicators.ts";
import { REGIME_VERSIONS, isRegimeVersion } from "../src/analyze/regime-versions.ts";
import { replayRun, UnknownRunError, type ReplayOptions, type ReplayResult } from "../src/replay/replay.ts";
import { parseArgs, resolveFromCaller, UsageError } from "./args.ts";
import { openBackupsDir } from "./backups-dir.ts";

const USAGE = "usage: bun run replay --archive <local copy dir> --run <run_key> [--print-row] [--json] [--included macro,onchain] [--version <tag>]";

function fail(e: unknown, code: number): never {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  if (code === 2) console.error(USAGE);
  process.exit(code);
}

function panelsOf(text: string): Panel[] {
  const panels = text.split(",").map((p) => p.trim());
  if (panels.length === 0 || panels.some((p) => !(ALL_PANELS as string[]).includes(p)) || new Set(panels).size !== panels.length) {
    throw new UsageError(`--included takes distinct panels from ${ALL_PANELS.join(", ")}, comma separated, got ${JSON.stringify(text)}`);
  }
  return panels as Panel[];
}

let args;
const opts: ReplayOptions = {};
try {
  args = parseArgs(process.argv.slice(2), { flags: ["--print-row", "--json"], values: ["--archive", "--run", "--included", "--version"], maxPositionals: 0 });
  if (!args.values.has("--archive")) throw new UsageError("--archive is required");
  if (!args.values.has("--run")) throw new UsageError("--run is required");
  const included = args.values.get("--included");
  if (included !== undefined) opts.included = panelsOf(included);
  const version = args.values.get("--version");
  if (version !== undefined) {
    if (!isRegimeVersion(version)) throw new UsageError(`--version is one of ${REGIME_VERSIONS.join(", ")}, got ${JSON.stringify(version)}`);
    opts.version = version;
  }
} catch (e) {
  fail(e, 2);
}

const runKey = args.values.get("--run")!;
let result: ReplayResult;
try {
  const copy = openBackupsDir(resolveFromCaller(args.values.get("--archive")!, "replay"));
  result = replayRun(copy, runKey, opts);
} catch (e) {
  // A run key not in the copy is a usage error; a corrupt or incomplete copy (ArchiveError) is not.
  fail(e, e instanceof UnknownRunError ? 2 : 1);
}

if (args.flags.has("--print-row")) {
  if (result.computed.asof === null) {
    for (const p of result.problems) console.error(p);
    console.error(`run ${runKey}: the SDK computed no as-of row for ${result.run.asof}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result.computed.asof));
  process.exit(0);
}

const d = result.diff;
const ok = d !== null && d.match && result.problems.length === 0;
if (args.flags.has("--json")) {
  console.log(
    JSON.stringify({
      run: runKey,
      asof: result.run.asof,
      methodology: result.run.methodology.label,
      version: result.version,
      line: result.line,
      kind: result.published.kind,
      artifactId: result.published.artifactId,
      panels: result.panels,
      match: d?.match ?? false,
      differing: d?.differing ?? [],
      details: d?.details ?? [],
      firstDiff: d?.firstDiff ?? null,
      beyondRounding: d?.beyondRounding ?? [],
      publishedSha256: d?.publishedSha256 ?? null,
      replaySha256: d?.replaySha256 ?? null,
      publishedRows: result.published.rows?.length ?? null,
      computedRows: result.computed.rows.length,
      kept: result.kept === null ? null : { days: result.kept.days.length, artifactIds: result.kept.artifactIds, sha256: result.kept.sha256, computedDays: result.kept.computedDays },
      notes: result.notes,
      problems: result.problems,
    }),
  );
} else {
  const head = `run ${runKey} as of ${result.run.asof} (${result.version ?? `methodology ${result.run.methodology.label}`}${result.published.kind ? `, ${result.published.kind}` : ""})`;
  for (const n of result.notes) console.log(`note: ${n}`);
  for (const p of result.problems) console.log(`problem: ${p}`);
  if (d !== null && d.match) console.log(`${head}: the SDK's as-of row equals the published one (sha256 ${d.replaySha256})`);
  else if (d !== null && d.firstDiff !== null) {
    const f = d.firstDiff;
    console.log(`${head}: the SDK's as-of row differs from the published one in ${d.differing.join(", ")} (${d.details.join(", ")}); first ${f.field}: published ${f.published.slice(0, 80)}, SDK ${f.replay.slice(0, 80)}`);
  } else console.log(`${head}: not compared`);
}
process.exit(ok ? 0 : 1);
