// Extract stage: the indicator-id → fetch+parse wiring. This is the map of which
// canonical series come from which KEYLESS source, driven by the analyze/
// indicators.ts registry — ported from agentjuno/robotmoney lib/fetch_all.js.
//
// Every indicator id resolves to a raw {date,value}[] series matching the
// original's raw-indicator-history layout (PRE-transform):
//   - fred single series          → level (T10Y2Y, DFII10, T5YIE, HY_OAS/BAMLH0A0HYM2,
//                                    DXY/DTWEXBGS, ICSA)
//   - yahoo single symbol         → adj-close level (VIX/^VIX, SPX_TREND/^GSPC,
//                                    ETH_TREND/ETH-USD)
//   - yahoo [num, den]            → num/den ratio on shared dates (COPPER_GOLD=HG/GC,
//                                    IWM_SPY, BTC_ETH=BTC-USD/ETH-USD, SPHB_SPLV,
//                                    MTUM_SPY, IWF_IWD, XLU_SPY, XLP_XLY)
//   - defillama_tvl               → DEFI_TVL / DEFI_GROWTH (raw TVL level; the
//                                    change90 transform is applied downstream)
//   - defillama_stables           → STABLES / STABLES_GROWTH (raw stable float)
//   - blockchain_com              → BTC_ACTIVE (n-unique-addresses)
//   - coinmetrics                 → ETH_ACTIVE (eth / AdrActCnt),
//                                    BTC_MVRV (btc / CapMVRVCur — repointed off the
//                                    dead blockchain.com mvrv chart, #127)
//   - geckoterminal_newpools      → NEW_TOKENS (today's 24h count; merged forward)
//   - shiller_cape / multpl       → SHILLER_CAPE
//
// Note the derivation semantics: `*_TREND` ids store the RAW price (the 50/200
// SMA ratio is a downstream transform), and `*_GROWTH` ids store the RAW level
// (the 90d %-change is downstream) — so a fetched series compares apples-to-apples
// against raw-indicator-history.
import type { Point } from "../types.ts";
import { INDICATORS, type Indicator } from "../analyze/indicators.ts";
import { isoDay } from "../transform/math.ts";
import { mergeRatioSeries } from "../transform/grid.ts";
import { ratioLegStorageKey, STORED_UNDER } from "../series-ids.ts";
import { inventoryCollection } from "../inventory.ts";
import { fetchFred } from "./fred.ts";
import { fetchYahoo } from "./yahoo.ts";
import { fetchDefillamaTvl, fetchDefillamaStables } from "./defillama.ts";
import { fetchBlockchainComChart } from "./blockchain-com.ts";
import { fetchCoinmetrics } from "./coinmetrics.ts";
import { fetchShillerCape, fetchMultplShillerCape } from "./shiller.ts";

// Backend-only seams (issue #1095 part B). geckoterminal reads process.env and
// the ledger needs a database sink, so the SDK takes them as arguments instead
// of importing them. A host that supplies neither gets every other source.
export interface SourceExtensions {
  /** NEW_TOKENS (geckoterminal_newpools); without it that source throws. */
  geckoterminal_newpools?: () => Promise<Point[]>;
}

export interface AcquisitionMeta {
  provider: string;
  sourceKey: string;
  parserVersion: string;
  cacheIdentity: string;
  requestedByRunId?: number | null;
  provenance?: string;
}

/** Wraps one indicator's fetch so a host can record it (the backend's source ledger). */
export type AcquireFn = (meta: AcquisitionMeta, operation: () => Promise<Point[]>) => Promise<Point[]>;

type Logger = {
  log?: (m: string) => void;
  warn?: (m: string) => void;
  error?: (m: string) => void;
};

// ── One request per (provider, symbol) per run (issue 1514) ────────────────
// Several consumers read the same provider series: ETH-USD feeds ETH_TREND,
// BTC_ETH and backtest:ETH-USD; SPY feeds three ratios and research:SPY;
// DefiLlama's TVL feeds DEFI_TVL and DEFI_GROWTH. Fetched separately, at
// different moments and from different starts, one run's regime and backtest
// read different prices for the same day (2026-10-28: ETH_TREND 2334.76,
// backtest:ETH-USD 2334.65). A FetchMemo is made once per run. It requests each
// Yahoo symbol once, from the widest start any consumer of the run needs (the
// run's `plan`), and each DefiLlama endpoint once. Every consumer gets the same
// values on every shared date, cut at its own requested start, so each key's
// first date is what its own request returned before. A failed request fails
// every consumer of it, which falls back to persisted history as before.
// Without a memo every call fetches on its own, as before.
export interface FetchMemo {
  /** fetchYahoo(symbol, startUnix), served from the run's one request for `symbol`. */
  yahoo(symbol: string, startUnix?: number): Promise<Point[]>;
  defillamaTvl(): Promise<Point[]>;
  defillamaStables(): Promise<Point[]>;
}

/** Yahoo symbol -> the earliest start (unix seconds, 0 = full history) any consumer of the run requests. */
export type YahooPlan = Readonly<Record<string, number>>;

/** The Yahoo plan of the registry fetch: every symbol it reads, from full history (period1=0). */
export function registryYahooPlan(indicators: readonly Indicator[] = INDICATORS): Record<string, number> {
  const plan: Record<string, number> = {};
  for (const ind of indicators) {
    if (ind.source !== "yahoo") continue;
    for (const sym of Array.isArray(ind.series) ? ind.series : [ind.series as string]) plan[sym] = 0;
  }
  return plan;
}

/** The widest start per symbol across several plans. */
export function mergeYahooPlans(...plans: YahooPlan[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const plan of plans) for (const [sym, start] of Object.entries(plan)) out[sym] = Math.min(out[sym] ?? start, start);
  return out;
}

export function createFetchMemo(plan: YahooPlan = {}): FetchMemo {
  const yahoo = new Map<string, { start: number; points: Promise<Point[]> }>();
  let tvl: Promise<Point[]> | null = null;
  let stables: Promise<Point[]> | null = null;
  return {
    async yahoo(symbol, startUnix = 0) {
      let hit = yahoo.get(symbol);
      // A start the plan did not foresee is fetched again rather than cut
      // short: a wrong plan costs a request, never a missing row.
      if (!hit || hit.start > startUnix) {
        const start = Math.min(plan[symbol] ?? startUnix, startUnix);
        hit = { start, points: fetchYahoo(symbol, start) };
        yahoo.set(symbol, hit);
      }
      const points = await hit.points;
      if (startUnix <= hit.start) return points.slice();
      const from = isoDay(startUnix * 1000);
      return points.filter((p) => p.date >= from);
    },
    defillamaTvl: () => (tvl ??= fetchDefillamaTvl()).then((p) => p.slice()),
    defillamaStables: () => (stables ??= fetchDefillamaStables()).then((p) => p.slice()),
  };
}

// The one ratio function lives in the transform stage (SDK-10).
export { mergeRatioSeries };

// Resolve ONE indicator to its raw series. Throws on fetch/parse failure so the
// caller decides whether to fall back to persisted history.
// Both legs of a Yahoo ratio, full history, and the ratio on their shared dates.
async function fetchYahooRatio(series: readonly [string, string], memo?: FetchMemo): Promise<{ legs: [Point[], Point[]]; ratio: Point[] }> {
  const yahoo = (symbol: string) => (memo ? memo.yahoo(symbol, 0) : fetchYahoo(symbol));
  const [a, b] = await Promise.all([yahoo(series[0]), yahoo(series[1])]);
  if (a.length === 0) throw new Error(`Yahoo numerator ${series[0]} empty`);
  if (b.length === 0) throw new Error(`Yahoo denominator ${series[1]} empty`);
  return { legs: [a, b], ratio: mergeRatioSeries(a, b) };
}

/**
 * The ratio legs the registry fetch records itself (issue 1514): a leg stored
 * under its own source id that no shipped inventory collects. The other legs
 * (yahoo:SPY, yahoo:BTC-USD, yahoo:ETH-USD, yahoo:HG=F, yahoo:GC=F) are
 * recorded by the collector that holds their key, from the run's same request.
 */
export function registryRecordedLegs(indicators: readonly Indicator[] = INDICATORS): Set<string> {
  const held = new Set(inventoryCollection().map((s) => s.storageKey));
  const out = new Set<string>();
  for (const ind of indicators) {
    if (ind.source !== "yahoo" || !Array.isArray(ind.series)) continue;
    for (const sym of ind.series) {
      const id = `yahoo:${sym}`;
      if (ratioLegStorageKey(id) === id && !held.has(id)) out.add(id);
    }
  }
  return out;
}

export async function fetchOne(ind: Indicator, logger: Logger = console, ext: SourceExtensions = {}, memo?: FetchMemo): Promise<Point[]> {
  const yahoo = (symbol: string) => (memo ? memo.yahoo(symbol, 0) : fetchYahoo(symbol));
  switch (ind.source) {
    case "fred":
      return fetchFred(ind.series as string);
    case "yahoo": {
      if (Array.isArray(ind.series)) return (await fetchYahooRatio(ind.series as [string, string], memo)).ratio;
      return yahoo(ind.series as string);
    }
    case "defillama_tvl":
      return memo ? memo.defillamaTvl() : fetchDefillamaTvl();
    case "defillama_stables":
      return memo ? memo.defillamaStables() : fetchDefillamaStables();
    case "blockchain_com":
      return fetchBlockchainComChart(ind.series as string);
    case "coinmetrics": {
      const s = ind.series as { asset: string; metric: string };
      return fetchCoinmetrics(s.asset, s.metric);
    }
    case "geckoterminal_newpools":
      if (!ext.geckoterminal_newpools) throw new Error("geckoterminal_newpools needs a host-supplied adapter (SourceExtensions)");
      return ext.geckoterminal_newpools();
    case "multpl_shiller_cape":
      return fetchMultplShillerCape();
    case "shiller_cape":
      return fetchShillerCape(logger);
    default:
      throw new Error(`Unknown source: ${ind.source}`);
  }
}

// Fetch every registry indicator's raw history concurrently. A failed/empty
// series returns [] (logged loudly) — the orchestrator falls back to persisted
// history for that id. Returns { [indicatorId]: Point[] }.
// `provenance` (issue #979) is the data-source label these values carry into
// source_value_versions.provenance. Omitted means 'live', matching both
// captureSourceAcquisition()'s and saveRawIndicatorHistory()'s defaults; the
// producer's gap catch-up passes 'seed' because it writes the same points into
// raw_indicator_history through the 'seed'-tagged floor writer.
export async function fetchAll(
  opts: {
    logger?: Logger;
    indicators?: Indicator[];
    acquire?: AcquireFn;
    extensions?: SourceExtensions;
    requestedByRunId?: number | null;
    provenance?: string;
    /** The run's fetch memo (issue 1514): each symbol requested once per run. */
    memo?: FetchMemo;
  } = {},
): Promise<Record<string, Point[]>> {
  const logger = opts.logger ?? console;
  // D74 amendment (issue 1514): DEFI_GROWTH and STABLES_GROWTH read the
  // DEFI_TVL and STABLES series, so nothing is fetched or written for them.
  const inds = (opts.indicators ?? INDICATORS).filter((ind) => !Object.hasOwn(STORED_UNDER, ind.id));
  const legsToRecord = registryRecordedLegs(inds);
  const recordedLegs = new Set<string>();
  // Issue 1514: a Yahoo ratio's legs are recorded as source data from the
  // same fetch the ratio is calculated from. The ratio is still calculated
  // from the fetched legs and stored as before, so no published output
  // changes. A leg that fails to record is logged and does not fail the ratio.
  const recordLegs = async (ind: Indicator, legs: [Point[], Point[]]) => {
    const acquire = opts.acquire!;
    const series = ind.series as [string, string];
    for (let i = 0; i < 2; i++) {
      const legKey = `yahoo:${series[i]}`;
      if (!legsToRecord.has(legKey) || recordedLegs.has(legKey)) continue;
      recordedLegs.add(legKey);
      const points = legs[i]!;
      try {
        await acquire({
          provider: "yahoo",
          sourceKey: legKey,
          parserVersion: "yahoo:1",
          cacheIdentity: `${series[i]}:ratio-leg:${ind.id}`,
          requestedByRunId: opts.requestedByRunId,
          provenance: opts.provenance,
        }, async () => points);
      } catch (e: any) {
        logger.error?.(`[extract] record ${ind.id} leg ${legKey} FAILED: ${e?.message ?? e}`);
      }
    }
  };
  const results = await Promise.all(
    inds.map(async (ind): Promise<[string, Point[]]> => {
      try {
        const ratioLegs = ind.source === "yahoo" && Array.isArray(ind.series) && opts.acquire ? (ind.series as [string, string]) : null;
        const operation = ratioLegs
          ? async () => {
              const { legs, ratio } = await fetchYahooRatio(ratioLegs, opts.memo);
              await recordLegs(ind, legs);
              return ratio;
            }
          : () => fetchOne(ind, logger, opts.extensions, opts.memo);
        const points = opts.acquire
          ? await opts.acquire({
              provider: ind.source,
              sourceKey: `raw_indicator_history:${ind.id}`,
              parserVersion: `${ind.source}:1`,
              cacheIdentity: JSON.stringify(ind.series ?? null),
              requestedByRunId: opts.requestedByRunId,
              provenance: opts.provenance,
            }, operation)
          : await operation();
        return [ind.id, points];
      } catch (e: any) {
        logger.error?.(`[extract] fetch ${ind.id} (${ind.source}) FAILED: ${e?.message ?? e}`);
        return [ind.id, []];
      }
    }),
  );
  const out: Record<string, Point[]> = {};
  for (const [id, data] of results) out[id] = data;
  logger.log?.("[extract] fetch summary:");
  for (const [id, data] of results) {
    const last = data.length ? data[data.length - 1] : null;
    logger.log?.(`  ${(data.length === 0 ? "x EMPTY" : "ok").padEnd(8)} ${id.padEnd(14)} rows=${String(data.length).padStart(6)} last=${last?.date ?? "-"}`);
  }
  return out;
}
