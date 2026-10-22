// The token page's market reading, written by the api for the pipeline worker
// (issue 1034, decision D75). worker/handlers/token-market.ts reads the prices
// and the pool and sends the reading; a leg that failed is sent as null with a
// null instant, and this upsert keeps that leg's last good value.
import { on, registerQuery, type RegistryDb } from "../../db/registry.ts";

const upsertTokenMarket = registerQuery({
  role: "rm_app",
  object: "token_market_samples",
  // UPDATE for ON CONFLICT DO UPDATE; SELECT because the conflict target, the
  // existing row and EXCLUDED are read.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/token-market:upsertTokenMarketSample",
  purpose: "Upsert the token page's market reading (prices and pool), keeping each failed leg's last good value.",
  callers: ["src/api/routes/pipeline"],
  probe: {
    statement: `INSERT INTO token_market_samples
        (token, price_usd, price_at, weth_usd, weth_at, liquidity_usd, volume_24h_usd, volume_30d_usd, pool_at, sampled_at)
      SELECT $1, $2::numeric, $3::timestamptz, $4::numeric, $5::timestamptz,
             $6::numeric, $7::numeric, $8::numeric, $9::timestamptz, now() WHERE false
      ON CONFLICT (token) DO UPDATE SET
        price_usd = CASE WHEN EXCLUDED.price_at IS NULL THEN token_market_samples.price_usd ELSE EXCLUDED.price_usd END,
        price_at = COALESCE(EXCLUDED.price_at, token_market_samples.price_at),
        weth_usd = CASE WHEN EXCLUDED.weth_at IS NULL THEN token_market_samples.weth_usd ELSE EXCLUDED.weth_usd END,
        weth_at = COALESCE(EXCLUDED.weth_at, token_market_samples.weth_at),
        liquidity_usd = CASE WHEN EXCLUDED.pool_at IS NULL THEN token_market_samples.liquidity_usd ELSE EXCLUDED.liquidity_usd END,
        volume_24h_usd = CASE WHEN EXCLUDED.pool_at IS NULL THEN token_market_samples.volume_24h_usd ELSE EXCLUDED.volume_24h_usd END,
        volume_30d_usd = CASE WHEN EXCLUDED.pool_at IS NULL THEN token_market_samples.volume_30d_usd ELSE EXCLUDED.volume_30d_usd END,
        pool_at = COALESCE(EXCLUDED.pool_at, token_market_samples.pool_at),
        sampled_at = EXCLUDED.sampled_at`,
    params: ["PROBE", 1, "2000-01-01T00:00:00Z", 1, "2000-01-01T00:00:00Z", 1, 1, 1, "2000-01-01T00:00:00Z"],
  },
});

/** One market reading. A leg whose instant is null failed this tick and keeps its last good value. */
export interface TokenMarketReading {
  token: string;
  priceUsd: number | null;
  priceAt: Date | null;
  wethUsd: number | null;
  wethAt: Date | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volume30dUsd: number | null;
  poolAt: Date | null;
}

/** Upsert the reading on `token`, keeping each failed leg's last good value. */
export async function upsertTokenMarketSample(db: RegistryDb, r: TokenMarketReading): Promise<void> {
  await on(db, upsertTokenMarket)`
    INSERT INTO token_market_samples
      (token, price_usd, price_at, weth_usd, weth_at, liquidity_usd, volume_24h_usd, volume_30d_usd, pool_at, sampled_at)
    VALUES
      (${r.token}, ${r.priceUsd}, ${r.priceAt}, ${r.wethUsd}, ${r.wethAt},
       ${r.liquidityUsd}, ${r.volume24hUsd}, ${r.volume30dUsd}, ${r.poolAt}, now())
    ON CONFLICT (token) DO UPDATE SET
      price_usd = CASE WHEN EXCLUDED.price_at IS NULL THEN token_market_samples.price_usd ELSE EXCLUDED.price_usd END,
      price_at = COALESCE(EXCLUDED.price_at, token_market_samples.price_at),
      weth_usd = CASE WHEN EXCLUDED.weth_at IS NULL THEN token_market_samples.weth_usd ELSE EXCLUDED.weth_usd END,
      weth_at = COALESCE(EXCLUDED.weth_at, token_market_samples.weth_at),
      liquidity_usd = CASE WHEN EXCLUDED.pool_at IS NULL THEN token_market_samples.liquidity_usd ELSE EXCLUDED.liquidity_usd END,
      volume_24h_usd = CASE WHEN EXCLUDED.pool_at IS NULL THEN token_market_samples.volume_24h_usd ELSE EXCLUDED.volume_24h_usd END,
      volume_30d_usd = CASE WHEN EXCLUDED.pool_at IS NULL THEN token_market_samples.volume_30d_usd ELSE EXCLUDED.volume_30d_usd END,
      pool_at = COALESCE(EXCLUDED.pool_at, token_market_samples.pool_at),
      sampled_at = EXCLUDED.sampled_at
  `;
}
