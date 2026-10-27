// Reading a format 1 local copy (the robotmoney/csv-backups layout, D72 in docs
// PR 1412) to generate one run's input file. Pure: the command line
// (bin/inputs.ts) lists the files, reads, hashes and gunzips them, and hands
// the text here. This module decides what is complete, what a run's frozen
// vintage holds, and what the input file says. It never fetches: acquisition
// (a repo clone, `csvb backup --source api`) is finished before it runs, and
// the SDK has no download client (analyst SDK requirements section 2).
//
// Layout, as csvb writes it:
//   csv/<backup id>/backup.json                      the record (BackupRecord)
//   csv/<backup id>/data/<table>.<start>_<end>.csv.gz rows this backup added
//   csv/<backup id>/revisions/<table>.csv.gz          revised-table changes
// Every file is listed in its record with its row count and the SHA-256 of its
// uncompressed bytes (gzip is only a transport encoding). Append-only tables chain: each backup's watermark_before is
// the previous backup's watermark_after. Values are Postgres COPY CSV text.
//
// A run's inputs are exactly its vintage: analytics_data_vintages names the
// run's vintage, analytics_vintage_members lists its source_value_versions ids
// as ranges, and those versions are the committed observations the run used.
// Their stored value text is copied unchanged.
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
  revisions: Record<string, { file: FileRecord | null }>;
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
