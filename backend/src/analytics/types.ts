// Leaf types shared across every analytics stage (access → extract → transform →
// analyze → store → report). No I/O, no logic — just the series shapes that flow
// through the pipeline, so each stage can be imported and tested in isolation.

export interface SeriesSpec {
  id: string; // canonical series id (e.g. "VIX", "BTC", "QQQ")
  base: number; // central level
  vol: number; // step volatility as a fraction of base
  drift?: number; // small per-step drift fraction
}

export interface Point { date: string; value: number; }
