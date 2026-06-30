// Shared shape + persistence for research-signal tools. A research signal is a
// small set of named gauges (each a value + 0..1 percentile + a human read) plus
// one representative series for charting. Persisted to research_signals by key.
import { sql } from "../../db/client.ts";

export interface Gauge { id: string; name: string; value: number; percentile: number; read: string; }
export interface ResearchPayload {
  asof: string;
  title: string;
  question: string;
  spec: Record<string, unknown>;
  gauges: Gauge[];
  series: { label: string; points: { date: string; value: number }[] };
}

export async function persistResearchSignal(key: string, asof: string, payload: ResearchPayload): Promise<void> {
  await sql`
    INSERT INTO research_signals (signal_key, date, payload)
    VALUES (${key}, ${asof}, ${sql.json(payload)})
    ON CONFLICT (signal_key, date) DO UPDATE SET payload = EXCLUDED.payload`;
}
