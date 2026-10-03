// Raw-indicator-history input loader. Pure: takes TEXT, returns rows. Reading
// the file is the caller's job (bin/regime.ts), so this module stays free of
// node:fs and process.env (see scripts/tests/unit/analyst-sdk-purity.test.ts).
//
// CSV schema: `date,indicator,value,source` (header required, exact names and
// order). JSON schema: an array of `{date, indicator, value, source}` objects.
// Both forms produce the same rows, hence byte-identical regime output.
import type { Point, RawIndicatorHistory } from "../types.ts";

export interface RawRow {
  date: string;
  indicator: string;
  value: number;
  source: string;
}

export const CSV_HEADER = "date,indicator,value,source";

// Named so callers (and tests) can tell a bad header from a bad row.
export class CsvHeaderError extends Error {
  override readonly name = "CsvHeaderError";
  constructor(readonly got: string) {
    super(`CSV header must be exactly "${CSV_HEADER}", got "${got}"`);
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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function checkRow(row: number, date: unknown, indicator: unknown, value: unknown, source: unknown): RawRow {
  if (typeof date !== "string" || !ISO_DAY.test(date)) throw new InputRowError(row, `date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  if (typeof indicator !== "string" || indicator === "") throw new InputRowError(row, "indicator must be a non-empty string");
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new InputRowError(row, `value must be a finite number, got ${JSON.stringify(value)}`);
  return { date, indicator, value: n, source: typeof source === "string" ? source : "" };
}

export function parseRawCsv(text: string): RawRow[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = (lines[0] ?? "").trim();
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
