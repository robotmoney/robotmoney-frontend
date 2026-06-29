import { sql } from "../../db/client.ts";
import { computeRegimeHistory, type RegimeSnapshot } from "../../lib/regime.ts";

export async function writeRegimeHistory(asof: string, historyDays = 120): Promise<number> {
  const snapshots = computeRegimeHistory(asof, historyDays);
  for (const s of snapshots) await upsert(s);
  return snapshots.length;
}

async function upsert(s: RegimeSnapshot): Promise<void> {
  await sql`
    INSERT INTO regime_snapshots
      (date, composite, composite_percentile, regime, macro_regime, onchain_regime, factor_regime, percentiles, indicators)
    VALUES
      (${s.date}, ${s.composite}, ${s.compositePercentile}, ${s.regime},
       ${s.macroRegime}, ${s.onchainRegime}, ${s.factorRegime},
       ${sql.json(s.percentiles)}, ${sql.json(s.indicators)})
    ON CONFLICT (date) DO UPDATE SET
      composite = EXCLUDED.composite,
      composite_percentile = EXCLUDED.composite_percentile,
      regime = EXCLUDED.regime,
      macro_regime = EXCLUDED.macro_regime,
      onchain_regime = EXCLUDED.onchain_regime,
      factor_regime = EXCLUDED.factor_regime,
      percentiles = EXCLUDED.percentiles,
      indicators = EXCLUDED.indicators
  `;
}

// Job handler: classify and persist the regime as of today (backfills history on
// first run; idempotent upsert on date).
export async function regimeClassify(payload: Record<string, unknown>): Promise<unknown> {
  const asof = (payload.asof as string) ?? new Date().toISOString().slice(0, 10);
  const historyDays = (payload.historyDays as number) ?? 120;
  const n = await writeRegimeHistory(asof, historyDays);
  return { asof, snapshotsWritten: n };
}
