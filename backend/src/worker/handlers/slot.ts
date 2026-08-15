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
// The fix is not to replay a Class C slot at all: decline it explicitly, with
// a durable, recorded reason (job_runs.output), and let the NEXT on-time slot
// keep writing forward. That is D16-compliant (docs/decisions.md) — it
// discloses the unrecoverable window instead of fabricating a value for it.
// Generous tolerance for ordinary scheduler tick lag / worker restart jitter —
// a slot fired a few minutes late is still "now", not a replay. Anything
// beyond this is a genuine catch-up (the scheduler's overflow guard, a
// downtime window, or an operator-triggered admin retry of a past slot).
export const REPLAY_SLACK_MS = 5 * 60_000;

/**
 * True when `payload.slotAt` is far enough behind `now` that this job is a
 * REPLAYED past slot rather than its own on-time firing. A payload with no
 * `slotAt` (e.g. an admin-enqueued job, or a job predating #614) is never
 * treated as a replay — only the scheduler sets this field, and its absence
 * must not change existing on-time behavior.
 */
export function isReplayedSlot(payload: Record<string, unknown>, now: Date = new Date()): boolean {
  const slotAt = payload.slotAt;
  if (typeof slotAt !== "string") return false;
  const slotMs = Date.parse(slotAt);
  if (Number.isNaN(slotMs)) return false;
  return now.getTime() - slotMs > REPLAY_SLACK_MS;
}

/** Standard decline shape for a Class C handler skipping a replayed slot.
 *  `ok: true` deliberately — this is not a failure or a transient degrade
 *  (worker/loop.ts's isDegradedResult / retry path), it is the CORRECT
 *  outcome for this input, and job_runs must record it as a normal succeeded
 *  run so it never engages backoff retry (retrying would just decline again). */
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
