// Job-kind wiring for the retroactive asset_prices backfill (issue #927).
//
// backend/tests/asset-prices-backfill-clean-days.test.ts already proves the
// BACKFILL LOGIC (backfillAssetPricesForCleanDays) writes the right rows for
// a clean-day fixture, with injected deps so it never touches the network.
// That test calls the function directly, though — it says nothing about
// whether a real deployment's scheduler would ever actually run it. This
// file is the other half: the mechanism exists BEFORE this issue could not
// be discovered from `job_schedules`/`getHandler` at all (it was a function
// nothing called), which is the defect #927 fixes as much as the coverage
// gap itself — SELF-HEALING MEANS SCHEDULED, NOT MANUAL, same principle
// `ops.repair_gaps` already follows (worker/handlers/repair.ts).
import { expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { SCHEDULES } from "../src/db/seed.ts";
import { getHandler } from "../src/worker/handlers/index.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

test("ops.backfill_asset_prices is a seeded, enabled schedule with a registered handler", () => {
  const row = SCHEDULES.find((s) => s.kind === "ops.backfill_asset_prices");
  expect(row, "ops.backfill_asset_prices must be seeded in db/seed.ts::SCHEDULES — a handler with no schedule row never runs").toBeDefined();
  expect(row!.enabled).toBe(true);
  // Every 5/10/15/20/30/60-minute cadence is fine; what matters is that it is
  // NOT a one-shot (this file's whole point) and is at least as frequent as
  // hourly, so a fresh gap converges in minutes rather than days.
  expect(row!.cron).toMatch(/^\*\/(5|10|15|20|30) \* \* \* \*$/);

  const handler = getHandler("ops.backfill_asset_prices");
  expect(handler, "worker/handlers/index.ts must map ops.backfill_asset_prices to a handler").toBeDefined();
});

test("the registered ops.backfill_asset_prices handler runs the real backfill against Postgres", async () => {
  // No wallet_balance_samples fixture is seeded here — the point is to prove
  // the WIRING (the registered function really is
  // backfillAssetPricesForCleanDays, called with its real production
  // defaults), not to re-prove the write logic asset-prices-backfill-clean-days.test.ts
  // already covers with injected deps. A clean DB has no candidate days, so
  // this executes the real anti-join query against real Postgres and returns
  // without ever reaching the network-touching branch.
  await sql`DELETE FROM wallet_balance_samples`;
  await sql`DELETE FROM asset_prices`;

  const handler = getHandler("ops.backfill_asset_prices")!;
  const result = (await handler({})) as {
    daysProcessed: number;
    rowsWritten: number;
    rowsSkipped: number;
    errors: unknown[];
  };
  expect(result.daysProcessed).toBe(0);
  expect(result.rowsWritten).toBe(0);
  expect(result.errors).toEqual([]);
});
