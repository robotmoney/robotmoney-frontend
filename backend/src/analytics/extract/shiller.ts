// Extract stage: Shiller CAPE (keyless) source client — two sources merged.
// Ported from agentjuno/robotmoney fetchers/shiller.js + multpl.js.
//
//   1. MULTPL (primary)  — HTML scrape of multpl.com/shiller-pe/table/by-month.
//                          Actively maintained; updates monthly.
//   2. DATAHUB (backfill) — GitHub CSV mirror of Shiller's spreadsheet (PE10
//                          column). Stable URL; updates lag and it can serve
//                          explicit zeros for stale rows.
//
// multpl wins on overlap; datahub backfills older dates. Any value <= 0 is
// rejected (CAPE is a strictly positive valuation ratio). SHILLER_CAPE, sign -1.
import type { Point } from "../types.ts";
import { fetchText } from "./http.ts";

export const datahubUrl =
  "https://raw.githubusercontent.com/datasets/s-and-p-500/master/data/data.csv";
export const multplUrl = "https://www.multpl.com/shiller-pe/table/by-month";

// Parse the datahub CSV. Finds the Date + PE10 columns (tolerant to renames),
// coerces YYYY-MM → YYYY-MM-01, drops non-positive / non-finite CAPE. Throws
// when columns are missing or nothing parses.
export function parseDatahubCsv(text: string): Point[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) throw new Error("datahub: CSV empty");
  const header = lines[0].split(",").map((s) => s.trim());
  const dateIdx = header.indexOf("Date");
  let peIdx = header.indexOf("PE10");
  if (peIdx < 0) peIdx = header.findIndex((h) => /^P\/?E\s*10$/i.test(h));
  if (peIdx < 0) peIdx = header.findIndex((h) => /pe10/i.test(h));
  if (dateIdx < 0 || peIdx < 0)
    throw new Error(`datahub: missing columns (header: ${header.join("|")})`);
  const out: Point[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const rawDate = parts[dateIdx];
    const rawVal = parts[peIdx];
    if (!rawDate || rawVal === "" || rawVal == null) continue;
    const v = parseFloat(rawVal);
    if (!Number.isFinite(v) || v <= 0) continue;
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : /^\d{4}-\d{2}$/.test(rawDate)
        ? `${rawDate}-01`
        : null;
    if (!iso) continue;
    out.push({ date: iso, value: v });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  if (out.length === 0) throw new Error("datahub: 0 valid rows parsed (no positive CAPE values)");
  return out;
}

// The value cell's leading filler now includes an EN-SPACE HTML entity
// (`&#x2002;`) that the original `\s*` could not match — multpl.com changed its
// markup, silently breaking the original scraper. We match any run of
// whitespace, HTML entities (`&#x2002;`, `&nbsp;`, …), or <a> wrappers before
// the number so both the old and current layouts parse.
const FILLER = "(?:\\s|&[#a-zA-Z0-9]+;|<a[^>]*>)*";
const MULTPL_ROW_RE = new RegExp(
  [
    "<tr[^>]*>\\s*",
    "<td[^>]*>" + FILLER,
    "([A-Z][a-z]+\\.?\\s+\\d{1,2},?\\s*\\d{4})",
    "\\s*(?:</a>\\s*)?</td>\\s*",
    "<td[^>]*>" + FILLER,
    "([\\d.]+)",
  ].join(""),
  "g",
);

// Parse the multpl.com by-month HTML table. Each row: "Month DD, YYYY" + value.
// Drops duplicates and non-positive values. Throws when nothing parses.
export function parseMultplHtml(html: string): Point[] {
  const out: Point[] = [];
  const seen = new Set<string>();
  MULTPL_ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MULTPL_ROW_RE.exec(html)) !== null) {
    const d = new Date(`${m[1]} UTC`);
    if (isNaN(d.getTime())) continue;
    const iso = d.toISOString().slice(0, 10);
    if (seen.has(iso)) continue;
    seen.add(iso);
    const v = Number(m[2]);
    if (!Number.isFinite(v) || v <= 0) continue;
    out.push({ date: iso, value: v });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  if (out.length === 0) throw new Error("multpl: 0 rows parsed (HTML structure may have changed)");
  return out;
}

// Merge two date-sorted CAPE series: multpl wins on overlap, datahub backfills
// older dates. Result is date-sorted, deduped. Pure.
export function mergeShiller(multpl: Point[], datahub: Point[]): Point[] {
  const seen = new Set(multpl.map((p) => p.date));
  const out = multpl.slice();
  for (const p of datahub) {
    if (!seen.has(p.date)) {
      out.push(p);
      seen.add(p.date);
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export async function fetchFromDatahub(timeoutMs = 15000): Promise<Point[]> {
  return parseDatahubCsv(await fetchText(datahubUrl, timeoutMs));
}

export async function fetchMultplShillerCape(timeoutMs = 15000): Promise<Point[]> {
  const html = await fetchText(multplUrl, timeoutMs, {
    "user-agent": "Mozilla/5.0 (compatible; robotmoney-regime/1.0)",
    accept: "text/html,application/xhtml+xml",
  });
  return parseMultplHtml(html);
}

// Try both sources in parallel; merge when both succeed, else whichever works.
// Throws only when BOTH fail. Loud-logs the outcome via `logger`.
export async function fetchShillerCape(
  logger: { log?: (m: string) => void; warn?: (m: string) => void } = console,
): Promise<Point[]> {
  const [m, d] = await Promise.allSettled([
    fetchMultplShillerCape().then((rows) => rows.filter((p) => p.value > 0)),
    fetchFromDatahub(),
  ]);
  const multpl = m.status === "fulfilled" && m.value.length > 0 ? m.value : null;
  const datahub = d.status === "fulfilled" && d.value.length > 0 ? d.value : null;
  const multplErr = m.status === "rejected" ? String(m.reason?.message ?? m.reason) : "0 rows";
  const datahubErr = d.status === "rejected" ? String(d.reason?.message ?? d.reason) : "0 rows";

  if (multpl && datahub) {
    const merged = mergeShiller(multpl, datahub);
    logger.log?.(`[shiller] multpl ${multpl.length} + datahub backfill ${datahub.length} → merged ${merged.length}`);
    return merged;
  }
  if (multpl) {
    logger.log?.(`[shiller] multpl only: ${multpl.length} rows (datahub failed: ${datahubErr})`);
    return multpl;
  }
  if (datahub) {
    logger.warn?.(`[shiller] datahub fallback only: ${datahub.length} rows (multpl failed: ${multplErr})`);
    return datahub;
  }
  throw new Error(`shiller: both sources failed (multpl: ${multplErr}; datahub: ${datahubErr})`);
}
