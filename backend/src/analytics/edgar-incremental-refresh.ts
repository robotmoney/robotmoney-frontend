// Orchestration for the incremental EDGAR/MNA research refresh (issue #109).
// Ties together the pure planner (extract/edgar-fetch-plan.ts) and the EDGAR
// HTTP client (extract/edgar.ts) under ONE absolute hard deadline: plan the
// missing/revisable months against the persisted floor, fetch ONLY those
// months (never the whole 2010-to-present range), validate the batch as a
// whole, and report an honest outcome. No I/O beyond the injected
// `fetchMonth` — no SQL, no analytics store writer, no persistence call: the
// caller (analytics/index.ts, which owns the AnalyticsPersistence port)
// decides what to submit and when, so this module stays inside the
// updater/orchestrator boundary scanned by
// tests/analytics-api-boundary.test.ts.
//
// HONESTY MODEL: if the deadline is hit or ANY planned month comes back
// missing/duplicated/invalid/out-of-range, the WHOLE refresh degrades — no
// partial batch is ever returned as `newRows`. The caller retains its
// last-good persisted floor and research signal by simply not submitting
// anything this run.
import { fetchEdgarMonthCount } from "./extract/edgar.ts";
import {
  planEdgarFetch,
  validateEdgarBatch,
  EDGAR_FLOOR_START,
  EDGAR_REVISION_WINDOW_MONTHS,
} from "./extract/edgar-fetch-plan.ts";
import type { EdgarPointRow } from "./extract/edgar-fetch-plan.ts";
import type { Point } from "./types.ts";

export type EdgarRefreshStatus = "up-to-date" | "updated" | "degraded";

export interface EdgarRefreshOutcome {
  status: EdgarRefreshStatus;
  plannedMonths: number;
  fetchedMonths: number;
  missingMonths: number;
  reason?: string;
  // The freshly-fetched rows ONLY (never the whole merged series) — empty
  // unless status === "updated". The caller submits these (and only these)
  // to the persisted raw floor.
  newRows: EdgarPointRow[];
}

export interface EdgarIncrementalRefreshOptions {
  asOf: string;
  persistedMonths: readonly string[];
  deadlineAt: number; // absolute cutoff (same clock as `now`) — the hard deadline
  floorStart?: string;
  revisionWindowMonths?: number;
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
  const revisionWindowMonths = opts.revisionWindowMonths ?? EDGAR_REVISION_WINDOW_MONTHS;

  const plan = planEdgarFetch({
    asOf: opts.asOf,
    persistedMonths: opts.persistedMonths,
    floorStart,
    revisionWindowMonths,
  });

  if (plan.length === 0) {
    logger.log?.("[edgar] MNA refresh: up to date — 0 month(s) planned, 0 request(s)");
    return { status: "up-to-date", plannedMonths: 0, fetchedMonths: 0, missingMonths: 0, newRows: [] };
  }

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
    logger.warn?.(`[edgar] MNA refresh DEGRADED: ${reason} — retaining last-good, no partial commit`);
    return {
      status: "degraded",
      plannedMonths: plan.length,
      fetchedMonths: plan.length - missingBeforeValidation,
      missingMonths: missingBeforeValidation,
      reason,
      newRows: [],
    };
  }

  const validation = validateEdgarBatch(plan, fetched, { floorStart, asOf: opts.asOf });
  if (!validation.ok) {
    logger.warn?.(`[edgar] MNA refresh DEGRADED: ${validation.reason} — retaining last-good, no partial commit`);
    return {
      status: "degraded",
      plannedMonths: plan.length,
      fetchedMonths: plan.length - missingBeforeValidation,
      missingMonths: missingBeforeValidation,
      reason: validation.reason,
      newRows: [],
    };
  }

  logger.log?.(
    `[edgar] MNA refresh: planned=${plan.length} fetched=${validation.rows.length} missing=0 status=updated`,
  );
  return {
    status: "updated",
    plannedMonths: plan.length,
    fetchedMonths: validation.rows.length,
    missingMonths: 0,
    newRows: validation.rows,
  };
}
