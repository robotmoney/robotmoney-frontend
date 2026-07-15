// Extract stage: the canonical EDGAR/MNA monthly seed artifact — format,
// checksum, and validation (issue #108). A fresh live database has NO
// persisted history for the late-cycle M&A input (raw floor indicator
// "MNA"), so its first research run would otherwise attempt a full
// January-2010-to-present SEC EDGAR crawl (~200 requests) before it can
// classify. This module defines the committed seed's canonical text format,
// its manifest, and the validation every load MUST pass before the parsed
// data is ever submitted to the analytics seed-ingestion API.
//
// Pure parsing/validation — no network, no SQL. The live fetch used to
// REGENERATE the artifact lives in extract/edgar-seed-generator.ts; the
// authenticated ingestion (the loader/repopulation client) lives in
// ../edgar-seed-loader.ts.
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { RawIndicatorHistory } from "../types.ts";

export const EDGAR_SEED_FORMAT_VERSION = 1;
// The dedicated raw-floor indicator key for the EDGAR S-4 monthly research
// input (matches late-cycle.ts's `get("MNA", ...)` and data-source.ts's mna
// leg — this is the SAME indicator id the live research fetch stamps).
export const EDGAR_SEED_INDICATOR = "MNA";
export const EDGAR_SEED_SOURCE = "sec-edgar-fts-s4";

export interface EdgarSeedRow {
  date: string; // month-end, YYYY-MM-DD
  indicator: string;
  value: number; // S-4 filing count for the month (finite, non-negative integer)
}

export interface EdgarSeedManifest {
  formatVersion: number;
  indicator: string;
  source: string;
  startMonth: string; // YYYY-MM — the declared January-2010 baseline
  endMonth: string; // YYYY-MM — the pinned as-of month (inclusive)
  asOf: string; // YYYY-MM-DD — the date the regeneration was pinned/run
  rowCount: number; // exact row count (one row per covered month)
  checksum: string; // sha256 hex of the canonical DECOMPRESSED CSV content
}

// The committed fixture location (same convention as extract/floor-seed.ts's
// DEFAULT_FLOOR_SEED_PATH) — overridable via EDGAR_SEED_PATH/
// EDGAR_SEED_MANIFEST_PATH for tests and the repopulation/regeneration CLIs.
export const DEFAULT_EDGAR_SEED_PATH = new URL(
  "../../../tests/fixtures/regime/edgar-mna-seed.csv.gz",
  import.meta.url,
).pathname;
export const DEFAULT_EDGAR_SEED_MANIFEST_PATH = new URL(
  "../../../tests/fixtures/regime/edgar-mna-seed.manifest.json",
  import.meta.url,
).pathname;

function resolveSeedPath(explicit?: string): string {
  return explicit || process.env.EDGAR_SEED_PATH || DEFAULT_EDGAR_SEED_PATH;
}
function resolveManifestPath(explicit?: string): string {
  return explicit || process.env.EDGAR_SEED_MANIFEST_PATH || DEFAULT_EDGAR_SEED_MANIFEST_PATH;
}

const CSV_HEADER = "date,indicator,value";

// Deterministic canonical text: sorted ascending by date, LF-joined, single
// trailing newline. The manifest checksum is computed over EXACTLY this
// string, so it never depends on gzip timestamp/OS/compression-level bytes.
export function canonicalCsv(rows: readonly EdgarSeedRow[]): string {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const lines = [CSV_HEADER, ...sorted.map((r) => `${r.date},${r.indicator},${r.value}`)];
  return lines.join("\n") + "\n";
}

export function computeChecksum(canonicalText: string): string {
  return createHash("sha256").update(canonicalText, "utf8").digest("hex");
}

function isMonthEndDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return false;
  const nextDay = new Date(d.getTime() + 86_400_000);
  return nextDay.getUTCDate() === 1; // v is the LAST calendar day of its month
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}
// YYYY-MM → the following YYYY-MM.
function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m is 1-based here, so Date.UTC(y, m, 1) is next month's 1st
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Strict parse: the header must match EXACTLY, and every subsequent
// non-empty line must be `date,indicator,value` — a valid calendar date, a
// non-empty indicator, and a finite number. Throws loudly on any malformed
// line (never silently drops a row).
export function parseCanonicalCsv(text: string): EdgarSeedRow[] {
  const lines = text.split("\n");
  if (lines[0] !== CSV_HEADER) {
    throw new Error(`EDGAR seed: expected header ${JSON.stringify(CSV_HEADER)}, got ${JSON.stringify(lines[0])}`);
  }
  const rows: EdgarSeedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue; // tolerate the single trailing blank line
    const parts = line.split(",");
    if (parts.length !== 3) {
      throw new Error(`EDGAR seed: line ${i + 1} is not "date,indicator,value": ${JSON.stringify(line)}`);
    }
    const [date, indicator, valueStr] = parts as [string, string, string];
    if (!isMonthEndDate(date)) {
      throw new Error(`EDGAR seed: line ${i + 1} has an invalid month-end date ${JSON.stringify(date)}`);
    }
    if (!indicator) {
      throw new Error(`EDGAR seed: line ${i + 1} has an empty indicator`);
    }
    const value = Number(valueStr);
    if (!Number.isFinite(value)) {
      throw new Error(`EDGAR seed: line ${i + 1} value ${JSON.stringify(valueStr)} is not a finite number`);
    }
    rows.push({ date, indicator, value });
  }
  return rows;
}

// Full structural + manifest-consistency validation. Throws with a
// descriptive message on the FIRST violation — used both to validate a
// loaded artifact (before any API call/DB change) and to self-check a
// freshly generated one before it is ever written to disk.
export function validateSeed(rows: readonly EdgarSeedRow[], manifest: EdgarSeedManifest): void {
  if (manifest.formatVersion !== EDGAR_SEED_FORMAT_VERSION) {
    throw new Error(`EDGAR seed: unsupported formatVersion ${manifest.formatVersion} (expected ${EDGAR_SEED_FORMAT_VERSION})`);
  }
  if (manifest.indicator !== EDGAR_SEED_INDICATOR) {
    throw new Error(
      `EDGAR seed: manifest indicator ${JSON.stringify(manifest.indicator)} !== expected ${JSON.stringify(EDGAR_SEED_INDICATOR)}`,
    );
  }
  if (manifest.source !== EDGAR_SEED_SOURCE) {
    throw new Error(`EDGAR seed: manifest source ${JSON.stringify(manifest.source)} !== expected ${JSON.stringify(EDGAR_SEED_SOURCE)}`);
  }
  if (!Number.isInteger(manifest.rowCount) || manifest.rowCount <= 0) {
    throw new Error(`EDGAR seed: manifest rowCount must be a positive integer, got ${manifest.rowCount}`);
  }
  if (rows.length !== manifest.rowCount) {
    throw new Error(`EDGAR seed: parsed ${rows.length} row(s) but manifest declares rowCount=${manifest.rowCount}`);
  }
  if (!/^\d{4}-\d{2}$/.test(manifest.startMonth) || !/^\d{4}-\d{2}$/.test(manifest.endMonth)) {
    throw new Error("EDGAR seed: manifest startMonth/endMonth must be YYYY-MM");
  }
  if (manifest.startMonth > manifest.endMonth) {
    throw new Error(`EDGAR seed: manifest startMonth ${manifest.startMonth} is after endMonth ${manifest.endMonth}`);
  }
  const dAsOf = new Date(`${manifest.asOf}T00:00:00Z`);
  if (Number.isNaN(dAsOf.getTime()) || dAsOf.toISOString().slice(0, 10) !== manifest.asOf) {
    throw new Error(`EDGAR seed: manifest asOf ${JSON.stringify(manifest.asOf)} is not a valid ISO date`);
  }
  if (manifest.endMonth > manifest.asOf.slice(0, 7)) {
    throw new Error(
      `EDGAR seed: manifest endMonth ${manifest.endMonth} is AFTER the pinned asOf ${manifest.asOf} — future rows are never valid`,
    );
  }

  let prevMonth: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.indicator !== manifest.indicator) {
      throw new Error(
        `EDGAR seed: row ${i} (${r.date}) indicator ${JSON.stringify(r.indicator)} !== manifest indicator ${JSON.stringify(manifest.indicator)} — a seed artifact holds exactly one indicator`,
      );
    }
    if (!isMonthEndDate(r.date)) {
      throw new Error(`EDGAR seed: row ${i} date ${JSON.stringify(r.date)} is not a valid month-end date`);
    }
    if (!Number.isFinite(r.value) || !Number.isInteger(r.value) || r.value < 0) {
      throw new Error(`EDGAR seed: row ${i} (${r.date}) value ${r.value} must be a finite non-negative integer`);
    }
    const ym = monthOf(r.date);
    if (prevMonth !== null) {
      if (ym <= prevMonth) {
        throw new Error(`EDGAR seed: rows are not strictly ascending — ${r.date} follows a row already in/after month ${prevMonth}`);
      }
      if (ym !== nextMonth(prevMonth)) {
        throw new Error(
          `EDGAR seed: coverage gap — month after ${prevMonth} is ${ym}, expected ${nextMonth(prevMonth)} (contiguous monthly coverage required)`,
        );
      }
    }
    prevMonth = ym;
  }
  if (rows.length > 0) {
    if (monthOf(rows[0]!.date) !== manifest.startMonth) {
      throw new Error(`EDGAR seed: first row month ${monthOf(rows[0]!.date)} !== manifest startMonth ${manifest.startMonth}`);
    }
    if (monthOf(rows[rows.length - 1]!.date) !== manifest.endMonth) {
      throw new Error(
        `EDGAR seed: last row month ${monthOf(rows[rows.length - 1]!.date)} !== manifest endMonth ${manifest.endMonth}`,
      );
    }
  }

  // Content checksum LAST: every structural check above is independent of
  // this, so a mutated value/added row/reordered row/altered metadata is
  // caught by whichever check is more specific — and ANY byte-level change
  // to the canonical content also always changes this digest.
  const checksum = computeChecksum(canonicalCsv(rows));
  if (checksum !== manifest.checksum) {
    throw new Error(`EDGAR seed: checksum mismatch (computed ${checksum}, manifest declares ${manifest.checksum})`);
  }
}

export function buildManifest(rows: readonly EdgarSeedRow[], opts: { asOf: string; source?: string }): EdgarSeedManifest {
  if (rows.length === 0) throw new Error("EDGAR seed: cannot build a manifest for zero rows");
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    formatVersion: EDGAR_SEED_FORMAT_VERSION,
    indicator: EDGAR_SEED_INDICATOR,
    source: opts.source ?? EDGAR_SEED_SOURCE,
    startMonth: monthOf(sorted[0]!.date),
    endMonth: monthOf(sorted[sorted.length - 1]!.date),
    asOf: opts.asOf,
    rowCount: sorted.length,
    checksum: computeChecksum(canonicalCsv(sorted)),
  };
}

// Load + FULLY VALIDATE the committed artifact. Fails loudly (never
// silent-skip) on a missing file, corrupt gzip, malformed manifest JSON, or
// any structural/checksum violation — always BEFORE returning, so a caller
// can never submit a partially-trusted seed to the analytics API.
export async function loadEdgarSeed(
  path?: string,
  manifestPath?: string,
): Promise<{ history: RawIndicatorHistory; manifest: EdgarSeedManifest; rows: EdgarSeedRow[] }> {
  const p = resolveSeedPath(path);
  const mp = resolveManifestPath(manifestPath);

  const file = Bun.file(p);
  if (!(await file.exists())) {
    throw new Error(`EDGAR seed artifact not found at ${p} — set EDGAR_SEED_PATH or ship the committed seed`);
  }
  const manifestFile = Bun.file(mp);
  if (!(await manifestFile.exists())) {
    throw new Error(`EDGAR seed manifest not found at ${mp} — set EDGAR_SEED_MANIFEST_PATH or ship the committed manifest`);
  }

  const gz = Buffer.from(await file.arrayBuffer());
  let text: string;
  try {
    text = gunzipSync(gz).toString("utf8");
  } catch (e) {
    throw new Error(`EDGAR seed artifact at ${p} is not valid gzip: ${e instanceof Error ? e.message : e}`);
  }

  let manifest: EdgarSeedManifest;
  try {
    manifest = JSON.parse(await manifestFile.text()) as EdgarSeedManifest;
  } catch (e) {
    throw new Error(`EDGAR seed manifest at ${mp} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }

  const rows = parseCanonicalCsv(text);
  validateSeed(rows, manifest); // throws loudly on ANY corruption — before any API call

  return {
    history: { [manifest.indicator]: rows.map((r) => ({ date: r.date, value: r.value })) },
    manifest,
    rows,
  };
}
