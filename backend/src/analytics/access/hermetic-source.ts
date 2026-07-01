// Hermetic (offline, deterministic) analytics data source for the DEMO / e2e path.
//
// The PRODUCTION default is `liveDataSource` (real keyless fetchers). The demo
// spec forbids the demo reaching out to FRED/Yahoo/DefiLlama/EDGAR/etc. — the
// seeded provider must supply deterministic data. So `bun run scripts/demo.ts`
// and the CI `e2e` job select THIS source (ANALYTICS_SOURCE=hermetic, or the demo
// e2e entry passes it explicitly): every series is a deterministic seeded walk
// (access/provider.ts `seededProvider`), so a full analytics run is completely
// network-free, deterministic, and fast. NEVER used on the prod path.
//
// Magnitudes are irrelevant — every series is percentile-ranked downstream, so
// `base` only anchors a level and `vol` supplies the variation the ranks need.
import type { AnalyticsDataSource, ResearchInputs, BacktestExtras, Logger } from "./data-source.ts";
import type { Point } from "../types.ts";
import type { Indicator } from "../analyze/indicators.ts";
import { seededProvider } from "./provider.ts";
import { TOP7 } from "../analyze/research-signals.ts";

const HERMETIC_ANCHOR = "2018-01-01"; // seededProvider's fixed epoch

// Days from the seeded anchor through `asof` (inclusive) — the lookback that makes
// seededProvider emit the full 2018-01-01..asof path the orchestrator's date axis
// expects. Floored so short asofs still yield a rankable window.
function lookbackTo(asof: string): number {
  const [ay, am, ad] = HERMETIC_ANCHOR.split("-").map(Number);
  const [y, m, d] = asof.split("-").map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ay, am - 1, ad)) / 86_400_000) + 1;
  return Math.max(days, 400);
}

function seeded(id: string, asof: string, base = 100, vol = 0.05, drift = 0): Point[] {
  return seededProvider.getSeries({ id, base, vol, drift }, asof, lookbackTo(asof));
}

const today = () => new Date().toISOString().slice(0, 10);

export const hermeticDataSource: AnalyticsDataSource = {
  // Registry indicators: one deterministic seeded series per id. fetchIndicators
  // carries no `asof`, so we anchor at today (the demo always runs for today).
  async fetchIndicators(indicators: Indicator[], logger: Logger = console) {
    logger.warn?.(
      "[analytics] HERMETIC data source — deterministic seeded series, NO network " +
        "(demo/e2e path; prod uses liveDataSource)",
    );
    const asof = today();
    const out: Record<string, Point[]> = {};
    for (const ind of indicators) out[ind.id] = seeded(ind.id, asof);
    return out;
  },

  // Research-only inputs (BTC/QQQ/SPY/RSP/top-7/MNA/MARGIN/CONF). Per-series
  // base/vol picked so the gauges land in a believable range for the demo UI.
  async fetchResearchInputs(asof: string, logger: Logger = console): Promise<ResearchInputs> {
    logger.warn?.("[analytics] HERMETIC research inputs — deterministic seeded series, NO network");
    return {
      btc: seeded("BTC-USD", asof, 60_000, 0.04, 0.0003),
      qqq: seeded("QQQ", asof, 480, 0.02, 0.0004),
      spy: seeded("SPY", asof, 540, 0.015, 0.0004),
      rsp: seeded("RSP", asof, 170, 0.015, 0.0002),
      top7: TOP7.map((sym, i) => seeded(`TOP7_${sym}`, asof, 150 + i * 25, 0.03, 0.0006)),
      mna: seeded("MNA_S4", asof, 40, 0.08),
      margin: seeded("MARGIN_DEBT", asof, 900_000, 0.02, 0.0005),
      conf: seeded("UMCSENT", asof, 75, 0.02),
    };
  },

  // Backtest/correlations overlays: deterministic seeded price/yield walks anchored
  // at today (the demo always runs for today). Magnitudes are illustrative — the
  // demo only needs a coherent equity chart + correlations panel, never parity.
  async fetchBacktestExtras(logger: Logger = console): Promise<BacktestExtras> {
    logger.warn?.("[analytics] HERMETIC backtest extras — deterministic seeded series, NO network");
    const asof = today();
    return {
      spx: seeded("^GSPC", asof, 4500, 0.012, 0.0003),
      eth: seeded("ETH-USD", asof, 2500, 0.04, 0.0004),
      tbill3m: seeded("DTB3", asof, 4.5, 0.01),
    };
  },
};
