import parser from "cron-parser";
import { sql } from "../db/client.ts";

interface ScheduleRow {
  id: number;
  kind: string;
  cron: string;
  payload: Record<string, unknown>;
  timezone: string;
  next_run_at: Date | null;
}

// Enqueue jobs for any schedule whose next_run_at is due, then advance
// next_run_at to the following cron occurrence. Multiple schedulers are safe:
// rows are claimed with SKIP LOCKED, and the dedupe_key (kind + slot minute)
// guarantees a given slot enqueues at most once.
export async function tickScheduler(): Promise<number> {
  return await sql.begin(async (tx) => {
    const due = await tx<ScheduleRow[]>`
      SELECT id, kind, cron, payload, timezone, next_run_at
        FROM job_schedules
       WHERE enabled AND (next_run_at IS NULL OR next_run_at <= now())
       FOR UPDATE SKIP LOCKED
    `;

    let enqueued = 0;
    for (const s of due) {
      const interval = parser.parseExpression(s.cron, { tz: s.timezone });
      // The slot we are firing for: the most recent past occurrence.
      const prev = interval.prev().toDate();
      const slot = (s.next_run_at ?? prev).toISOString().slice(0, 16).replace(/[-:T]/g, "");
      const dedupeKey = `${s.kind}:${slot}`;

      const inserted = await tx`
        INSERT INTO jobs (kind, payload, dedupe_key)
        VALUES (${s.kind}, ${tx.json(s.payload)}, ${dedupeKey})
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id
      `;
      if (inserted.length > 0) enqueued++;

      // Advance to the next future occurrence.
      const nextInterval = parser.parseExpression(s.cron, { tz: s.timezone });
      const next = nextInterval.next().toDate();
      await tx`UPDATE job_schedules
                  SET last_enqueued_at = now(), next_run_at = ${next}
                WHERE id = ${s.id}`;
    }
    return enqueued;
  });
}
