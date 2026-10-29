// Supplementary series (analyst SDK requirements section 4; decision D79): source
// data an analyst collects outside the platform, for an asset or a date range the
// platform does not carry. They live in the supplementary directory, never in the
// local copy. This module is the format, and it is pure: the command line reads
// and writes the files (bin/supplementary-dir.ts) and hands their text here.
//
// One series per file. `yahoo:GC=F` is `yahoo/GC%3DF.csv`: the provider is the
// folder, the symbol is the file name, percent-encoded so `^`, `=` and `/` are
// safe. The file is the source contract (`date,series,value`, analytics
// requirements section 4.1) with one source id on every row and the dates
// strictly ascending. Its sidecar `<name>.manifest.json` says what the values are
// (`field`), who fetched them, when, and the row count and SHA-256 of the file.

import type { Point } from "../types.ts";
import { InputRowError, parseSourceCsv, SOURCE_CSV_HEADER } from "./load.ts";

export const SUPPLEMENTARY_FORMAT = 1;

/** The default start of a fetch, the collection floor proposed in frontend issue 1514. */
export const DEFAULT_SUPPLEMENTARY_START = "2016-01-01";

export class SupplementaryError extends Error {
  override readonly name = "SupplementaryError";
}

export interface SupplementaryManifest {
  format: 1;
  /** The source id, `<provider>:<symbol>`. */
  series: string;
  /** What each value is, as the source client states it, e.g. `adjusted close`. */
  field: string;
  row_count: number;
  first_date: string | null;
  last_date: string | null;
  /** SHA-256 of the series file's bytes. */
  sha256: string;
  /** When the values were fetched (ISO 8601, UTC). */
  fetched_at: string;
  /** What fetched them: the tool, its version and the endpoint. */
  fetched_by: string;
}

const PROVIDER = /^[a-z][a-z0-9-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const KEYS = ["format", "series", "field", "row_count", "first_date", "last_date", "sha256", "fetched_at", "fetched_by"];

const isRealDay = (d: unknown): d is string => {
  if (typeof d !== "string" || !ISO_DAY.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};

/** Split a source id into provider and symbol; throws on anything that is not `<provider>:<symbol>`. */
export function splitSourceId(id: string): { provider: string; symbol: string } {
  const i = id.indexOf(":");
  const provider = id.slice(0, i);
  const symbol = id.slice(i + 1);
  if (i < 1 || !PROVIDER.test(provider) || symbol === "" || /[\s,"]/.test(symbol)) {
    throw new SupplementaryError(`${JSON.stringify(id)} is not a source id <provider>:<symbol> (provider in lowercase letters, digits and dashes)`);
  }
  return { provider, symbol };
}

/** Paths of a series inside the supplementary directory, relative to it, with `/` separators. */
export function supplementaryPaths(id: string): { file: string; manifest: string } {
  const { provider, symbol } = splitSourceId(id);
  const stem = `${provider}/${encodeURIComponent(symbol)}`;
  return { file: `${stem}.csv`, manifest: `${stem}.manifest.json` };
}

/** The source id a series file path names (the inverse of `supplementaryPaths`), or null. */
export function sourceIdOfPath(relPath: string): string | null {
  const m = /^([a-z][a-z0-9-]*)\/([^/]+)\.csv$/.exec(relPath);
  if (!m) return null;
  try {
    const id = `${m[1]}:${decodeURIComponent(m[2]!)}`;
    return supplementaryPaths(id).file === relPath ? id : null;
  } catch {
    return null;
  }
}

function checkPoints(id: string, points: readonly Point[]): void {
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (!isRealDay(p.date)) throw new SupplementaryError(`${id}: point ${i} has date ${JSON.stringify(p.date)}, not a real YYYY-MM-DD date`);
    if (!Number.isFinite(p.value)) throw new SupplementaryError(`${id}: ${p.date} has value ${p.value}; values must be finite`);
    if (i > 0 && !(points[i - 1]!.date < p.date)) throw new SupplementaryError(`${id}: dates must be strictly ascending (${points[i - 1]!.date} then ${p.date})`);
  }
}

/** The series file text: the source contract header, then one row per point. Values print in the shortest form that
 *  reads back as the same double. */
export function formatSupplementaryCsv(id: string, points: readonly Point[]): string {
  splitSourceId(id);
  checkPoints(id, points);
  return [SOURCE_CSV_HEADER, ...points.map((p) => `${p.date},${id},${String(p.value)}`)].join("\n") + "\n";
}

/** Parse a series file: the source contract, every row the series `id`, dates strictly ascending. */
export function parseSupplementaryCsv(id: string, text: string): Point[] {
  splitSourceId(id);
  const rows = parseSourceCsv(text);
  rows.forEach((r, i) => {
    if (r.series !== id) throw new InputRowError(i + 2, `series ${r.series} in the file of ${id}; a supplementary file holds one series`);
  });
  const points = rows.map((r) => ({ date: r.date, value: r.value }));
  checkPoints(id, points);
  return points;
}

/** The manifest as written: fixed key order, two-space JSON, trailing newline. */
export function serializeSupplementaryManifest(m: SupplementaryManifest): string {
  const ordered: SupplementaryManifest = {
    format: 1,
    series: m.series,
    field: m.field,
    row_count: m.row_count,
    first_date: m.first_date,
    last_date: m.last_date,
    sha256: m.sha256,
    fetched_at: m.fetched_at,
    fetched_by: m.fetched_by,
  };
  return JSON.stringify(ordered, null, 2) + "\n";
}

/** Check a manifest's shape and that it describes exactly this file: its series, SHA-256, row count and date range. */
export function validateSupplementaryManifest(
  text: string,
  file: { series: string; sha256: string; points: readonly Point[] },
): SupplementaryManifest {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text);
  } catch (e) {
    throw new SupplementaryError(`${file.series}: manifest is not JSON: ${(e as Error).message}`);
  }
  if (m === null || typeof m !== "object" || Array.isArray(m)) throw new SupplementaryError(`${file.series}: manifest must be a JSON object`);
  const missing = KEYS.filter((k) => !(k in m));
  const extra = Object.keys(m).filter((k) => !KEYS.includes(k));
  if (missing.length || extra.length) throw new SupplementaryError(`${file.series}: manifest keys: missing [${missing.join(", ")}], unknown [${extra.join(", ")}]`);
  const bad = (what: string): never => {
    throw new SupplementaryError(`${file.series}: manifest ${what}`);
  };
  if (m.format !== SUPPLEMENTARY_FORMAT) bad(`format must be ${SUPPLEMENTARY_FORMAT}, got ${JSON.stringify(m.format)}`);
  if (typeof m.field !== "string" || m.field === "") bad("field must be a non-empty string");
  if (typeof m.fetched_by !== "string" || m.fetched_by === "") bad("fetched_by must be a non-empty string");
  if (typeof m.fetched_at !== "string" || !Number.isFinite(Date.parse(m.fetched_at))) bad(`fetched_at must be an ISO 8601 time, got ${JSON.stringify(m.fetched_at)}`);
  if (typeof m.sha256 !== "string" || !SHA256_RE.test(m.sha256)) bad("sha256 must be 64 lowercase hex characters");
  if (m.series !== file.series) bad(`describes ${JSON.stringify(m.series)}, not ${file.series}`);
  if (m.sha256 !== file.sha256) bad(`sha256 ${m.sha256} does not match the file's ${file.sha256}`);
  if (m.row_count !== file.points.length) bad(`row_count ${JSON.stringify(m.row_count)} does not match the file's ${file.points.length} rows`);
  const first = file.points[0]?.date ?? null;
  const last = file.points.at(-1)?.date ?? null;
  if (m.first_date !== first || m.last_date !== last) bad(`dates ${m.first_date}..${m.last_date} do not match the file's ${first}..${last}`);
  return m as unknown as SupplementaryManifest;
}
