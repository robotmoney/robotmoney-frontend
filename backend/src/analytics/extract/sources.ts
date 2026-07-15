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
//   - blockchain_com              → BTC_ACTIVE (n-unique-addresses), BTC_MVRV (mvrv)
//   - coinmetrics                 → ETH_ACTIVE (eth / AdrActCnt)
//   - geckoterminal_newpools      → NEW_TOKENS (today's 24h count; merged forward)
//   - shiller_cape / multpl       → SHILLER_CAPE
//
// Note the derivation semantics: `*_TREND` ids store the RAW price (the 50/200
// SMA ratio is a downstream transform), and `*_GROWTH` ids store the RAW level
// (the 90d %-change is downstream) — so a fetched series compares apples-to-apples
// against raw-indicator-history.
import type { Point } from "../types.ts";
import { INDICATORS, type Indicator } from "../analyze/indicators.ts";
import { fetchFred } from "./fred.ts";
import { fetchYahoo } from "./yahoo.ts";
import { fetchDefillamaTvl, fetchDefillamaStables } from "./defillama.ts";
import { fetchBlockchainComChart } from "./blockchain-com.ts";
import { fetchCoinmetrics } from "./coinmetrics.ts";
import { fetchGeckoTerminalNewPools } from "./geckoterminal.ts";
import { fetchShillerCape, fetchMultplShillerCape } from "./shiller.ts";

type Logger = {
  log?: (m: string) => void;
  warn?: (m: string) => void;
  error?: (m: string) => void;
};

// Ratio of two gappy series on the intersection of dates (a/b), skipping any
// date where the denominator is 0 or non-finite. Matches the original's
// mergeRatioSeries in lib/fetch_all.js.
export function mergeRatioSeries(a: Point[], b: Point[]): Point[] {
  const bm = new Map(b.map((p) => [p.date, p.value]));
  const out: Point[] = [];
  for (const p of a) {
    const d = bm.get(p.date);
    if (Number.isFinite(d as number) && d !== 0 && d !== undefined) out.push({ date: p.date, value: p.value / d });
  }
  return out;
}

// Resolve ONE indicator to its raw series. Throws on fetch/parse failure so the
// caller decides whether to fall back to persisted history.
export async function fetchOne(ind: Indicator, logger: Logger = console): Promise<Point[]> {
  switch (ind.source) {
    case "fred":
      return fetchFred(ind.series as string);
    case "yahoo": {
      if (Array.isArray(ind.series)) {
        const [a, b] = await Promise.all([fetchYahoo(ind.series[0]), fetchYahoo(ind.series[1])]);
        if (a.length === 0) throw new Error(`Yahoo numerator ${ind.series[0]} empty`);
        if (b.length === 0) throw new Error(`Yahoo denominator ${ind.series[1]} empty`);
        return mergeRatioSeries(a, b);
      }
      return fetchYahoo(ind.series as string);
    }
    case "defillama_tvl":
      return fetchDefillamaTvl();
    case "defillama_stables":
      return fetchDefillamaStables();
    case "blockchain_com":
      return fetchBlockchainComChart(ind.series as string);
    case "coinmetrics": {
      const s = ind.series as { asset: string; metric: string };
      return fetchCoinmetrics(s.asset, s.metric);
    }
    case "geckoterminal_newpools":
      return fetchGeckoTerminalNewPools();
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
export async function fetchAll(
  opts: { logger?: Logger; indicators?: Indicator[] } = {},
): Promise<Record<string, Point[]>> {
  const logger = opts.logger ?? console;
  const inds = opts.indicators ?? INDICATORS;
  const results = await Promise.all(
    inds.map(async (ind): Promise<[string, Point[]]> => {
      try {
        return [ind.id, await fetchOne(ind, logger)];
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
