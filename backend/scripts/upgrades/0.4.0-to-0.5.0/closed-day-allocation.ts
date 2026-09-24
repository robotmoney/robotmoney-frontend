// Historical rehearsal criterion #9: a closed-day
// allocation total must not move when the D41 read path switches. The
// smoke-twin boot applies 0046, which seeds `asset_prices` from the fused
// live/seed price rows; after migration BOTH sides of the switch are still
// computable in the twin:
//
//   old — the pre-migration read: the sample row's own fused `price_usd`
//         (wallet-valuation.ts falls back to `value_usd / amount` when
//         `price_usd` is NULL — issue #927's samplers no longer write it);
//   new — the post-migration read: `asset_prices.price_usd` joined on
//         (symbol, sample_date, 'utc-daily-close').
//
// The check compares the fund-level allocation total (Σ amount × price over
// `wallet_balance_samples`, live/seed provenance, symbol ≠ SP500) for the
// most recent closed day `asset_prices` covers, allowing one cent per symbol
// for rounding. A divergence means a bad `asset_prices` seed or a broken
// join — the one thing the structural FAIL/PASS checks in postflight cannot
// see.
//
// Runs inside the rehearsal window (G8) against the smoke-twin's own
// Postgres, SELECT-only, before teardown. It is deliberately NOT a production
// postflight check: production has its own manual baseline cross-check
// (runbook §7), and this comparison exists to grade the rehearsal.

import type postgres from "postgres";
import { createChecker, printVerdict } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";

export type Db = postgres.Sql<{}>;

/** Per-symbol rounding slack: one US cent, the "within rounding" the runbook
 *  criterion allows (the sampled `value_usd` and the seeded/dual-written
 *  `asset_prices.price_usd` are the same JS double in the common case, so a
 *  real mismatch is many orders of magnitude larger than this). */
const ROUNDING_SLACK_PER_SYMBOL = 0.01;

export async function runClosedDayAllocationCheck(db: Db, { record }: Checker): Promise<void> {
  // The most recent CLOSED day asset_prices covers AND that has fund-level
  // live/seed samples to compare — the day the join actually bites on.
  const [day] = (await db`
    SELECT max(ap.price_date) AS day
      FROM asset_prices ap
     WHERE ap.price_date < (now() AT TIME ZONE 'UTC')::date
       AND EXISTS (
         SELECT 1 FROM wallet_balance_samples wbs
          WHERE wbs.sample_date = ap.price_date
            AND wbs.provenance IN ('live', 'seed')
            AND wbs.amount IS NOT NULL AND wbs.amount > 0
       )
  `) as unknown as { day: Date | string | null }[];
  if (!day?.day) {
    record(
      "closed-day-allocation",
      "FAIL",
      "no closed-day asset_prices row with matching fund-level samples exists to compare",
      "Confirm the D41 read-path switch manually before teardown: pick a closed day the pre-migration baseline captured and compare its /allocation total on the twin with the fused price_usd value.",
    );
    return;
  }

  const rows = (await db`
    SELECT wbs.symbol AS symbol,
           wbs.amount AS amount,
           wbs.price_usd AS price_usd,
           wbs.value_usd AS value_usd,
           ap.price_usd AS asset_price_usd
      FROM wallet_balance_samples wbs
      JOIN asset_prices ap
        ON ap.symbol = wbs.symbol
       AND ap.price_date = wbs.sample_date
       AND ap.time_basis = 'utc-daily-close'
     WHERE wbs.sample_date = ${day.day}
       AND wbs.provenance IN ('live', 'seed')
       AND wbs.amount IS NOT NULL AND wbs.amount > 0
       AND wbs.symbol <> 'SP500'
     ORDER BY wbs.symbol
  `) as unknown as {
    symbol: string;
    amount: string;
    price_usd: string | null;
    value_usd: string | null;
    asset_price_usd: string | null;
  }[];

  let oldTotal = 0;
  let newTotal = 0;
  let compared = 0;
  const mismatches: string[] = [];
  for (const r of rows) {
    const amount = Number(r.amount);
    const oldPrice = r.price_usd != null
      ? Number(r.price_usd)
      : r.value_usd != null && amount !== 0
        ? Number(r.value_usd) / amount
        : null;
    const newPrice = r.asset_price_usd != null ? Number(r.asset_price_usd) : null;
    // A row without an asset_prices price reads through the application's
    // fused fallback (wallet-valuation.ts) — unchanged by the cutover, so it
    // cannot drift. Only rows the join actually switches are comparable.
    if (oldPrice == null || newPrice == null) continue;
    compared += 1;
    oldTotal += amount * oldPrice;
    newTotal += amount * newPrice;
    if (Math.abs(amount * newPrice - amount * oldPrice) > ROUNDING_SLACK_PER_SYMBOL) {
      mismatches.push(`${r.symbol}: new ${(amount * newPrice).toFixed(6)} vs fused ${(amount * oldPrice).toFixed(6)}`);
    }
  }

  if (compared === 0) {
    record(
      "closed-day-allocation",
      "FAIL",
      `no comparable rows on ${String(day.day)} — every live/seed fund-level row falls back to the fused price, so the join switch was not exercised`,
      "Confirm the D41 read-path switch manually before teardown with a day the pre-migration baseline captured.",
    );
    return;
  }

  const slack = compared * ROUNDING_SLACK_PER_SYMBOL + 1e-9 * Math.max(Math.abs(oldTotal), 1);
  const pass = mismatches.length === 0 && Math.abs(newTotal - oldTotal) <= slack;
  record(
    "closed-day-allocation",
    pass ? "PASS" : "FAIL",
    [
      pass
        ? `${compared} live/seed symbol(s) on ${String(day.day)}: new join total ${newTotal.toFixed(6)} vs fused total ${oldTotal.toFixed(6)} — within rounding`
        : `${compared} live/seed symbol(s) on ${String(day.day)}: new join total ${newTotal.toFixed(6)} vs fused total ${oldTotal.toFixed(6)} — diverges beyond rounding`,
      ...mismatches,
    ],
    "A closed-day total moved when the D41 read switched — the asset_prices seed or the join is wrong. Investigate before deploying; do not explain a moved total away as rounding.",
  );
}

// Run directly (e.g. `bun closed-day-allocation.ts <DATABASE_URL>`) for a
// one-off against any database that has both columns.
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2] ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("usage: bun closed-day-allocation.ts <postgres://url>");
    process.exitCode = 2;
  } else {
    const { default: postgres } = await import("postgres");
    const db = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const checker = createChecker("[closed-day-allocation] ");
      await runClosedDayAllocationCheck(db, checker);
      process.exitCode = printVerdict(checker.results, {
        logPrefix: "[closed-day-allocation] ",
        okAll: "CLOSED-DAY ALLOCATION UNCHANGED",
        okWithWarnings: "CLOSED-DAY ALLOCATION UNCHANGED",
        blocked: "CLOSED-DAY ALLOCATION MOVED",
      });
    } finally {
      await db.end({ timeout: 5 });
    }
  }
}
