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
import { generateFredBackfill, resolveFirstRelease, UNRECOVERABLE_PRESERVE_IDS } from "../src/analytics/extract/floor-seed-generator.ts";
import { firstReleaseValues, parseAlfredCsv } from "../src/analytics/extract/fred.ts";
import { applyRawFloorSeed } from "../src/analytics/store/floor-seed.ts";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

// The BAA10Y backfill test ingests into a database of its own.
useCleanDatabase(import.meta.file);

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

// ── Issue 1653: BAA10Y, a collected series, backfilled from 1986 ─────────────

test("issue 1653: the committed floor seed holds BAA10Y rows from 1986-01-02", async () => {
  const floor = await loadRawFloorSeed(DEFAULT_FLOOR_SEED_PATH);
  const rows = floor.BAA10Y ?? [];
  expect(rows[0]).toEqual({ date: "1986-01-02", value: 2.34 });
  expect(rows.filter((p) => p.date < "2010-01-01").length).toBeGreaterThan(5000);
});

// The sha256 of every non-BAA10Y line of the committed floor seed on origin/main
// before issue 1653 (unchanged since issue 616). The BAA10Y backfill adds lines
// only, so every other series' rows are byte-identical, in their order.
const PRE_1653_OTHER_ROWS_SHA256 = "c9c0b12fa3c3bcc8f016292de362ed186f72608f414cffb1c957b15fa4c21fd6";

test("issue 1653: every row of every series other than BAA10Y is byte-identical to the floor seed before the backfill", () => {
  const text = gunzipSync(readFileSync(DEFAULT_FLOOR_SEED_PATH)).toString("utf8");
  const others = text.split("\n").filter((l) => l.split(",")[1] !== "BAA10Y").join("\n");
  expect(createHash("sha256").update(others).digest("hex")).toBe(PRE_1653_OTHER_ROWS_SHA256);
  expect(text.includes(",BAA10Y,")).toBe(true);
});

test("issue 1653: a default purge keeps BAA10Y's pre-2010 rows and every HY_OAS row before the live FRED window", async () => {
  expect(UNRECOVERABLE_PRESERVE_IDS).toContain("BAA10Y");
  expect(UNRECOVERABLE_PRESERVE_IDS).toContain("HY_OAS");
  const seedPath = writeSeed([
    "1986-01-02,BAA10Y,2.34", // Thursday, before the daily fetch's 2010 start
    "2009-12-31,BAA10Y,2.95",
    "2021-06-01,HY_OAS,3.10", // before FRED's trailing 3-year window
    "2023-08-10,HY_OAS,4.10",
  ]);
  try {
    const purged = await generateFullUniversePurge({
      fetchAll: async () => ({ BAA10Y: [{ date: "2010-01-04", value: 2.80 }], HY_OAS: [{ date: "2023-11-20", value: 3.70 }] }),
      seedPath,
      indicatorIds: ["BAA10Y", "HY_OAS"],
    });
    expect(purged.merged.BAA10Y).toEqual([
      { date: "1986-01-02", value: 2.34 },
      { date: "2009-12-31", value: 2.95 },
      { date: "2010-01-04", value: 2.80 },
    ]);
    expect(purged.merged.HY_OAS).toEqual([
      { date: "2021-06-01", value: 3.10 },
      { date: "2023-08-10", value: 4.10 },
      { date: "2023-11-20", value: 3.70 },
    ]);
  } finally {
    rmSync(join(seedPath, ".."), { recursive: true, force: true });
  }
});

// Two ALFRED vintages side by side, as alfredgraph.csv serves them: 2020-05-26
// was first released at 3.14 and later revised to 3.12; 2020-05-27 first
// appears in the second vintage. 2014-01-24 predates every vintage's window here.
const ALFRED_TWO_VINTAGES = [
  "observation_date,BAA10Y_20200527,BAA10Y_20200601",
  "2020-05-26,3.14,3.12",
  "2020-05-27,,3.10",
  "",
].join("\n");

test("issue 1653: parseAlfredCsv reads each vintage column, and firstReleaseValues keeps each date's earliest value", () => {
  const vintages = parseAlfredCsv(ALFRED_TWO_VINTAGES, "BAA10Y");
  expect(vintages).toEqual([
    { vintage: "2020-05-27", points: [{ date: "2020-05-26", value: 3.14 }] },
    { vintage: "2020-06-01", points: [{ date: "2020-05-26", value: 3.12 }, { date: "2020-05-27", value: 3.10 }] },
  ]);
  // Order of the columns does not matter: the earliest vintage wins.
  expect(firstReleaseValues([...vintages].reverse())).toEqual([
    { date: "2020-05-26", value: 3.14 },
    { date: "2020-05-27", value: 3.10 },
  ]);
  expect(() => parseAlfredCsv("<html>maintenance</html>", "BAA10Y")).toThrow(/not CSV/);
  expect(resolveFirstRelease([{ date: "2014-01-24", value: 2.35 }, { date: "2020-05-26", value: 3.12 }], [{ date: "2020-05-26", value: 3.14 }])).toEqual([
    { date: "2014-01-24", value: 2.35 },
    { date: "2020-05-26", value: 3.14 },
  ]);
});

test("issue 1653: the backfill stores first-release values, other rows byte-identical; ingested, every version is learned at the backfill time as a seed", async () => {
  const seedPath = writeSeed([
    "2014-01-24,T10Y2Y,2.30", // a value JS would print as 2.3: must stay byte for byte
    "2020-05-26,T10Y2Y,0.50",
    "2020-05-28,VIX,28.590000152587891",
  ]);
  try {
    const generated = await generateFredBackfill({
      indicatorId: "BAA10Y",
      fetchCurrent: async () => [
        { date: "2014-01-24", value: 2.35 }, // no ALFRED vintage holds it: FRED's current value
        { date: "2020-05-26", value: 3.12 }, // current (revised) value
        { date: "2020-05-27", value: 3.10 },
        { date: "2020-05-30", value: 3.0 }, // a Saturday: calendar-invalid, never stored
      ],
      fetchFirstRelease: async () => firstReleaseValues(parseAlfredCsv(ALFRED_TWO_VINTAGES, "BAA10Y")),
      maxDate: "2020-12-31",
      seedPath,
    });
    expect(generated.merged.BAA10Y).toEqual([
      { date: "2014-01-24", value: 2.35 },
      { date: "2020-05-26", value: 3.14 }, // the first release, not the revision
      { date: "2020-05-27", value: 3.10 },
    ]);
    const text = gunzipSync(generated.gz).toString("utf8");
    expect(text).toBe([
      "date,indicator,value",
      "2014-01-24,T10Y2Y,2.30",
      "2014-01-24,BAA10Y,2.35",
      "2020-05-26,T10Y2Y,0.50",
      "2020-05-26,BAA10Y,3.14",
      "2020-05-27,BAA10Y,3.1",
      "2020-05-28,VIX,28.590000152587891",
      "",
    ].join("\n"));

    // Ingest through the existing seed ingestion, as prod and stage receive it.
    replaceFloorSeedAtomically(seedPath, generated);
    const seed = await loadRawFloorSeed(seedPath);
    const [{ t: before }] = await sql<{ t: Date }[]>`SELECT clock_timestamp() AS t`;
    await applyRawFloorSeed({ BAA10Y: seed.BAA10Y! });
    const [{ t: after }] = await sql<{ t: Date }[]>`SELECT clock_timestamp() AS t`;
    const versions = await sql<{ market_date: string; value: number; knowledge_time: Date; provenance: string; provider: string; parser_version: string }[]>`
      SELECT v.market_date::text AS market_date, v.value, v.knowledge_time, v.provenance, a.provider, a.parser_version
      FROM source_value_versions v JOIN source_acquisitions a ON a.id = v.acquisition_id
      WHERE v.source_key = 'raw_indicator_history:BAA10Y' ORDER BY v.market_date`;
    expect(versions.map((v) => [v.market_date, v.value])).toEqual([["2014-01-24", 2.35], ["2020-05-26", 3.14], ["2020-05-27", 3.1]]);
    for (const v of versions) {
      // Learned at the backfill, never at a past time.
      expect(v.knowledge_time.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(v.knowledge_time.getTime()).toBeLessThanOrEqual(after.getTime());
      // The backfill mark: a seed acquisition, seed provenance.
      expect({ provenance: v.provenance, provider: v.provider, parser: v.parser_version }).toEqual({ provenance: "seed", provider: "seed", parser: "floor-seed:1" });
    }
  } finally {
    rmSync(join(seedPath, ".."), { recursive: true, force: true });
  }
});
