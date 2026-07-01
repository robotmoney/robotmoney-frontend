// Access stage: the data seam for the REAL analytics orchestrator. Production
// default is `liveDataSource` — pure real keyless fetchers (FRED/Yahoo/DefiLlama/
// blockchain.com/Coinmetrics/GeckoTerminal/Shiller/EDGAR). There is NO synthetic
// substitution here: a failed/empty fetch returns [] and the orchestrator falls
// back to the persisted-real floor via mergeSeries (never to seeded data).
//
// Tests inject a fixture-backed source implementing the same interface for a
// deterministic, network-free round-trip (see tests/analytics-suite.test.ts).
import type { Point } from "../types.ts";
import type { Indicator } from "../analyze/indicators.ts";
import { fetchAll } from "../extract/sources.ts";
import { fetchYahoo } from "../extract/yahoo.ts";
import { fetchFred } from "../extract/fred.ts";
import { fetchEdgarS4Monthly } from "../extract/edgar.ts";
import type { ChannelInputs, LateCycleInputs } from "../analyze/research-signals.ts";
import { TOP7 } from "../analyze/research-signals.ts";

export type Logger = {
  log?: (m: string) => void;
  warn?: (m: string) => void;
  error?: (m: string) => void;
};

// Extra inputs the research signals need beyond the regime registry. STABLES is
// NOT here — it is a registry indicator, so the orchestrator sources it from the
// persisted raw floor (matching channel-divergence.js reading raw-indicator-history).
export interface ResearchInputs {
  btc: Point[];
  qqq: Point[];
  spy: Point[];
  rsp: Point[];
  top7: Point[][];
  mna: Point[];
  margin: Point[];
  conf: Point[];
}

// Chart-overlay extras the regime backtest + predictive correlations need beyond
// the regime registry: daily SPX (^GSPC) and ETH (ETH-USD) PRICE LEVELS and the
// DTB3 3-month T-bill yield. These are NOT registry indicators (the raw floor
// stores derived ratios like SPX_TREND=SMA50/SMA200, never price levels), so the
// orchestrator fetches them here — mirroring update.js fetchExtras.
export interface BacktestExtras {
  spx: Point[];
  eth: Point[];
  tbill3m: Point[];
}

export interface AnalyticsDataSource {
  // Registry indicator raw series (id → pre-transform {date,value}[]).
  fetchIndicators(indicators: Indicator[], logger?: Logger): Promise<Record<string, Point[]>>;
  // Research-only inputs (BTC/QQQ/SPY/RSP/top-7/MNA/MARGIN/CONF).
  fetchResearchInputs(asof: string, logger?: Logger): Promise<ResearchInputs>;
  // Backtest/correlations overlays (SPX/ETH price levels + DTB3 yield). A failed
  // fetch returns [] (logged) → that leg is simply excluded downstream.
  fetchBacktestExtras(logger?: Logger): Promise<BacktestExtras>;
}

const CHANNEL_START = "2018-01-01";
const LATECYCLE_START = "2010-01-01";
const EXTRAS_START = "2010-01-01"; // Yahoo returns inception for younger tickers
const unix = (iso: string) => Math.floor(new Date(iso + "T00:00:00Z").getTime() / 1000);

// Isolate one fetch: on any failure return [] (logged loudly). Never throws, so
// one bad source only drops its own series (orchestrator falls back to the floor).
async function safe(label: string, fn: () => Promise<Point[]>, logger: Logger): Promise<Point[]> {
  try {
    const pts = await fn();
    if (!pts.length) logger.warn?.(`[extract] ${label}: 0 rows (falling back to persisted floor if any)`);
    return pts;
  } catch (e: any) {
    logger.error?.(`[extract] ${label} FAILED: ${e?.message ?? e}`);
    return [];
  }
}

export const liveDataSource: AnalyticsDataSource = {
  fetchIndicators(indicators, logger = console) {
    return fetchAll({ logger, indicators });
  },

  async fetchResearchInputs(asof, logger = console): Promise<ResearchInputs> {
    // Channel + late-cycle share Yahoo tickers; fetch the union concurrently.
    const [btc, qqq, spy, rsp, ...top7] = await Promise.all([
      safe("BTC-USD", () => fetchYahoo("BTC-USD", unix(CHANNEL_START)), logger),
      safe("QQQ", () => fetchYahoo("QQQ", unix(CHANNEL_START)), logger),
      safe("SPY", () => fetchYahoo("SPY", unix(LATECYCLE_START)), logger),
      safe("RSP", () => fetchYahoo("RSP", unix(LATECYCLE_START)), logger),
      ...TOP7.map((sym) => safe(sym, () => fetchYahoo(sym, unix(LATECYCLE_START)), logger)),
    ]);
    const [mna, margin, conf] = await Promise.all([
      safe("EDGAR S-4", () => fetchEdgarS4Monthly(LATECYCLE_START, asof, 15000, logger), logger),
      safe("FRED BOGZ1FL663067003Q", () => fetchFred("BOGZ1FL663067003Q"), logger),
      safe("FRED UMCSENT", () => fetchFred("UMCSENT"), logger),
    ]);
    return { btc, qqq, spy, rsp, top7, mna, margin, conf };
  },

  async fetchBacktestExtras(logger = console): Promise<BacktestExtras> {
    const [spx, eth, tbill3m] = await Promise.all([
      safe("^GSPC", () => fetchYahoo("^GSPC", unix(EXTRAS_START)), logger),
      safe("ETH-USD", () => fetchYahoo("ETH-USD", unix(EXTRAS_START)), logger),
      safe("FRED DTB3", () => fetchFred("DTB3"), logger),
    ]);
    return { spx, eth, tbill3m };
  },
};
