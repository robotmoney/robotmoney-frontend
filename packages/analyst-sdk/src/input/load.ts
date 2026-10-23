// Raw-indicator-history input loader. Pure: takes TEXT, returns rows. Reading
// the file is the caller's job (bin/regime.ts), so this module stays free of
// node:fs and process.env (see scripts/tests/unit/analyst-sdk-purity.test.ts).
//
// CSV schema: `date,indicator,value,source` (header required, exact names and
// order). JSON schema: an array of `{date, indicator, value, source}` objects.
// Both forms produce the same rows, hence byte-identical regime output.
//
// SOURCE-DATA FORM (analytics requirements 4.2, issue 1398): the header
// `date,series,value`, where `series` is a source id (`<provider>:<symbol>`,
// D74), or JSON objects `{date, series, value}`. A row's series becomes its
// `indicator` and its source is empty; src/series-ids.ts resolveInputHistory
// maps source ids to the ids the computation reads. This form is strict: a
// date must be a real calendar date and a value a plain decimal number.
//
// Source data only (issue 1404): a row naming a calculated ratio indicator
// (COPPER_GOLD and the other Yahoo ratios), by its id or its storage key, is
// rejected with CalculatedRowError.
//
// HISTORICAL REPLAY FORM (issue 1404): `date,series,value,kind`, JSON
// `[{date, series, value, kind}]`, kind `source` or `calculated`. The only form
// that accepts a stored calculated ratio (kind `calculated`, ratio ids only),
// used as stored: its legs are never invented. `series` is any name
// resolveInputHistory reads (input id, storage key or source id). Accepted only
// when the caller asks for it: parseInput(text, { replay: true }), the CLI's
// --replay.
//
// Every form shares the strict row rule (issue 1404, SDK-7): a date is a real
// calendar date in YYYY-MM-DD form, and a string value is a plain decimal
// (optional sign, digits, an optional fraction and exponent) with no padding,
// hex or non-finite value. That includes the legacy form.
import type { Point, RawIndicatorHistory } from "../types.ts";
import { INDICATORS } from "../analyze/indicators.ts";

export interface RawRow {
  date: string;
  indicator: string;
  value: number;
  source: string;
}

export const CSV_HEADER = "date,indicator,value,source";
export const SERIES_CSV_HEADER = "date,series,value";

// Named so callers (and tests) can tell a bad header from a bad row.
export class CsvHeaderError extends Error {
  override readonly name = "CsvHeaderError";
  constructor(readonly got: string, want: string = `${SERIES_CSV_HEADER}" or "${CSV_HEADER}`) {
    super(`CSV header must be exactly "${want}", got "${got}"`);
  }
}

export class InputRowError extends Error {
  override readonly name: string = "InputRowError";
  constructor(readonly row: number, reason: string) {
    super(`input row ${row}: ${reason}`);
  }
}

// CSV quoting is not supported: a quote would silently shift the field splits
// below, so any quote anywhere in a row is refused by name.
export class CsvQuotedFieldError extends InputRowError {
  override readonly name = "CsvQuotedFieldError";
  constructor(row: number) {
    super(row, 'quoted CSV fields are not supported (found a `"`); remove the quotes, ids and sources must not contain commas');
  }
}

// INPUT RULE (two layers, deliberate, tested): PARSE is STRICT, MERGE is
// TOLERANT. This loader is the user-facing boundary: a non-finite value (NaN,
// Infinity, blank, non-numeric) throws InputRowError so analysts are told. The
// backend's mergeSeries (transform/math.ts) instead drops non-finite values
// because upstream providers emit holes. The layers are not forced to behave
// identically; instead, for every input BOTH accept, the series reaching
// alignment are identical: a repeated (indicator, date) keeps the LAST row,
// output ascending by date. See tests/input-rule.test.ts and
// backend/tests/input-rule-parity.test.ts.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const SOURCE_ID = /^[^\s,:"]+:[^\s,"]+$/;
const PLAIN_DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const isRealDay = (d: string) => {
  if (!ISO_DAY.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};

export function isCalendarDate(v: unknown): v is string {
  return typeof v === "string" && isRealDay(v);
}

function checkValue(row: number, value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && PLAIN_DECIMAL.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new InputRowError(row, `value must be a finite plain decimal number, got ${JSON.stringify(value)}`);
  return n;
}

function checkRow(row: number, date: unknown, indicator: unknown, value: unknown, source: unknown): RawRow {
  if (typeof date !== "string" || !isRealDay(date)) throw new InputRowError(row, `date must be a real calendar date in YYYY-MM-DD form, got ${JSON.stringify(date)}`);
  if (typeof indicator !== "string" || indicator === "") throw new InputRowError(row, "indicator must be a non-empty string");
  return { date, indicator, value: checkValue(row, value), source: typeof source === "string" ? source : "" };
}

// The calculated indicators: the Yahoo ratios of two series (analytics
// requirements 4.3). Their stored values are calculations, not source data.
export const CALCULATED_SERIES: ReadonlySet<string> = new Set(
  INDICATORS.filter((i) => i.source === "yahoo" && Array.isArray(i.series)).map((i) => i.id),
);
const isCalculatedName = (name: string) =>
  CALCULATED_SERIES.has(name) || (name.startsWith("raw_indicator_history:") && CALCULATED_SERIES.has(name.slice("raw_indicator_history:".length)));

export class CalculatedRowError extends InputRowError {
  override readonly name = "CalculatedRowError";
  constructor(row: number, series: string) {
    super(row, `series ${series} is a calculated ratio, not source data; source input holds source data only (historical calculated values load through the replay contract, --replay)`);
  }
}

function checkSeriesRow(row: number, date: unknown, series: unknown, value: unknown): RawRow {
  if (typeof date !== "string" || !isRealDay(date)) throw new InputRowError(row, `date must be a real calendar date in YYYY-MM-DD form, got ${JSON.stringify(date)}`);
  if (typeof series === "string" && isCalculatedName(series)) throw new CalculatedRowError(row, series);
  if (typeof series !== "string" || !SOURCE_ID.test(series)) throw new InputRowError(row, `series must be a source id <provider>:<symbol>, got ${JSON.stringify(series)}`);
  return checkRow(row, date, series, value, "");
}

function parseSeriesCsv(lines: string[]): RawRow[] {
  const out: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (line.includes('"')) throw new CsvQuotedFieldError(i + 1);
    const f = line.split(",");
    if (f.length !== 3) throw new InputRowError(i + 1, `expected 3 fields, got ${f.length}: "${line}"`);
    out.push(checkSeriesRow(i + 1, f[0], f[1], f[2]));
  }
  return out;
}

export function parseRawCsv(text: string): RawRow[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = (lines[0] ?? "").trim();
  if (header === SERIES_CSV_HEADER) return parseSeriesCsv(lines);
  if (header === REPLAY_CSV_HEADER) throw new ReplayContractError();
  if (header !== CSV_HEADER) throw new CsvHeaderError(header);
  const out: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    // Indicator ids and sources contain no commas or quotes; the source is the last field.
    if (line.includes('"')) throw new CsvQuotedFieldError(i + 1);
    const c1 = line.indexOf(",");
    const c2 = line.indexOf(",", c1 + 1);
    const c3 = line.indexOf(",", c2 + 1);
    if (c1 < 0 || c2 < 0 || c3 < 0) throw new InputRowError(i + 1, `expected 4 fields, got "${line}"`);
    if (line.indexOf(",", c3 + 1) >= 0) throw new InputRowError(i + 1, `expected 4 fields, got more: "${line}"`);
    out.push(checkRow(i + 1, line.slice(0, c1), line.slice(c1 + 1, c2), line.slice(c2 + 1, c3), line.slice(c3 + 1)));
  }
  return out;
}

export function parseRawJson(text: string): RawRow[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new InputRowError(0, "JSON input must be an array of {date, indicator, value, source}");
  return data.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    // `{date, series, value}` is the source-data form; `indicator` keeps the original one.
    if (!("indicator" in o) && "series" in o) {
      if ("kind" in o) throw new ReplayContractError();
      return checkSeriesRow(i + 1, o.date, o.series, o.value);
    }
    return checkRow(i + 1, o.date, o.indicator, o.value, o.source);
  });
}

// Picks the parser from the first non-space character: `[` is JSON, else CSV.
export function parseRawHistory(text: string): RawRow[] {
  return text.trimStart().startsWith("[") ? parseRawJson(text) : parseRawCsv(text);
}

// Rows -> series per indicator, ascending by date. A repeated (indicator, date)
// keeps the LAST row in input order.
export function toHistory(rows: RawRow[]): RawIndicatorHistory {
  const byId = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = byId.get(r.indicator);
    if (!m) byId.set(r.indicator, (m = new Map()));
    m.set(r.date, r.value);
  }
  const out: RawIndicatorHistory = {};
  for (const [id, m] of byId) {
    const pts: Point[] = [...m].map(([date, value]) => ({ date, value }));
    pts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    out[id] = pts;
  }
  return out;
}

// ── Source rows and the historical replay contract (issue 1404) ──────────────

export const SOURCE_CSV_HEADER = SERIES_CSV_HEADER;
export const REPLAY_CSV_HEADER = "date,series,value,kind";

export type InputKind = "source" | "calculated";

export interface InputRow {
  date: string;
  series: string;
  value: number;
  kind: InputKind;
}

export type InputFormat = "source" | "replay" | "legacy";

// A file in the replay contract handed to a reader that did not ask for it.
export class ReplayContractError extends Error {
  override readonly name = "ReplayContractError";
  constructor() {
    super(`this is a historical replay input (${REPLAY_CSV_HEADER}); it may hold calculated ratio values and loads only through the replay contract: pass --replay (or parseInput(text, { replay: true }))`);
  }
}

const toInputRow = (r: RawRow): InputRow => ({ date: r.date, series: r.indicator, value: r.value, kind: "source" });

// The source form alone: `date,series,value` rows, series a source id.
export function parseSourceCsv(text: string): InputRow[] {
  const header = (text.replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "").trim();
  if (header !== SOURCE_CSV_HEADER) throw new CsvHeaderError(header, SOURCE_CSV_HEADER);
  return parseRawCsv(text).map(toInputRow);
}
export function parseSourceJson(text: string): InputRow[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new InputRowError(0, "JSON input must be an array of {date, series, value}");
  return data.map((r, i) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw new InputRowError(i + 1, "expected an object {date, series, value}");
    const keys = Object.keys(r);
    if (keys.length !== 3 || !["date", "series", "value"].every((k) => k in r)) throw new InputRowError(i + 1, `expected exactly the keys date, series, value, got ${keys.join(", ")}`);
    const o = r as Record<string, unknown>;
    return toInputRow(checkSeriesRow(i + 1, o.date, o.series, o.value));
  });
}

function checkReplayRow(row: number, date: unknown, series: unknown, value: unknown, kind: unknown): InputRow {
  if (typeof date !== "string" || !isRealDay(date)) throw new InputRowError(row, `date must be a real calendar date in YYYY-MM-DD form, got ${JSON.stringify(date)}`);
  if (typeof series !== "string" || series === "" || /[\s,"]/.test(series)) throw new InputRowError(row, `series must be a non-empty name with no space, comma or quote, got ${JSON.stringify(series)}`);
  const v = checkValue(row, value);
  if (kind !== "source" && kind !== "calculated") throw new InputRowError(row, `kind must be "source" or "calculated", got ${JSON.stringify(kind)}`);
  if (kind === "calculated" && !isCalculatedName(series)) throw new InputRowError(row, `series ${series} is source data; kind "calculated" is only for the calculated ratio indicators`);
  if (kind === "source" && isCalculatedName(series)) throw new InputRowError(row, `series ${series} is a calculated ratio; its stored values have kind "calculated"`);
  return { date, series, value: v, kind };
}

export function parseReplayCsv(text: string): InputRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = (lines[0] ?? "").trim();
  if (header !== REPLAY_CSV_HEADER) throw new CsvHeaderError(header, REPLAY_CSV_HEADER);
  const out: InputRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (line.includes('"')) throw new CsvQuotedFieldError(i + 1);
    const f = line.split(",");
    if (f.length !== 4) throw new InputRowError(i + 1, `expected 4 fields, got ${f.length}: "${line}"`);
    out.push(checkReplayRow(i + 1, f[0], f[1], f[2], f[3]));
  }
  return out;
}

export function parseReplayJson(text: string): InputRow[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new InputRowError(0, "JSON input must be an array of {date, series, value, kind}");
  return data.map((r, i) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw new InputRowError(i + 1, "expected an object {date, series, value, kind}");
    const keys = Object.keys(r);
    if (keys.length !== 4 || !["date", "series", "value", "kind"].every((k) => k in r)) throw new InputRowError(i + 1, `expected exactly the keys date, series, value, kind, got ${keys.join(", ")}`);
    const o = r as Record<string, unknown>;
    return checkReplayRow(i + 1, o.date, o.series, o.value, o.kind);
  });
}

// Which contract a file is in: from the CSV header, or the keys of the first
// JSON row (an empty JSON array is a source input).
export function detectInputFormat(text: string): InputFormat {
  const t = text.replace(/^\uFEFF/, "").trimStart();
  if (t.startsWith("[")) {
    const first = (JSON.parse(t) as unknown[])[0];
    if (first && typeof first === "object") {
      if ("indicator" in first) return "legacy";
      if ("kind" in first) return "replay";
    }
    return "source";
  }
  const header = (t.split(/\r?\n/)[0] ?? "").trim();
  if (header === CSV_HEADER) return "legacy";
  if (header === REPLAY_CSV_HEADER) return "replay";
  if (header === SOURCE_CSV_HEADER) return "source";
  throw new CsvHeaderError(header, `${SOURCE_CSV_HEADER}" (or "${REPLAY_CSV_HEADER}" with --replay, or the legacy "${CSV_HEADER}`);
}

export interface ParsedInput {
  format: InputFormat;
  rows: number;
  history: RawIndicatorHistory;
}

// Parse any input file into the history runRegime reads. The replay contract is
// accepted only when the caller asks for it (`replay: true`); a source or legacy
// file is read the same with or without it.
export function parseInput(text: string, opts: { replay?: boolean } = {}): ParsedInput {
  const format = detectInputFormat(text);
  if (format !== "replay") {
    const rows = parseRawHistory(text);
    return { format, rows: rows.length, history: toHistory(rows) };
  }
  if (opts.replay !== true) throw new ReplayContractError();
  const rows = text.replace(/^\uFEFF/, "").trimStart().startsWith("[") ? parseReplayJson(text) : parseReplayCsv(text);
  return { format, rows: rows.length, history: inputHistory(rows) };
}

// Rows -> series per name, ascending by date; a repeated (series, date) keeps the
// LAST row, the same rule as toHistory and mergeSeries.
export function inputHistory(rows: readonly InputRow[]): RawIndicatorHistory {
  return toHistory(rows.map((r) => ({ date: r.date, indicator: r.series, value: r.value, source: r.kind })));
}
