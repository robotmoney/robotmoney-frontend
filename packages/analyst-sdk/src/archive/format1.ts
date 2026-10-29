// Format 1 (D72): the one module that defines the layout, for both its writers
// and its reader (issue 1477, D80). csvb (packages/csvb) and the public archive
// routes (backend/src/analytics/store/public-archive-store.ts) write with the
// writer half; the SDK's local-copy reader reads with the reader half. Pure: no
// file, database or network access here. Each caller does its own I/O and hands
// text or bytes in.
//
// Layout:
//   csv/<backup id>/backup.json                      the record (BackupRecord)
//   csv/<backup id>/data/<table>.<start>_<end>.csv.gz rows this backup added
//   csv/<backup id>/revisions/<table>.csv.gz          revised-table changes
// Every file is listed in its record with its row count and the SHA-256 of its
// uncompressed bytes (gzip is only a transport encoding). Append-only tables chain: each backup's watermark_before is
// the previous backup's watermark_after. Values are Postgres COPY CSV text.
//
// Backup ids: one per UTC day boundary (`YYYY-MM-DDT000000Z`, the cut rule
// below), plus the legacy snapshot-time ids csvb wrote before the day cut
// (format1-legacy.ts). BACKUP_ID_RE accepts both shapes.
//
// Reader half: a run's inputs are exactly its vintage. analytics_data_vintages
// names the run's vintage, analytics_vintage_members lists its
// source_value_versions ids as ranges, and those versions are the committed
// observations the run used. Their stored value text is copied unchanged. The
// reader never fetches: acquisition (a repo clone, `csvb backup --source api`)
// is finished before it runs, and the SDK has no download client (analyst SDK
// requirements section 2).
import { gunzipSync } from "node:zlib";
import { SERIES_MAPPING } from "../series-ids.ts";
import { CALCULATED_SERIES, REPLAY_CSV_HEADER, SOURCE_CSV_HEADER, type InputKind } from "../input/load.ts";

export interface FileRecord {
  path: string;
  rows: number;
  // Length of the file's uncompressed bytes: the bound on its inflate (requirements 4.5, at most 64 MB).
  bytes_raw: number;
  // SHA-256 of the file's uncompressed bytes: its identity. The gzip is only a transport encoding.
  sha256_raw: string;
}

export interface BackupRecord {
  format: 1;
  backup: string;
  // Acquisition source (`api` or `db`). Absent in records written before the
  // API fill existed; those were all read from the database replica.
  source?: "api" | "db";
  append_only: Record<string, { watermark_before: string | null; watermark_after: string | null; files: FileRecord[] }>;
  // Per revised table: the columns that identify a row (a revision upserts or deletes by them) and the changes file.
  revisions: Record<string, { key: string[]; file: FileRecord | null }>;
}

export class ArchiveError extends Error {
  override readonly name = "ArchiveError";
}

// The largest archive part, uncompressed (requirements section 4.5).
export const MAX_PART_BYTES = 67108864;

// Inflate a downloaded archive with its output bounded by the record's bytes_raw
// (at most one part, plus one byte to see an overrun; a bytes_raw over the part cap is refused), so a small hostile
// gzip cannot exhaust memory. Refuses a file whose inflated length is not exactly
// bytesRaw, before anything hashes it. `gunzip` is a parameter so a test can spy
// on the options it is given.
export function inflateBounded(buf: Uint8Array, bytesRaw: number, path = "archive", gunzip: typeof gunzipSync = gunzipSync): Uint8Array {
  if (!Number.isSafeInteger(bytesRaw) || bytesRaw < 0) throw new ArchiveError(`corrupt local copy: ${path} has no valid bytes_raw in its record (got ${JSON.stringify(bytesRaw)})`);
  const overCap = () => new ArchiveError(`corrupt local copy: ${path} records bytes_raw ${bytesRaw}, over the ${MAX_PART_BYTES} byte part cap`);
  let out: Uint8Array;
  try {
    out = gunzip(buf, { maxOutputLength: Math.min(bytesRaw, MAX_PART_BYTES) + 1 });
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      if (bytesRaw > MAX_PART_BYTES) throw overCap();
      throw new ArchiveError(`corrupt local copy: ${path} inflates to more than the record's bytes_raw ${bytesRaw}`);
    }
    throw err;
  }
  if (bytesRaw > MAX_PART_BYTES) throw overCap();
  if (out.length !== bytesRaw) throw new ArchiveError(`corrupt local copy: ${path} inflates to ${out.length} bytes, the record says bytes_raw ${bytesRaw}`);
  return out;
}

export const BACKUP_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/;

// The append-only tables a regime run's inputs are read from.
export const INPUT_TABLES = [
  "analytics_ledger_runs",
  "analytics_ledger_methodology_versions",
  "analytics_data_vintages",
  "analytics_vintage_members",
  "source_value_versions",
] as const;

// ── Postgres COPY CSV ────────────────────────────────────────────────────────

// One COPY ... CSV document: a header row, then rows. A field is quoted when it
// holds a comma, quote or newline (a doubled quote is a quote). An unquoted
// empty field is NULL; a quoted empty field is the empty string.
export function parseCopyCsv(text: string): { header: string[]; rows: (string | null)[][] } {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let i = 0;
  const n = text.length;
  let atRowStart = true;
  while (i < n) {
    if (atRowStart && text[i] === "\n") {
      i++;
      continue;
    }
    atRowStart = false;
    let field: string | null;
    if (text[i] === '"') {
      let s = "";
      i++;
      for (;;) {
        if (i >= n) throw new ArchiveError("CSV: unterminated quoted field");
        const c = text[i]!;
        if (c === '"') {
          if (text[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += c;
        i++;
      }
      field = s;
    } else {
      let j = i;
      while (j < n && text[j] !== "," && text[j] !== "\n" && text[j] !== "\r") j++;
      const raw = text.slice(i, j);
      field = raw === "" ? null : raw;
      i = j;
    }
    row.push(field);
    if (text[i] === "\r") i++;
    if (i >= n || text[i] === "\n") {
      rows.push(row);
      row = [];
      atRowStart = true;
      i++;
    } else if (text[i] === ",") {
      i++;
      if (i >= n) {
        row.push(null);
        rows.push(row);
        row = [];
      }
    } else {
      throw new ArchiveError(`CSV: unexpected character ${JSON.stringify(text[i])} after a field`);
    }
  }
  if (rows.length === 0) throw new ArchiveError("CSV: no header row");
  const header = rows.shift()!.map((h) => h ?? "");
  for (const [k, r] of rows.entries()) {
    if (r.length !== header.length) throw new ArchiveError(`CSV: row ${k + 2} has ${r.length} fields for ${header.length} columns`);
  }
  return { header, rows };
}

export type Row = Record<string, string | null>;

export function toObjects(csv: { header: string[]; rows: (string | null)[][] }): Row[] {
  return csv.rows.map((r) => {
    const o: Row = {};
    csv.header.forEach((h, i) => (o[h] = r[i] ?? null));
    return o;
  });
}

// ── Writer half: the rules csvb and the archive routes share (issue 1477) ────

// The settle time before a day boundary is cut: a transaction that took its id
// before the boundary and committed after it is in by then (requirements 4.5).
// The contract's ARCHIVE_SETTLE_MS and ARCHIVE_PART_BYTES carry the same values
// for the API (scripts/tests/unit/archive-identity-guard.test.ts holds them equal).
export const SETTLE_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// Where a row's time comes from, for naming files by the period they cover and
// for the day cut: a column of the row itself, or (for a table whose rows carry
// no time) the time of the row it points to.
export type TimeSpec = { column: string } | { lookup: { column: string; table: string; key: string; timeColumn: string } };

export interface CatalogAppendOnly {
  name: string;
  time: TimeSpec;
  // Served by the public archive routes. The run events and the parity
  // observations are backed up by csvb only (issue 1422 owner decisions).
  served: boolean;
}

export interface CatalogRevised {
  name: string;
  // The columns that identify a row.
  key: string[];
}

// The table catalog, in record order. Append-only tables only gain rows; each
// backup adds the rows above the previous watermark. Revised tables are
// rewritten in place; each backup adds a revision file of the rows new or
// changed since the previous backup.
export const APPEND_ONLY_TABLES: readonly CatalogAppendOnly[] = [
  { name: "analytics_output_snapshots", time: { column: "created_at" }, served: true },
  { name: "analytics_report_snapshots", time: { column: "created_at" }, served: true },
  { name: "source_value_versions", time: { column: "knowledge_time" }, served: true },
  { name: "analytics_ledger_runs", time: { column: "created_at" }, served: true },
  { name: "analytics_ledger_run_events", time: { column: "knowledge_time" }, served: false },
  { name: "analytics_ledger_methodology_versions", time: { column: "created_at" }, served: true },
  { name: "analytics_data_vintages", time: { column: "created_at" }, served: true },
  { name: "analytics_vintage_members", time: { lookup: { column: "vintage_id", table: "analytics_data_vintages", key: "id", timeColumn: "created_at" } }, served: true },
  { name: "analytics_overwrite_events", time: { column: "recorded_at" }, served: true },
  { name: "analytics_parity_observations", time: { column: "observed_at" }, served: false },
];

export const REVISED_TABLES: readonly CatalogRevised[] = [
  { name: "regime_snapshots", key: ["date"] },
  { name: "raw_indicator_history", key: ["indicator", "date"] },
  { name: "asset_prices", key: ["price_date", "symbol", "time_basis"] },
  { name: "analytics_read_mode", key: ["id"] },
];

/**
 * One row in the CSV dialect Postgres COPY writes: a field is quoted when it is
 * empty (so it differs from NULL), or holds a comma, a double quote, CR or LF,
 * with embedded quotes doubled; NULL is an unquoted empty field. Ends with a newline.
 */
export function encodeCsvRow(values: readonly (string | null)[]): string {
  return (
    values
      .map((v) => {
        if (v === null) return "";
        if (v === "" || /[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
        return v;
      })
      .join(",") + "\n"
  );
}

/**
 * Parse ONE complete CSV row, as COPY writes it, back into fields. NULL is an
 * UNQUOTED empty field, so an empty string (`""`) parses to "", not null. The
 * row's newline may be absent on a last row.
 */
export function parseCsvRow(row: Uint8Array): (string | null)[] {
  let text = new TextDecoder("utf-8", { fatal: true }).decode(row);
  if (text.endsWith("\n")) text = text.slice(0, -1);
  const out: (string | null)[] = [];
  let i = 0;
  const n = text.length;
  for (;;) {
    if (i < n && text[i] === '"') {
      let v = "";
      i += 1;
      for (;;) {
        if (i >= n) throw new Error("unterminated quoted field");
        const c = text[i]!;
        if (c === '"') {
          if (text[i + 1] === '"') {
            v += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        v += c;
        i += 1;
      }
      out.push(v);
    } else {
      const start = i;
      while (i < n && text[i] !== ",") {
        if (text[i] === '"') throw new Error("a quote inside an unquoted field");
        i += 1;
      }
      const raw = text.slice(start, i);
      out.push(raw === "" ? null : raw);
    }
    if (i >= n) return out;
    if (text[i] !== ",") throw new Error(`expected a comma at ${i}`);
    i += 1;
    if (i >= n) {
      out.push(null); // a trailing comma ends with an empty (NULL) field
      return out;
    }
  }
}

// ── Part splitting ───────────────────────────────────────────────────────────
// An append-only table's new rows are written in id order into parts of at most
// maxPartBytes uncompressed (the header included). A row is never cut: a part
// holds at least one data row, so one row larger than the bound is a part of its
// own and exceeds it.

/** Does a row of `rowBytes` start a new part, given the open part's data rows and bytes? */
export function startsNewPart(partRows: number, partBytes: number, rowBytes: number, maxPartBytes: number): boolean {
  return partRows > 0 && partBytes + rowBytes > maxPartBytes;
}

export interface PartSink {
  write(bytes: Uint8Array): void | Promise<void>;
  /** Called once when the part is complete, with its DATA rows (header excluded); the return value is passed through. */
  close(info: { dataRows: number }): Promise<unknown>;
}

export interface SplitOptions {
  maxPartBytes: number;
  /** Open part number `n` (1-based). Called lazily, so a header-only stream opens exactly one part. */
  openPart: (n: number) => PartSink;
  /** Called once with the header row (including its newline). */
  onHeader?: (row: Uint8Array) => void;
  /** Called for every data row, in order, as soon as it is complete. */
  onRow?: (row: Uint8Array) => void;
}

export interface SplitResult {
  /** Return values of each sink's close(), in part order. */
  parts: unknown[];
  /** Data rows seen (header excluded). */
  rows: number;
  /** Parts that exceed maxPartBytes because one row alone is larger than it. */
  oversize: number;
}

const QUOTE = 0x22;
const NEWLINE = 0x0a;

function concatBytes(pieces: Uint8Array[], total: number): Uint8Array {
  if (pieces.length === 1) return pieces[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Split one CSV byte stream (a header row, then rows) into parts on row
 * boundaries, by the part rule above; every part begins with the header. Only a
 * newline outside quotes ends a row: toggling "inside quotes" on every `"` byte
 * gives the right state at every newline (a doubled quote toggles twice).
 */
export async function splitCsv(source: AsyncIterable<Uint8Array>, opts: SplitOptions): Promise<SplitResult> {
  if (!(opts.maxPartBytes > 0)) throw new RangeError("maxPartBytes must be positive");
  const results: unknown[] = [];
  let header: Uint8Array | null = null;
  let sink: PartSink | null = null;
  let partNo = 0;
  let partBytes = 0;
  let partDataRows = 0;
  let rows = 0;
  let oversize = 0;
  let inQuote = false;
  let pending: Uint8Array[] = [];
  let pendingLen = 0;

  const closeSink = async (): Promise<void> => {
    if (!sink) return;
    results.push(await sink.close({ dataRows: partDataRows }));
    sink = null;
  };
  const openSink = async (): Promise<PartSink> => {
    partNo += 1;
    sink = opts.openPart(partNo);
    await sink.write(header!);
    partBytes = header!.length;
    partDataRows = 0;
    return sink;
  };

  const onRow = async (row: Uint8Array): Promise<void> => {
    if (header === null) {
      header = row;
      opts.onHeader?.(row);
      return;
    }
    rows += 1;
    opts.onRow?.(row);
    if (sink && startsNewPart(partDataRows, partBytes, row.length, opts.maxPartBytes)) await closeSink();
    const s = sink ?? (await openSink());
    await s.write(row);
    partBytes += row.length;
    partDataRows += 1;
    if (partDataRows === 1 && partBytes > opts.maxPartBytes) oversize += 1;
  };

  for await (const chunk of source) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;
      if (b === QUOTE) inQuote = !inQuote;
      else if (b === NEWLINE && !inQuote) {
        const tail = chunk.subarray(start, i + 1);
        pending.push(tail);
        pendingLen += tail.length;
        const row = concatBytes(pending, pendingLen);
        pending = [];
        pendingLen = 0;
        start = i + 1;
        await onRow(row);
      }
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      pending.push(rest);
      pendingLen += rest.length;
    }
  }
  if (pendingLen > 0) await onRow(concatBytes(pending, pendingLen)); // a last row with no newline is still a row
  if (header === null) throw new Error("csv stream was empty: no header row");
  if (!sink && partNo === 0) await openSink(); // a table with no data rows still gets one part holding the header
  await closeSink();
  return { parts: results, rows, oversize };
}

// ── Names ────────────────────────────────────────────────────────────────────

export const CSV_DIR = "csv";
export const backupDir = (id: string): string => `${CSV_DIR}/${id}`;
export const recordPath = (id: string): string => `${backupDir(id)}/backup.json`;
export const dataPath = (id: string, name: string): string => `${backupDir(id)}/data/${name}`;
export const revisionFile = (id: string, table: string): string => `${backupDir(id)}/revisions/${table}.csv.gz`;

/** `2026-09-21 01:59:32.748478+00` (the database's UTC text) as microseconds since the epoch. */
export function parseDbTime(text: string): bigint {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:\+00(?::00)?|Z)$/.exec(text.trim());
  if (!m) throw new Error(`${JSON.stringify(text)} is not a UTC timestamp (expected e.g. 2026-09-21 01:59:32.748478+00)`);
  const secs = BigInt(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) / 1000n;
  return secs * 1_000_000n + BigInt((m[7] ?? "").padEnd(6, "0") || "0");
}

/** The UTC time as `YYYY-MM-DDTHHMMSSZ`, to the second (rounded down). */
export function stamp(micros: bigint): string {
  const d = new Date(Number(micros / 1000n));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * A data file's name: `<table>.<start>_<end>.csv.gz` by the earliest and latest
 * row time in it (UTC, to the second), `late.` before the span for rows that
 * committed late (csvb only). `dup` is 1 for the first file with this name in
 * its backup, 2 for the next (`-2` before `.csv.gz`), and so on.
 */
export function dataFileName(table: string, late: boolean, tMin: string, tMax: string, dup = 1): string {
  const span = `${stamp(parseDbTime(tMin))}_${stamp(parseDbTime(tMax))}`;
  return `${table}.${late ? "late." : ""}${span}${dup > 1 ? `-${dup}` : ""}.csv.gz`;
}

/** Names a backup's data files, giving a repeated name the next `-N`. One per table per backup. */
export class DataFileNamer {
  private used = new Set<string>();
  constructor(private table: string, private late = false) {}
  next(tMin: string, tMax: string): string {
    let dup = 1;
    let name = dataFileName(this.table, this.late, tMin, tMax, dup);
    while (this.used.has(name)) name = dataFileName(this.table, this.late, tMin, tMax, ++dup);
    this.used.add(name);
    return name;
  }
}

// ── The backup cut rule ──────────────────────────────────────────────────────
// Both writers cut a backup at every UTC day boundary t once t is SETTLE_MS in
// the past (sealed), named `YYYY-MM-DDT000000Z`. The first boundary is the UTC
// midnight after the earliest first row (by id) of the tables the writer holds.
// Per append-only table, the watermark at t is the largest existing id, after the
// previous backup's watermark, below the first row whose time is at or after t
// (or the newest id, when no such row exists yet). A table timed through a
// lookup (vintage members) is cut by the row it points to instead: every row
// whose lookup key is at or below that table's watermark at t, so one vintage's
// members are never split between backups.
//
// The legacy junction (format1-legacy.ts) is one extra cut point between the
// day boundaries around it, with its own id and baked watermarks. It applies
// once a sealed day boundary lies past it and some table holds an id above its
// junction watermark; a database whose rows all predate it is cut by day alone.

export const DAY_CUT_ID_RE = /^(\d{4}-\d{2}-\d{2})T000000Z$/;

export interface Junction {
  id: string;
  watermarks: Readonly<Record<string, string>>;
}

export type Cut = { id: string; kind: "day"; boundaryMs: number } | { id: string; kind: "junction"; watermarks: Readonly<Record<string, string>> };

/** The day-cut id of the UTC midnight at `dayMs`. */
export const backupIdOfDay = (dayMs: number): string => `${new Date(dayMs).toISOString().slice(0, 10)}T000000Z`;

/** The instant a backup id names (either shape), in ms since the epoch. */
export function backupInstantMs(id: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
  if (!m) throw new Error(`${JSON.stringify(id)} is not a backup id (YYYY-MM-DDTHHMMSSZ)`);
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

/** The instant as the database prints a UTC time: `2026-10-19 20:24:21+00`. */
export const dbTimeText = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}+00`;

/** The newest sealed boundary: the latest UTC midnight at least SETTLE_MS before `nowMs`. */
export const lastSealedDayMs = (nowMs: number): number => Math.floor((nowMs - SETTLE_MS) / DAY_MS) * DAY_MS;

/** The first boundary: the UTC midnight after the earliest first row's time (microseconds). */
export const firstBoundaryMs = (earliestMicros: bigint): number => Math.floor(Number(earliestMicros / 1000n) / DAY_MS) * DAY_MS + DAY_MS;

/** Does the junction apply: a sealed day boundary lies past it, and rows follow it? */
export function junctionApplies(junction: Junction | null, nowMs: number, rowsFollowJunction: boolean): junction is Junction {
  return junction !== null && rowsFollowJunction && backupIdOfDay(lastSealedDayMs(nowMs)) > junction.id;
}

/**
 * The cut points, oldest first: every sealed day boundary from the first, with
 * the junction in its place when it applies, and only those after `after` (the
 * newest backup a writer already holds). No first boundary (no rows yet) gives none.
 */
export function planCuts(o: { firstDayMs: number | null; nowMs: number; junction: Junction | null; rowsFollowJunction: boolean; after?: string | null }): Cut[] {
  if (o.firstDayMs === null) return [];
  const cuts: Cut[] = [];
  for (let d = o.firstDayMs; d <= lastSealedDayMs(o.nowMs); d += DAY_MS) cuts.push({ id: backupIdOfDay(d), kind: "day", boundaryMs: d });
  if (junctionApplies(o.junction, o.nowMs, o.rowsFollowJunction) && !cuts.some((c) => c.id === o.junction!.id)) {
    const at = cuts.findIndex((c) => c.id > o.junction!.id);
    cuts.splice(at < 0 ? cuts.length : at, 0, { id: o.junction.id, kind: "junction", watermarks: o.junction.watermarks });
  }
  const after = o.after ?? null;
  return after === null ? cuts : cuts.filter((c) => c.id > after);
}

// ── Records: which backups, and are they complete ────────────────────────────

// Parse and check backup records (the backup.json texts, keyed by directory
// name), oldest first, up to `asOf` (a backup id, or undefined for the newest).
// Checks the record shape, that each directory names its own backup, and that
// every append-only table's watermark chain is unbroken, so a missing backup in
// the middle of the copy is an error rather than a silent gap.
export function selectBackups(recordTexts: Record<string, string>, asOf?: string): BackupRecord[] {
  const ids = Object.keys(recordTexts).filter((d) => BACKUP_ID_RE.test(d)).sort();
  if (ids.length === 0) throw new ArchiveError("no format 1 backups found (expected csv/<backup id>/backup.json)");
  if (asOf !== undefined && !BACKUP_ID_RE.test(asOf)) throw new ArchiveError(`--as-of must be a backup id (YYYY-MM-DDTHHMMSSZ), got ${JSON.stringify(asOf)}`);
  if (asOf !== undefined && !ids.includes(asOf)) throw new ArchiveError(`backup ${asOf} is not in the local copy (newest is ${ids[ids.length - 1]})`);
  const out: BackupRecord[] = [];
  for (const id of ids) {
    if (asOf !== undefined && id > asOf) break;
    let rec: BackupRecord;
    try {
      rec = JSON.parse(recordTexts[id]!);
    } catch (e) {
      throw new ArchiveError(`csv/${id}/backup.json is not JSON: ${(e as Error).message}`);
    }
    if (rec.format !== 1) throw new ArchiveError(`csv/${id}/backup.json: format ${JSON.stringify(rec.format)} is not format 1`);
    if (rec.backup !== id) throw new ArchiveError(`csv/${id}/backup.json: record says backup ${rec.backup}`);
    if (rec.source !== undefined && rec.source !== "api" && rec.source !== "db") throw new ArchiveError(`csv/${id}/backup.json: source must be "api" or "db"`);
    if (!rec.append_only || typeof rec.append_only !== "object") throw new ArchiveError(`csv/${id}/backup.json: no append_only section`);
    checkRevisionKeys(rec, id);
    for (const f of listedFiles([rec])) {
      checkFilePath(f.path, id);
      if (typeof f.sha256_raw !== "string") throw new ArchiveError(`csv/${id}/backup.json: ${f.path} has no string sha256_raw`);
    }
    out.push(rec);
  }
  const last = new Map<string, string | null>();
  for (const rec of out) {
    for (const [table, t] of Object.entries(rec.append_only)) {
      const prev = last.has(table) ? last.get(table)! : null;
      if ((t.watermark_before ?? null) !== prev) {
        throw new ArchiveError(`incomplete local copy: backup ${rec.backup} continues ${table} from id ${t.watermark_before ?? "none"}, but the copy holds it through ${prev ?? "none"} (a backup is missing)`);
      }
      last.set(table, t.watermark_after ?? null);
    }
  }
  return out;
}

// Every revised table a record lists must name the columns that identify a row:
// a non-empty array of non-empty strings. A revision with no usable key cannot be
// replayed (an upsert or delete would match nothing, or everything), so the
// record is refused when it is read, not when the table is replayed.
function checkRevisionKeys(rec: BackupRecord, backup: string): void {
  const revisions: unknown = rec.revisions;
  if (revisions === undefined) return;
  if (revisions === null || typeof revisions !== "object" || Array.isArray(revisions)) throw new ArchiveError(`csv/${backup}/backup.json: revisions must be an object`);
  for (const [table, r] of Object.entries(revisions as Record<string, unknown>)) {
    const key = (r as { key?: unknown } | null)?.key;
    if (!Array.isArray(key) || key.length === 0) throw new ArchiveError(`csv/${backup}/backup.json: the ${table} revision names no key (got ${JSON.stringify(key ?? null)})`);
    for (const c of key) {
      if (typeof c !== "string" || c === "") throw new ArchiveError(`csv/${backup}/backup.json: the ${table} revision key has a column that is not a non-empty string (got ${JSON.stringify(c)})`);
    }
  }
}

// A listed path must stay inside its own backup directory: relative, under
// `csv/<backup id>/`, with no empty, `.` or `..` segment and no backslash or
// NUL, so a crafted record cannot make the reader open a file outside the copy.
function checkFilePath(path: unknown, backup: string): void {
  const ok =
    typeof path === "string" &&
    path.startsWith(`csv/${backup}/`) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
  if (!ok) throw new ArchiveError(`csv/${backup}/backup.json lists the path ${JSON.stringify(path)}, which is not a file inside csv/${backup}/`);
}

// Every file the selected backups list (data and revision files).
export function listedFiles(records: readonly BackupRecord[]): FileRecord[] {
  const out: FileRecord[] = [];
  for (const rec of records) {
    for (const t of Object.values(rec.append_only)) out.push(...t.files);
    for (const r of Object.values(rec.revisions ?? {})) if (r.file) out.push(r.file);
  }
  return out;
}

// A listed file against what was read: present, same SHA-256 of its uncompressed
// bytes (never of the gzip, which any encoder may write differently), and (when
// its rows were parsed) the same row count.
export function verifyFile(f: FileRecord, got: { sha256_raw: string | null; rows?: number }): void {
  if (got.sha256_raw === null) throw new ArchiveError(`incomplete local copy: ${f.path} is listed in its backup record but missing`);
  if (got.sha256_raw !== f.sha256_raw) throw new ArchiveError(`corrupt local copy: ${f.path} content sha256 ${got.sha256_raw} does not match the record's ${f.sha256_raw}`);
  if (got.rows !== undefined && got.rows !== f.rows) throw new ArchiveError(`corrupt local copy: ${f.path} has ${got.rows} rows, the record says ${f.rows}`);
}

// ── One run's inputs ─────────────────────────────────────────────────────────

// Storage key -> the id the run reads it under, through the one D74 storage
// mapping (src/series-ids.ts). A key no regime consumer reads (another
// consumer's input) maps to null and is counted, never silently dropped.
const INPUT_ID_OF_KEY = new Map(SERIES_MAPPING.map((m) => [m.storageKey, m.inputId]));
export function seriesForStorageKey(key: string): string | null {
  return INPUT_ID_OF_KEY.get(key) ?? null;
}

export interface GeneratedRow {
  date: string;
  series: string;
  // The stored value text, unchanged.
  value: string;
  kind: InputKind;
}

export interface RunIdentity {
  runId: string;
  runKey: string;
  asof: string;
  vintageId: string;
  memberCount: number;
  methodology: { id: string; label: string | null; config_digest: string | null };
  codeRevision: string;
}

export interface RunInputs {
  run: RunIdentity;
  rows: GeneratedRow[];
  // Vintage members that are not regime inputs (other consumers' keys, or a
  // market_instant row), by storage key: counted, never silently dropped.
  skipped: Record<string, number>;
}

// Collects a run's frozen inputs from the source_value_versions files, one file
// at a time (a real copy holds millions of versions), then checks membership.
export class RunInputCollector {
  readonly run: RunIdentity;
  private ranges: { lo: number; hi: number; key: string }[] = [];
  private seen = new Set<number>();
  private best = new Map<string, { id: number; row: GeneratedRow }>();
  private skipped: Record<string, number> = {};

  constructor(runKey: string, tables: { runs: Row[]; methodologies: Row[]; vintages: Row[]; members: Row[] }) {
    const runs = tables.runs.filter((r) => r.run_key === runKey);
    if (runs.length === 0) throw new ArchiveError(`run ${runKey} is not in the local copy's run ledger`);
    if (runs.length > 1) throw new ArchiveError(`run key ${runKey} names ${runs.length} runs`);
    const run = runs[0]!;
    if (run.tool_id !== "regime") throw new ArchiveError(`run ${runKey} is a ${run.tool_id} run, not a regime run`);
    const vins = tables.vintages.filter((v) => v.run_id === run.id);
    if (vins.length !== 1) throw new ArchiveError(`run ${runKey} has ${vins.length} frozen vintages in the local copy (expected 1)`);
    const vin = vins[0]!;
    const meth = tables.methodologies.find((m) => m.id === run.methodology_version_id);
    this.run = {
      runId: run.id!,
      runKey,
      asof: run.asof!,
      vintageId: vin.id!,
      memberCount: Number(vin.member_count),
      methodology: { id: run.methodology_version_id!, label: meth?.version_label ?? null, config_digest: meth?.config_digest ?? null },
      codeRevision: run.build_identity!,
    };
    let covered = 0;
    for (const m of tables.members) {
      if (m.vintage_id !== vin.id) continue;
      const lo = Number(m.source_value_version_id);
      const hi = Number(m.last_source_value_version_id ?? m.source_value_version_id);
      if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi < lo) throw new ArchiveError(`vintage ${vin.id}: bad member range ${m.source_value_version_id}..${m.last_source_value_version_id}`);
      this.ranges.push({ lo, hi, key: m.source_key! });
      covered += hi - lo + 1;
    }
    this.ranges.sort((a, b) => a.lo - b.lo);
    for (let k = 1; k < this.ranges.length; k++) {
      if (this.ranges[k]!.lo <= this.ranges[k - 1]!.hi) throw new ArchiveError(`vintage ${vin.id}: member ranges overlap at id ${this.ranges[k]!.lo}`);
    }
    if (covered !== this.run.memberCount) throw new ArchiveError(`vintage ${vin.id} records ${this.run.memberCount} members but its member ranges cover ${covered} versions`);
  }

  private rangeOf(id: number): { lo: number; hi: number; key: string } | null {
    let a = 0;
    let b = this.ranges.length - 1;
    while (a <= b) {
      const m = (a + b) >> 1;
      const r = this.ranges[m]!;
      if (id < r.lo) b = m - 1;
      else if (id > r.hi) a = m + 1;
      else return r;
    }
    return null;
  }

  addVersions(rows: readonly Row[]): void {
    for (const r of rows) {
      const id = Number(r.id);
      const range = this.rangeOf(id);
      if (!range) continue;
      if (r.source_key !== range.key) throw new ArchiveError(`vintage ${this.run.vintageId}: version ${r.id} is ${r.source_key}, but the vintage lists it under ${range.key}`);
      if (this.seen.has(id)) throw new ArchiveError(`source_value_versions id ${r.id} appears twice in the local copy`);
      this.seen.add(id);
      const series = seriesForStorageKey(r.source_key!);
      if (series === null || r.market_date === null || r.value === null) {
        this.skipped[r.source_key!] = (this.skipped[r.source_key!] ?? 0) + 1;
        continue;
      }
      const k = `${series}\u0001${r.market_date}`;
      const prior = this.best.get(k);
      // Two versions of one (series, date) in a vintage: the newest revision, as
      // the run read it (the highest id).
      if (!prior || id > prior.id) {
        this.best.set(k, { id, row: { date: r.market_date!, series, value: r.value!, kind: CALCULATED_SERIES.has(series) ? "calculated" : "source" } });
      }
    }
  }

  finish(): RunInputs {
    if (this.seen.size !== this.run.memberCount) {
      const missing: number[] = [];
      for (const r of this.ranges) {
        for (let id = r.lo; id <= r.hi && missing.length < 5; id++) if (!this.seen.has(id)) missing.push(id);
        if (missing.length >= 5) break;
      }
      throw new ArchiveError(
        `incomplete local copy: vintage ${this.run.vintageId} of run ${this.run.runKey} names ${this.run.memberCount} source value versions, ${this.seen.size} are in the copy (first missing ids ${missing.join(", ")}); the input is not generated from a partial vintage`,
      );
    }
    const rows = [...this.best.values()].map((b) => b.row);
    rows.sort((a, b) => (a.series < b.series ? -1 : a.series > b.series ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { run: this.run, rows, skipped: this.skipped };
  }
}

// The input file text. A run whose vintage holds a calculated ratio is written
// in the replay contract (with `kind`); otherwise as a source input. CSV keeps
// the stored value text; JSON carries the same numbers.
export function serializeInputs(rows: readonly GeneratedRow[], format: "csv" | "json"): string {
  const replay = rows.some((r) => r.kind === "calculated");
  if (format === "csv") {
    const head = replay ? REPLAY_CSV_HEADER : SOURCE_CSV_HEADER;
    const lines = rows.map((r) => (replay ? `${r.date},${r.series},${r.value},${r.kind}` : `${r.date},${r.series},${r.value}`));
    return [head, ...lines].join("\n") + "\n";
  }
  const objs = rows.map((r) =>
    replay ? { date: r.date, series: r.series, value: Number(r.value), kind: r.kind } : { date: r.date, series: r.series, value: Number(r.value) },
  );
  return JSON.stringify(objs) + "\n";
}
