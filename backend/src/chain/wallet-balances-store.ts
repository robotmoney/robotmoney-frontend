// The wallet balances' persisted reads, run by the api (issue 1034, decision
// D75). GET /api/dashboards/wallet-balances serves fetchPersistedWalletBalances
// from here, with zero chain reads (issue #118). The pipeline worker's live
// sampler (chain/wallet-balances.ts fetchWalletBalances) reaches the other two
// reads over /api/pipeline/** (pipeline/ops.ts `wallet.last_persisted_holding`,
// `wallet.history_rows`): it holds no database credential.
import { resolveBaseRpcSource, resolvePriceSource, resolveTrackedAssets, SP500_SIZE_VERIFIED_AT } from "../config.ts";
import { sql } from "../db/client.ts";
import { on, registerQuery, type RegistryDb } from "../db/registry.ts";
import { QUARANTINED_PROVENANCE, type Provenance } from "./wallet-valuation.ts";
import { ASSET_PRICE_TIME_BASIS } from "../ops/asset-price-basis.ts";
import {
  historyFromRows,
  PRICE_VENDOR,
  type PersistedHolding,
  type WalletBalances,
  type WalletHistoryPoint,
  type WalletHistoryRow,
  type WalletHolding,
} from "./wallet-balances.ts";

const lastHolding = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["SELECT"],
  site: "src/chain/wallet-balances-store:lastPersistedHolding",
  purpose: "Read a symbol's newest non-quarantined sample, for the stale-degrade path of a failed live read.",
  callers: ["src/api/routes/pipeline"],
  probe: {
    statement: `SELECT amount, price_usd, value_usd FROM wallet_balance_samples
      WHERE symbol = $1 AND provenance <> $2 AND superseded_at IS NULL ORDER BY sample_date DESC LIMIT 1`,
    params: ["USDC", QUARANTINED_PROVENANCE],
  },
});

// The joined read below, as tests/db-registry-execution.test.ts runs it: the
// call site's own statement (that test holds the two to the same text), under
// both declarations it joins.
const HISTORY_PROBE = {
  statement: `SELECT wbs.sample_date, wbs.symbol, wbs.amount, wbs.value_usd, wbs.provenance,
           ap.price_usd AS asset_price_usd,
           (wbs.sample_date < (now() AT TIME ZONE 'UTC')::date) AS is_closed
      FROM wallet_balance_samples wbs
      LEFT JOIN asset_prices ap
        ON ap.symbol = wbs.symbol
       AND ap.price_date = wbs.sample_date
       AND ap.time_basis = $1
     WHERE wbs.superseded_at IS NULL
       AND wbs.sample_date NOT IN (
             SELECT sample_date FROM wallet_balance_samples
              WHERE provenance = $2
                AND superseded_at IS NULL
           )
     ORDER BY wbs.sample_date ASC, wbs.symbol ASC`,
  params: [ASSET_PRICE_TIME_BASIS, QUARANTINED_PROVENANCE],
};

const historySamples = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["SELECT"],
  site: "src/chain/wallet-balances-store:loadHistory.samples",
  purpose: "Read the wallet's daily sample history, excluding quarantined days, for the balances payload.",
  callers: ["src/api/routes/dashboards", "src/api/routes/pipeline"],
  probe: HISTORY_PROBE,
});

const historyPrices = registerQuery({
  role: "rm_app",
  object: "asset_prices",
  privileges: ["SELECT"],
  site: "src/chain/wallet-balances-store:loadHistory.prices",
  purpose: "Join each closed day's settled asset price onto the wallet history, which the history read LEFT JOINs.",
  callers: ["src/api/routes/dashboards", "src/api/routes/pipeline"],
  probe: HISTORY_PROBE,
});

const latestSamples = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["SELECT"],
  site: "src/chain/wallet-balances-store:fetchPersistedWalletBalances",
  purpose: "Read the last scheduled sample per symbol for the persisted, zero-RPC balances payload.",
  callers: ["src/api/routes/dashboards"],
  probe: {
    statement: `SELECT DISTINCT ON (symbol) symbol, amount, price_usd, value_usd, provenance, strategy_nav_idle_only, sampled_at
      FROM wallet_balance_samples WHERE provenance <> $1 AND superseded_at IS NULL
      ORDER BY symbol, sample_date DESC, sampled_at DESC`,
    params: [QUARANTINED_PROVENANCE],
  },
});

/** A symbol's newest non-quarantined sample (the pipeline read `wallet.last_persisted_holding`). */
export async function lastPersistedHolding(db: RegistryDb, symbol: string): Promise<PersistedHolding | null> {
  const rows = await on(db, lastHolding)<{ amount: string | null; price_usd: string | null; value_usd: string }>`
    SELECT amount, price_usd, value_usd
      FROM wallet_balance_samples
     WHERE symbol = ${symbol}
       AND provenance <> ${QUARANTINED_PROVENANCE}
       -- D55 (6): a row the repair pass superseded (migration 0104) is gone
       -- for every reader, as the delete it replaces left it.
       AND superseded_at IS NULL
     ORDER BY sample_date DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const amount = row.amount == null ? null : Number(row.amount);
  const valueUsd = Number(row.value_usd);
  // Issue #927: the live sampler no longer writes `price_usd`, so the most
  // recent row for a stale-degrade almost always has it NULL. `value_usd` is
  // still written (the same `amount * price` JS double the sampler computed),
  // so a row missing `price_usd` derives it back out rather than surfacing a
  // null price next to a perfectly good value.
  const priceUsd = row.price_usd != null
    ? Number(row.price_usd)
    : amount != null && amount !== 0
      ? valueUsd / amount
      : null;
  return { amount, priceUsd, valueUsd };
}

/**
 * The wallet's daily sample history with each closed day's settled price
 * joined (the pipeline read `wallet.history_rows`). A quarantined row (migration
 * 0036) drops its whole day; wallet-balances.ts historyFromRows sums the rest.
 */
export async function walletHistoryRows(db: RegistryDb): Promise<WalletHistoryRow[]> {
  return on(db, historySamples, historyPrices)<WalletHistoryRow>`
    SELECT wbs.sample_date, wbs.symbol, wbs.amount, wbs.value_usd, wbs.provenance,
           ap.price_usd AS asset_price_usd,
           (wbs.sample_date < (now() AT TIME ZONE 'UTC')::date) AS is_closed
      FROM wallet_balance_samples wbs
      LEFT JOIN asset_prices ap
        ON ap.symbol = wbs.symbol
       AND ap.price_date = wbs.sample_date
       AND ap.time_basis = ${ASSET_PRICE_TIME_BASIS}
     -- D55 (6): superseded rows (migration 0104) are filtered on both sides —
     -- a superseded point is not drawn, and a superseded quarantined row does
     -- not hide its day, exactly as the delete it replaces left the table.
     WHERE wbs.superseded_at IS NULL
       AND wbs.sample_date NOT IN (
             SELECT sample_date FROM wallet_balance_samples
              WHERE provenance = ${QUARANTINED_PROVENANCE}
                AND superseded_at IS NULL
           )
     ORDER BY wbs.sample_date ASC, wbs.symbol ASC
  `;;
}

// REQUEST-PATH reader (issue #118): serve the /api/dashboards/wallet-balances
// payload PURELY from persisted `wallet_balance_samples` — ZERO chain calls, ZERO
// price fetches. Chain reads happen ONLY on the backend schedule
// (worker/handlers/wallet.ts sampleWalletBalances → fetchWalletBalances above),
// so a client request never touches the rate-limited public RPC. The served
// provenance is EXACTLY the last scheduled sample per symbol (live/stub/stale/
// seed) — never relabelled, never fabricated. Payload shape is identical to
// fetchWalletBalances so the frontend + goldens are unchanged.
export async function fetchPersistedWalletBalances(db: RegistryDb = sql): Promise<WalletBalances> {
  // Top-level provenance markers stay config-resolved (no RPC) so hermetic mode
  // still reports 'stub' and the frontend walletNonLive() badge keeps working.
  // Fail-closed resolvers OUTSIDE any try: an invalid marker refuses loudly.
  const source = resolveBaseRpcSource();
  const priceSource = resolvePriceSource();
  const assets = resolveTrackedAssets();

  // Latest sample per symbol. The (sample_date, symbol) upsert keeps one row per
  // symbol per UTC day, so "newest sample_date wins" is the last scheduled read.
  const rows = await on(db, latestSamples)<
    { symbol: string; amount: string | null; price_usd: string | null; value_usd: string | null; provenance: string; strategy_nav_idle_only: boolean | null; sampled_at: Date }
  >`
    SELECT DISTINCT ON (symbol) symbol, amount, price_usd, value_usd, provenance, strategy_nav_idle_only, sampled_at
      FROM wallet_balance_samples
     WHERE provenance <> ${QUARANTINED_PROVENANCE}
       AND superseded_at IS NULL -- D55 (6), migration 0104
     ORDER BY symbol, sample_date DESC, sampled_at DESC
  `;
  const latest = new Map(rows.map((r) => [r.symbol, r]));

  // Iterate resolveTrackedAssets() (NOT the samples table) so ordering and the
  // chain/group/color/priceSource metadata the table doesn't store are preserved.
  const holdings: WalletHolding[] = assets.map((a) => {
    const row = latest.get(a.symbol);
    const base = {
      symbol: a.symbol,
      chain: "base" as const,
      group: a.group,
      color: a.color,
      priceSource: PRICE_VENDOR[a.priceKind] ?? a.priceKind,
      // issue #642 — this is the feed the HTTP route serves, so the
      // idle-USDC-only disclosure has to reach it too. It cannot be recomputed
      // here (zero RPC on the request path, issue #118), so it is echoed from
      // what the sampler recorded (migration 0032). NULL — a pre-0032 row, a
      // seeded row, a leg with no sample yet, or a non-strategy symbol — stays
      // ABSENT rather than becoming `false`: "not known" is not "positions
      // contributed".
      ...(row?.strategy_nav_idle_only == null ? {} : { strategyNavIdleOnly: row.strategy_nav_idle_only }),
      // issue #862: same disclosure as computeWalletBalances' valueAsset()
      // above, derived from config (never persisted) so the request path
      // needs no schema change and stays zero-RPC.
      ...(a.valuationKind === "config" ? { sizeVerifiedAt: SP500_SIZE_VERIFIED_AT } : {}),
    };
    if (!row) {
      // No scheduled sample yet for this symbol → honest 'stale' with null
      // values (never fabricate a number the schedule hasn't produced).
      return { ...base, amount: null, priceUsd: null, valueUsd: null, provenance: "stale" as Provenance };
    }
    const amount = row.amount == null ? null : Number(row.amount);
    const valueUsd = row.value_usd == null ? null : Number(row.value_usd);
    // Issue #927: the live sampler no longer writes price_usd, so the latest
    // sample for a symbol typically has it NULL from the moment it is
    // written. value_usd is still written (the same amount*price JS double
    // the sampler computed), so a row missing price_usd derives it back out —
    // this is the zero-RPC request path (issue #118), so there is no live
    // read to fall back to here, only this derivation.
    const priceUsd = row.price_usd != null
      ? Number(row.price_usd)
      : amount != null && valueUsd != null && amount !== 0
        ? valueUsd / amount
        : null;
    return {
      ...base,
      amount,
      priceUsd,
      valueUsd,
      provenance: row.provenance as Provenance, // exactly what the schedule persisted
    };
  });

  const totalUsd = holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
  const EMPTY_PROVENANCE: Record<Provenance, number> = { live: 0, stub: 0, stale: 0, seed: 0, backfilled: 0 };
  const { history, historyProvenance } = await walletHistoryRows(db)
    .then(historyFromRows)
    .catch(() => ({ history: [] as WalletHistoryPoint[], historyProvenance: EMPTY_PROVENANCE }));

  // asOf = freshest served sample's real timestamp (data age), or now() if empty.
  const asOfMs = rows.reduce((max, r) => {
    const t = (r.sampled_at instanceof Date ? r.sampled_at : new Date(r.sampled_at)).getTime();
    return t > max ? t : max;
  }, 0);
  const asOf = new Date(asOfMs > 0 ? asOfMs : Date.now()).toISOString();

  return { asOf, totalUsd, source, priceSource, holdings, history, historyProvenance };
}
