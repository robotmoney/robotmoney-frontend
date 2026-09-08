// Price-side gap detection (D41 phase 5; issue #849;
// docs/technical/markets-asset-pricing-ingest.md §5.6). Expected days minus
// distinct persisted days, PER SYMBOL, bounded by a persisted first-priceable
// floor — a deliberately different, simpler shape than ops/gap-detector.ts's
// generic per-slot AND-across-keys detector (markets §5.6: "no manifest, no
// per-slot expected-key sets").
//
// RED CONTROL: ops/asset-prices.ts::detectAssetPriceGaps did not exist before
// #849 — this file fails to import against the pre-change tree.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { detectAssetPriceGaps } from "../src/ops/asset-prices.ts";
import type { TrackedAsset } from "../src/config.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const SYMBOL = "TESTASSET";
const FLOOR = "2018-02-10"; // the symbol's proven first-priceable day
const NOW = new Date("2018-02-15T09:00:00Z"); // lastClosedPriceDay = 2018-02-14

function testAsset(overrides: Partial<TrackedAsset> = {}): TrackedAsset {
  return {
    symbol: SYMBOL,
    group: "Protocol",
    color: "#f59e0b",
    valuationKind: "erc20",
    priceKind: "gecko",
    decimals: 18,
    address: "0xtest",
    poolId: null,
    deployedAt: "2018-01-01", // earlier than FLOOR — the floor must win, not this
    ...overrides,
  };
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM asset_prices WHERE symbol = ${SYMBOL}`;
  await sql`DELETE FROM asset_price_floors WHERE symbol = ${SYMBOL}`;
}

beforeEach(cleanup);
afterEach(cleanup);

async function insertPrice(date: string): Promise<void> {
  await sql`
    INSERT INTO asset_prices
      (price_date, symbol, time_basis, price_usd, currency, source, observed_at, fetched_at, config_identity)
    VALUES
      (${date}, ${SYMBOL}, 'utc-daily-close', 1, 'USD', 'geckoterminal', now(), now(), 'fixture')
  `;
}

test("gap detection never reports a day before the symbol's proven floor, even though deployedAt is earlier", async () => {
  await sql`
    INSERT INTO asset_price_floors (symbol, first_priceable_date, proven)
    VALUES (${SYMBOL}, ${FLOOR}, true)
  `;
  // Persist every day in [FLOOR, cutoff] except 2018-02-12 — the one real gap.
  for (const d of ["2018-02-10", "2018-02-11", "2018-02-13", "2018-02-14"]) await insertPrice(d);

  const [report] = await detectAssetPriceGaps([testAsset()], sql, NOW);
  expect(report!.floorDate).toBe(FLOOR);
  expect(report!.floorProven).toBe(true);
  expect(report!.missingDays).toEqual(["2018-02-12"]);
  expect(report!.expectedDays).toBe(5); // 02-10..02-14 inclusive
  expect(report!.persistedDays).toBe(4);
  // Nothing before the floor is ever reported, despite deployedAt = 2018-01-01.
  expect(report!.missingDays.every((d) => d >= FLOOR)).toBe(true);
});

test("with no persisted floor, gap detection falls back to the config deployedAt", async () => {
  const [report] = await detectAssetPriceGaps([testAsset({ deployedAt: "2018-02-13" })], sql, NOW);
  expect(report!.floorDate).toBe("2018-02-13");
  expect(report!.floorProven).toBe(false);
  expect(report!.missingDays).toEqual(["2018-02-13", "2018-02-14"]);
});

test("SP500 (priceKind 'yahoo') is never reported — it is not part of the price series", async () => {
  const reports = await detectAssetPriceGaps(
    [testAsset(), testAsset({ symbol: "SP500", priceKind: "yahoo", valuationKind: "config", address: null })],
    sql,
    NOW,
  );
  expect(reports.map((r) => r.symbol)).toEqual([SYMBOL]);
});

test("a fully dense symbol reports zero missing days", async () => {
  await sql`
    INSERT INTO asset_price_floors (symbol, first_priceable_date, proven)
    VALUES (${SYMBOL}, ${FLOOR}, true)
  `;
  for (const d of ["2018-02-10", "2018-02-11", "2018-02-12", "2018-02-13", "2018-02-14"]) await insertPrice(d);
  const [report] = await detectAssetPriceGaps([testAsset()], sql, NOW);
  expect(report!.missingDays).toEqual([]);
  expect(report!.persistedDays).toBe(report!.expectedDays);
});
