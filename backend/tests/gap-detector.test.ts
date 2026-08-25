// The generic gap detector (issue #614 AC3). Must fail against pre-#614
// main: no such module exists at all, and the Motivation section verified
// "No generate_series, no LAG(date) OVER (...), no expected-vs-actual
// comparison anywhere in .ts or .sql."
//
// Classification fixtures run against a fresh TEMP table (created and
// populated inside ONE sql.begin transaction, so postgres.js's connection
// pool can never round-robin the CREATE TEMP TABLE and the query onto
// different backend connections) rather than any real registry table — every
// real table here (wallet_balance_samples, research_signals, ...) is written
// to by several OTHER test files sharing this ephemeral Postgres, so
// asserting an exact clean/gap/stale shape against one of them would be
// order-dependent. The separate "registry coverage" test below is
// deliberately read-only against the real tables instead.
import { expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { detectGaps, detectAllGaps } from "../src/ops/gap-detector.ts";
import { SERIES_REGISTRY, type SeriesDef } from "../src/ops/series-registry.ts";

const DAILY_DEF: SeriesDef = {
  key: "test_daily", label: "Test daily series", table: "gap_detector_test_daily",
  dateColumn: "d", cadence: "daily", seriesStart: "2026-01-01", remediationClass: "C",
};
const NOW_DAILY = new Date("2026-01-10T12:00:00Z"); // mid-day — must truncate to 2026-01-10T00:00:00Z

const HOURLY_DEF: SeriesDef = {
  key: "test_hourly", label: "Test hourly series", table: "gap_detector_test_hourly",
  dateColumn: "h", cadence: "hourly", seriesStart: "2026-01-01T00:00:00Z", remediationClass: "C",
};
const NOW_HOURLY = new Date("2026-01-01T05:30:00Z"); // truncates to 2026-01-01T05:00:00Z

test("gap-detector: a fully-populated daily series classifies clean — no interior gaps, no stale head", async () => {
  await sql.begin(async (tx) => {
    await tx`CREATE TEMP TABLE gap_detector_test_daily (d date) ON COMMIT DROP`;
    for (let day = 1; day <= 10; day++) {
      await tx`INSERT INTO gap_detector_test_daily (d) VALUES (${`2026-01-${String(day).padStart(2, "0")}`}::date)`;
    }
    const report = await detectGaps(DAILY_DEF, tx, NOW_DAILY);
    expect(report.interiorGaps).toEqual([]);
    expect(report.staleHead).toBe(false);
    expect(report.clean).toBe(true);
    expect(report.headDate).toBe("2026-01-10T00:00:00.000Z");
    expect(report.expectedHead).toBe("2026-01-10T00:00:00.000Z");
  });
});

test("gap-detector: a daily series missing one interior day reports exactly that day, head still current", async () => {
  await sql.begin(async (tx) => {
    await tx`CREATE TEMP TABLE gap_detector_test_daily (d date) ON COMMIT DROP`;
    for (let day = 1; day <= 10; day++) {
      if (day === 5) continue; // the hole
      await tx`INSERT INTO gap_detector_test_daily (d) VALUES (${`2026-01-${String(day).padStart(2, "0")}`}::date)`;
    }
    const report = await detectGaps(DAILY_DEF, tx, NOW_DAILY);
    expect(report.interiorGaps).toEqual(["2026-01-05T00:00:00.000Z"]);
    expect(report.interiorGapCount).toBe(1);
    expect(report.staleHead).toBe(false); // the head (Jan 10) is still current
    expect(report.clean).toBe(false);
  });
});

test("gap-detector: a slot with only some expected natural keys is a gap", async () => {
  const def: SeriesDef = {
    ...DAILY_DEF,
    expectedKeys: { columns: ["symbol"], resolve: () => [["A"], ["B"]] },
  };
  await sql.begin(async (tx) => {
    await tx`CREATE TEMP TABLE gap_detector_test_daily (d date, symbol text) ON COMMIT DROP`;
    for (let day = 1; day <= 10; day++) {
      const date = `2026-01-${String(day).padStart(2, "0")}`;
      await tx`INSERT INTO gap_detector_test_daily (d, symbol) VALUES (${date}::date, 'A')`;
      if (day !== 5) await tx`INSERT INTO gap_detector_test_daily (d, symbol) VALUES (${date}::date, 'B')`;
    }
    const report = await detectGaps(def, tx, NOW_DAILY);
    expect(report.interiorGaps).toEqual(["2026-01-05T00:00:00.000Z"]);
    expect(report.clean).toBe(false);
  });
});

test("gap-detector: completeness is evaluated per date and composite natural key", async () => {
  const def: SeriesDef = {
    ...DAILY_DEF,
    expectedKeys: {
      columns: ["wallet_address", "symbol"],
      resolve: () => [["0xaaa", "A"], ["0xbbb", "B"]],
    },
  };
  await sql.begin(async (tx) => {
    await tx`CREATE TEMP TABLE gap_detector_test_daily (d date, wallet_address text, symbol text) ON COMMIT DROP`;
    for (let day = 1; day <= 10; day++) {
      const date = `2026-01-${String(day).padStart(2, "0")}`;
      await tx`INSERT INTO gap_detector_test_daily VALUES (${date}::date, '0xaaa', 'A')`;
      if (day !== 5) await tx`INSERT INTO gap_detector_test_daily VALUES (${date}::date, '0xbbb', 'B')`;
    }
    const report = await detectGaps(def, tx, NOW_DAILY);
    expect(report.interiorGaps).toEqual(["2026-01-05T00:00:00.000Z"]);
  });
});

test("gap-detector: a daily series whose head stopped advancing days ago reports stale, not an interior gap", async () => {
  await sql.begin(async (tx) => {
    await tx`CREATE TEMP TABLE gap_detector_test_daily (d date) ON COMMIT DROP`;
    for (let day = 1; day <= 3; day++) {
      await tx`INSERT INTO gap_detector_test_daily (d) VALUES (${`2026-01-${String(day).padStart(2, "0")}`}::date)`;
    }
    // Nothing since Jan 3; `now` (NOW_DAILY) is Jan 10 — a wedged scheduler.
    const report = await detectGaps(DAILY_DEF, tx, NOW_DAILY);
    expect(report.interiorGaps).toEqual([]); // Jan 1-3 are fully present; nothing to call an interior gap
    expect(report.staleHead).toBe(true);
    expect(report.headDate).toBe("2026-01-03T00:00:00.000Z");
    expect(report.expectedHead).toBe("2026-01-10T00:00:00.000Z");
    expect(report.clean).toBe(false);
  });
});

test("gap-detector: an unstarted series (zero rows) reports stale, never throws on a null head", async () => {
  await sql.begin(async (tx) => {
    await tx`CREATE TEMP TABLE gap_detector_test_daily (d date) ON COMMIT DROP`;
    const report = await detectGaps(DAILY_DEF, tx, NOW_DAILY);
    expect(report.headDate).toBeNull();
    expect(report.staleHead).toBe(true);
    expect(report.clean).toBe(false);
  });
});

// Cadence-independence: the same classification logic over an HOURLY series,
// proving the detector is not a daily special case.
test("gap-detector: hourly cadence — an interior hour gap and a stale head classify correctly", async () => {
  await sql.begin(async (tx) => {
    await tx`CREATE TEMP TABLE gap_detector_test_hourly (h timestamptz) ON COMMIT DROP`;
    // 00:00, 01:00, 02:00 present; 03:00 MISSING; 04:00 present; nothing after
    // (05:00 expected per NOW_HOURLY truncating to 05:00 — a stale head too).
    for (const hour of [0, 1, 2, 4]) {
      await tx`INSERT INTO gap_detector_test_hourly (h) VALUES (${`2026-01-01T${String(hour).padStart(2, "0")}:00:00Z`}::timestamptz)`;
    }
    const report = await detectGaps(HOURLY_DEF, tx, NOW_HOURLY);
    expect(report.interiorGaps).toEqual(["2026-01-01T03:00:00.000Z"]);
    expect(report.headDate).toBe("2026-01-01T04:00:00.000Z");
    expect(report.expectedHead).toBe("2026-01-01T05:00:00.000Z");
    // 05:00 (expectedHead) - 04:00 (head) = 1 hour = 1 tick, within the
    // STALE_TICKS=2 slack budget — NOT stale yet.
    expect(report.staleHead).toBe(false);
    expect(report.clean).toBe(false); // still dirty via the interior gap
  });
});

// issue #614 AC3: "The detector covers wallet, sleeve, vault, projects-daily,
// research_signals and raw_indicator_history — not only the AUM series."
// Read-only against the REAL registry/tables (no fixture, no truncation —
// several other test files in this shared ephemeral Postgres also write to
// these tables) — proves every declared series actually detects without
// throwing and returns a well-formed report, and that the registry itself
// names every series this AC lists.
test("gap-detector: the registry covers every series named in AC3, and detectAllGaps runs clean over all of them", async () => {
  const keys = SERIES_REGISTRY.map((s) => s.key);
  for (const expected of [
    "wallet_balance_samples",
    "wallet_sleeve_samples",
    "vault_share_price_history",
    "vault_adapter_samples",
    "daily_coin_snapshots",
    "daily_agent_snapshots",
    "daily_wallet_snapshots",
    "daily_tvl_snapshots",
    "research_signals",
    "raw_indicator_history",
  ]) {
    expect(keys).toContain(expected);
  }

  const reports = await detectAllGaps();
  expect(reports.length).toBe(SERIES_REGISTRY.length);
  for (const r of reports) {
    expect(typeof r.key).toBe("string");
    expect(["daily", "hourly"]).toContain(r.cadence);
    expect(["A", "B", "C"]).toContain(r.remediationClass);
    expect(Array.isArray(r.interiorGaps)).toBe(true);
    expect(r.interiorGapCount).toBe(r.interiorGaps.length);
    expect(typeof r.staleHead).toBe("boolean");
    expect(typeof r.clean).toBe("boolean");
    expect(r.headDate === null || typeof r.headDate === "string").toBe(true);
  }
});
