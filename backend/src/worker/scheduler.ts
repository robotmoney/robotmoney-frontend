import parser from "cron-parser";
import { jsonValue, sql } from "../db/client.ts";

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
    const now = new Date();
    for (const s of due) {
      if (s.next_run_at == null) {
        // Brand-new schedule: seed next_run_at to the next FUTURE occurrence
        // without firing a stale past slot.
        const it = parser.parseExpression(s.cron, { tz: s.timezone, currentDate: now });
        await tx`UPDATE job_schedules SET next_run_at = ${it.next().toDate()} WHERE id = ${s.id}`;
        continue;
      }
      // Enqueue EVERY occurrence from the stored slot up to now (catch up missed
      // runs after downtime/tick lag); each slot has its own dedupe_key so it's
      // enqueued at most once. Then store the first future occurrence.
      const it = parser.parseExpression(s.cron, { tz: s.timezone, currentDate: new Date(s.next_run_at.getTime() - 1000) });
      let nextRun = new Date(s.next_run_at);
      for (let guard = 0; guard < 1000; guard++) {
        const slotDate = it.next().toDate();
        if (slotDate > now) { nextRun = slotDate; break; }
        const slot = slotDate.toISOString().slice(0, 16).replace(/[-:T]/g, "");
        const inserted = await tx`
          INSERT INTO jobs (kind, payload, dedupe_key)
          VALUES (${s.kind}, ${tx.json(jsonValue(s.payload))}, ${`${s.kind}:${slot}`})
          ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
          RETURNING id`;
        if (inserted.length > 0) enqueued++;
      }
      await tx`UPDATE job_schedules SET last_enqueued_at = now(), next_run_at = ${nextRun} WHERE id = ${s.id}`;
    }
    return enqueued;
  });
}
