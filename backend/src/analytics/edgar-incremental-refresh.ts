// Orchestration for the EDGAR/MNA research refresh. Ties together the pure
// planners (extract/edgar-fetch-plan.ts) and the EDGAR HTTP client
// (extract/edgar.ts) under ONE absolute hard deadline, per run: pick a tier
// (`selectEdgarRefreshTier`, below), plan that tier's months, fetch each
// planned month, validate the batch as a whole, and report an honest
// outcome. No I/O beyond the injected `fetchMonth` — no SQL, no analytics
// store writer, no persistence call: the caller (analytics/index.ts, which
// owns the AnalyticsPersistence port) decides what to submit and when, so
// this module stays inside the updater/orchestrator boundary scanned by
// tests/analytics-api-boundary.test.ts.
//
// TWO-TIER DESIGN (see docs/v0-v1-quant-platform-parity-report.md, finding
// 1.10 / Phase R item R6, and extract/edgar-fetch-plan.ts's header comment
// for the full history of why):
//
//   Tier 1 — INCREMENTAL, every run (daily, from PRODUCER_RESEARCH_CRON —
//   see ../../producer/index.ts): plan only the months missing from the
//   persisted floor plus a small trailing revision window
//   (`planEdgarFetchIncremental` / EDGAR_REVISION_WINDOW_MONTHS). Cheap — a
//   handful of EDGAR requests, not ~200.
//
//   Tier 2 — FULL, periodically: plan the ENTIRE [EDGAR_FLOOR_START, asof]
//   range (`planEdgarFetch`, unchanged from the first R6 commit) so an
//   EDGAR back-revision to ANY historical month, however old, still lands —
//   just on a bounded periodic cadence instead of every single run. Which
//   `asOf` dates get the full tier is decided by `selectEdgarRefreshTier`
//   below: currently, once a week (EDGAR_FULL_SWEEP_WEEKDAY_UTC), which
//   bounds revision staleness to at most ~7 days — far tighter than the
//   original 2-month window this whole audit exists to fix, and ~7x cheaper
//   than a full crawl every day (the first R6 commit's over-correction).
//
// A weekly in-cron gate (option (a) from the R6 follow-up review) was
// chosen over a second independently-schedulable cron entry (option (b)):
// `producer/index.ts` has no precedent for a "same job, different mode on
// different days" cron today, but a single extra `PRODUCER_*_CRON` env var
// plus a second `schedule()` arm call is more moving parts (two timers,
// two failure/retry paths, two things to keep in sync with
// EDGAR_FLOOR_START) for a periodic reconciliation that only needs to run
// on a coarse, fixed cadence — a pure function of `asOf` is simpler, still
// fully unit-testable without a clock or a cron parser, and keeps the
// EDGAR sweep entirely inside the SAME daily research run the rest of this
// module already reasons about (one hard deadline, one honesty model, one
// log line).
//
// HONESTY MODEL (preserved from issue #109, independent of tier/window
// size): if the deadline is hit or ANY planned month comes back
// missing/duplicated/invalid/out-of-range, the WHOLE refresh degrades — no
// partial batch is ever returned as `newRows`. The caller retains its
// last-good persisted floor and research signal by simply not submitting
// anything this run (see analytics/index.ts:330-342).
import { fetchEdgarMonthCount } from "./extract/edgar.ts";
import {
  planEdgarFetch,
  planEdgarFetchIncremental,
  validateEdgarBatch,
  EDGAR_FLOOR_START,
  EDGAR_REVISION_WINDOW_MONTHS,
} from "./extract/edgar-fetch-plan.ts";
import type { EdgarPointRow } from "./extract/edgar-fetch-plan.ts";
import type { Point } from "./types.ts";

export type EdgarRefreshStatus = "up-to-date" | "updated" | "degraded";
export type EdgarRefreshTier = "incremental" | "full";

// The UTC weekday (0=Sunday .. 6=Saturday) on which the daily research run
// upgrades from Tier 1 (incremental) to Tier 2 (full reconciliation sweep).
// Sunday is off the beaten path for any human watching production dashboards
// on a weekday cadence, and — since this is a pure function of `asOf`, not
// wall-clock `now` — the choice is fully deterministic and replay-safe (the
// SAME asOf always selects the SAME tier, e.g. for AC7 idempotency replay).
export const EDGAR_FULL_SWEEP_WEEKDAY_UTC = 0; // Sunday

// PURE, deterministic given `asOf` alone (never wall-clock `now`) — so a
// replayed/backfilled run for a past `asOf` always makes the SAME tier
// choice a live run for that date would have made. Exported so the
// orchestrator (analytics/index.ts, which must size the deadline BEFORE
// invoking the fetch loop) and this module's own default tier selection
// below always agree — one function, two call sites, never allowed to
// drift apart.
export function selectEdgarRefreshTier(
  asOf: string,
  fullSweepWeekdayUtc: number = EDGAR_FULL_SWEEP_WEEKDAY_UTC,
): EdgarRefreshTier {
  const weekday = new Date(`${asOf}T00:00:00Z`).getUTCDay();
  return weekday === fullSweepWeekdayUtc ? "full" : "incremental";
}

// Tier 1 (incremental) hard-deadline budget: a handful of months (missing
// + the trailing revision window), at v0's own request pacing (250ms
// politeness delay + a normal EDGAR FTS round trip of a few hundred ms).
// Sized generously above what a realistic day-to-day sweep needs — even
// several days/weeks of producer downtime piling up missing months is
// nowhere near Tier 2's ~200-month range — while staying well below Tier
// 2's budget, so a genuinely-stuck EDGAR endpoint degrades THIS run
// quickly rather than tying up a request-sized budget for minutes.
export const DEFAULT_EDGAR_INCREMENTAL_DEADLINE_MS = 90_000; // 90 seconds

// Tier 2 (full reconciliation sweep) hard-deadline budget: EVERY month in
// [EDGAR_FLOOR_START, asof] (~200 months as of 2026, growing by 12/year).
// ~200 months * (250ms politeness delay + a normal EDGAR FTS round trip of
// a few hundred ms) is on the order of a few minutes end to end, plus slack
// for retries/backoff on a handful of slow months. This tier runs once a
// week (EDGAR_FULL_SWEEP_WEEKDAY_UTC), not daily, so the only cost of a
// generous budget is how long a genuinely-broken WEEKLY run degrades before
// giving up — the same tradeoff the first R6 commit made when this budget
// applied to every run, just now paid 1/7th as often.
export const DEFAULT_EDGAR_FULL_SWEEP_DEADLINE_MS = 15 * 60_000; // 15 minutes

// Single source of truth mapping a tier to its default deadline budget —
// callers that need to size a deadline BEFORE the fetch loop starts (e.g.
// analytics/index.ts, which must pass an absolute `deadlineAt` into
// `fetchResearchInputs`) use this instead of hand-copying the tier→constant
// mapping at each call site.
export function defaultEdgarRefreshDeadlineMs(tier: EdgarRefreshTier): number {
  return tier === "full" ? DEFAULT_EDGAR_FULL_SWEEP_DEADLINE_MS : DEFAULT_EDGAR_INCREMENTAL_DEADLINE_MS;
}

export interface EdgarRefreshOutcome {
  status: EdgarRefreshStatus;
  tier: EdgarRefreshTier; // which tier this run actually planned/executed
  plannedMonths: number;
  // Planned months NOT already in the persisted floor (genuinely new) vs
  // already-persisted months re-fetched for the trailing revision window
  // (tier "incremental") or the periodic full sweep (tier "full") — issue
  // #109 AC9's "planned/.../revised/..." metrics.
  newMonths: number;
  revisedMonths: number;
  fetchedMonths: number; // planned months successfully fetched + validated this run
  missingMonths: number; // planned months with no usable response (unrecovered/canceled)
  rejectedMonths: number; // planned months with a response that failed validation
  reason?: string;
  // The freshly-fetched rows ONLY (never the whole merged series) — empty
  // unless status === "updated". The caller submits these (and only these)
  // to the persisted raw floor.
  newRows: EdgarPointRow[];
}

export interface EdgarIncrementalRefreshOptions {
  asOf: string;
  // YYYY-MM keys already present in the persisted floor. Tier "incremental"
  // uses this to NARROW the plan (only missing + revisable months); tier
  // "full" ignores it for planning purposes (the whole range is planned
  // regardless) but it is still used to split the plan's `newMonths` vs
  // `revisedMonths` reporting metrics below.
  persistedMonths: readonly string[];
  deadlineAt: number; // absolute cutoff (same clock as `now`) — the hard deadline
  floorStart?: string;
  // Explicit tier override — mainly for tests and any future operator-
  // triggered "force a full reconciliation now" path. Defaults to
  // `selectEdgarRefreshTier(asOf)`, the normal production behavior.
  tier?: EdgarRefreshTier;
  revisionWindowMonths?: number; // tier "incremental" only; defaults to EDGAR_REVISION_WINDOW_MONTHS
  perMonthTimeoutMs?: number; // default 15000
  requestDelayMs?: number; // politeness delay between requests; default 250ms
  fetchMonth?: typeof fetchEdgarMonthCount; // injectable — tests supply deterministic/fake-clock doubles
  now?: () => number; // injectable clock — tests drive this to make the deadline test fake-clock deterministic
  logger?: { log?: (m: string) => void; warn?: (m: string) => void };
}

export async function refreshEdgarIncremental(opts: EdgarIncrementalRefreshOptions): Promise<EdgarRefreshOutcome> {
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? console;
  const fetchMonth = opts.fetchMonth ?? fetchEdgarMonthCount;
  const perMonthTimeoutMs = opts.perMonthTimeoutMs ?? 15000;
  const requestDelayMs = opts.requestDelayMs ?? 250;
  const floorStart = opts.floorStart ?? EDGAR_FLOOR_START;
  const tier = opts.tier ?? selectEdgarRefreshTier(opts.asOf);

  const plan =
    tier === "full"
      ? planEdgarFetch({ asOf: opts.asOf, floorStart })
      : planEdgarFetchIncremental({
          asOf: opts.asOf,
          persistedMonths: opts.persistedMonths,
          floorStart,
          revisionWindowMonths: opts.revisionWindowMonths ?? EDGAR_REVISION_WINDOW_MONTHS,
        });

  if (plan.length === 0) {
    logger.log?.(`[edgar] MNA refresh (${tier}): up to date — 0 month(s) planned, 0 request(s)`);
    return {
      status: "up-to-date",
      tier,
      plannedMonths: 0,
      newMonths: 0,
      revisedMonths: 0,
      fetchedMonths: 0,
      missingMonths: 0,
      rejectedMonths: 0,
      newRows: [],
    };
  }

  const persistedSet = new Set(opts.persistedMonths);
  const newMonths = plan.filter((m) => !persistedSet.has(m.monthStart.slice(0, 7))).length;
  const revisedMonths = plan.length - newMonths;

  const fetched: (Point | null)[] = [];
  let abortedByDeadline = false;
  for (let i = 0; i < plan.length; i++) {
    if (now() >= opts.deadlineAt) {
      abortedByDeadline = true;
      break;
    }
    const month = plan[i]!;
    const remaining = opts.deadlineAt - now();
    const timeoutMs = Math.max(0, Math.min(perMonthTimeoutMs, remaining));
    if (timeoutMs <= 0) {
      abortedByDeadline = true;
      break;
    }
    const count = await fetchMonth(month.monthStart, month.monthEnd, timeoutMs, logger, undefined, opts.deadlineAt);
    fetched.push(count == null ? null : { date: month.monthEnd, value: count });

    // Politeness delay between requests — capped so it can never itself carry
    // the sweep past the deadline (no sleep continues after cancellation).
    const isLast = i === plan.length - 1;
    if (!isLast && requestDelayMs > 0) {
      const budget = opts.deadlineAt - now();
      if (budget <= 0) {
        abortedByDeadline = true;
        break;
      }
      await new Promise<void>((r) => setTimeout(r, Math.min(requestDelayMs, budget)));
    }
  }
  // Anything never attempted (deadline hit mid-loop) counts as missing —
  // validated below, so an aborted sweep always degrades rather than
  // silently truncating the batch.
  while (fetched.length < plan.length) fetched.push(null);

  const missingBeforeValidation = fetched.filter((p) => p == null).length;
  if (abortedByDeadline) {
    const reason = `hard deadline exceeded — ${missingBeforeValidation} of ${plan.length} planned month(s) unfetched`;
    logger.warn?.(`[edgar] MNA refresh (${tier}) DEGRADED: ${reason} — retaining last-good, no partial commit`);
    return {
      status: "degraded",
      tier,
      plannedMonths: plan.length,
      newMonths,
      revisedMonths,
      fetchedMonths: plan.length - missingBeforeValidation,
      missingMonths: missingBeforeValidation,
      rejectedMonths: 0,
      reason,
      newRows: [],
    };
  }

  const validation = validateEdgarBatch(plan, fetched, { floorStart, asOf: opts.asOf });
  if (!validation.ok) {
    logger.warn?.(
      `[edgar] MNA refresh (${tier}) DEGRADED: ${validation.reason} — missing=${validation.missingCount} rejected=${validation.rejectedCount} — retaining last-good, no partial commit`,
    );
    return {
      status: "degraded",
      tier,
      plannedMonths: plan.length,
      newMonths,
      revisedMonths,
      fetchedMonths: plan.length - validation.missingCount - validation.rejectedCount,
      missingMonths: validation.missingCount,
      rejectedMonths: validation.rejectedCount,
      reason: validation.reason,
      newRows: [],
    };
  }

  logger.log?.(
    `[edgar] MNA refresh (${tier}): planned=${plan.length} new=${newMonths} revised=${revisedMonths} fetched=${validation.rows.length} missing=0 rejected=0 status=updated`,
  );
  return {
    status: "updated",
    tier,
    plannedMonths: plan.length,
    newMonths,
    revisedMonths,
    fetchedMonths: validation.rows.length,
    missingMonths: 0,
    rejectedMonths: 0,
    newRows: validation.rows,
  };
}
