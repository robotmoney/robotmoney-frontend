// Extract stage: the indicator-id → fetch+parse wiring. This is the map of which
// canonical series come from which KEYLESS source, driven by the analyze/
// indicators.ts registry — ported from agentjuno/robotmoney lib/fetch_all.js.
//
// Every indicator id resolves to a raw {date,value}[] series matching the
// original's raw-indicator-history layout (PRE-transform):
//   - fred single series          → level (T10Y2Y, DFII10, T5YIE, HY_OAS/BAMLH0A0HYM2,
//                                    DXY/DTWEXBGS, ICSA; and the collected, unscored
//                                    BAA10Y, extract/collected-series.ts)
//   - yahoo single symbol         → adj-close level (VIX/^VIX, SPX_TREND/^GSPC,
//                                    ETH_TREND/ETH-USD)
//   - yahoo [num, den]            → num/den ratio on shared dates (COPPER_GOLD=HG/GC,
//                                    IWM_SPY, BTC_ETH=BTC-USD/ETH-USD, SPHB_SPLV,
//                                    MTUM_SPY, IWF_IWD, XLU_SPY, XLP_XLY), for a ratio
//                                    declared ratioInput "stored"; plus each symbol's
//                                    two closes as legs, yahoo:<SYMBOL>.close and
//                                    yahoo:<SYMBOL>.adjclose (issue 1644)
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
import { ratioLegSourceId, STORED_UNDER, type LegClose } from "../series-ids.ts";
import { COLLECTED_SERIES, collectionRegistry, type SourceSeries } from "./collected-series.ts";
import { fetchFred } from "./fred.ts";
import { fetchYahoo, fetchYahooChart, fetchYahooClose, parseYahoo, parseYahooClose } from "./yahoo.ts";
import { fetchDefillamaTvl, fetchDefillamaStables } from "./defillama.ts";
import { fetchBlockchainComChart } from "./blockchain-com.ts";
import { fetchCoinmetrics } from "./coinmetrics.ts";
import { fetchShillerCape, fetchMultplShillerCape } from "./shiller.ts";
import type { DayClose } from "./http.ts";

// Each source's day-close rule (issue 1655, extract/http.ts applyDayClose).
// Declared "accept-partial" for every source: each extractor keeps exactly the
// rows it served before. "drop-unclosed" is supported for the DefiLlama and
// Coin Metrics sources only; GeckoTerminal stamps NEW_TOKENS with the poll day,
// so a drop there would discard every new row. An analyst changes an entry in
// its own reviewed diff.
export const DROP_UNCLOSED_SOURCES: readonly string[] = ["defillama_tvl", "defillama_stables", "coinmetrics"];
export const SOURCE_DAY_CLOSE: Readonly<Record<string, DayClose>> = {
  fred: "accept-partial",
  yahoo: "accept-partial",
  defillama_tvl: "accept-partial",
  defillama_stables: "accept-partial",
  blockchain_com: "accept-partial",
  coinmetrics: "accept-partial",
  geckoterminal_newpools: "accept-partial",
  multpl_shiller_cape: "accept-partial",
  shiller_cape: "accept-partial",
};

/** Throws when a rule is unknown, or drop-unclosed is declared for a source that does not support it. */
export function assertDayCloseRules(rules: Readonly<Record<string, string>>): void {
  for (const [source, rule] of Object.entries(rules)) {
    if (rule !== "accept-partial" && rule !== "drop-unclosed") throw new Error(`SOURCE_DAY_CLOSE.${source}: unknown day-close rule ${JSON.stringify(rule)}`);
    if (rule === "drop-unclosed" && !DROP_UNCLOSED_SOURCES.includes(source)) {
      throw new Error(`SOURCE_DAY_CLOSE.${source}: drop-unclosed is supported only for ${DROP_UNCLOSED_SOURCES.join(", ")}`);
    }
  }
}
// Checked at module load: a bad declaration stops every run before any fetch.
assertDayCloseRules(SOURCE_DAY_CLOSE);
const dayClose = (source: string) => ({ dayClose: SOURCE_DAY_CLOSE[source] });

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
  /** fetchYahooClose(symbol, startUnix), the raw close, from the same request as `yahoo` (issue 1644). */
  yahooClose(symbol: string, startUnix?: number): Promise<Point[]>;
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
  const yahoo = new Map<string, { start: number; chart: Promise<unknown> }>();
  let tvl: Promise<Point[]> | null = null;
  let stables: Promise<Point[]> | null = null;
  // The adjusted close and the raw close (issue 1644) read the one chart
  // response per symbol, so both closes of a day come from one request.
  const serve = async (symbol: string, startUnix: number, parse: (j: unknown) => Point[]) => {
    let hit = yahoo.get(symbol);
    // A start the plan did not foresee is fetched again rather than cut
    // short: a wrong plan costs a request, never a missing row.
    if (!hit || hit.start > startUnix) {
      const start = Math.min(plan[symbol] ?? startUnix, startUnix);
      hit = { start, chart: fetchYahooChart(symbol, start) };
      yahoo.set(symbol, hit);
    }
    const points = parse(await hit.chart);
    if (startUnix <= hit.start) return points;
    const from = isoDay(startUnix * 1000);
    return points.filter((p) => p.date >= from);
  };
  return {
    yahoo: (symbol, startUnix = 0) => serve(symbol, startUnix, parseYahoo),
    yahooClose: (symbol, startUnix = 0) => serve(symbol, startUnix, parseYahooClose),
    defillamaTvl: () => (tvl ??= fetchDefillamaTvl(15000, dayClose("defillama_tvl"))).then((p) => p.slice()),
    defillamaStables: () => (stables ??= fetchDefillamaStables(15000, dayClose("defillama_stables"))).then((p) => p.slice()),
  };
}

// The one ratio function lives in the transform stage (SDK-10).
export { mergeRatioSeries };

// Both legs of a Yahoo ratio (adjusted closes), full history, and the ratio on their shared dates.
async function fetchYahooRatio(series: readonly [string, string], memo?: FetchMemo): Promise<Point[]> {
  const yahoo = (symbol: string) => (memo ? memo.yahoo(symbol, 0) : fetchYahoo(symbol));
  const [a, b] = await Promise.all([yahoo(series[0]), yahoo(series[1])]);
  if (a.length === 0) throw new Error(`Yahoo numerator ${series[0]} empty`);
  if (b.length === 0) throw new Error(`Yahoo denominator ${series[1]} empty`);
  return mergeRatioSeries(a, b);
}

/** Each ratio leg the registry fetch records (issue 1644): both closes of every ratio symbol, by source id. */
export function registryRatioLegs(indicators: readonly SourceSeries[] = INDICATORS): { id: string; symbol: string; close: LegClose }[] {
  const out = new Map<string, { id: string; symbol: string; close: LegClose }>();
  for (const ind of indicators) {
    if (ind.source !== "yahoo" || !Array.isArray(ind.series)) continue;
    for (const symbol of ind.series) {
      for (const close of ["close", "adjclose"] as const) {
        const id = ratioLegSourceId(ind.source, symbol, close);
        out.set(id, { id, symbol, close });
      }
    }
  }
  return [...out.values()];
}

// Resolve ONE indicator to its raw series. Throws on fetch/parse failure so the
// caller decides whether to fall back to persisted history.
export async function fetchOne(ind: SourceSeries, logger: Logger = console, ext: SourceExtensions = {}, memo?: FetchMemo): Promise<Point[]> {
  const yahoo = (symbol: string) => (memo ? memo.yahoo(symbol, 0) : fetchYahoo(symbol));
  switch (ind.source) {
    case "fred":
      return fetchFred(ind.series as string);
    case "yahoo": {
      if (Array.isArray(ind.series)) {
        // Issue 1644: a ratio declared "legs" is never computed at ingestion.
        if (ind.ratioInput === "legs") throw new Error(`${ind.id} is declared ratioInput "legs": it is calculated from its legs in the transform stage, never fetched`);
        return fetchYahooRatio(ind.series as [string, string], memo);
      }
      return yahoo(ind.series as string);
    }
    case "defillama_tvl":
      return memo ? memo.defillamaTvl() : fetchDefillamaTvl(15000, dayClose("defillama_tvl"));
    case "defillama_stables":
      return memo ? memo.defillamaStables() : fetchDefillamaStables(15000, dayClose("defillama_stables"));
    case "blockchain_com":
      return fetchBlockchainComChart(ind.series as string);
    case "coinmetrics": {
      const s = ind.series as { asset: string; metric: string };
      return fetchCoinmetrics(s.asset, s.metric, "2018-01-01", 15000, dayClose("coinmetrics"));
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
// history for that id. Returns { [indicatorId]: Point[] }, plus each ratio
// leg under its source id (issue 1644), and no ratio declared "legs".
// `provenance` (issue #979) is the data-source label these values carry into
// source_value_versions.provenance. Omitted means 'live', matching both
// captureSourceAcquisition()'s and saveRawIndicatorHistory()'s defaults; the
// producer's gap catch-up passes 'seed' because it writes the same points into
// raw_indicator_history through the 'seed'-tagged floor writer.
export async function fetchAll(
  opts: {
    logger?: Logger;
    indicators?: readonly SourceSeries[];
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
  // Default: the registry and the collected series (collectionRegistry(), issue 1653).
  const inds = (opts.indicators ?? collectionRegistry()).filter((ind) => !Object.hasOwn(STORED_UNDER, ind.id));
  const record = (meta: AcquisitionMeta, operation: () => Promise<Point[]>) => (opts.acquire ? opts.acquire(meta, operation) : operation());
  // Issue 1644: each ratio symbol's two closes are recorded once per run, from
  // full history, as source data. A ratio declared ratioInput "stored" is
  // still calculated and stored exactly as before; one declared "legs" is not.
  const fetchLeg = async ({ id: legKey, symbol, close }: { id: string; symbol: string; close: LegClose }): Promise<[string, Point[]]> => {
    try {
      const points = await record({
        provider: "yahoo",
        sourceKey: legKey,
        parserVersion: close === "close" ? "yahoo-close:1" : "yahoo-adjclose:1",
        cacheIdentity: `${symbol}:${close}`,
        requestedByRunId: opts.requestedByRunId,
        provenance: opts.provenance,
      }, async () => {
        const memo = opts.memo;
        const pts = close === "close" ? await (memo ? memo.yahooClose(symbol, 0) : fetchYahooClose(symbol)) : await (memo ? memo.yahoo(symbol, 0) : fetchYahoo(symbol));
        if (pts.length === 0) throw new Error(`Yahoo ${symbol} ${close} empty`);
        return pts;
      });
      return [legKey, points];
    } catch (e: any) {
      logger.error?.(`[extract] fetch leg ${legKey} FAILED: ${e?.message ?? e}`);
      return [legKey, []];
    }
  };
  const results = await Promise.all([
    ...inds.filter((ind) => ind.ratioInput !== "legs").map(async (ind): Promise<[string, Point[]]> => {
      try {
        const points = await record({
          provider: ind.source,
          sourceKey: `raw_indicator_history:${ind.id}`,
          parserVersion: `${ind.source}:1`,
          cacheIdentity: JSON.stringify(ind.series ?? null),
          requestedByRunId: opts.requestedByRunId,
          provenance: opts.provenance,
        }, () => fetchOne(ind, logger, opts.extensions, opts.memo));
        return [ind.id, points];
      } catch (e: any) {
        // A collected series is scored by nothing: its failure is a warning on its own key (issue 1653).
        const log = COLLECTED_SERIES.some((c) => c.id === ind.id) ? logger.warn : logger.error;
        log?.(`[extract] fetch ${ind.id} (${ind.source}) FAILED: ${e?.message ?? e}`);
        return [ind.id, []];
      }
    }),
    ...registryRatioLegs(inds).map(fetchLeg),
  ]);
  const out: Record<string, Point[]> = {};
  for (const [id, data] of results) out[id] = data;
  logger.log?.("[extract] fetch summary:");
  for (const [id, data] of results) {
    const last = data.length ? data[data.length - 1] : null;
    logger.log?.(`  ${(data.length === 0 ? "x EMPTY" : "ok").padEnd(8)} ${id.padEnd(14)} rows=${String(data.length).padStart(6)} last=${last?.date ?? "-"}`);
  }
  return out;
}
