// Extract stage: the series-id → fetch+parse wiring. This is the map of which
// canonical series come from which keyless source — formerly inlined in
// FetcherProvider.warm(). The access/fetcher-provider just iterates these tasks.
//
// Each source is isolated: one failure (bad status, network, timeout, garbage
// payload) only drops its own series via the per-attempt catch, so the suite
// always runs. `set` is invoked per resolved series id with its Point[]; derived
// ratio series (BTC/ETH, copper/gold) are aligned on shared dates via the
// transform grid before being set.
import type { Point } from "../types.ts";
import { fetchJson } from "./http.ts";
import { parseLlamaTvl, parseLlamaStables, llamaTvlUrl, llamaStablesUrl } from "./defillama.ts";
import { parseCoinGecko, cgUrl } from "./coingecko.ts";
import { parseYahoo, yfUrl } from "./yahoo.ts";
import { ratioByDate } from "../transform/grid.ts";

// Build the per-source fetch tasks. Returns the in-flight promises so the caller
// can `await Promise.all(...)`. `set` is the sink for resolved series.
export function loadSources(set: (id: string, pts: Point[]) => void): Promise<void>[] {
  const tasks: Promise<void>[] = [];
  const attempt = (fn: () => Promise<void>) =>
    tasks.push(fn().catch(() => { /* per-source failure ⇒ seeded fallback */ }));

  // DefiLlama (keyless)
  attempt(async () => set("DEFI_TVL", parseLlamaTvl(await fetchJson(llamaTvlUrl))));
  attempt(async () => set("STABLES", parseLlamaStables(await fetchJson(llamaStablesUrl))));

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

  return tasks;
}
