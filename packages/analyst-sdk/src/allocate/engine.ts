// Allocation engine v1: the pattern on robotmoney.network/regime-detection
// ("Recommended Pattern for Regime-Driven TAA"), applied to the Base universe.
//
//   1. Top layer: a strategic neutral portfolio (SAA) plus bounded tactical
//      tilts, tilt = tanh(k * z), where z is a regime score centred on the
//      composite's own bucket edges (percentile 0.33 -> -1, 0.67 -> +1).
//   2. Within stables: a linear program that maximizes trailing yield subject to
//      per-protocol and per-group caps (greedy fill by yield; exact here except
//      where the Spark vault sits in both the Sky and the Morpho group).
//   3. Within crypto and RWA: HRP. On Base today each risky sleeve holds one
//      asset (cbBTC, DGLD), so the within-sleeve step is the identity until a
//      sleeve holds more than one token.
//
// Pure: every input arrives as an argument; no I/O.
import type { Weights } from "./types.ts";

export type SignalId =
  | "composite"            // composite percentile
  | "counter_composite"    // 1 - composite percentile (counter-cycle sleeves)
  | "onchain"              // on-chain panel percentile
  | "macro"                // macro panel percentile
  | "real_rates_dollar";   // mean of sign-aligned DFII10, DXY, T5YIE ranks: high = low real yields, weak dollar

export interface SleeveTilt {
  series: string;   // e.g. "BTC"
  signal: SignalId;
  saa: number;      // neutral weight, percent of NAV
  min: number;      // band floor
  max: number;      // band ceiling
  k: number;        // tanh steepness; z = 1 at the risk_on bucket edge
  // Volatility scaling: multiply the tilted weight by volTarget / realized vol
  // (60-day, annualized, %), bounded to [0.5, 1.5], then clamp to the band.
  volTarget?: number;
}

export interface YieldInstrument { series: string; cap: number }
export interface YieldGroup { id: string; members: string[]; cap: number }

export interface EngineSpec {
  tilts: SleeveTilt[];
  buffer: { series: string; weight: number };      // cash buffer, fixed
  yieldBook: { instruments: YieldInstrument[]; groups: YieldGroup[]; trailingDays: number };
}

export interface SignalInputs {
  compositePercentile: number | null;
  macroPercentile: number | null;
  onchainPercentile: number | null;
  signed: Record<string, number>; // sign-aligned percentile rank per indicator, 0..1, high = risk-on
  realizedVol?: Record<string, number>; // 60-day annualized vol per series, %, as of the decision
}

const BUCKET_HALF_WIDTH = 0.17; // 0.67 - 0.5: the composite's own bucket edge

export function signalPercentile(id: SignalId, s: SignalInputs): number | null {
  switch (id) {
    case "composite": return s.compositePercentile;
    case "counter_composite": return s.compositePercentile === null ? null : 1 - s.compositePercentile;
    case "onchain": return s.onchainPercentile;
    case "macro": return s.macroPercentile;
    case "real_rates_dollar": {
      const xs = ["DFII10", "DXY", "T5YIE"].map((k) => s.signed[k]).filter((v): v is number => v !== undefined && Number.isFinite(v));
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    }
  }
}

// Bounded tilt: saa plus the band on the side the tilt points to, scaled by tanh.
export function tiltWeight(t: SleeveTilt, p: number | null): { weight: number; z: number | null; tilt: number } {
  if (p === null || !Number.isFinite(p)) return { weight: t.saa, z: null, tilt: 0 };
  const z = (p - 0.5) / BUCKET_HALF_WIDTH;
  const tilt = Math.tanh(t.k * z);
  const span = tilt >= 0 ? t.max - t.saa : t.saa - t.min;
  return { weight: t.saa + span * tilt, z, tilt };
}

// Greedy fill by yield, highest first, each instrument up to its own cap and the
// remaining room in every group it belongs to. Ties keep the spec's order.
export function fillYieldBook(total: number, yields: Record<string, number>, spec: EngineSpec["yieldBook"]): Weights {
  const order = spec.instruments
    .map((ins, i) => ({ ins, i, y: yields[ins.series] ?? -Infinity }))
    .sort((a, b) => b.y - a.y || a.i - b.i);
  const room = new Map(spec.groups.map((g) => [g.id, g.cap]));
  const w: Weights = {};
  let left = total;
  for (const { ins } of order) {
    if (left <= 1e-9) { w[ins.series] = 0; continue; }
    let take = Math.min(ins.cap, left);
    for (const g of spec.groups) if (g.members.includes(ins.series)) take = Math.min(take, room.get(g.id)!);
    take = Math.max(0, take);
    w[ins.series] = take;
    left -= take;
    for (const g of spec.groups) if (g.members.includes(ins.series)) room.set(g.id, room.get(g.id)! - take);
  }
  // Whatever the caps cannot place stays in cash (the buffer), never over a cap.
  if (left > 1e-9) w.__unplaced = left;
  return w;
}

export interface EngineOutput {
  weights: Weights;
  trace: Record<string, { p: number | null; z: number | null; tilt: number; weight: number }>;
}

export function engineWeights(spec: EngineSpec, s: SignalInputs, yields: Record<string, number>): EngineOutput {
  const trace: EngineOutput["trace"] = {};
  const w: Weights = {};
  let risky = 0;
  for (const t of spec.tilts) {
    const p = signalPercentile(t.signal, s);
    const r = tiltWeight(t, p);
    let weight = r.weight;
    const rv = s.realizedVol?.[t.series];
    if (t.volTarget && rv && Number.isFinite(rv) && rv > 0) {
      weight = Math.min(t.max, Math.max(t.min, weight * Math.min(1.5, Math.max(0.5, t.volTarget / rv))));
    }
    w[t.series] = weight;
    risky += weight;
    trace[t.series] = { p, z: r.z, tilt: r.tilt, weight };
  }
  w[spec.buffer.series] = spec.buffer.weight;
  const book = fillYieldBook(100 - risky - spec.buffer.weight, yields, spec.yieldBook);
  const unplaced = book.__unplaced ?? 0;
  delete book.__unplaced;
  Object.assign(w, book);
  w[spec.buffer.series] = spec.buffer.weight + unplaced;
  return { weights: w, trace };
}
