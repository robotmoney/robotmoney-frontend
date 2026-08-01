// Store stage (DB round-trip; ephemeral Postgres via preload.ts — loud-fails if
// Docker/Postgres is absent, never skips). The append-only persisted-real floor:
// save then read back equal, grouped by indicator; upsert on (date, indicator)
// overwrites rather than duplicating.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import {
  loadRawIndicatorHistory,
  saveRawIndicatorHistory,
  type RawIndicatorHistory,
} from "../src/analytics/store/raw-history-store.ts";

// Indicator ids unique to this test so we don't collide with seeded/suite rows.
const A = "TEST_RAW_A";
const B = "TEST_RAW_B";

async function cleanup() {
  await sql`DELETE FROM raw_indicator_history WHERE indicator IN (${A}, ${B})`;
}

test("saveRawIndicatorHistory → loadRawIndicatorHistory: round-trips, grouped and sorted", async () => {
  await cleanup();
  const input: RawIndicatorHistory = {
    [A]: [
      { date: "2020-01-01", value: 1.0234 },
      { date: "2020-01-02", value: 1.0456 },
      { date: "2020-01-03", value: 1.0678 },
    ],
    [B]: [
      { date: "2020-01-01", value: 0.0567 },
      { date: "2020-01-02", value: 0.0589 },
    ],
  };
  await saveRawIndicatorHistory(input);

  const back = await loadRawIndicatorHistory();
  expect(back[A]).toEqual(input[A]);
  expect(back[B]).toEqual(input[B]);
  // ascending by date within an indicator.
  expect(back[A].map((p) => p.date)).toEqual(["2020-01-01", "2020-01-02", "2020-01-03"]);

  await cleanup();
});

test("saveRawIndicatorHistory: upsert overwrites on (date, indicator) conflict, no duplicates", async () => {
  await cleanup();
  await saveRawIndicatorHistory({
    [A]: [
      { date: "2020-02-01", value: 10 },
      { date: "2020-02-02", value: 20 },
    ],
  });
  // Re-save with overlapping dates (new values) + a new date. The overlap must
  // overwrite (fetched wins), the new date appends, nothing duplicates.
  await saveRawIndicatorHistory({
    [A]: [
      { date: "2020-02-02", value: 99 }, // overwrite
      { date: "2020-02-03", value: 30 }, // append
    ],
  });

  const rows = await sql`
    SELECT date::text AS date, value FROM raw_indicator_history
    WHERE indicator = ${A} ORDER BY date`;
  expect(rows.length).toBe(3); // no duplicate row for 2020-02-02
  expect(rows.map((r: any) => [r.date, Number(r.value)])).toEqual([
    ["2020-02-01", 10],
    ["2020-02-02", 99],
    ["2020-02-03", 30],
  ]);

  await cleanup();
});

test("saveRawIndicatorHistory: tags rows with the provenance `source` (issue #397); defaults to 'live'", async () => {
  await cleanup();
  // Default (no third arg): 'live' — the production merge path's implicit tag.
  await saveRawIndicatorHistory({ [A]: [{ date: "2020-04-01", value: 1 }] });
  const [defaulted] = await sql`SELECT source FROM raw_indicator_history WHERE indicator = ${A} AND date = '2020-04-01'`;
  expect(defaulted.source).toBe("live");

  // Explicit source override.
  await saveRawIndicatorHistory({ [B]: [{ date: "2020-04-01", value: 2 }] }, undefined, "hermetic");
  const [tagged] = await sql`SELECT source FROM raw_indicator_history WHERE indicator = ${B} AND date = '2020-04-01'`;
  expect(tagged.source).toBe("hermetic");

  // A later write with a DIFFERENT source overwrites provenance too (not
  // sticky to the first-ever write) — matches "fetched wins on overlap".
  await saveRawIndicatorHistory({ [B]: [{ date: "2020-04-01", value: 3 }] }, undefined, "live");
  const [overwritten] = await sql`SELECT value, source FROM raw_indicator_history WHERE indicator = ${B} AND date = '2020-04-01'`;
  expect(Number(overwritten.value)).toBe(3);
  expect(overwritten.source).toBe("live");

  await cleanup();
});

test("saveRawIndicatorHistory: skips non-finite values and no-ops on empty input", async () => {
  await cleanup();
  await saveRawIndicatorHistory({}); // no-op, must not throw
  await saveRawIndicatorHistory({
    [A]: [
      { date: "2020-03-01", value: NaN },
      { date: "2020-03-02", value: Infinity },
      { date: "2020-03-03", value: 5 },
    ],
  });
  const back = await loadRawIndicatorHistory();
  expect(back[A]).toEqual([{ date: "2020-03-03", value: 5 }]);

  await cleanup();
});
