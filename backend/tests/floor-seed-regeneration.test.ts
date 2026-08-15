// Full-universe purge regeneration (issue #616 / D6): purge semantics,
// preserve-list calendar filtering, and a regression proving the pre-existing
// single-indicator additive path (issue #400) is unchanged. No network — every
// fetch is injected.
import { test, expect } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateFloorSeedArtifact,
  generateFullUniversePurge,
  replaceFloorSeedAtomically,
} from "../src/analytics/extract/floor-seed-generator.ts";
import { loadRawFloorSeed, DEFAULT_FLOOR_SEED_PATH } from "../src/analytics/extract/floor-seed.ts";

function writeSeed(csvLines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-floor-seed-purge-"));
  const path = join(dir, "seed.csv.gz");
  writeFileSync(path, gzipSync(Buffer.from(["date,indicator,value", ...csvLines, ""].join("\n"), "utf8")));
  return path;
}

test("purge mode discards ALL prior rows for a recoverable indicator — only fetched rows survive", async () => {
  const seedPath = writeSeed([
    "2020-01-06,T10Y2Y,1.11", // old fixture row (a Monday — calendar-valid but must still be discarded)
    "2020-01-07,T10Y2Y,1.22",
  ]);
  try {
    const purged = await generateFullUniversePurge({
      fetchAll: async () => ({ T10Y2Y: [{ date: "2026-08-10", value: 0.55 }] }), // fresh live row only
      seedPath,
      indicatorIds: ["T10Y2Y"],
      preserveIds: [], // T10Y2Y is fully recoverable — not on the preserve list
    });
    expect(purged.merged.T10Y2Y).toEqual([{ date: "2026-08-10", value: 0.55 }]);
    expect(purged.perIndicator.T10Y2Y).toEqual({ fetched: 1, preserved: 0, total: 1 });
  } finally {
    rmSync(join(seedPath, ".."), { recursive: true, force: true });
  }
});

test("purge mode preserves an unrecoverable indicator's calendar-valid pre-cutoff span, dropping weekend rows", async () => {
  const seedPath = writeSeed([
    "2023-08-10,HY_OAS,4.10", // Thursday, pre-cutoff — calendar-valid, must SURVIVE
    "2023-08-12,HY_OAS,4.20", // Saturday, pre-cutoff — calendar-INVALID, must be DROPPED
    "2023-08-13,HY_OAS,4.25", // Sunday, pre-cutoff — calendar-INVALID, must be DROPPED
  ]);
  try {
    const purged = await generateFullUniversePurge({
      // FRED's live trailing ~3y window starts 2023-08-15 (D7) — the fetch can
      // never return the pre-cutoff span itself.
      fetchAll: async () => ({ HY_OAS: [{ date: "2023-08-15", value: 4.30 }] }),
      seedPath,
      indicatorIds: ["HY_OAS"],
      preserveIds: ["HY_OAS"],
    });
    expect(purged.merged.HY_OAS).toEqual([
      { date: "2023-08-10", value: 4.10 },
      { date: "2023-08-15", value: 4.30 },
    ]);
    expect(purged.perIndicator.HY_OAS).toEqual({ fetched: 1, preserved: 1, total: 2 });
  } finally {
    rmSync(join(seedPath, ".."), { recursive: true, force: true });
  }
});

test("purge mode refuses to purge a recoverable indicator whose live fetch returned 0 rows", async () => {
  const seedPath = writeSeed(["2020-01-06,T10Y2Y,1.11"]);
  try {
    await expect(
      generateFullUniversePurge({
        fetchAll: async () => ({ T10Y2Y: [] }),
        seedPath,
        indicatorIds: ["T10Y2Y"],
        preserveIds: [],
      }),
    ).rejects.toThrow(/0 rows/);
  } finally {
    rmSync(join(seedPath, ".."), { recursive: true, force: true });
  }
});

// Regression (issue #400): the default single-indicator additive invocation
// (generateFloorSeedArtifact, no purge) still merges append-only —
// fetched-wins-on-overlap — against whatever is already committed at
// seedPath. Purge mode must not have disturbed this behavior.
test("default additive mode still merges append-only, fetched wins on overlap (regression #400)", async () => {
  const seedPath = writeSeed(["2020-01-01,BTC_MVRV,1.0", "2020-01-02,BTC_MVRV,2.0"]);
  try {
    const generated = await generateFloorSeedArtifact({
      indicatorId: "BTC_MVRV",
      fetch: async () => [
        { date: "2020-01-02", value: 99.0 }, // overlap — fetched wins
        { date: "2020-01-03", value: 3.0 },
      ],
      seedPath,
    });
    expect(generated.merged.BTC_MVRV).toEqual([
      { date: "2020-01-01", value: 1.0 },
      { date: "2020-01-02", value: 99.0 },
      { date: "2020-01-03", value: 3.0 },
    ]);
    expect(generated.addedPoints).toBe(1);
  } finally {
    rmSync(join(seedPath, ".."), { recursive: true, force: true });
  }
});

// Atomic-replace round-trip: write a purge-mode result via
// replaceFloorSeedAtomically, then read it back through the EXACT production
// parser.
test("replaceFloorSeedAtomically round-trips a purge-mode result through the production parser", async () => {
  const seedPath = writeSeed(["2020-01-01,AAA,1"]);
  try {
    const purged = await generateFullUniversePurge({
      fetchAll: async () => ({ AAA: [{ date: "2026-01-01", value: 42 }] }),
      seedPath,
      indicatorIds: ["AAA"],
      preserveIds: [],
    });
    replaceFloorSeedAtomically(seedPath, { gz: purged.gz });
    const reread = await loadRawFloorSeed(seedPath);
    expect(reread.AAA).toEqual([{ date: "2026-01-01", value: 42 }]);
  } finally {
    rmSync(join(seedPath, ".."), { recursive: true, force: true });
  }
});

// Committed-artifact preserved-span assertion (AC): the regenerated floor
// retains genuine pre-truncation HY_OAS history that FRED can no longer serve
// live (D7), even though the calendar guard elsewhere proves it has zero
// calendar-invalid rows.
test("committed floor seed retains HY_OAS rows dated before FRED's live truncation (2023-08-15)", async () => {
  const floor = await loadRawFloorSeed(DEFAULT_FLOOR_SEED_PATH);
  const preTruncation = (floor.HY_OAS ?? []).filter((p) => p.date < "2023-08-15");
  expect(preTruncation.length).toBeGreaterThan(0);
});
