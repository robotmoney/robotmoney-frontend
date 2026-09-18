// D41 phase 4, repair-write-site slice (issue #851; markets §5.6, §8.1, §9) and
// live-sampler slice (issue #927).
//
// The fixture assertions in wallet-backfill.test.ts prove the BEHAVIOUR (a
// repaired row's price_usd comes back NULL). This file is the static
// complement the issue's test plan also asks for: a grep-backed check that
// the window executor's INSERT statements never name price_usd as a written
// column again, plus a PINNED inventory of every production-code site that
// still reads price_usd off wallet_balance_samples/wallet_sleeve_samples.
//
// WHY A PINNED INVENTORY, NOT A BLANKET "NOTHING READS IT" ASSERTION. That
// blanket claim is false today and is expected to stay false until the
// broader #849 coverage gap (§8.1) closes: the live sampler
// (worker/handlers/wallet.ts) still WRITES price_usd on every ordinary
// sample, and three #850 read sites plus one stale-degrade site still READ it
// as a fallback for exactly the cleanly-sampled closed days that never get a
// dual-written asset_prices row. Asserting zero reads would either be wrong
// the moment it was written, or would have to be satisfied by deleting a
// fallback this document explicitly says is still load-bearing — which is
// explicitly out of #851's scope (see markets §5.6's Cutover note on phase 4
// and §8.1's coverage-gap bullet). What #851 actually changes is narrower:
// the REPAIR write site no longer needs price_usd, because it always writes
// a fresh asset_prices row in the same transaction. This test pins today's
// known set of read/write sites so that set can only grow through a reviewed
// diff, never silently.
//
// Issue #927 closes the #849 coverage gap by making the live sampler dual-write
// to asset_prices and stop writing price_usd to wallet_balance_samples. After
// #927, the three #850 read sites no longer need the closed-day fallback;
// only today's row (is_closed = false) uses the sample's fused value_usd.
import { expect, test } from "bun:test";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..", "src");
const src = (rel: string): string => readFileSync(join(root, rel), "utf8");

// Vendored/generated trees carry nothing a hand-written read/write site could
// live in; skipping them just makes the walk faster.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// Matches an INSERT's column-list parenthetical, e.g.
// `(sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)`
// — used to check whether price_usd is named as a WRITTEN column, not merely
// present anywhere in the file (comments, disagreement-check reads, etc. are
// legitimate and checked separately below).
function insertColumnLists(source: string, table: string): string[] {
  const re = new RegExp(String.raw`INSERT INTO ${table}\s*\(([^)]*)\)`, "g");
  return [...source.matchAll(re)].map((m) => m[1]!);
}

test("repairResolvedDay's sample-row inserts no longer name price_usd as a written column", () => {
  const backfill = src("ops/wallet-backfill.ts");

  const balanceInserts = insertColumnLists(backfill, "wallet_balance_samples");
  const sleeveInserts = insertColumnLists(backfill, "wallet_sleeve_samples");

  // Sanity: the walk actually found the two live-write statements this test
  // is about, not zero (which would make every assertion below vacuous).
  expect(balanceInserts.length, "must find the wallet_balance_samples INSERT").toBeGreaterThan(0);
  expect(sleeveInserts.length, "must find the wallet_sleeve_samples INSERT").toBeGreaterThan(0);

  for (const cols of balanceInserts) {
    expect(cols.split(",").map((c) => c.trim())).not.toContain("price_usd");
    // value_usd stays: only price_usd is dropped, per #851's scope.
    expect(cols).toContain("value_usd");
  }
  for (const cols of sleeveInserts) {
    expect(cols.split(",").map((c) => c.trim())).not.toContain("price_usd");
    expect(cols).toContain("value_usd");
  }
});

test("sampleWalletBalances' sample-row insert no longer names price_usd as a written column", () => {
  const sampler = src("worker/handlers/wallet.ts");

  const balanceInserts = insertColumnLists(sampler, "wallet_balance_samples");

  // Sanity: the walk actually found the live-write statement this test
  // is about, not zero.
  expect(balanceInserts.length, "must find the wallet_balance_samples INSERT in sampleWalletBalances").toBeGreaterThan(0);

  for (const cols of balanceInserts) {
    expect(cols.split(",").map((c) => c.trim())).not.toContain("price_usd");
    // value_usd stays: only price_usd is dropped, per #927's scope.
    expect(cols).toContain("value_usd");
  }
});

test("sampleWalletSleeves' sample-row insert no longer names price_usd as a written column", () => {
  const sampler = src("worker/handlers/wallet.ts");

  const sleeveInserts = insertColumnLists(sampler, "wallet_sleeve_samples");

  expect(sleeveInserts.length, "must find the wallet_sleeve_samples INSERT in sampleWalletSleeves").toBeGreaterThan(0);

  for (const cols of sleeveInserts) {
    expect(cols.split(",").map((c) => c.trim())).not.toContain("price_usd");
    expect(cols).toContain("value_usd");
  }
});

test("the guard's column-list pattern actually matches an INSERT that DOES write price_usd", () => {
  // A guard that never fires on the shape it is meant to catch is a guard
  // that has silently stopped working (the same failure mode
  // append-only-no-new-deletes.test.ts guards against for its own pattern).
  const stillWriting = `
    await tx\`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES (\${date}, \${symbol}, \${amount}, \${price}, \${value}, 'backfilled', \${sampledAt})
    \`;
  `;
  const cols = insertColumnLists(stillWriting, "wallet_balance_samples");
  expect(cols.length).toBeGreaterThan(0);
  expect(cols[0]!.split(",").map((c) => c.trim())).toContain("price_usd");
});

// path (relative to backend/src) → why a production read of price_usd off
// wallet_balance_samples/wallet_sleeve_samples is correct there TODAY. Every
// entry here is documented in markets-asset-pricing-ingest.md §5.6/§8.1/§9.
// A file not in this list that references price_usd in the same statement as
// one of the two sample tables fails the test below — the point is that
// widening this set is a reviewed decision, not a silent side effect of an
// unrelated change.
const ALLOWED_READERS: Record<string, string> = {
  "chain/wallet-balances.ts":
    "lastPersistedHolding's stale-degrade fallback (a live read failed) reads the last persisted price_usd when present, deriving value_usd/amount instead for a post-#927 row that has it NULL; loadHistory reads the sample's fused value_usd for today's row (is_closed = false) and falls back to it for a closed day asset_prices has not covered yet, joining asset_prices for a covered closed day",
  "chain/wallet-sleeves.ts":
    "computeWalletSleeves reads the sample's price_usd when present, deriving value_usd/amount instead for a post-#927 row that has it NULL (both samplers now stop writing it, mirroring repairResolvedDay's already-shipped #851 change) for today's row (is_closed = false) and for a closed day asset_prices has not covered yet, joining asset_prices for a covered closed day",
  "chain/wallet-valuation.ts":
    "recentPersistedPrice reads the sample's price_usd when present, deriving value_usd/amount instead for a post-#927 row that has it NULL (else this stale-degrade path — issue #173 — would go permanently unreachable the moment a deployment picks up #927); joins asset_prices for a covered closed day",
  "ops/wallet-backfill.ts":
    "repairResolvedDay reads the PRIOR row's price_usd (before its own delete) purely for the sample-row-vs-price-row disagreement check (D41 phase 2's verify step); the evidence-table INSERT...SELECT also copies whatever price_usd a replaced row already had. Neither writes a fresh price_usd (see the test above)",
  "ops/asset-prices.ts":
    "mentions wallet_balance_samples only in prose comments (writeAssetPrice's own price_usd reads/writes are all against asset_prices, never a sample table); flagged by this test's file-level substring check rather than a real reference",
  "worker/handlers/wallet.ts":
    "neither sampler writes price_usd any more (issue #927 stopped both sampleWalletBalances and sampleWalletSleeves, mirroring repairResolvedDay); the string only survives in prose comments explaining that history — flagged by this test's file-level substring check rather than a real reference",
};

// Writers are tracked separately: db/seed.ts (the pre-launch history backfill)
// writes price_usd as an explicit NULL for every seeded row already, so it is
// not a live source of non-null price_usd. Neither live sampler
// (worker/handlers/wallet.ts::sampleWalletBalances / sampleWalletSleeves)
// writes price_usd at all after issue #927 — see ALLOWED_READERS above.
const ALLOWED_WRITERS: Record<string, string> = {
  "db/seed.ts":
    "the pre-launch prop-wallet history backfill; writes price_usd as an explicit NULL for every seeded row already, so it is not a live source of non-null price_usd",
};

const SAMPLE_TABLES = ["wallet_balance_samples", "wallet_sleeve_samples"];

function referencesPriceUsdOnSampleTable(source: string): boolean {
  if (!source.includes("price_usd")) return false;
  return SAMPLE_TABLES.some((t) => source.includes(t));
}

test("no undocumented production-code site references price_usd on a sample table", () => {
  const known = new Set([...Object.keys(ALLOWED_READERS), ...Object.keys(ALLOWED_WRITERS)]);
  const offenders: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  for (const file of walk(root)) {
    scanned++;
    const rel = relative(root, file).split("\\").join("/");
    if (!referencesPriceUsdOnSampleTable(readFileSync(file, "utf8"))) continue;
    seen.add(rel);
    if (!known.has(rel)) offenders.push(rel);
  }

  // An empty offender list only means something if the walk actually ran —
  // the silent-pass failure mode a misresolved root would produce.
  expect(scanned, "the walk must actually have read backend/src files").toBeGreaterThan(50);
  expect(
    offenders,
    "A new site references price_usd on wallet_balance_samples/wallet_sleeve_samples. " +
      "If it is a legitimate read (mirroring an existing #849/#850 fallback) or a legitimate " +
      "write (the live sampler/seed pattern), add it to ALLOWED_READERS/ALLOWED_WRITERS above " +
      "with a reason. If it is a NEW write of price_usd from the repair path, that is exactly " +
      "the regression #851 exists to prevent.",
  ).toEqual([]);

  // The inverse check: every entry in the pinned list must still be real,
  // so this allowlist cannot quietly outlive the code it describes.
  for (const file of known) {
    expect(seen.has(file), `${file} is pinned in ALLOWED_READERS/ALLOWED_WRITERS but no longer references price_usd on a sample table — remove it`).toBe(true);
  }
});
