// Store stage: persist regime snapshots to regime_snapshots, one row per date.
// Upserts on the date primary key so re-running a slot overwrites rather than
// duplicates. The only SQL write for the regime classifier.
import { sql } from "../../db/client.ts";
import type { RegimeSnapshot } from "../analyze/regime.ts";

export async function saveRegimeSnapshots(snapshots: RegimeSnapshot[]): Promise<void> {
  for (const s of snapshots) {
    await sql`
      INSERT INTO regime_snapshots
        (date, composite, composite_percentile, regime, macro_regime, onchain_regime, factor_regime, percentiles, indicators)
      VALUES (${s.date}, ${s.composite}, ${s.compositePercentile}, ${s.regime}, ${s.macroRegime}, ${s.onchainRegime}, ${s.factorRegime}, ${sql.json(s.percentiles)}, ${sql.json(s.indicators)})
      ON CONFLICT (date) DO UPDATE SET
        composite = EXCLUDED.composite, composite_percentile = EXCLUDED.composite_percentile,
        regime = EXCLUDED.regime, macro_regime = EXCLUDED.macro_regime, onchain_regime = EXCLUDED.onchain_regime,
        factor_regime = EXCLUDED.factor_regime, percentiles = EXCLUDED.percentiles, indicators = EXCLUDED.indicators`;
  }
}
