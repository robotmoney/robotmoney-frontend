// Store stage: persist a research signal to research_signals, keyed by signal +
// date. Upserts on the natural key so re-running a slot overwrites rather than
// duplicates. The only SQL write for research payloads.
import { sql } from "../../db/client.ts";
import type { ResearchPayload } from "../analyze/research.ts";

export async function persistResearchSignal(key: string, asof: string, payload: ResearchPayload): Promise<void> {
  await sql`
    INSERT INTO research_signals (signal_key, date, payload)
    VALUES (${key}, ${asof}, ${sql.json(payload)})
    ON CONFLICT (signal_key, date) DO UPDATE SET payload = EXCLUDED.payload`;
}
