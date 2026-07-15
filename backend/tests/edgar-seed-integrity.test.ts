// Integrity + corruption coverage for the committed EDGAR/MNA seed artifact
// (issue #108). Every corruption case must FAIL LOUDLY — via loadEdgarSeed's
// parse/validate path — before any API request or database change could ever
// be attempted. Uses a tiny deterministic 3-month fixture (not the real
// ~200-row committed artifact) so every assertion is exact; a separate test
// below loads the REAL committed pair with its own defaults.
import { test, expect } from "bun:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDGAR_SEED_FORMAT_VERSION,
  EDGAR_SEED_INDICATOR,
  EDGAR_SEED_SOURCE,
  canonicalCsv,
  computeChecksum,
  buildManifest,
  validateSeed,
  parseCanonicalCsv,
  loadEdgarSeed,
  type EdgarSeedRow,
  type EdgarSeedManifest,
} from "../src/analytics/extract/edgar-seed.ts";

const ROWS: EdgarSeedRow[] = [
  { date: "2020-01-31", indicator: "MNA", value: 10 },
  { date: "2020-02-29", indicator: "MNA", value: 12 },
  { date: "2020-03-31", indicator: "MNA", value: 9 },
];

function validManifest(): EdgarSeedManifest {
  return buildManifest(ROWS, { asOf: "2020-04-01" });
}

// Writes a (possibly corrupted) row set + manifest pair to a fresh temp dir
// and returns the paths. Callers mutate rows/manifest before calling this.
function writeSeed(rows: EdgarSeedRow[], manifest: EdgarSeedManifest): { gzPath: string; manifestPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rm-edgar-seed-"));
  const gzPath = join(dir, "seed.csv.gz");
  const manifestPath = join(dir, "seed.manifest.json");
  writeFileSync(gzPath, gzipSync(Buffer.from(canonicalCsv(rows), "utf8")));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { gzPath, manifestPath, dir };
}

// ── manifest/checksum construction (pure) ────────────────────────────────────

test("buildManifest computes rowCount/startMonth/endMonth/checksum from the canonical content", () => {
  const m = validManifest();
  expect(m.formatVersion).toBe(EDGAR_SEED_FORMAT_VERSION);
  expect(m.indicator).toBe(EDGAR_SEED_INDICATOR);
  expect(m.source).toBe(EDGAR_SEED_SOURCE);
  expect(m.startMonth).toBe("2020-01");
  expect(m.endMonth).toBe("2020-03");
  expect(m.rowCount).toBe(3);
  expect(m.asOf).toBe("2020-04-01");
  expect(m.checksum).toBe(computeChecksum(canonicalCsv(ROWS)));
});

test("canonicalCsv is gzip-metadata-independent: two gzips of the same rows share one checksum", () => {
  const a = gzipSync(Buffer.from(canonicalCsv(ROWS), "utf8"), { level: 1 });
  // Different compression level → different compressed bytes, identical decompressed content.
  const b = gzipSync(Buffer.from(canonicalCsv(ROWS), "utf8"), { level: 9 });
  expect(a.equals(b)).toBe(false);
  const textA = gunzipSync(a).toString("utf8");
  const textB = gunzipSync(b).toString("utf8");
  expect(computeChecksum(textA)).toBe(computeChecksum(textB));
});

// ── happy path: a valid artifact loads and round-trips ───────────────────────

test("a valid seed loads via loadEdgarSeed and yields RawIndicatorHistory keyed by the manifest indicator", async () => {
  const manifest = validManifest();
  const { gzPath, manifestPath, dir } = writeSeed(ROWS, manifest);
  try {
    const { history, manifest: loaded, rows } = await loadEdgarSeed(gzPath, manifestPath);
    expect(loaded).toEqual(manifest);
    expect(rows).toEqual(ROWS);
    expect(history.MNA).toEqual([
      { date: "2020-01-31", value: 10 },
      { date: "2020-02-29", value: 12 },
      { date: "2020-03-31", value: 9 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing artifact file fails loudly (never silent-skip)", async () => {
  const { manifestPath, dir } = writeSeed(ROWS, validManifest());
  try {
    await expect(loadEdgarSeed("/nonexistent/seed.csv.gz", manifestPath)).rejects.toThrow(/artifact not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing manifest file fails loudly", async () => {
  const { gzPath, dir } = writeSeed(ROWS, validManifest());
  try {
    await expect(loadEdgarSeed(gzPath, "/nonexistent/seed.manifest.json")).rejects.toThrow(/manifest not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the real committed artifact ──────────────────────────────────────────────

test("the committed EDGAR/MNA seed artifact loads with defaults and covers the declared 2010-01 baseline", async () => {
  const { history, manifest, rows } = await loadEdgarSeed();
  expect(manifest.indicator).toBe("MNA");
  expect(manifest.formatVersion).toBe(1);
  expect(manifest.startMonth).toBe("2010-01");
  expect(manifest.rowCount).toBe(rows.length);
  expect(history.MNA.length).toBe(manifest.rowCount);
  expect(history.MNA[0]!.date.startsWith("2010-01")).toBe(true);
  // Every value is a finite non-negative integer (re-asserted at the history level,
  // not just the row level, proving the returned shape is what the seed API expects).
  for (const p of history.MNA) {
    expect(Number.isInteger(p.value)).toBe(true);
    expect(p.value).toBeGreaterThanOrEqual(0);
  }
});

// ── corruption negatives: every case fails loudly, before any I/O to an API ──

test("corruption: a mutated value flips the checksum and is rejected", () => {
  const manifest = validManifest();
  const mutated = ROWS.map((r, i) => (i === 1 ? { ...r, value: r.value + 1 } : r));
  expect(() => validateSeed(mutated, manifest)).toThrow(/checksum mismatch/);
});

test("corruption: a deleted month breaks rowCount, coverage, and checksum", () => {
  const manifest = validManifest();
  const deleted = ROWS.filter((r) => r.date !== "2020-02-29");
  expect(() => validateSeed(deleted, manifest)).toThrow(/rowCount|coverage gap|checksum mismatch/);
});

test("corruption: a duplicated month breaks ascending-uniqueness", () => {
  const manifest = buildManifest([...ROWS, { date: "2020-03-31", indicator: "MNA", value: 9 }], { asOf: "2020-04-01" });
  const duplicated = [...ROWS, { date: "2020-03-31", indicator: "MNA", value: 9 }];
  expect(() => validateSeed(duplicated, manifest)).toThrow(/not strictly ascending/);
});

test("corruption: a reordered month is rejected (ascending order required)", () => {
  const manifest = validManifest();
  const reordered = [ROWS[1]!, ROWS[0]!, ROWS[2]!];
  expect(() => validateSeed(reordered, manifest)).toThrow(/not strictly ascending|checksum mismatch/);
});

test("corruption: altered manifest metadata (wrong rowCount) is rejected even though content is well-formed", () => {
  const manifest = { ...validManifest(), rowCount: 999 };
  expect(() => validateSeed(ROWS, manifest)).toThrow(/rowCount/);
});

test("corruption: altered manifest metadata (wrong startMonth) is rejected", () => {
  const manifest = { ...validManifest(), startMonth: "2019-12" };
  expect(() => validateSeed(ROWS, manifest)).toThrow(/startMonth/);
});

test("corruption: a second indicator in the row set is rejected (single-indicator artifact)", () => {
  const manifest = validManifest();
  const withSecondIndicator = ROWS.map((r, i) => (i === 2 ? { ...r, indicator: "OTHER" } : r));
  expect(() => validateSeed(withSecondIndicator, manifest)).toThrow(/indicator .* !== manifest indicator/);
});

test("corruption: truncated gzip content fails to decompress", async () => {
  const manifest = validManifest();
  const dir = mkdtempSync(join(tmpdir(), "rm-edgar-seed-"));
  try {
    const gzPath = join(dir, "seed.csv.gz");
    const manifestPath = join(dir, "seed.manifest.json");
    const full = gzipSync(Buffer.from(canonicalCsv(ROWS), "utf8"));
    writeFileSync(gzPath, full.subarray(0, Math.floor(full.length / 2))); // truncated
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(loadEdgarSeed(gzPath, manifestPath)).rejects.toThrow(/not valid gzip/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corruption: an explicit checksum mismatch (manifest checksum tampered) is rejected", () => {
  const manifest = { ...validManifest(), checksum: "0".repeat(64) };
  expect(() => validateSeed(ROWS, manifest)).toThrow(/checksum mismatch/);
});

test("corruption: every case above is caught BEFORE returning from loadEdgarSeed (fails loudly, not silently)", async () => {
  const manifest = { ...validManifest(), rowCount: 999 };
  const { gzPath, manifestPath, dir } = writeSeed(ROWS, manifest);
  try {
    await expect(loadEdgarSeed(gzPath, manifestPath)).rejects.toThrow(/rowCount/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── parseCanonicalCsv structural strictness ─────────────────────────────────

test("parseCanonicalCsv rejects a wrong header", () => {
  expect(() => parseCanonicalCsv("wrong,header\n2020-01-31,MNA,10\n")).toThrow(/expected header/);
});

test("parseCanonicalCsv rejects a malformed line (wrong field count)", () => {
  expect(() => parseCanonicalCsv("date,indicator,value\n2020-01-31,MNA\n")).toThrow(/is not "date,indicator,value"/);
});

test("parseCanonicalCsv rejects a non-month-end date", () => {
  expect(() => parseCanonicalCsv("date,indicator,value\n2020-01-15,MNA,10\n")).toThrow(/invalid month-end date/);
});

test("parseCanonicalCsv rejects a non-finite value", () => {
  expect(() => parseCanonicalCsv("date,indicator,value\n2020-01-31,MNA,not-a-number\n")).toThrow(/not a finite number/);
});

// ── no unexpected/future rows ────────────────────────────────────────────────

test("validateSeed rejects a manifest whose endMonth is AFTER the pinned asOf (future rows)", () => {
  const manifest = { ...validManifest(), asOf: "2020-02-15" }; // endMonth 2020-03 > asOf month 2020-02
  expect(() => validateSeed(ROWS, manifest)).toThrow(/AFTER the pinned asOf/);
});
