// The remediation DISPATCHER and the Class C day executor (issue #709,
// docs/technical/markets-asset-pricing-ingest.md §4.1 and §5).
//
// This is where `remediationClass` stops being a label and becomes behaviour.
// Before this file, ops/series-registry.ts declared a class for every series and
// nothing anywhere branched on it: `detectAllGaps` had exactly ONE production
// caller, the read-only GET /api/admin/gaps. The pipeline could see its holes
// and had no way to close them.
//
// SELF-HEALING MEANS SCHEDULED, NOT MANUAL. `ops.repair_gaps` is an ordinary
// seeded cron row (db/seed.ts) claimed by the analytics lane like every other
// producer. It re-derives the work list FROM THE DATA on every run, so a gap
// that appears for any reason — a wedged scheduler, an RPC outage, a fresh
// database whose bootstrap postdates the series start — is found and closed by
// the running system. Nothing about repair lives in a migration or a one-shot
// script.
//
// CONVERGENCE, NOT A BURST. One run enqueues at most
// WALLET_BACKFILL_MAX_DAYS_PER_RUN days, because the reads are metered against a
// per-IP RPC budget shared with the live sampler. A wide gap closes over
// successive runs, and what a run deferred is REPORTED in its output rather than
// silently dropped.
import { sql } from "../../db/worker-client.ts";
import { detectAllGaps } from "../../ops/gap-detector.ts";
import {
  assertRpcBudgetConfigured,
  backfillWalletDay as runBackfillDay,
  backfillWalletWindow as runBackfillWindow,
  BACKFILLED_SERIES,
  maxDaysPerRun,
  planWalletBackfill,
} from "../../ops/wallet-backfill.ts";

const BACKFILL_KIND = "wallet.backfill_day";
const WINDOW_KIND = "wallet.backfill_window";

/** Whether this deployment may dispatch repair work. See the note in
 *  repairGaps: under a live RPC source the shared rate budget must be
 *  configured first (PD6); under the hermetic stub there is no provider bucket
 *  to exhaust, so nothing is gated. */
function backfillEnabled(): boolean {
  try {
    assertRpcBudgetConfigured();
    return true;
  } catch {
    return false;
  }
}

/**
 * `ops.repair_gaps` — detect, then DISPATCH BY CLASS.
 *
 * Class C (chain-derived) is the class this issue makes repairable: one
 * `{asof}` job per missing day. Classes A and B are reported here rather than
 * silently omitted, so the dispatcher's coverage is visible in job_runs instead
 * of being something a reader has to infer from absence:
 *
 *   - Class A (`raw_indicator_history`) now self-heals the same way Class B
 *     does: the independent producer's `catchUpMissedIndicatorDays`
 *     (src/producer/index.ts, issue #646) re-fetches the live indicator
 *     registry and writes back only the gap dates, through
 *     GET /api/analytics/raw-history/gaps — the same shared gap detector this
 *     dispatcher reads, not a second notion of "which dates are missing".
 *     Named here rather than silently omitted, same as Class B, because this
 *     dispatcher still dispatches neither.
 *   - Class B (`research_signals`) already self-heals through the independent
 *     producer's own catch-up, which computes its own missing-days set. Unifying
 *     those two notions of "which days are missing" is tracked in markets §4.1 and is
 *     deliberately not done here.
 */
export async function repairGaps(): Promise<unknown> {
  // THE PD6 PRECONDITION, WHICH IS NO LONGER AN OPT-IN. A live backfill must
  // never run unpaced against a per-IP-metered provider, so the driver refuses
  // when pacing is off. It used to be off by DEFAULT — the budget had to be
  // measured and set before repair did anything, which meant the ordinary
  // deployment ran this dispatcher hourly and healed nothing. The transport now
  // paces from a conservative hardcoded default
  // (chain/base-rpc-client.ts::DEFAULT_RATE_PER_SEC, half the markets §3.4 measured
  // refill), so this check passes unless an operator has explicitly set
  // BASE_RPC_MAX_CALLS_PER_SEC=0. Rather than let each enqueued day discover
  // that and fail, the dispatcher checks once and reports it.
  if (!backfillEnabled()) {
    const reports = await detectAllGaps(sql);
    return {
      ok: true,
      status: "skipped",
      reason:
        "BASE_RPC_MAX_CALLS_PER_SEC=0 — pacing is explicitly disabled, and the backfill shares the live sampler's per-IP RPC budget, so it will not run unpaced (PD6, #651). Unset the variable to use the conservative default.",
      dirtySeries: reports.filter((r) => !r.clean).map((r) => r.key),
    };
  }

  const reports = await detectAllGaps(sql);
  const dirty = reports.filter((r) => !r.clean);

  const classC = dirty.filter((r) => r.remediationClass === "C").map((r) => r.key);
  const classA = dirty.filter((r) => r.remediationClass === "A").map((r) => r.key);
  const classB = dirty.filter((r) => r.remediationClass === "B").map((r) => r.key);

  // Only the two wallet series have an executor. Other Class C series (vault
  // hourly samples, the projects daily rollups) are chain- or state-derived in
  // ways this executor does not cover, and are listed as unhandled rather than
  // quietly counted as dispatched.
  const covered = new Set<string>(BACKFILLED_SERIES);
  const unhandledClassC = classC.filter((k) => !covered.has(k));

  const plan = await planWalletBackfill(sql);

  // ONE WINDOW JOB, NOT N DAY JOBS — because the provider meters HTTP hits and
  // the two costs a day carries are both shareable. Ten separate day jobs each
  // resolved their own block from `latest` (~5 hits apiece) and each loaded
  // their own day of prices; a window resolves all ten in lockstep (~4 hits
  // total) and loads the price range once. The per-day guarantees are untouched:
  // the executor still writes each day in its own transaction with its own
  // checkpoint, and each day still fails alone.
  //
  // No dedupe_key: that index is UNIQUE across the WHOLE jobs table including
  // terminal rows, so a dedupe_key would make a day that once failed permanently
  // un-retryable — the exact opposite of self-healing. Duplicate work is
  // prevented by skipping days a live job already covers, and the executor is
  // idempotent regardless (it never writes a non-empty day).
  const [liveWindow] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM jobs
     WHERE kind = ${WINDOW_KIND}
       AND status IN ('pending', 'running')
  `;
  // Legacy per-day rows may still be in flight from a pre-upgrade dispatcher.
  // Their days are excluded rather than repaired twice.
  const liveDays = await sql<{ asof: string }[]>`
    SELECT payload->>'asof' AS asof
      FROM jobs
     WHERE kind = ${BACKFILL_KIND}
       AND status IN ('pending', 'running')
  `;
  const claimed = new Set(liveDays.map((r) => r.asof));
  const days = (liveWindow?.n ?? 0) > 0 ? [] : plan.days.filter((d) => !claimed.has(d));
  let enqueued = 0;
  if (days.length > 0) {
    await sql`
      INSERT INTO jobs (kind, payload)
      VALUES (${WINDOW_KIND}, ${sql.json({ dates: days })})
    `;
    enqueued = 1;
  }

  return {
    ok: true,
    dirtySeries: dirty.map((r) => r.key),
    dispatched: { classC: days, enqueued, kind: WINDOW_KIND },
    deferredDays: plan.deferred,
    totalMissingDays: plan.totalMissing,
    retryingDays: plan.retrying,
    // Days that hit the attempt ceiling. Reported EVERY run, not just the run
    // that exhausted them: a cap that silences itself reads as "covered
    // everything" when it did not.
    exhaustedDays: plan.exhausted,
    perRunCap: maxDaysPerRun(),
    unhandled: {
      // Named, not omitted — an undispatched class must be as visible as an
      // unrepaired day (markets §9's standing warning about ticked-but-unimplemented).
      classA: classA.length > 0 ? { series: classA, tracking: "producer catch-up owns Class A (#646, src/producer/index.ts::catchUpMissedIndicatorDays)" } : null,
      classB: classB.length > 0 ? { series: classB, tracking: "producer catch-up owns Class B (regime-engine.md §11.4)" } : null,
      classC: unhandledClassC.length > 0 ? { series: unhandledClassC, tracking: "no executor for these Class C series" } : null,
    },
  };
}

/**
 * `wallet.backfill_day` — repair exactly one day.
 *
 * Takes `{asof}` in the payload, which is the house shape already:
 * worker/handlers/analytics.ts:24-25 reads `payload.asof` the same way.
 *
 * NOTE ON `slotAt`: this handler deliberately does NOT call classifySlot. That
 * helper declines a past-bucket slot because a `latest`-pinned read cannot
 * honestly answer for a past day — which is precisely the premise #709 changes
 * for THIS handler and no other. Reading a past day at its own block is not a
 * replay of a stale slot; it is the whole job.
 */
export async function backfillWalletDay(payload: Record<string, unknown> = {}): Promise<unknown> {
  const asof = payload.asof;
  if (typeof asof !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asof)) {
    throw new Error(`${BACKFILL_KIND}: payload.asof must be an ISO calendar day, got ${JSON.stringify(asof)}`);
  }
  // A day that could not be read honestly must surface as a FAILED run, not a
  // succeeded one with a quiet note. worker/loop.ts's isDegradedResult matches
  // `ok === false`, and the wallet samplers' inability to do this is exactly the
  // alerting gap #651 records — a chain-read storm that recorded
  // status='succeeded' with no retry and no alert.
  return await runBackfillDay(sql, asof);
}

/**
 * `wallet.backfill_window` — repair a window of days in as few HTTP hits as the
 * work allows. The kind the dispatcher now enqueues; `wallet.backfill_day` above
 * is retained so rows enqueued by a pre-upgrade dispatcher still drain.
 *
 * ONE JOB IS NOT ONE OUTCOME. The window is a batching unit, and the result
 * reports each day's own status — the run is degraded if ANY day failed, so a
 * window that repaired nine days and lost one still surfaces as a failed run
 * rather than a succeeded one with a quiet note. That is the same rule the
 * per-day handler follows and the same alerting gap #651 records.
 */
export async function backfillWalletWindow(payload: Record<string, unknown> = {}): Promise<unknown> {
  const dates = payload.dates;
  if (!Array.isArray(dates) || dates.length === 0) {
    throw new Error(`${WINDOW_KIND}: payload.dates must be a non-empty array, got ${JSON.stringify(dates)}`);
  }
  for (const d of dates) {
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new Error(`${WINDOW_KIND}: payload.dates entries must be ISO calendar days, got ${JSON.stringify(d)}`);
    }
  }
  const results = await runBackfillWindow(sql, dates as string[]);
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    days: results.length,
    filled: results.filter((r) => r.status === "filled").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: failed.length,
    exhausted: results.filter((r) => r.status === "exhausted").length,
    results,
    // worker/loop.ts's degrade path reads `error` for the job_runs text, so the
    // reason a window is degraded is durable and greppable rather than only in
    // the per-day console lines.
    ...(failed.length > 0
      ? { error: `${failed.length}/${results.length} day(s) unrepaired: ${failed.map((r) => `${r.sampleDate} (${r.detail ?? r.status})`).join("; ")}` }
      : {}),
  };
}
