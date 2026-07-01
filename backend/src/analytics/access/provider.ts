// The single data seam for the analytics suite. Every tool gets its raw series
// from a Provider — tools never know whether the data is seeded or live. The
// default is a deterministic seededProvider (hermetic, no API keys). An opt-in,
// implemented live FetcherProvider (DefiLlama/Yahoo, all keyless;
// PROVIDER=live) satisfies the same interface and falls back to seeded per series,
// so it is the ONLY thing that changes when serving real data.
import type { SeriesSpec, Point } from "../types.ts";
import { lcg, hashStr } from "../transform/math.ts";

export type { SeriesSpec, Point } from "../types.ts";

export interface Provider {
  getSeries(spec: SeriesSpec, asof: string, lookbackDays: number): Point[];
}

// Deterministic mean-reverting random walk anchored at a FIXED epoch and seeded
// by `id` ONLY (not asof). A given calendar date therefore always maps to the
// same index in the same path → identical value across asof runs (persisted
// history is stable; re-running for a later asof never rewrites past dates with
// different numbers). The window [asof - lookback, asof] is sliced from that path.
const ANCHOR_MS = Date.UTC(2018, 0, 1);
const DAY = 86400_000;

export const seededProvider: Provider = {
  getSeries(spec, asof, lookbackDays) {
    const [y, m, d] = asof.split("-").map(Number);
    const asofMs = Date.UTC(y, m - 1, d);
    const totalDays = Math.max(lookbackDays, Math.round((asofMs - ANCHOR_MS) / DAY) + 1);
    const rand = lcg(hashStr(spec.id));
    const drift = spec.drift ?? 0;
    // Generate the full path from the fixed anchor; mean reversion + drift keep it bounded.
    let v = spec.base;
    const path = new Array<number>(totalDays);
    for (let i = 0; i < totalDays; i++) {
      const shock = (rand() - 0.5) * 2 * spec.vol * spec.base;
      v += shock + (spec.base - v) * 0.05 + drift * spec.base;
      path[i] = v;
    }
    const start = totalDays - lookbackDays;
    const out: Point[] = [];
    for (let k = 0; k < lookbackDays; k++) {
      out.push({ date: new Date(ANCHOR_MS + (start + k) * DAY).toISOString().slice(0, 10), value: path[start + k] });
    }
    return out;
  },
};
