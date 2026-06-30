// The single data seam for the analytics suite. Every tool gets its raw series
// from a Provider — tools never know whether the data is seeded or live. v0 ships
// a deterministic SeededProvider (hermetic, no API keys); a future FetcherProvider
// (FRED/Yahoo/CoinMetrics/DefiLlama/RPC) implements the same interface and is the
// ONLY thing that changes when wiring real data.
import { lcg, hashStr, dateBefore } from "./transforms.ts";

export interface SeriesSpec {
  id: string; // canonical series id (e.g. "VIX", "BTC", "QQQ")
  base: number; // central level
  vol: number; // step volatility as a fraction of base
  drift?: number; // small per-step drift fraction
}

export interface Point { date: string; value: number; }

export interface Provider {
  getSeries(spec: SeriesSpec, asof: string, lookbackDays: number): Point[];
}

// Deterministic mean-reverting random walk, seeded by (id, asof) so the same
// inputs always reproduce the same series.
export const seededProvider: Provider = {
  getSeries(spec, asof, lookbackDays) {
    const rand = lcg(hashStr(spec.id) ^ (Number(asof.replace(/-/g, "")) >>> 0));
    const drift = spec.drift ?? 0;
    const out: Point[] = [];
    let v = spec.base;
    for (let i = 0; i < lookbackDays; i++) {
      const shock = (rand() - 0.5) * 2 * spec.vol * spec.base;
      v += shock + (spec.base - v) * 0.05 + drift * spec.base;
      out.push({ date: dateBefore(asof, lookbackDays - 1 - i), value: v });
    }
    return out;
  },
};
