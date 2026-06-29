// Regime classifier. A self-contained, hermetic port of robotmoney's regime
// engine: a set of macro + on-chain indicators, each normalized to a 0..1
// percentile within a rolling window and sign-adjusted to a "risk-on" score;
// panel composites and an overall composite are bucketed into a regime label.
//
// v0 uses deterministically-seeded indicator series (no external API keys) so it
// runs anywhere and produces real, reproducible classification statistics. The
// live fetchers (FRED/Yahoo/CoinMetrics/DefiLlama) are a later upgrade that swaps
// only the series source — the classification math is unchanged.

export interface RegimeSnapshot {
  date: string; // YYYY-MM-DD
  composite: number; // 0..1, higher = more risk-on
  compositePercentile: number; // composite's rank within its own history
  regime: "risk_off" | "neutral" | "risk_on";
  macroRegime: "risk_off" | "neutral" | "risk_on";
  onchainRegime: "risk_off" | "neutral" | "risk_on";
  factorRegime: null;
  percentiles: Record<string, number>; // per-indicator risk-on score 0..1
  indicators: IndicatorReading[];
}

export interface IndicatorReading {
  id: string;
  name: string;
  panel: "macro" | "onchain";
  sign: 1 | -1; // +1: higher value = more risk-on; -1: inverse
  value: number;
  score: number; // sign-adjusted percentile, 0..1 risk-on
  weight: number;
}

interface IndicatorDef {
  id: string;
  name: string;
  panel: "macro" | "onchain";
  sign: 1 | -1;
  base: number;
  vol: number; // step volatility as a fraction of base
  weight: number;
}

const INDICATORS: IndicatorDef[] = [
  // macro
  { id: "T10Y2Y", name: "10y–2y yield curve", panel: "macro", sign: 1, base: 0.4, vol: 0.15, weight: 1 },
  { id: "HY_OAS", name: "High-yield credit spread", panel: "macro", sign: -1, base: 3.5, vol: 0.06, weight: 1.4 },
  { id: "VIX", name: "Equity volatility (VIX)", panel: "macro", sign: -1, base: 17, vol: 0.08, weight: 1.1 },
  { id: "DXY", name: "US dollar index", panel: "macro", sign: -1, base: 103, vol: 0.02, weight: 0.9 },
  { id: "COPPER_GOLD", name: "Copper/gold ratio", panel: "macro", sign: 1, base: 0.18, vol: 0.04, weight: 1 },
  { id: "ICSA", name: "Initial jobless claims", panel: "macro", sign: -1, base: 220000, vol: 0.05, weight: 1.2 },
  // on-chain
  { id: "DEFI_TVL", name: "DeFi total value locked", panel: "onchain", sign: 1, base: 95e9, vol: 0.05, weight: 1.2 },
  { id: "STABLES", name: "Stablecoin supply growth", panel: "onchain", sign: 1, base: 1.0, vol: 0.03, weight: 1 },
  { id: "BTC_ACTIVE", name: "BTC active addresses", panel: "onchain", sign: 1, base: 950000, vol: 0.06, weight: 1 },
  { id: "ETH_TREND", name: "ETH price trend", panel: "onchain", sign: 1, base: 3200, vol: 0.07, weight: 1.1 },
  { id: "BTC_ETH", name: "BTC/ETH ratio", panel: "onchain", sign: 1, base: 18, vol: 0.04, weight: 0.9 },
];

const WINDOW = 90; // rolling percentile window (days)
const RISK_OFF = 0.33;
const RISK_ON = 0.67;

// Deterministic LCG so the seeded series is reproducible across runs/machines.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Mean-reverting random walk for one indicator.
function series(def: IndicatorDef, n: number, rand: () => number): number[] {
  const out: number[] = [];
  let v = def.base;
  for (let i = 0; i < n; i++) {
    const shock = (rand() - 0.5) * 2 * def.vol * def.base;
    v += shock + (def.base - v) * 0.05; // pull back toward base
    out.push(v);
  }
  return out;
}

function percentileOf(value: number, window: number[]): number {
  if (window.length <= 1) return 0.5;
  const below = window.filter((x) => x <= value).length;
  return below / window.length;
}

function label(score: number): "risk_off" | "neutral" | "risk_on" {
  if (score < RISK_OFF) return "risk_off";
  if (score >= RISK_ON) return "risk_on";
  return "neutral";
}

function dateNDaysBefore(asof: string, daysAgo: number): string {
  // asof is YYYY-MM-DD; compute earlier date without Date.now()
  const [y, m, d] = asof.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) - daysAgo * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// Compute a full regime history of `historyDays` snapshots ending at `asof`
// (inclusive). Seeded so output is deterministic for a given asof.
export function computeRegimeHistory(asof: string, historyDays = 120): RegimeSnapshot[] {
  const total = WINDOW + historyDays;
  // Seed from asof so the same date reproduces the same series.
  const seed = Number(asof.replace(/-/g, "")) % 2147483647;
  const rand = lcg(seed || 1);
  const allSeries = INDICATORS.map((def) => series(def, total, rand));
  const weightSum = INDICATORS.reduce((a, d) => a + d.weight, 0);

  const compositeHistory: number[] = [];
  const snapshots: RegimeSnapshot[] = [];

  for (let t = WINDOW; t < total; t++) {
    const readings: IndicatorReading[] = INDICATORS.map((def, idx) => {
      const window = allSeries[idx].slice(t - WINDOW, t);
      const value = allSeries[idx][t];
      const pct = percentileOf(value, window);
      const score = def.sign === 1 ? pct : 1 - pct;
      return { id: def.id, name: def.name, panel: def.panel, sign: def.sign, value, score, weight: def.weight };
    });

    const composite = readings.reduce((a, r) => a + r.score * r.weight, 0) / weightSum;
    compositeHistory.push(composite);
    const compositePercentile = percentileOf(composite, compositeHistory);

    const panelScore = (panel: "macro" | "onchain") => {
      const rs = readings.filter((r) => r.panel === panel);
      const w = rs.reduce((a, r) => a + r.weight, 0);
      return rs.reduce((a, r) => a + r.score * r.weight, 0) / w;
    };
    const macro = panelScore("macro");
    const onchain = panelScore("onchain");

    const percentiles: Record<string, number> = {};
    for (const r of readings) percentiles[r.id] = Number(r.score.toFixed(4));

    snapshots.push({
      date: dateNDaysBefore(asof, total - 1 - t),
      composite: Number(composite.toFixed(4)),
      compositePercentile: Number(compositePercentile.toFixed(4)),
      regime: label(composite),
      macroRegime: label(macro),
      onchainRegime: label(onchain),
      factorRegime: null,
      percentiles,
      indicators: readings.map((r) => ({ ...r, value: Number(r.value.toFixed(4)), score: Number(r.score.toFixed(4)) })),
    });
  }
  return snapshots;
}
