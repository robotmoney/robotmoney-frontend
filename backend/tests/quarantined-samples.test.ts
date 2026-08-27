// T0.2 — a quarantined sample is ABSENT from every response, and still present
// in the table.
//
// docs/code-review/20260823-review-data-integrity-aum-correctness.md
//
// Migration 0036 moves every row the pre-de5cf06 backfill wrote to
// provenance='backfilled-quarantined', because that writer asked GeckoTerminal
// for a POOL without naming the TOKEN it meant and may therefore have priced a
// holding as a different asset entirely (WETH at ~60,000 USD — cbBTC's price).
//
// The migration is only half the fix. Renaming a provenance changes nothing on
// its own: what makes the row harmless is that no read serves it. These tests
// assert the serving half, which is the half a future refactor can silently
// undo.
//
// WHY THE DATES ARE ABSURD. This file shares one ephemeral Postgres with ~150
// others that write real dates into these tables. 1999 and 2099 belong to no
// other fixture, so the assertions here are order-independent, and afterEach
// removes exactly the rows this file wrote.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../src/db/client.ts";
import { QUARANTINED_PROVENANCE } from "../src/chain/wallet-valuation.ts";
import { getWalletBalances } from "../src/api/routes/dashboards.ts";
import { detectGaps } from "../src/ops/gap-detector.ts";
import { getSeriesDef } from "../src/ops/series-registry.ts";

const PAST = "1999-04-01"; // a day this file owns, in history
const FUTURE = "2099-04-01"; // sorts after every real row, so DISTINCT ON picks it
const OURS = [PAST, FUTURE];

// A quarantined WETH row at the price the broken path actually wrote on the
// 2026-08-23 smoke-twin, against the amount it held. If any of these numbers reaches
// a response, the response is wrong by ~25x.
const BAD_PRICE = 59_988.42;
const AMOUNT = 15.4378;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM wallet_balance_samples WHERE sample_date = ANY(${OURS}::date[])`;
  await sql`DELETE FROM wallet_sleeve_samples WHERE sample_date = ANY(${OURS}::date[])`;
}

beforeEach(cleanup);
afterEach(cleanup);

test("T0.2: a quarantined day is absent from the served history", async () => {
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${PAST}, 'WETH', ${AMOUNT}, ${BAD_PRICE}, ${AMOUNT * BAD_PRICE}, ${QUARANTINED_PROVENANCE}, ${`${PAST}T23:59:00Z`})
  `;

  const { history } = await getWalletBalances();
  expect(history.some((p) => p.date === PAST)).toBe(false);
});

test("T0.2: a day is dropped WHOLE — a partial total is a wrong number, not a smaller one", async () => {
  // The mixed day the (sample_date, symbol) key permits: one leg quarantined,
  // one leg trustworthy. Serving the day with only the good leg would publish
  // an AUM total that silently omits a holding — plausible, undisclosed, and
  // wrong. Absence is the only honest answer.
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES
      (${PAST}, 'WETH', ${AMOUNT}, ${BAD_PRICE}, ${AMOUNT * BAD_PRICE}, ${QUARANTINED_PROVENANCE}, ${`${PAST}T23:59:00Z`}),
      (${PAST}, 'USDC', 1000, 1, 1000, 'live', ${`${PAST}T23:59:00Z`})
  `;

  const { history } = await getWalletBalances();
  const point = history.find((p) => p.date === PAST);
  expect(point).toBeUndefined();
});

test("T0.2: a quarantined row is not served as a current holding, even when it is the newest row for its symbol", async () => {
  // Dated past every real sample, so `DISTINCT ON (symbol) … ORDER BY symbol,
  // sample_date DESC` would pick it if the predicate were missing. This is the
  // read that decides what the allocation surface shows RIGHT NOW.
  // The symbol comes from the resolved tracked set, not a literal: this suite's
  // configuration does not necessarily track WETH, and a hard-coded symbol that
  // is absent turns the whole test into a silent no-op — which is how
  // §3.1's fixture-constant price came to make a pricing error unreachable.
  const { holdings: before } = await getWalletBalances();
  const target = before[0];
  expect(target).toBeDefined();
  const symbol = target!.symbol;

  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${FUTURE}, ${symbol}, ${AMOUNT}, ${BAD_PRICE}, ${AMOUNT * BAD_PRICE}, ${QUARANTINED_PROVENANCE}, ${`${FUTURE}T23:59:00Z`})
  `;

  const { holdings: after } = await getWalletBalances();
  const served = after.find((h) => h.symbol === symbol);
  expect(served?.priceUsd).not.toBe(BAD_PRICE);
  expect(served).toEqual(target!); // unchanged: the quarantined row contributed nothing
});

test("T0.2: the wrong numbers are still in the table — quarantine preserves the evidence", async () => {
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${PAST}, 'WETH', ${AMOUNT}, ${BAD_PRICE}, ${AMOUNT * BAD_PRICE}, ${QUARANTINED_PROVENANCE}, ${`${PAST}T23:59:00Z`})
  `;

  // T5.1 adjudicates each quarantined row against a freshly fetched
  // token-addressed price for its day. It cannot do that if the migration threw
  // the number away, which is why 0036 is an UPDATE and not a DELETE.
  const rows = await sql<{ price_usd: string; provenance: string }[]>`
    SELECT price_usd, provenance FROM wallet_balance_samples WHERE sample_date = ${PAST} AND symbol = 'WETH'
  `;
  expect(rows.length).toBe(1);
  expect(Number(rows[0]!.price_usd)).toBe(BAD_PRICE);
  expect(rows[0]!.provenance).toBe(QUARANTINED_PROVENANCE);
});

test("T0.2: a quarantined day reads as a GAP, so the operator surface and the API agree", async () => {
  // markets §4.1's unification point: there must be exactly one notion of "which days
  // are missing". If the detector counted a row the API refuses to serve, the
  // dashboard would show a hole the gap report calls covered — and the repair
  // would never be told to look at it.
  const def = getSeriesDef("wallet_balance_samples")!;
  await sql.begin(async (tx) => {
    await tx`CREATE TEMP TABLE wallet_balance_samples (sample_date date, symbol text, provenance text) ON COMMIT DROP`;
    const expectedSymbols = def.expectedKeys!.resolve().map(([symbol]) => symbol!);
    for (const date of ["2026-03-18", "2026-03-19", "2026-03-21"]) {
      for (const symbol of expectedSymbols) {
        await tx`INSERT INTO wallet_balance_samples VALUES (${date}::date, ${symbol}, 'seed')`;
      }
    }
    await tx`INSERT INTO wallet_balance_samples VALUES ('2026-03-20'::date, ${expectedSymbols[0]}, ${QUARANTINED_PROVENANCE})`;
    const report = await detectGaps(def, tx, new Date("2026-03-21T12:00:00Z"));
    expect(report.interiorGaps).toEqual(["2026-03-20T00:00:00.000Z"]);
    expect(report.clean).toBe(false);
  });
});

test("T0.2: every read of the sample tables excludes quarantined rows, or says why it does not", async () => {
  // The contract test, in the shape T3.1 established for the OHLCV URL: the
  // defect this whole review is about survived because nothing asserted the
  // SHAPE of a request. A new reader added next month is exactly how a
  // quarantined row gets served again, and it will not be caught by any test
  // that only exercises today's call sites.
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) files.push(p);
    }
  };
  walk(srcDir);

  const offenders: string[] = [];
  for (const file of files) {
    if (file.endsWith("/db/seed.ts")) continue; // a writer, and the seed's own provenance
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/FROM wallet_(balance|sleeve)_samples/.test(line)) return;
      // The query's own text, plus the comment block immediately above it.
      const window = lines.slice(Math.max(0, i - 12), i + 14).join("\n");
      const excluded = window.includes("QUARANTINED_PROVENANCE");
      const declared = window.includes("counts-quarantined: DELIBERATE");
      if (!excluded && !declared) {
        offenders.push(`${file.slice(srcDir.length)}:${i + 1} — ${line.trim()}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});

test("T0.2/P0: quarantine and repairability migrations are applied to this database", async () => {
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM schema_migrations
     WHERE name IN ('0036_quarantine_backfilled_samples.sql', '0037_aum_repairable_quarantine.sql')
  `;
  expect(rows.map((row) => row.name).sort()).toEqual([
    "0036_quarantine_backfilled_samples.sql",
    "0037_aum_repairable_quarantine.sql",
  ]);
});
