// Reading a format 1 local copy from disk: the file side of src/archive/format1.ts.
// That module is pure (no filesystem, issue 1095); this edge module lists the
// backup records, reads, hashes and gunzips the listed files, and hands their
// text to it. bin/inputs.ts writes one run's input with it; the published-record
// replay (backend/tests/regime-replay-archive.test.ts, issue 1431) replays every
// regime run of a copy with the same reader, so there is one archive reader.
//
// Every listed file of the selected backups is checked before anything is
// returned: present and, once gunzipped, matching its recorded SHA-256 (the hash
// of the uncompressed bytes: gzip is only a transport encoding, so any encoder's
// output verifies). Files of the tables read here are also parsed and row-counted
// against their record.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ArchiveError,
  INPUT_TABLES,
  inflateBounded,
  RunInputCollector,
  listedFiles,
  parseCopyCsv,
  selectBackups,
  toObjects,
  verifyFile,
  type BackupRecord,
  type FileRecord,
  type Row,
  type RunInputs,
} from "../src/archive/format1.ts";

const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

// A listed archive's uncompressed bytes, or null when it is missing. The inflate
// is bounded by the record's bytes_raw. A file that is not a valid gzip is
// corrupt, not missing.
function contentOf(abs: string, f: FileRecord): Uint8Array | null {
  if (!existsSync(abs)) return null;
  try {
    return inflateBounded(readFileSync(abs), f.bytes_raw, abs);
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError(`corrupt local copy: ${abs} is not a readable gzip (${(err as Error).message})`);
  }
}

const tableOf = (f: FileRecord): string => f.path.split("/").pop()!.split(".")[0]!;

export interface LocalCopy {
  root: string;
  // The selected backups, oldest first; the last is the as-of backup.
  records: BackupRecord[];
  asOf: BackupRecord;
  // The run-ledger tables (INPUT_TABLES except source_value_versions), as objects.
  tables: Record<string, Row[]>;
  // The listed data files of any table, verified, for the caller to read with readRows.
  files(table: string): FileRecord[];
  readRows(f: FileRecord): Row[];
  // Every source_value_versions file's rows, read once.
  versions(): Row[][];
}

// Open and verify a local copy as of a backup id (or its newest backup).
export function openLocalCopy(root: string, asOf?: string): LocalCopy {
  const csvDir = join(root, "csv");
  if (!existsSync(csvDir)) throw new ArchiveError(`${root} is not a format 1 local copy (no csv/ directory)`);
  const texts: Record<string, string> = {};
  for (const d of readdirSync(csvDir)) {
    const rec = join(csvDir, d, "backup.json");
    if (existsSync(rec)) texts[d] = readFileSync(rec, "utf8");
  }
  const records = selectBackups(texts, asOf);
  const all = listedFiles(records);

  const readRows = (f: FileRecord): Row[] => {
    const abs = join(root, f.path);
    const content = contentOf(abs, f);
    const digest = content === null ? null : sha256(content);
    verifyFile(f, { sha256_raw: digest });
    const rows = toObjects(parseCopyCsv(new TextDecoder().decode(content!)));
    verifyFile(f, { sha256_raw: digest, rows: rows.length });
    return rows;
  };

  // Every listed file must be present and match its recorded hash; the
  // run-ledger tables are parsed now, the rest when a caller asks.
  const tables: Record<string, Row[]> = {};
  for (const f of all) {
    const table = tableOf(f);
    if ((INPUT_TABLES as readonly string[]).includes(table) && table !== "source_value_versions") {
      // A loop, not push(...rows): a production vintage file holds over a
      // million member rows, past the engine's argument limit.
      const into = (tables[table] ??= []);
      for (const r of readRows(f)) into.push(r);
      continue;
    }
    const abs = join(root, f.path);
    const content = contentOf(abs, f);
    verifyFile(f, { sha256_raw: content === null ? null : sha256(content) });
  }

  const files = (table: string) => all.filter((f) => tableOf(f) === table && f.path.includes("/data/"));
  let versionRows: Row[][] | null = null;
  return {
    root,
    records,
    asOf: records[records.length - 1]!,
    tables,
    files,
    readRows,
    versions: () => (versionRows ??= files("source_value_versions").map(readRows)),
  };
}

// One run's frozen inputs from an open copy (exactly its vintage).
export function collectRunInputs(copy: LocalCopy, runKey: string): RunInputs {
  const collector = new RunInputCollector(runKey, {
    runs: copy.tables.analytics_ledger_runs ?? [],
    methodologies: copy.tables.analytics_ledger_methodology_versions ?? [],
    vintages: copy.tables.analytics_data_vintages ?? [],
    members: copy.tables.analytics_vintage_members ?? [],
  });
  for (const rows of copy.versions()) collector.addVersions(rows);
  return collector.finish();
}
