// Original (pre-refactor) report evidence for issue 1421. Test-side only: it
// reads local files, so it lives under tests/, never under src/.
//
// The originals in tests/fixtures/originals/ were produced by the code at the
// commit named in manifest.json (`origin.codeCommit`), BEFORE any issue 1421
// source change, by scripts/capture-originals.ts (SDK envelopes and the shared
// analysis artifact) and backend/scripts/capture-analytics-originals.ts (the
// backend envelopes). Every later test compares fresh output against these
// bytes exactly: no numeric tolerance, no re-serialization.
//
// Input variants are DERIVED from the committed production fixture
// (fixtures/raw-indicator-history.csv) by the pure rules below. The manifest
// records the sha256 of each derived input, so a change to a rule or to the
// fixture is caught by the provenance test.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { BacktestPayload } from "../../src/analyze/backtest.ts";
import type { Point } from "../../src/types.ts";

export const SDK_TESTS = join(import.meta.dir, "..");
export const ORIGINALS_DIR = join(SDK_TESTS, "fixtures/originals");
export const PRODUCTION_CSV = join(SDK_TESTS, "fixtures/raw-indicator-history.csv");

export const VARIANTS = ["production", "missing-label", "zero-volatility"] as const;
export type Variant = (typeof VARIANTS)[number];

// The extras that are not registry indicators (price levels and the T-bill yield).
const EXTRA_INPUT_IDS = new Set(["SPX", "ETH", "TBILL3M"]);
// missing-label: every registry row in this window is removed. The window is
// longer than MAX_FORWARD_FILL_DAYS (120), so forward-filled values expire and
// the composite has no label on some days: the AN-9 skip path.
export const MISSING_LABEL_WINDOW = { from: "2024-03-01", to: "2024-08-31" } as const;

export const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** The CSV text of one input variant, derived from the production fixture. */
export function variantCsv(variant: Variant, productionCsv = readFileSync(PRODUCTION_CSV, "utf8")): string {
  if (variant === "production") return productionCsv;
  const [header, ...rest] = productionCsv.split("\n");
  const rows = rest.filter((l) => l.length > 0);
  const out: string[] = [];
  for (const line of rows) {
    const [date, indicator, value, source] = line.split(",");
    if (variant === "missing-label") {
      if (!EXTRA_INPUT_IDS.has(indicator!) && date! >= MISSING_LABEL_WINDOW.from && date! <= MISSING_LABEL_WINDOW.to) continue;
      out.push(line);
    } else {
      // zero-volatility: flat prices and a zero cash yield, so every daily
      // portfolio return is 0 and every Sharpe takes the sd = 0 branch.
      if (indicator === "SPX" || indicator === "ETH") out.push(`${date},${indicator},100,${source}`);
      else if (indicator === "TBILL3M") out.push(`${date},${indicator},0,${source}`);
      else out.push(line);
    }
    void value;
  }
  return [header, ...out].join("\n") + "\n";
}

/** The shared calculation artifact both consumers carry: the correlations and stripped backtest. */
export function sharedAnalysisBytes(payload: { correlations: unknown; backtest: unknown }): string {
  return JSON.stringify({ correlations: payload.correlations, backtest: payload.backtest });
}

/** Daily portfolio values, portfolio -> strategy -> [date, value][], from an UNSTRIPPED backtest. */
export function dailyEvidenceBytes(backtest: BacktestPayload): string {
  const out: Record<string, Record<string, [string, number][]>> = {};
  for (const [pf, strategies] of Object.entries(backtest)) {
    out[pf] = {};
    for (const [name, m] of Object.entries(strategies)) {
      if (!m._daily) throw new Error(`${pf}.${name} has no _daily series: pass the unstripped backtest`);
      out[pf]![name] = m._daily.map((p: Point) => [p.date, p.value]);
    }
  }
  return JSON.stringify(out);
}

export interface OriginalEntry {
  /** File name under fixtures/originals (gzipped). */
  file: string;
  /** sha256 of the gzipped file on disk. */
  fileSha256: string;
  /** sha256 of the original bytes (the gunzipped content). */
  contentSha256: string;
  byteLength: number;
  kind: "input" | "report";
  variant: Variant | "an-behaviours";
  describes: string;
  producedBy: string;
}

export interface OriginalsManifest {
  origin: {
    codeCommit: string;
    capturedAt: string;
    commands: string[];
    rule: string;
  };
  inputs: Record<Variant, { contentSha256: string; rows: number; derivation: string }>;
  originals: OriginalEntry[];
}

export function loadManifest(): OriginalsManifest {
  return JSON.parse(readFileSync(join(ORIGINALS_DIR, "manifest.json"), "utf8")) as OriginalsManifest;
}

/** The original bytes of one fixture, as a string (all originals are UTF-8 JSON). */
export function readOriginal(file: string): string {
  return gunzipSync(readFileSync(join(ORIGINALS_DIR, file))).toString("utf8");
}

/**
 * Byte equality, the only comparison allowed against an original: no numeric
 * tolerance, no parse-and-compare, no whitespace normalisation.
 */
export function bytesEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const ab = typeof a === "string" ? new TextEncoder().encode(a) : a;
  const bb = typeof b === "string" ? new TextEncoder().encode(b) : b;
  if (ab.length !== bb.length) return false;
  for (let i = 0; i < ab.length; i++) if (ab[i] !== bb[i]) return false;
  return true;
}

/** First differing byte offset with a short context, for a readable failure. */
export function firstDifference(a: string, b: string): string | null {
  if (a === b) return null;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `first difference at char ${i}: got ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 40))}, original ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 40))}`;
}

export const originalFile = {
  sdkReport: (v: Variant) => `sdk-report-${v}.json.gz`,
  sdkReportFull: (v: Variant) => `sdk-report-full-factor-${v}.json.gz`,
  sharedAnalysis: (v: Variant) => `shared-analysis-${v}.json.gz`,
  daily: (v: Variant) => `daily-portfolio-${v}.json.gz`,
  backendRows: (v: Variant) => `backend-regime-snapshots-${v}.json.gz`,
  backendReport: (v: Variant) => `backend-report-${v}.json.gz`,
  anBehaviours: "an-behaviours.json.gz",
} as const;
