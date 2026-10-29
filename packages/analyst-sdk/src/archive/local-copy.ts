// Reading a format 1 local copy (issue 1513): the reader core, pure. File access
// goes through an injected ArchiveFiles reader, so the same code runs over a
// directory on disk (bin/local-copy.ts, the reader of `bun run inputs`), an
// in-memory map in a test, or anything else a client hands it. The SDK never
// fetches and never touches a filesystem here (analyst SDK requirements
// section 2, D57; scripts/tests/unit/analyst-sdk-purity.test.ts).
//
// Every listed file of the selected backups is checked before anything is
// returned: present and, once inflated within its record's bytes_raw, matching
// its recorded SHA-256 (the hash of the uncompressed bytes: gzip is only a
// transport encoding, so any encoder's output verifies). Files of the run-ledger
// tables are also parsed and row-counted against their record; every other file
// (source_value_versions, revision files) is row-counted when it is read.
//
// Beyond one run's inputs (collectRunInputs), a copy answers two questions a
// research client asks of the whole archive:
//   revisedTable(table)    a revised table (regime_snapshots, raw_indicator_history,
//                          asset_prices, ...) as of the copy's as-of backup: every
//                          selected backup's revisions/<table>.csv.gz replayed in
//                          backup order, upserting or deleting by the key columns
//                          its record names.
//   latestValues(keys)     the newest source_value_versions value per
//                          (source_key, market_date) for the requested storage
//                          keys, tagged with the input id they are read under.
import { createHash } from "node:crypto";
import {
  ArchiveError,
  INPUT_TABLES,
  inflateBounded,
  listedFiles,
  parseCopyCsv,
  RunInputCollector,
  selectBackups,
  seriesForStorageKey,
  toObjects,
  verifyFile,
  type BackupRecord,
  type FileRecord,
  type Row,
  type RunInputs,
} from "./format1.ts";

// The one thing the reader needs from where a copy lives.
export interface ArchiveFiles {
  // The copy's location, used only in messages (a directory path, or any label).
  readonly root: string;
  // The directory names under csv/ (one per backup), or null when the copy has no csv/ directory.
  backupDirs(): string[] | null;
  // The bytes of a file at a path relative to the copy root, with "/" separators,
  // or null when the file is absent.
  read(path: string): Uint8Array | null;
}

// A revised table's state as of a backup: its columns (the widest revision
// header, without _backup and _op) and its rows, sorted by key column by column.
export interface RevisedTable {
  header: string[];
  rows: Row[];
}

// The newest value of one storage key on one market date.
export interface LatestValue {
  // The input id the key is read under (src/series-ids.ts), e.g. SPX for backtest:^GSPC.
  series: string;
  sourceKey: string;
  date: string;
  // The source_value_versions id of the newest version (decimal text, compared as BigInt).
  id: string;
  // The stored value text, unchanged (null when the newest version stores NULL).
  value: string | null;
}

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
  // A revised table as of the copy's as-of backup (see the header).
  revisedTable(table: string): RevisedTable;
  // The newest value per (source_key, market_date) for these storage keys, sorted
  // by market date then source key. A key no input id maps to is refused.
  latestValues(sourceKeys: readonly string[]): LatestValue[];
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
// readFileSync(path, "utf8") keeps a byte order mark; so does this.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
const where = (root: string, path: string) => (root === "" ? path : `${root.replace(/\/+$/, "")}/${path}`);
const tableOf = (f: FileRecord): string => f.path.split("/").pop()!.split(".")[0]!;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// Key cells sort in code point order; a NULL cell sorts before any text.
const cmpCell = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : cmp(a, b));

// Open and verify a local copy as of a backup id (or its newest backup).
export function openArchive(fs: ArchiveFiles, asOf?: string): LocalCopy {
  const root = fs.root;
  const dirs = fs.backupDirs();
  if (dirs === null) throw new ArchiveError(`${root} is not a format 1 local copy (no csv/ directory)`);
  const texts: Record<string, string> = {};
  for (const d of dirs) {
    const rec = fs.read(`csv/${d}/backup.json`);
    if (rec !== null) texts[d] = utf8.decode(rec);
  }
  const records = selectBackups(texts, asOf);
  const all = listedFiles(records);

  // A listed file's uncompressed bytes, or null when it is missing. The inflate
  // is bounded by the record's bytes_raw. A file that is not a valid gzip is
  // corrupt, not missing.
  const contentOf = (f: FileRecord): Uint8Array | null => {
    const buf = fs.read(f.path);
    if (buf === null) return null;
    const abs = where(root, f.path);
    try {
      return inflateBounded(buf, f.bytes_raw, abs);
    } catch (err) {
      if (err instanceof ArchiveError) throw err;
      throw new ArchiveError(`corrupt local copy: ${abs} is not a readable gzip (${(err as Error).message})`);
    }
  };

  const readCsv = (f: FileRecord) => {
    const content = contentOf(f);
    const digest = content === null ? null : sha256(content);
    verifyFile(f, { sha256_raw: digest });
    const csv = parseCopyCsv(utf8.decode(content!));
    verifyFile(f, { sha256_raw: digest, rows: csv.rows.length });
    return csv;
  };
  const readRows = (f: FileRecord): Row[] => toObjects(readCsv(f));

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
    const content = contentOf(f);
    verifyFile(f, { sha256_raw: content === null ? null : sha256(content) });
  }

  const files = (table: string) => all.filter((f) => tableOf(f) === table && f.path.includes("/data/"));
  let versionRows: Row[][] | null = null;
  const versions = () => (versionRows ??= files("source_value_versions").map(readRows));

  const revisedTable = (table: string): RevisedTable => {
    const state = new Map<string, Row>();
    let header: string[] | null = null;
    let keyCols: readonly string[] = [];
    for (const rec of records) {
      const rev = rec.revisions?.[table];
      if (!rev?.file) continue;
      keyCols = rev.key;
      const csv = readCsv(rev.file);
      const cols = csv.header.filter((c) => c !== "_backup" && c !== "_op");
      for (const c of keyCols) {
        if (!csv.header.includes(c)) throw new ArchiveError(`corrupt local copy: ${rev.file.path} has no ${c} column, a key column of ${table} in csv/${rec.backup}/backup.json`);
      }
      if (header === null || cols.length > header.length) header = cols;
      for (const row of toObjects(csv)) {
        const key = JSON.stringify(keyCols.map((c) => row[c] ?? null));
        if (row._op === "delete") {
          state.delete(key);
          continue;
        }
        const cur = state.get(key) ?? {};
        for (const c of cols) cur[c] = row[c] ?? null;
        state.set(key, cur);
      }
    }
    const cols = header ?? [];
    const rows = [...state.values()].map((r) => {
      const o: Row = {};
      for (const c of cols) o[c] = r[c] ?? null;
      return o;
    });
    rows.sort((a, b) => {
      for (const c of keyCols) {
        const d = cmpCell(a[c] ?? null, b[c] ?? null);
        if (d !== 0) return d;
      }
      return 0;
    });
    return { header: cols, rows };
  };

  const latestValues = (sourceKeys: readonly string[]): LatestValue[] => {
    const seriesOf = new Map<string, string>();
    for (const k of sourceKeys) {
      const s = seriesForStorageKey(k);
      if (s === null) throw new ArchiveError(`latestValues: ${JSON.stringify(k)} is not a storage key any input id is read under`);
      seriesOf.set(k, s);
    }
    const best = new Map<string, { n: bigint; v: LatestValue }>();
    for (const rows of versions()) {
      for (const r of rows) {
        const sk = r.source_key;
        if (sk === null || sk === undefined || !seriesOf.has(sk) || r.market_date === null || r.market_date === undefined) continue;
        let n: bigint;
        try {
          n = BigInt(r.id ?? "");
        } catch {
          throw new ArchiveError(`corrupt local copy: a source_value_versions row of ${sk} has the id ${JSON.stringify(r.id)}, not an integer`);
        }
        const k = `${sk}\u0001${r.market_date}`;
        const prior = best.get(k);
        if (!prior || n > prior.n) best.set(k, { n, v: { series: seriesOf.get(sk)!, sourceKey: sk, date: r.market_date, id: r.id!, value: r.value ?? null } });
      }
    }
    return [...best.values()].map((b) => b.v).sort((a, b) => cmp(a.date, b.date) || cmp(a.sourceKey, b.sourceKey));
  };

  return {
    root,
    records,
    asOf: records[records.length - 1]!,
    tables,
    files,
    readRows,
    versions,
    revisedTable,
    latestValues,
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
