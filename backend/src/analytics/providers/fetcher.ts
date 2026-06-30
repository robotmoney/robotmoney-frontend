// OPT-IN live data provider. Implements the same `Provider` interface as the
// default `seededProvider`, but pulls REAL series from KEYLESS public sources:
//   - DefiLlama   (keyless): DEFI_TVL, STABLES
//   - CoinGecko   (keyless): BTC, ETH_TREND, BTC_ACTIVE (volume proxy), BTC_ETH
//   - Yahoo Finance (keyless): SPY, QQQ, RSP, VIX, DXY, COPPER_GOLD (HG/GC)
// Series that require keys (FRED: T10Y2Y/HY_OAS/ICSA) or RPC, plus anything with
// no keyless source (MNA/MARGIN/CONF), fall back to the seeded path PER SERIES.
//
// The `Provider` contract is synchronous, but real fetches are async, so the live
// provider PRE-FETCHES every mappable series once via `warm(asof)` (called from
// analytics/index.ts before registry.run) and then serves `getSeries` from that
// in-run cache. ANY failure — bad status, network error, timeout, empty/garbage
// payload, or an id we don't map — degrades to `seededProvider.getSeries` for that
// single series. `getSeries` therefore never throws and the suite always runs.
import type { Provider, SeriesSpec, Point } from "../provider.ts";
import { seededProvider } from "../provider.ts";
import { dateBefore } from "../transforms.ts";

// Fetch JSON with a hard timeout so an unreachable/slow source falls back fast.
async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Daily real series can have gaps (weekends/holidays) and may stop "today", while
// the tools expect a dense array of `lookbackDays` consecutive calendar days
// ending at `asof` (exactly what seededProvider returns). Forward-fill the raw,
// gappy series onto that dense grid. Returns null when there is no usable data
// at/-before `asof`, signalling the caller to fall back to seeded.
function shapeDaily(raw: Point[], asof: string, lookbackDays: number): Point[] | null {
  const filtered = raw
    .filter((p) => Number.isFinite(p.value) && p.date <= asof)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!filtered.length) return null;
  const out: Point[] = [];
  let ptr = 0;
  let last = filtered[0].value; // back-fill before the first observation
  for (let k = 0; k < lookbackDays; k++) {
    const date = dateBefore(asof, lookbackDays - 1 - k);
    while (ptr < filtered.length && filtered[ptr].date <= date) last = filtered[ptr++].value;
    out.push({ date, value: last });
  }
  return out;
}

// Element-wise ratio of two gappy series, aligned on shared dates (a/b).
function ratioByDate(a: Point[], b: Point[]): Point[] {
  const bd = new Map(b.map((p) => [p.date, p.value]));
  const out: Point[] = [];
  for (const p of a) {
    const d = bd.get(p.date);
    if (d) out.push({ date: p.date, value: p.value / d });
  }
  return out;
}

// ---- upstream parsers (each returns date-keyed Point[] or throws) ------------

// DefiLlama total value locked across all chains: [{date: unixSeconds, tvl}].
function parseLlamaTvl(j: unknown): Point[] {
  if (!Array.isArray(j)) throw new Error("llama tvl: not an array");
  return j.map((row: any) => ({ date: isoDay(Number(row.date) * 1000), value: Number(row.tvl) }));
}

// DefiLlama stablecoins aggregate circulating: [{date, totalCirculatingUSD:{peggedUSD}}].
function parseLlamaStables(j: unknown): Point[] {
  if (!Array.isArray(j)) throw new Error("llama stables: not an array");
  return j.map((row: any) => ({
    date: isoDay(Number(row.date) * 1000),
    value: Number(row.totalCirculatingUSD?.peggedUSD ?? row.totalCirculating?.peggedUSD),
  }));
}

// CoinGecko market_chart series: {prices|total_volumes|market_caps: [[ms, v], ...]}.
function parseCoinGecko(j: unknown, key: "prices" | "total_volumes" | "market_caps"): Point[] {
  const arr = (j as any)?.[key];
  if (!Array.isArray(arr)) throw new Error(`coingecko: missing ${key}`);
  return arr.map((row: any) => ({ date: isoDay(Number(row[0])), value: Number(row[1]) }));
}

// Yahoo Finance chart: result.chart.result[0].{timestamp[], indicators.quote[0].close[]}.
function parseYahoo(j: unknown): Point[] {
  const res = (j as any)?.chart?.result?.[0];
  const ts: number[] = res?.timestamp;
  const close: number[] = res?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(close)) throw new Error("yahoo: missing timestamp/close");
  const out: Point[] = [];
  for (let i = 0; i < ts.length; i++) if (close[i] != null) out.push({ date: isoDay(ts[i] * 1000), value: Number(close[i]) });
  return out;
}

const cgUrl = (coin: string) =>
  `https://api.coingecko.com/api/v3/coins/${coin}/market_chart?vs_currency=usd&days=365&interval=daily`;
const yfUrl = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;

export class FetcherProvider implements Provider {
  // Per-run cache of REAL series, keyed by the canonical series id. Absent entry
  // (fetch failed or unmapped) ⇒ getSeries falls back to seeded for that id.
  private series = new Map<string, Point[]>();
  private warmed = false;

  // Pre-fetch every mappable series once. Concurrent; every source is isolated so
  // one failure only drops its own series. Safe to call once per analytics run.
  async warm(_asof?: string): Promise<void> {
    if (this.warmed) return;
    this.warmed = true;

    const tasks: Promise<void>[] = [];
    const set = (id: string, pts: Point[]) => {
      if (pts.length) this.series.set(id, pts);
    };
    const attempt = (fn: () => Promise<void>) =>
      tasks.push(fn().catch(() => { /* per-source failure ⇒ seeded fallback */ }));

    // DefiLlama (keyless)
    attempt(async () => set("DEFI_TVL", parseLlamaTvl(await fetchJson("https://api.llama.fi/v2/historicalChainTvl"))));
    attempt(async () =>
      set("STABLES", parseLlamaStables(await fetchJson("https://stablecoins.llama.fi/stablecoincharts/all"))));

    // CoinGecko (keyless): one fetch per coin, several derived series.
    attempt(async () => {
      const [btc, eth] = await Promise.all([fetchJson(cgUrl("bitcoin")), fetchJson(cgUrl("ethereum"))]);
      const btcPx = parseCoinGecko(btc, "prices");
      const ethPx = parseCoinGecko(eth, "prices");
      set("BTC", btcPx);
      set("ETH_TREND", ethPx);
      set("BTC_ACTIVE", parseCoinGecko(btc, "total_volumes")); // on-chain activity proxy
      set("BTC_ETH", ratioByDate(btcPx, ethPx));
    });

    // Yahoo Finance (keyless)
    const yf = (id: string, symbol: string) =>
      attempt(async () => set(id, parseYahoo(await fetchJson(yfUrl(symbol)))));
    yf("SPY", "SPY");
    yf("QQQ", "QQQ");
    yf("RSP", "RSP");
    yf("VIX", "^VIX");
    yf("DXY", "DX-Y.NYB");
    attempt(async () => {
      const [copper, gold] = await Promise.all([fetchJson(yfUrl("HG=F")), fetchJson(yfUrl("GC=F"))]);
      set("COPPER_GOLD", ratioByDate(parseYahoo(copper), parseYahoo(gold)));
    });

    await Promise.all(tasks);
  }

  getSeries(spec: SeriesSpec, asof: string, lookbackDays: number): Point[] {
    const raw = this.series.get(spec.id);
    if (raw) {
      const shaped = shapeDaily(raw, asof, lookbackDays);
      if (shaped) return shaped;
    }
    // Unmapped id, fetch failure, or no data at/-before asof ⇒ seeded fallback.
    return seededProvider.getSeries(spec, asof, lookbackDays);
  }
}

// Factory used by analytics/index.ts when PROVIDER=live.
export function createFetcherProvider(): FetcherProvider {
  return new FetcherProvider();
}
