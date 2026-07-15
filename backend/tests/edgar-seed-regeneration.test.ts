// Regeneration coverage for the EDGAR/MNA seed generator (issue #108). Uses
// ONLY deterministic mocked EDGAR responses (an injected fetchMonth) — never
// live network, per the no-live-network-in-required-CI contract. Covers:
// deterministic regeneration (same checksum twice), refusal on any
// missing/duplicate/out-of-range/non-finite/non-integer month, round-tripping
// through the exact parser/loader the API-ingestion path uses, and atomic
// filesystem replacement (including leaving a valid prior pair untouched on
// failure).
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchCompleteEdgarSeed,
  generateEdgarSeedArtifact,
  replaceSeedArtifactAtomically,
  type GeneratedSeed,
} from "../src/analytics/extract/edgar-seed-generator.ts";
import { buildManifest, validateSeed, loadEdgarSeed, type EdgarSeedRow } from "../src/analytics/extract/edgar-seed.ts";

// Deterministic mocked fetch: a fixed count per calendar month (derived from
// the month index), so two independent runs over the same range produce
// byte-identical canonical content.
function deterministicFetchMonth(monthStart: string): Promise<number | null> {
  const [, m] = monthStart.split("-");
  return Promise.resolve(10 + Number(m)); // e.g. Jan→11, Feb→12, ... Dec→22
}

const RANGE = { startIso: "2020-01-01", endIso: "2020-06-30", asOf: "2020-07-01" };

test("deterministic mocked EDGAR responses produce the SAME artifact + checksum twice", async () => {
  const a = await generateEdgarSeedArtifact({ ...RANGE, fetchMonth: deterministicFetchMonth, requestDelayMs: 0 });
  const b = await generateEdgarSeedArtifact({ ...RANGE, fetchMonth: deterministicFetchMonth, requestDelayMs: 0 });
  expect(a.manifest.checksum).toBe(b.manifest.checksum);
  expect(a.rows).toEqual(b.rows);
  expect(a.manifest.rowCount).toBe(6); // Jan..Jun 2020
});

test("round-trips through the EXACT parser/loader the API-ingestion path uses", async () => {
  const generated = await generateEdgarSeedArtifact({ ...RANGE, fetchMonth: deterministicFetchMonth, requestDelayMs: 0 });
  const dir = mkdtempSync(join(tmpdir(), "rm-edgar-regen-"));
  try {
    const gzPath = join(dir, "seed.csv.gz");
    const manifestPath = join(dir, "seed.manifest.json");
    replaceSeedArtifactAtomically(gzPath, manifestPath, generated);
    const { history, manifest, rows } = await loadEdgarSeed(gzPath, manifestPath);
    expect(manifest.checksum).toBe(generated.manifest.checksum);
    expect(rows).toEqual(generated.rows);
    expect(history.MNA.length).toBe(6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses (throws) when a month is unrecoverable — never returns a partial artifact", async () => {
  const flaky = (monthStart: string) => (monthStart === "2020-03-01" ? Promise.resolve(null) : deterministicFetchMonth(monthStart));
  await expect(
    generateEdgarSeedArtifact({ ...RANGE, fetchMonth: flaky, requestDelayMs: 0 }),
  ).rejects.toThrow(/unrecoverable/);
});

test("refuses when a month's count is not a finite non-negative integer (non-integer)", async () => {
  const fractional = (monthStart: string) =>
    monthStart === "2020-02-01" ? Promise.resolve(4.5) : deterministicFetchMonth(monthStart);
  await expect(generateEdgarSeedArtifact({ ...RANGE, fetchMonth: fractional, requestDelayMs: 0 })).rejects.toThrow(
    /finite non-negative integer/,
  );
});

test("refuses when a month's count is out of range (negative)", async () => {
  const negative = (monthStart: string) => (monthStart === "2020-04-01" ? Promise.resolve(-1) : deterministicFetchMonth(monthStart));
  await expect(generateEdgarSeedArtifact({ ...RANGE, fetchMonth: negative, requestDelayMs: 0 })).rejects.toThrow(
    /finite non-negative integer/,
  );
});

test("fetchCompleteEdgarSeed refuses an empty range", async () => {
  await expect(
    fetchCompleteEdgarSeed({ startIso: "2020-07-01", endIso: "2020-06-30", asOf: "2020-07-01", fetchMonth: deterministicFetchMonth }),
  ).rejects.toThrow(/no months/);
});

// A duplicate month never arises from the live enumeration path (enumerateMonths
// walks strictly forward), but the generator's self-validate step must still
// reject one if the row set were ever hand-assembled with a duplicate —
// exercising the SAME validateSeed the generator calls before ever touching disk.
test("self-validation rejects a duplicated month in a hand-assembled row set", () => {
  const rows: EdgarSeedRow[] = [
    { date: "2020-01-31", indicator: "MNA", value: 11 },
    { date: "2020-01-31", indicator: "MNA", value: 11 },
    { date: "2020-02-29", indicator: "MNA", value: 12 },
  ];
  const manifest = buildManifest(rows, { asOf: "2020-03-01" });
  expect(() => validateSeed(rows, manifest)).toThrow(/not strictly ascending/);
});

// ── atomic filesystem replacement ────────────────────────────────────────────

function makeGenerated(rows: EdgarSeedRow[], asOf: string): GeneratedSeed {
  const manifest = buildManifest(rows, { asOf });
  const { gzipSync } = require("node:zlib") as typeof import("node:zlib");
  const { canonicalCsv } = require("../src/analytics/extract/edgar-seed.ts") as typeof import("../src/analytics/extract/edgar-seed.ts");
  return { rows, manifest, gz: gzipSync(Buffer.from(canonicalCsv(rows), "utf8")) };
}

test("replaceSeedArtifactAtomically swaps in a new valid pair", () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-edgar-atomic-"));
  try {
    const gzPath = join(dir, "seed.csv.gz");
    const manifestPath = join(dir, "seed.manifest.json");
    const v1 = makeGenerated([{ date: "2020-01-31", indicator: "MNA", value: 1 }], "2020-02-01");
    replaceSeedArtifactAtomically(gzPath, manifestPath, v1);
    const v2 = makeGenerated(
      [
        { date: "2020-01-31", indicator: "MNA", value: 1 },
        { date: "2020-02-29", indicator: "MNA", value: 2 },
      ],
      "2020-03-01",
    );
    replaceSeedArtifactAtomically(gzPath, manifestPath, v2);
    const manifestOnDisk = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifestOnDisk.rowCount).toBe(2);
    expect(manifestOnDisk.checksum).toBe(v2.manifest.checksum);
    // No leftover temp files.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaceSeedArtifactAtomically leaves the prior valid pair COMPLETELY untouched when the new pair fails validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-edgar-atomic-"));
  try {
    const gzPath = join(dir, "seed.csv.gz");
    const manifestPath = join(dir, "seed.manifest.json");
    const v1 = makeGenerated([{ date: "2020-01-31", indicator: "MNA", value: 1 }], "2020-02-01");
    replaceSeedArtifactAtomically(gzPath, manifestPath, v1);
    const gzBefore = readFileSync(gzPath);
    const manifestBefore = readFileSync(manifestPath, "utf8");

    // A "generated" pair whose manifest checksum is tampered — fails the
    // round-trip re-validate INSIDE replaceSeedArtifactAtomically.
    const broken = makeGenerated([{ date: "2020-01-31", indicator: "MNA", value: 1 }], "2020-02-01");
    broken.manifest = { ...broken.manifest, checksum: "0".repeat(64) };

    expect(() => replaceSeedArtifactAtomically(gzPath, manifestPath, broken)).toThrow(/checksum mismatch/);

    // The ORIGINAL pair is byte-for-byte unchanged.
    expect(readFileSync(gzPath).equals(gzBefore)).toBe(true);
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
    // No leftover temp files (cleaned up even on failure).
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
