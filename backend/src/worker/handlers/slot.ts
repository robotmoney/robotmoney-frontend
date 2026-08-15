// Shared slot-replay helper for Class C (NOT_BACKFILLABLE) handlers — issue
// #614 AC2.
//
// worker/scheduler.ts now carries the SLOT'S OWN timestamp in every enqueued
// job's payload (`payload.slotAt`), including catch-up slots replayed after
// downtime. Most handlers can and should honour that target date. But a
// Class C sampler reads CURRENT chain/market state — chain reads are pinned
// to `"latest"` against a non-archive RPC endpoint
// (chain/base-rpc-client.ts), and prices are spot-only
// (chain/token-prices.ts) — so there is no way to answer "what was this on
// 2026-08-05" other than by asking "what is it right now" and mislabeling the
// answer. Before #614 every one of these handlers ignored its payload
// entirely and called `new Date()`, so a slot replayed three days late
// silently overwrote TODAY's row with today's data under today's key — the
// stale slot did nothing wrong, but it did nothing useful either, and the
// schedule's `next_run_at` advancing past the missed days looked exactly like
// those days had been sampled.
//
// The fix is NOT to blanket-decline every replayed slot, though: whether a
// replay is honest depends on which BUCKET (calendar day, or UTC hour for an
// hourly sampler) it targets, not merely on how late it fires.
//
//   - Still the CURRENT bucket (e.g. a slot for today, fired late in the day
//     after a few hours of scheduler wedge): a live read taken RIGHT NOW is
//     exactly as truthful for that bucket as an on-time sample would have
//     been — "today" is still today. Declining this would just re-create the
//     "catch-up that doesn't catch up the data" trap AC2 calls out: the
//     schedule would advance past the slot while the DATA stayed missing
//     until the next on-time tick happened to land. So this case PROCEEDS —
//     but is tagged distinctly ('backfilled', not 'live') so a consumer can
//     tell it was a late catch-up rather than the nominal scheduled sample
//     (issue #614 AC4 "Backfilled rows are distinguishable from 'live'").
//   - A PAST bucket (a slot for yesterday, or an hour that has already
//     closed): a read taken now cannot honestly represent that bucket at
//     all — chain state is pinned to "latest" and prices are spot-only, so
//     there is no way to answer "what was this on 2026-08-05" without
//     fabricating it. This case DECLINES explicitly, with a durable,
//     recorded reason (job_runs.output), and lets the NEXT on-time slot keep
//     writing forward. That is D16-compliant (docs/decisions.md) — it
//     discloses the unrecoverable window instead of fabricating a value for it.
//
// Generous tolerance for ordinary scheduler tick lag / worker restart jitter
// gates BOTH cases: a slot fired a few minutes late is still "now", not a
// replay at all.
export const REPLAY_SLACK_MS = 5 * 60_000;

export type SlotReplayStatus = "on-time" | "same-bucket-catchup" | "past-bucket";
export type SlotCadence = "daily" | "hourly";

function bucketStart(d: Date, cadence: SlotCadence): Date {
  const t = new Date(d.getTime());
  if (cadence === "hourly") t.setUTCMinutes(0, 0, 0);
  else t.setUTCHours(0, 0, 0, 0);
  return t;
}

/**
 * Classify `payload.slotAt` against `now` for a handler of the given
 * cadence. A payload with no (or unparseable) `slotAt` — e.g. an
 * admin-enqueued job, or a job predating #614 — is always "on-time": only
 * the scheduler sets this field, and its absence must not change existing
 * on-time behavior.
 */
export function classifySlot(
  payload: Record<string, unknown>,
  cadence: SlotCadence,
  now: Date = new Date(),
): SlotReplayStatus {
  const slotAt = payload.slotAt;
  if (typeof slotAt !== "string") return "on-time";
  const slotMs = Date.parse(slotAt);
  if (Number.isNaN(slotMs)) return "on-time";
  if (now.getTime() - slotMs <= REPLAY_SLACK_MS) return "on-time";
  return bucketStart(new Date(slotMs), cadence).getTime() === bucketStart(now, cadence).getTime()
    ? "same-bucket-catchup"
    : "past-bucket";
}

/** Convenience boolean for handlers with no same-bucket catch-up path (no
 *  provenance column to tag a 'backfilled' row distinctly, e.g. vault/
 *  projects-daily) — any replay, same-bucket or not, declines. Still fully
 *  D16-honest: it is simply the more conservative of the two valid choices
 *  classifySlot's same-bucket-catchup case allows. */
export function isReplayedSlot(payload: Record<string, unknown>, now: Date = new Date()): boolean {
  const slotAt = payload.slotAt;
  if (typeof slotAt !== "string") return false;
  const slotMs = Date.parse(slotAt);
  if (Number.isNaN(slotMs)) return false;
  return now.getTime() - slotMs > REPLAY_SLACK_MS;
}

/** Standard decline shape for a Class C handler skipping a past-bucket
 *  replayed slot. `ok: true` deliberately — this is not a failure or a
 *  transient degrade (worker/loop.ts's isDegradedResult / retry path), it is
 *  the CORRECT outcome for this input, and job_runs must record it as a
 *  normal succeeded run so it never engages backoff retry (retrying would
 *  just decline again). */
export function declineReplayedSlot(handlerKind: string, payload: Record<string, unknown>): {
  ok: true;
  status: "skipped";
  skipped: true;
  reason: string;
  slotAt: unknown;
} {
  const reason = `Class C (NOT_BACKFILLABLE) — chain state and prices are current-only; declining to rewrite a replayed slot as today's data (docs/decisions.md D16)`;
  console.warn(`[${handlerKind}] declining replayed slot ${String(payload.slotAt)}: ${reason}`);
  return { ok: true, status: "skipped", skipped: true, reason, slotAt: payload.slotAt };
}
