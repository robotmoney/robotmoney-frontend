// Analyze stage: the shape of a research signal. A research signal is a small set
// of named gauges (each a value + 0..1 percentile + a human read) plus one
// representative series for charting. Pure types — no I/O; the store stage
// persists this payload to research_signals by key.

export interface Gauge { id: string; name: string; value: number; percentile: number; read: string; }
export interface ResearchPayload {
  asof: string;
  title: string;
  question: string;
  spec: Record<string, unknown>;
  gauges: Gauge[];
  series: { label: string; points: { date: string; value: number }[] };
}
