import parser from "cron-parser";
import { jsonValue, sql } from "../db/worker-client.ts";

interface ScheduleRow {
  id: number;
  kind: string;
  cron: string;
  payload: Record<string, unknown>;
  timezone: string;
  next_run_at: Date | null;
}

// Catch-up is bounded per tick so one wedged schedule can't hold the
// transaction (and therefore every other schedule's SKIP LOCKED row) open
// indefinitely. A schedule left behind by more than this many slots simply
// takes several ticks to fully drain — see the CLAMP note below for why that
// bound never leaves next_run_at pinned on a single stale value between
// ticks, unlike the pre-#614 loop it replaces.
const MAX_SLOTS_PER_TICK = 1000;

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
      // enqueued at most once, and the slot's OWN timestamp rides along in the
      // payload (issue #614 AC2) so a handler that can honour a target date
      // knows which slot it is filling in for rather than always writing
      // `new Date()`.
      const it = parser.parseExpression(s.cron, { tz: s.timezone, currentDate: new Date(s.next_run_at.getTime() - 1000) });
      let nextRun = new Date(s.next_run_at);
      for (let guard = 0; guard < MAX_SLOTS_PER_TICK; guard++) {
        const slotDate = it.next().toDate();
        if (slotDate > now) { nextRun = slotDate; break; }
        const slot = slotDate.toISOString().slice(0, 16).replace(/[-:T]/g, "");
        const payload = { ...s.payload, slotAt: slotDate.toISOString() };
        const inserted = await tx`
          INSERT INTO jobs (kind, payload, dedupe_key)
          VALUES (${s.kind}, ${tx.json(jsonValue(payload))}, ${`${s.kind}:${slot}`})
          ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
          RETURNING id`;
        if (inserted.length > 0) enqueued++;
        // CLAMP (issue #614): advance the cursor to the slot just processed on
        // EVERY iteration, not only when the loop breaks on `slotDate > now`.
        // Before this fix `nextRun` never changed inside the loop body, so a
        // schedule more than MAX_SLOTS_PER_TICK slots behind (16h40m for a
        // per-minute cron, ~41 days for hourly) exhausted the guard with
        // `nextRun` still equal to the schedule's ORIGINAL next_run_at, and the
        // trailing UPDATE wrote that unchanged past value straight back —
        // leaving the row permanently due, so every later tick re-attempted the
        // SAME first MAX_SLOTS_PER_TICK slots (all dedupe-suppressed, zero new
        // enqueues) forever and never advanced. Tracking progress here instead
        // means an overflowing schedule keeps draining a fresh batch of slots
        // tick over tick until it reaches `now` — next_run_at moves forward on
        // every tick and can never be left pinned on a single stale value.
        nextRun = slotDate;
      }
      await tx`UPDATE job_schedules SET last_enqueued_at = now(), next_run_at = ${nextRun} WHERE id = ${s.id}`;
    }
    return enqueued;
  });
}
