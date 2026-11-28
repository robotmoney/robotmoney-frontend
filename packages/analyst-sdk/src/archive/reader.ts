// Reading a format 1 archive (issues 1513, 1544): the reader core, pure. The
// reader reads the csv-backups folder in place and copies nothing. File access
// goes through an injected ArchiveFiles reader, so the same code runs over a
// directory on disk (node/backups-dir.ts, the reader of `bun run inputs`), an
// in-memory map in a test, or anything else a client hands it. The SDK never
// fetches and never touches a filesystem here (analyst SDK requirements
// section 2, D57; scripts/tests/unit/analyst-sdk-purity.test.ts).
//
// Opening reads only the backup.json files: backup selection, the watermark
// chain, revision keys and file paths. Each listed data or revision file is read
// the first time a call needs it, before any of its rows are returned: present
// and, once inflated within its record's bytes_raw, matching its recorded SHA-256
// (the hash of the uncompressed bytes: gzip is only a transport encoding, so any
// encoder's output verifies) and its recorded row count. A file no call needs is
// never read. Every file is decoded as strict UTF-8 with no byte order mark.
//
// Beyond one run's inputs (collectRunInputs), an archive answers questions a
// research client asks of the whole archive:
//   table(name)            a table's listed data files, read and parsed once (the
//                          run-ledger tables, for instance).
//   revisedTable(table)    a revised table (regime_snapshots, raw_indicator_history,
//                          asset_prices, ...) as of the archive's as-of backup: every
//                          selected backup's revisions/<table>.csv.gz replayed in
//                          backup order, upserting or deleting by the key columns
//                          its record names.
//   latestValues(keys)     the newest source_value_versions value per
//                          (source_key, market_date) for the requested storage
//                          keys, tagged with the input id they are read under.
import { sha256 } from "../hash.ts";
import type { Point } from "../types.ts";
import {
  ArchiveError,
  INPUT_TABLES,
  inflateBounded,
  listedFiles,
  parseCopyCsv,
  RunInputCollector,
  checkVersionRow,
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
  // The archive's location, used only in messages (a directory path, or any label).
  readonly root: string;
  // The directory names under csv/ (one per backup), or null when the folder has no csv/ directory.
  backupDirs(): string[] | null;
  // The bytes of a file at a path relative to the root, with "/" separators,
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
  // The stored value text, unchanged.
  value: string;
}

export interface Archive {
  root: string;
  // The selected backups, oldest first; the last is the as-of backup.
  records: BackupRecord[];
  asOf: BackupRecord;
  // The rows of a table's listed data files, read and verified on the first call, then memoized.
  table(name: string): Row[];
  // The listed data files of any table (not read), for the caller to read with readRows.
  files(table: string): FileRecord[];
  // One file's rows, verified before they are returned.
  readRows(f: FileRecord): Row[];
  // One file's rows, verified, and not kept by the archive: for a table too large
  // to hold whole (issue 1751). The caller drops them before reading the next file.
  scanRows(f: FileRecord): Row[];
  // Every source_value_versions file's rows, read once on the first call.
  versions(): Row[][];
  // A revised table as of the archive's as-of backup (see the header).
  revisedTable(table: string): RevisedTable;
  // The newest value per (source_key, market_date) for these storage keys, sorted
  // by market date then source key. A key no input id maps to is refused.
  latestValues(sourceKeys: readonly string[]): LatestValue[];
}

// Strict UTF-8: an invalid byte throws. ignoreBOM keeps a byte order mark in the
// text so decodeText can refuse it, rather than the decoder silently dropping it.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeText(bytes: Uint8Array, path: string): string {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new ArchiveError(`corrupt archive: ${path} is not valid UTF-8`);
  }
  if (text.charCodeAt(0) === 0xfeff) throw new ArchiveError(`corrupt archive: ${path} starts with a byte order mark`);
  return text;
}
const where = (root: string, path: string) => (root === "" ? path : `${root.replace(/\/+$/, "")}/${path}`);
const tableOf = (f: FileRecord): string => f.path.split("/").pop()!.split(".")[0]!;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// Key cells sort in code point order; a NULL cell sorts before any text.
const cmpCell = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : cmp(a, b));

// Open an archive as of a backup id (or its newest backup): reads only the backup.json files.
export function openArchive(fs: ArchiveFiles, asOf?: string): Archive {
  const root = fs.root;
  const dirs = fs.backupDirs();
  if (dirs === null) throw new ArchiveError(`${root} is not a format 1 local copy (no csv/ directory)`);
  const texts: Record<string, string> = {};
  for (const d of dirs) {
    const rec = fs.read(`csv/${d}/backup.json`);
    if (rec !== null) texts[d] = decodeText(rec, where(root, `csv/${d}/backup.json`));
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
    const csv = parseCopyCsv(decodeText(content!, where(root, f.path)));
    verifyFile(f, { sha256_raw: digest, rows: csv.rows.length });
    return csv;
  };
  // A data file's rows, verified on first read and memoized by path.
  const rowsOf = new Map<string, Row[]>();
  const readRows = (f: FileRecord): Row[] => {
    let rows = rowsOf.get(f.path);
    if (rows === undefined) rowsOf.set(f.path, (rows = toObjects(readCsv(f))));
    return rows;
  };
  const scanRows = (f: FileRecord): Row[] => rowsOf.get(f.path) ?? toObjects(readCsv(f));

  const files = (table: string) => all.filter((f) => tableOf(f) === table && f.path.includes("/data/"));
  const tableRows = new Map<string, Row[]>();
  const table = (name: string): Row[] => {
    let rows = tableRows.get(name);
    if (rows === undefined) {
      rows = [];
      // A loop, not push(...rows): a production vintage file holds over a
      // million member rows, past the engine's argument limit.
      for (const f of files(name)) for (const r of readRows(f)) rows.push(r);
      tableRows.set(name, rows);
    }
    return rows;
  };
  let versionRows: Row[][] | null = null;
  const versions = () => (versionRows ??= files("source_value_versions").map(readRows));

  const revised = new Map<string, RevisedTable>();
  const revisedTable = (table: string): RevisedTable => {
    const memo = revised.get(table);
    if (memo !== undefined) return memo;
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
    const out = { header: cols, rows };
    revised.set(table, out);
    return out;
  };

  const latestValues = (sourceKeys: readonly string[]): LatestValue[] => {
    const seriesOf = new Map<string, string>();
    for (const k of sourceKeys) {
      const s = seriesForStorageKey(k);
      if (s === null) throw new ArchiveError(`latestValues: ${JSON.stringify(k)} is not a storage key any input id is read under`);
      seriesOf.set(k, s);
    }
    const best = new Map<string, { n: bigint; v: LatestValue }>();
    const vfiles = files("source_value_versions");
    versions().forEach((rows, i) => {
      rows.forEach((r, j) => {
        const bad = checkVersionRow(r, where(root, vfiles[i]!.path), j + 1);
        const sk = r.source_key!;
        if (!seriesOf.has(sk)) return;
        if (bad === "instant") throw new ArchiveError(`corrupt archive: ${where(root, vfiles[i]!.path)} row ${j + 1}: ${sk} version ${r.id} has a market_instant and no market_date, which latestValues cannot place on a date`);
        const n = BigInt(r.id!);
        const k = `${sk}\u0001${r.market_date}`;
        const prior = best.get(k);
        if (!prior || n > prior.n) best.set(k, { n, v: { series: seriesOf.get(sk)!, sourceKey: sk, date: r.market_date!, id: r.id!, value: r.value! } });
      });
    });
    return [...best.values()].map((b) => b.v).sort((a, b) => cmp(a.date, b.date) || cmp(a.sourceKey, b.sourceKey));
  };

  return {
    root,
    records,
    asOf: records[records.length - 1]!,
    table,
    files,
    readRows,
    scanRows,
    versions,
    revisedTable,
    latestValues,
  };
}

// Options of latestStoredSeries (issue 1766).
export interface LatestStoredSeriesOptions {
  // The last market date kept (YYYY-MM-DD). Default: every date.
  notAfter?: string;
  // Refuse a value at or below 0 (a price). Default false.
  positive?: boolean;
}

// For each storage key asked, its newest stored version of each market date
// (the highest source_value_versions id, compared as BigInt), as numbers in
// date order, cut at notAfter (issue 1766). Any storage key is accepted,
// whether or not an input id maps to it (latestValues refuses one no input id
// maps to). Throws ArchiveError naming the key for a key with no rows, a row
// with a market_instant and no market_date, or a value that is not finite, and
// under `positive` for a value at or below 0.
export function latestStoredSeries(archive: Archive, sourceKeys: readonly string[], options: LatestStoredSeriesOptions = {}): Record<string, Point[]> {
  for (const k of Object.keys(options)) {
    if (k !== "notAfter" && k !== "positive") throw new RangeError(`latestStoredSeries: unknown option ${JSON.stringify(k)}; expected notAfter, positive`);
  }
  const { notAfter, positive = false } = options;
  if (notAfter !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(notAfter)) throw new RangeError(`latestStoredSeries: notAfter must be a YYYY-MM-DD date, got ${JSON.stringify(notAfter)}`);
  const wanted = new Set(sourceKeys);
  const newest = new Map<string, Map<string, { n: bigint; value: string }>>([...wanted].map((k) => [k, new Map()]));
  const vfiles = archive.files("source_value_versions");
  archive.versions().forEach((rows, i) => {
    rows.forEach((r, j) => {
      const at = where(archive.root, vfiles[i]!.path);
      const kind = checkVersionRow(r, at, j + 1);
      const byDate = newest.get(r.source_key!);
      if (byDate === undefined) return;
      if (kind === "instant") throw new ArchiveError(`${at} row ${j + 1}: ${r.source_key} version ${r.id} has a market_instant and no market_date`);
      const date = r.market_date!.slice(0, 10);
      if (notAfter !== undefined && date > notAfter) return;
      const n = BigInt(r.id!);
      const prior = byDate.get(date);
      if (!prior || n > prior.n) byDate.set(date, { n, value: r.value! });
    });
  });
  const out: Record<string, Point[]> = {};
  for (const [key, byDate] of newest) {
    if (byDate.size === 0) throw new ArchiveError(`${archive.root} as of ${archive.asOf.backup} has no rows for ${key}`);
    out[key] = [...byDate.keys()].sort().map((date) => {
      const value = Number(byDate.get(date)!.value);
      if (!Number.isFinite(value)) throw new ArchiveError(`${key} on ${date} is ${byDate.get(date)!.value}, not a finite number`);
      if (positive && !(value > 0)) throw new ArchiveError(`${key} on ${date} is ${value}, not above 0`);
      return { date, value };
    });
  }
  return out;
}

// The analytics_vintage_members rows of one run's vintage, in file order (issue
// 1751). The table is read one file at a time and never through table(): a
// production copy holds about 29 million member rows, and one run reads a few.
export function runVintageMembers(archive: Archive, runKey: string): Row[] {
  const runIds = new Set(archive.table("analytics_ledger_runs").filter((r) => r.run_key === runKey).map((r) => r.id));
  const vintageIds = new Set(archive.table("analytics_data_vintages").filter((v) => runIds.has(v.run_id)).map((v) => v.id));
  const members: Row[] = [];
  for (const f of archive.files("analytics_vintage_members")) {
    for (const m of archive.scanRows(f)) if (vintageIds.has(m.vintage_id)) members.push(m);
  }
  return members;
}

// One run's frozen inputs from an open archive (exactly its vintage).
export function collectRunInputs(archive: Archive, runKey: string): RunInputs {
  const collector = new RunInputCollector(runKey, {
    runs: archive.table("analytics_ledger_runs"),
    methodologies: archive.table("analytics_ledger_methodology_versions"),
    vintages: archive.table("analytics_data_vintages"),
    members: runVintageMembers(archive, runKey),
  });
  const vfiles = archive.files("source_value_versions");
  archive.versions().forEach((rows, i) => collector.addVersions(rows, `${archive.root.replace(/\/+$/, "")}/${vfiles[i]!.path}`));
  return collector.finish();
}
