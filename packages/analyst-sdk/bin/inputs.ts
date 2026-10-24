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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  ArchiveError,
  INPUT_TABLES,
  RunInputCollector,
  listedFiles,
  parseCopyCsv,
  selectBackups,
  serializeInputs,
  toObjects,
  verifyFile,
  type FileRecord,
  type Row,
} from "../src/archive/format1.ts";
import { serializeManifest } from "../src/input/manifest.ts";
import { parseArgs, resolveFromCaller, UsageError } from "./args.ts";

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

  const csvDir = join(root, "csv");
  if (!existsSync(csvDir)) throw new ArchiveError(`${root} is not a format 1 local copy (no csv/ directory)`);
  const texts: Record<string, string> = {};
  for (const d of readdirSync(csvDir)) {
    const rec = join(csvDir, d, "backup.json");
    if (existsSync(rec)) texts[d] = readFileSync(rec, "utf8");
  }
  const records = selectBackups(texts, args.values.get("--as-of"));
  const asOf = records[records.length - 1]!;

  // Every listed file must be present and match its recorded hash; the files of
  // the tables a run's inputs come from are also parsed and row-counted.
  const read = (f: FileRecord): Row[] | null => {
    const abs = join(root, f.path);
    if (!existsSync(abs)) {
      verifyFile(f, { sha256_gz: null });
      return null;
    }
    const gz = readFileSync(abs);
    const digest = sha256(gz);
    verifyFile(f, { sha256_gz: digest });
    const isInput = INPUT_TABLES.some((t) => f.path.split("/").pop()!.startsWith(`${t}.`));
    if (!isInput) return null;
    const rows = toObjects(parseCopyCsv(new TextDecoder().decode(gunzipSync(gz))));
    verifyFile(f, { sha256_gz: digest, rows: rows.length });
    return rows;
  };
  const tableRows: Record<string, Row[]> = {};
  const versionFiles: FileRecord[] = [];
  for (const f of listedFiles(records)) {
    const name = f.path.split("/").pop()!;
    if (name.startsWith("source_value_versions.")) {
      versionFiles.push(f);
      continue;
    }
    const rows = read(f);
    if (!rows) continue;
    const table = INPUT_TABLES.find((t) => name.startsWith(`${t}.`))!;
    (tableRows[table] ??= []).push(...rows);
  }
  const collector = new RunInputCollector(args.values.get("--run")!, {
    runs: tableRows.analytics_ledger_runs ?? [],
    methodologies: tableRows.analytics_ledger_methodology_versions ?? [],
    vintages: tableRows.analytics_data_vintages ?? [],
    members: tableRows.analytics_vintage_members ?? [],
  });
  for (const f of versionFiles) collector.addVersions(read(f)!);
  const inputs = collector.finish();

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
