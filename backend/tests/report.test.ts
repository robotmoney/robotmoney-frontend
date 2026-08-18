// Report stage (DB round-trip; ephemeral Postgres via preload.ts). Seed via the
// store, then assert the projection returns chronological history + correct latest,
// and that the HTTP adapter clamps the `range` param.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { saveRegimeSnapshots } from "../src/analytics/store/regime-store.ts";
import type { RegimeSnapshot } from "../src/analytics/analyze/regime.ts";
import { fetchRegimeSnapshots } from "../src/analytics/report/projections.ts";
import { getRegimeSnapshots } from "../src/api/routes/dashboards.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// Own database per TEST, cloned from the migrated template: these tests each
// start from an empty table, which used to mean wiping one the previous test
// filled. See support/clean-db.ts.
useCleanDatabasePerTest(import.meta.file);

function snap(date: string, composite: number): RegimeSnapshot {
  return {
    date, composite, compositePercentile: composite,
    regime: "neutral", macroRegime: "neutral", onchainRegime: "neutral", factorRegime: null,
    percentiles: {}, indicators: [],
  };
}

test("fetchRegimeSnapshots: chronological history + latest = most recent", async () => {
  // insert out of order to prove the projection sorts chronologically.
  await saveRegimeSnapshots([
    snap("1991-03-03", 0.3),
    snap("1991-03-01", 0.1),
    snap("1991-03-04", 0.4),
    snap("1991-03-02", 0.2),
  ]);

  const { latest, history } = await fetchRegimeSnapshots(180);
  expect(history.map((h) => h.date)).toEqual(["1991-03-01", "1991-03-02", "1991-03-03", "1991-03-04"]);
  expect(latest!.date).toBe("1991-03-04");
  expect(latest!.composite).toBeCloseTo(0.4, 9);
});

test("getRegimeSnapshots route clamps range to [1, 3650]", async () => {
  await saveRegimeSnapshots([
    snap("1991-03-01", 0.1),
    snap("1991-03-02", 0.2),
    snap("1991-03-03", 0.3),
    snap("1991-03-04", 0.4),
  ]);

  // range below the floor clamps to 1 → exactly the single latest row.
  const low = await getRegimeSnapshots(new URL("https://x/api?range=0"));
  expect(low.history.length).toBe(1);
  expect(low.latest!.date).toBe("1991-03-04");

  const neg = await getRegimeSnapshots(new URL("https://x/api?range=-50"));
  expect(neg.history.length).toBe(1);

  // huge range clamps to 3650 (>= rows) → all rows, no error.
  const high = await getRegimeSnapshots(new URL("https://x/api?range=99999"));
  expect(high.history.length).toBe(4);
  expect(high.history.map((h) => h.date)).toEqual(["1991-03-01", "1991-03-02", "1991-03-03", "1991-03-04"]);
});
