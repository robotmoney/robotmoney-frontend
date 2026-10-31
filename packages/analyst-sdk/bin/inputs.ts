// `bun run inputs --archive <local copy> --run <run_key> [--as-of <backup id>] [--out <dir>] [--json]`
// Writes one published run's input file and its manifest sidecar from a format 1
// local copy: `<out>/inputs.csv` (or `inputs.json`) and `<out>/inputs.manifest.json`.
// The local copy is acquired first, outside the SDK (a clone of the backups repo
// plus `csvb backup --source api`, or the API-only fill); this command reads
// local files only and never fetches. It verifies every listed file of the
// selected backups (present, SHA-256, row count for the tables it reads) and the
// run's vintage membership before writing anything, and refuses to overwrite.
//
// Exit status: 0 on success, 2 for a usage error, 1 for anything else
// (incomplete or corrupt copy, unknown run, partial vintage, existing output).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArchiveError, serializeInputs } from "../src/archive/format1.ts";
import { serializeManifest } from "../src/input/manifest.ts";
import { parseArgs, resolveFromCaller, UsageError } from "./args.ts";
import { collectRunInputs, openBackupsDir } from "./backups-dir.ts";

const USAGE = "usage: bun run inputs --archive <local copy dir> --run <run_key> [--as-of <backup id>] [--out <dir>] [--json]";

function fail(e: unknown, code: number): never {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  if (code === 2) console.error(USAGE);
  process.exit(code);
}

let args;
try {
  args = parseArgs(process.argv.slice(2), { flags: ["--json"], values: ["--archive", "--run", "--as-of", "--out"], maxPositionals: 0 });
  if (!args.values.has("--archive")) throw new UsageError("--archive is required");
  if (!args.values.has("--run")) throw new UsageError("--run is required");
} catch (e) {
  fail(e, 2);
}

const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

try {
  const root = resolveFromCaller(args.values.get("--archive")!, "inputs");
  const outDir = resolveFromCaller(args.values.get("--out") ?? ".", "inputs");
  const format = args.flags.has("--json") ? "json" : "csv";
  const inputName = `inputs.${format}`;
  const inputPath = join(outDir, inputName);
  const manifestPath = join(outDir, "inputs.manifest.json");
  for (const p of [inputPath, manifestPath]) if (existsSync(p)) throw new ArchiveError(`${p} exists; inputs are never overwritten`);

  const copy = openBackupsDir(root, args.values.get("--as-of"));
  const asOf = copy.asOf;
  const inputs = collectRunInputs(copy, args.values.get("--run")!);

  const text = serializeInputs(inputs.rows, format);
  const bytes = new TextEncoder().encode(text);
  const manifest = serializeManifest({
    format: 1,
    input: inputName,
    backup_id: asOf.backup,
    run_key: inputs.run.runKey,
    asof: inputs.run.asof,
    source: asOf.source ?? "db",
    row_count: inputs.rows.length,
    sha256: sha256(bytes),
    methodology: inputs.run.methodology,
    code_revision: inputs.run.codeRevision,
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(inputPath, bytes, { flag: "wx" });
  writeFileSync(manifestPath, manifest, { flag: "wx" });
  const skipped = Object.entries(inputs.skipped).map(([k, n]) => `${k} ${n}`).join(", ");
  console.error(
    `wrote ${inputPath} (${inputs.rows.length} rows) and ${manifestPath}: run ${inputs.run.runKey} as of ${inputs.run.asof}, backup ${asOf.backup}, vintage ${inputs.run.vintageId} (${inputs.run.memberCount} members)` +
      (skipped ? `; members that are not regime inputs: ${skipped}` : ""),
  );
} catch (e) {
  fail(e, 1);
}
