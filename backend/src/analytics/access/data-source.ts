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
import { mergeSeries } from "../transform/math.ts";
import {
  refreshEdgarWithTierFallback,
  selectEdgarRefreshTier,
  defaultEdgarRefreshDeadlineMs,
  type EdgarRefreshOutcome,
} from "../edgar-incremental-refresh.ts";
import type { ChannelInputs, LateCycleInputs } from "../analyze/research-signals.ts";
import { TOP7 } from "../analyze/research-signals.ts";

export type Logger = {
  log?: (m: string) => void;
  warn?: (m: string) => void;
  error?: (m: string) => void;
};

// Issue #109: the orchestrator (the only place that knows the persisted raw
// floor) hands the live source its current MNA floor + one absolute hard
// deadline for the incremental EDGAR sweep. Hermetic/fixture sources ignore
// this entirely (structurally compatible — TS allows implementing a fewer-
// parameter function against a type that declares more).
export interface EdgarPlanContext {
  persistedMna: Point[]; // the CURRENTLY persisted raw floor for the MNA indicator
  deadlineAt: number; // absolute epoch-ms hard deadline for the whole sweep
}

// Extra inputs the research signals need beyond the regime registry. STABLES is
// NOT here — it is a registry indicator, so the orchestrator sources it from the
// persisted raw floor (matching channel-divergence.js reading raw-indicator-history).
export interface ResearchInputs {
  btc: Point[];
  qqq: Point[];
  spy: Point[];
  rsp: Point[];
  top7: Point[][];
  // The COMPLETE, usable MNA series for signal computation: for the live
  // source, persisted floor ∪ freshly-fetched incremental rows (or the
  // floor alone, unchanged, when the refresh degrades — never a partial
  // fresh batch). Hermetic/fixture sources supply their own complete series
  // directly, unchanged from before.
  mna: Point[];
  margin: Point[];
  conf: Point[];
  // Present ONLY when the live source ran the incremental EDGAR refresh
  // (issue #109). Absent ⇒ treat as complete/up-to-date (hermetic/fixture
  // sources never gate signal publication on this). When present with
  // status "degraded", the orchestrator MUST NOT compute/publish
  // late-cycle-signals this run — it logs the degraded outcome and retains
  // the last-good persisted signal untouched.
  mnaRefresh?: EdgarRefreshOutcome;
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
  // Research-only inputs (BTC/QQQ/SPY/RSP/top-7/MNA/MARGIN/CONF). `edgarCtx`
  // (issue #109) carries the persisted MNA floor + hard deadline for the
  // live source's incremental EDGAR sweep; hermetic/fixture sources never
  // need it (a fewer-parameter implementation is structurally valid TS).
  fetchResearchInputs(asof: string, logger?: Logger, edgarCtx?: EdgarPlanContext): Promise<ResearchInputs>;
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

  async fetchResearchInputs(asof, logger = console, edgarCtx): Promise<ResearchInputs> {
    // Channel + late-cycle share Yahoo tickers; fetch the union concurrently.
    const [btc, qqq, spy, rsp, ...top7] = await Promise.all([
      safe("BTC-USD", () => fetchYahoo("BTC-USD", unix(CHANNEL_START)), logger),
      safe("QQQ", () => fetchYahoo("QQQ", unix(CHANNEL_START)), logger),
      safe("SPY", () => fetchYahoo("SPY", unix(LATECYCLE_START)), logger),
      safe("RSP", () => fetchYahoo("RSP", unix(LATECYCLE_START)), logger),
      ...TOP7.map((sym) => safe(sym, () => fetchYahoo(sym, unix(LATECYCLE_START)), logger)),
    ]);

    // Two-tier EDGAR refresh (R6 follow-up, docs/v0-v1-quant-platform-parity-
    // report.md finding 1.10): most runs are a cheap INCREMENTAL sweep
    // (missing months + a small trailing revision window); periodically
    // (see selectEdgarRefreshTier in ../edgar-incremental-refresh.ts) it's a
    // FULL 2010-to-present crawl, matching v0's `late-cycle-signals.js`, so
    // an EDGAR back-revision to any historical month still lands, just on a
    // bounded periodic cadence rather than every run. One hard deadline
    // either way, sized to whichever tier this asof selects. A degraded
    // refresh (deadline hit, any planned month missing/duplicated/invalid,
    // or — issue #509 — a complete batch that diverges from the persisted
    // floor beyond bounds) falls back to the persisted floor UNCHANGED —
    // never a partial fresh batch — and is reported via `mnaRefresh` so the
    // orchestrator can skip publishing a signal against incomplete data
    // this run.
    //
    // `refreshEdgarWithTierFallback` (not the bare refresh) so a degraded
    // WEEKLY reconciliation sweep retries once as the cheap daily
    // incremental sweep instead of suppressing that day's signal outright
    // (issue #509). `persistedRows` feeds the batch-level divergence guard —
    // the floor VALUES the fresh batch is about to overwrite, which is the
    // only thing that guard can compare against.
    const persistedMna = edgarCtx?.persistedMna ?? [];
    const deadlineAt = edgarCtx?.deadlineAt ?? Date.now() + defaultEdgarRefreshDeadlineMs(selectEdgarRefreshTier(asof));
    const [margin, conf, mnaRefresh] = await Promise.all([
      safe("FRED BOGZ1FL663067003Q", () => fetchFred("BOGZ1FL663067003Q"), logger),
      safe("FRED UMCSENT", () => fetchFred("UMCSENT"), logger),
      refreshEdgarWithTierFallback({
        asOf: asof,
        persistedMonths: persistedMna.map((p) => p.date.slice(0, 7)),
        persistedRows: persistedMna,
        deadlineAt,
        logger,
      }),
    ]);
    const mna = mnaRefresh.status === "degraded" ? persistedMna : mergeSeries(persistedMna, mnaRefresh.newRows);

    return { btc, qqq, spy, rsp, top7, mna, margin, conf, mnaRefresh };
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
