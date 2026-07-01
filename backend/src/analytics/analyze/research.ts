// Analyze stage: the shape of a research signal. A research signal is a small set
// of named gauges (each a value + 0..1 percentile + a human read) plus one
// representative series for charting. Pure types — no I/O; the store stage
// persists this payload to research_signals by key.

export interface Gauge { id: string; name: string; value: number; percentile: number; read: string; }

// One dated point in a research indicator series (value nullable for pre-history
// / gaps, matching the original JSON artifacts).
export type ResearchPoint = { date: string; value: number | null };

export interface ResearchPayload {
  asof: string;
  title: string;
  question: string;
  spec: Record<string, unknown>;
  gauges: Gauge[];
  series: { label: string; points: { date: string; value: number }[] };
  // ── richer, original-shaped fields (optional; populated by the real
  // production signals in research-signals.ts, absent from the hermetic seeded
  // tools). Surfaced through the extended contract DTO. ──
  indicators?: Record<string, ResearchPoint[]>; // full per-indicator series
  summary?: Record<string, unknown>; // latest + trend summary
  btc_price?: ResearchPoint[]; // channel-divergence overlay
  qqq_price?: ResearchPoint[]; // channel-divergence overlay
  spy_price?: ResearchPoint[]; // late-cycle overlay
}
