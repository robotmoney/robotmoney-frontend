// Extract stage: PURE fetch-planning + batch validation for the live
// EDGAR/MNA research refresh.
//
// Issue #109 originally scoped this to an INCREMENTAL plan — fetch only the
// months missing from the persisted floor plus a small trailing "revision
// window" — to avoid a ~199-request full crawl on every run. The v0-vs-v1
// parity audit's R6 finding (docs/v0-v1-quant-platform-parity-report.md,
// finding 1.10 / Phase R) showed why that was insufficient: v0's
// `scripts/regime/late-cycle-signals.js` re-crawls EVERY month from 2010 on
// EVERY run, so any EDGAR back-revision to any historical month lands.
// Under the 2-month window, a revision to a month older than that never
// landed and the persisted `mna_s4_monthly`/`mna_pct` value diverged
// permanently from what a full re-crawl would show.
//
// The FIRST R6 fix over-corrected the other direction: it made the plan the
// full [floorStart, asOf] range UNCONDITIONALLY, on EVERY call — and this
// runs once/day, forever, from the independent producer process
// (PRODUCER_RESEARCH_CRON — see ../edgar-incremental-refresh.ts and
// ../../producer/index.ts). That is ~200 live EDGAR requests, daily,
// forever, just to catch revisions that (per SEC's own FTS indexing
// behavior) only ever land within a few weeks of a month's close. Confirmed
// owner decision: v0's ARCHIVED historical data is what gets seeded (issue
// #108's committed artifact, untouched by this module); the ONGOING
// production refresh should be cheap day-to-day and only pay the full-crawl
// cost periodically. Current (corrected) design is two-tier:
//
//   Tier 1 — INCREMENTAL (`planEdgarFetchIncremental`): every day. Only the
//   months missing from the persisted floor, plus a small trailing revision
//   window (`EDGAR_REVISION_WINDOW_MONTHS`) to catch EDGAR's normal
//   few-week-late indexing of the most recent month(s). A handful of
//   requests, not ~200.
//
//   Tier 2 — FULL (`planEdgarFetch`, unchanged from the first R6 commit):
//   periodically (see `selectEdgarRefreshTier` / EDGAR_FULL_SWEEP_WEEKDAY_UTC
//   in ../edgar-incremental-refresh.ts), the full [floorStart, asOf] range —
//   exactly the v0-matching full re-crawl the R6 audit called for — so a
//   revision to ANY historical month, however old, still lands, just on a
//   bounded periodic cadence (currently weekly) instead of permanently
//   (2-month window bug) or on every single run (the over-corrected first
//   fix).
//
// `selectEdgarRefreshTier` (../edgar-incremental-refresh.ts) is the single
// source of truth for WHICH tier a given `asOf` uses; this module only knows
// how to PLAN each tier once asked.
//
// No I/O here — enumerateMonths lives in ./edgar.ts; this module is pure
// planning + pure validation (given a fetched batch). The stateful fetch
// loop that ties these together under a hard deadline lives in
// ../edgar-incremental-refresh.ts.
import { enumerateMonths } from "./edgar.ts";
import type { Point } from "../types.ts";

// The declared floor start — the SAME baseline the committed seed artifact
// (#108), v0's `late-cycle-signals.js` START constant, and the orchestrator
// (data-source.ts's LATECYCLE_START) all use. Exported so both planners, the
// orchestrator, and tests all share ONE constant (never redeclared, never
// allowed to drift apart).
export const EDGAR_FLOOR_START = "2010-01-01";

// Trailing months (counting back from asof's month, inclusive) that Tier 1
// ALWAYS re-fetches even when already persisted: SEC's full-text-search
// index keeps ingesting S-4 filings for a few weeks after month-end, so a
// month's true count can still grow after it was first recorded. Fixed and
// documented here — not a per-run knob — so the planning tests can pin down
// an exact, stable expected month set. Deliberately small: catching
// near-term revisions FAST (daily) is Tier 1's job; catching an
// arbitrarily-old revision is Tier 2's job (see the periodic full sweep).
export const EDGAR_REVISION_WINDOW_MONTHS = 2;

export interface EdgarPlanMonth {
  monthStart: string;
  monthEnd: string;
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

// Trailing `n` YYYY-MM keys ending at (and including) `endMonth`.
function trailingMonthKeys(endMonth: string, n: number): Set<string> {
  const [y, m] = endMonth.split("-").map(Number) as [number, number];
  const out = new Set<string>();
  for (let k = 0; k < n; k++) {
    let yy = y;
    let mm = m - k;
    while (mm <= 0) {
      mm += 12;
      yy -= 1;
    }
    out.add(`${yy}-${String(mm).padStart(2, "0")}`);
  }
  return out;
}

export interface PlanEdgarFetchOptions {
  asOf: string; // YYYY-MM-DD — the pinned as-of date; nothing after this is ever planned
  floorStart?: string; // YYYY-MM-DD, defaults to EDGAR_FLOOR_START
}

// PURE — Tier 2 (periodic full reconciliation sweep): the exact, ordered
// (chronological, deduplicated) set of months a FULL EDGAR re-crawl must
// fetch — EVERY month in [floorStart, month(asOf)], matching v0's
// unconditional full re-crawl (R6). Never produces a month before
// floorStart or after asOf's month. Deliberately ignores what is already
// persisted — that is the whole point of running this tier at all: an
// EDGAR back-revision to ANY historical month, however old, lands the next
// time this tier runs. Callers decide WHEN to invoke this (see
// `selectEdgarRefreshTier` in ../edgar-incremental-refresh.ts) — this
// function itself has no notion of cadence.
export function planEdgarFetch(opts: PlanEdgarFetchOptions): EdgarPlanMonth[] {
  const floorStart = opts.floorStart ?? EDGAR_FLOOR_START;
  return enumerateMonths(floorStart, opts.asOf);
}

export interface PlanEdgarFetchIncrementalOptions {
  asOf: string; // YYYY-MM-DD — the pinned as-of date; nothing after this is ever planned
  persistedMonths: readonly string[]; // YYYY-MM keys already present in the persisted floor
  floorStart?: string; // YYYY-MM-DD, defaults to EDGAR_FLOOR_START
  revisionWindowMonths?: number; // defaults to EDGAR_REVISION_WINDOW_MONTHS
}

// PURE — Tier 1 (cheap daily incremental sweep): every month NOT already in
// the persisted floor, plus the trailing revision window, bounded to
// [floorStart, month(asOf)]. Never produces a month before floorStart or
// after asOf's month. An already-current floor (nothing missing, asof not
// yet past the revision window boundary again) yields an EMPTY plan — the
// caller then performs ZERO EDGAR requests. This is the original issue #109
// incremental design, restored after the first R6 commit replaced it
// wholesale with the unconditional full crawl (`planEdgarFetch`) above —
// that full-range logic is preserved for Tier 2, not deleted; it's just no
// longer the only plan this module can produce.
export function planEdgarFetchIncremental(opts: PlanEdgarFetchIncrementalOptions): EdgarPlanMonth[] {
  const floorStart = opts.floorStart ?? EDGAR_FLOOR_START;
  const revisionWindow = opts.revisionWindowMonths ?? EDGAR_REVISION_WINDOW_MONTHS;
  const asOfMonth = monthKey(opts.asOf);
  const allMonths = enumerateMonths(floorStart, opts.asOf);
  if (allMonths.length === 0) return [];

  const persisted = new Set(opts.persistedMonths);
  const revisable = trailingMonthKeys(asOfMonth, revisionWindow);

  return allMonths.filter(({ monthStart }) => {
    const key = monthKey(monthStart);
    return !persisted.has(key) || revisable.has(key);
  });
}

export interface EdgarPointRow {
  date: string;
  value: number;
}

export type EdgarBatchValidation =
  | { ok: true; rows: EdgarPointRow[] }
  // `missingCount` — planned months with NO usable response at all (`null`
  // in `fetched`: unrecovered after retries, or never attempted/canceled by
  // a deadline). `rejectedCount` — planned months that DID get a response,
  // but it failed validation (mismatched/out-of-range date, invalid value,
  // duplicate). Distinct metrics (issue #109 AC9: planned/fetched/
  // revised/missing/rejected/persisted counts).
  | { ok: false; reason: string; missingCount: number; rejectedCount: number };

// PURE: validate a fetched batch against its plan BEFORE it is ever
// submitted or used to recompute a signal. Shared by BOTH tiers — the
// honesty model (whole-batch degrade on any missing/invalid month, never a
// partial commit) applies identically regardless of which tier produced the
// plan. Every planned month must have EXACTLY one finite, non-negative-
// integer point stamped on EXACTLY that month's last calendar day (in the
// SAME position as the plan), with that month's key (YYYY-MM) inside
// [floorStart, month(asof)] — no missing month (`null` in `fetched`), no
// duplicate date, no invalid value, no mismatched/out-of-range date. Bounds
// are compared at MONTH granularity (not the literal `asof` day) so the
// current, still-incomplete month — always legitimately planned/stamped on
// its own month-end — is never rejected merely because `asof` falls
// mid-month. Every entry is checked (never fail-fast) so the caller gets an
// accurate missing/rejected count; a single bad entry still fails the WHOLE
// batch — never a partial commit.
export function validateEdgarBatch(
  plan: readonly EdgarPlanMonth[],
  fetched: readonly (Point | null)[],
  opts: { floorStart?: string; asOf: string },
): EdgarBatchValidation {
  if (fetched.length !== plan.length) {
    return {
      ok: false,
      reason: `fetched ${fetched.length} result(s) for a ${plan.length}-month plan`,
      missingCount: plan.length,
      rejectedCount: 0,
    };
  }
  const floorMonth = monthKey(opts.floorStart ?? EDGAR_FLOOR_START);
  const asOfMonth = monthKey(opts.asOf);
  const seen = new Set<string>();
  const rows: EdgarPointRow[] = [];
  const reasons: string[] = [];
  let missingCount = 0;
  let rejectedCount = 0;
  for (let i = 0; i < plan.length; i++) {
    const month = plan[i]!;
    const pt = fetched[i];
    if (pt == null) {
      missingCount++;
      reasons.push(`month ${month.monthStart} is missing (unrecovered/canceled)`);
      continue;
    }
    if (pt.date !== month.monthEnd) {
      rejectedCount++;
      reasons.push(`month ${month.monthStart}: expected date ${month.monthEnd}, got ${JSON.stringify(pt.date)}`);
      continue;
    }
    const ptMonth = monthKey(pt.date);
    if (ptMonth < floorMonth || ptMonth > asOfMonth) {
      rejectedCount++;
      reasons.push(`month ${month.monthStart}: date ${pt.date} is out of range [${floorMonth}, ${asOfMonth}]`);
      continue;
    }
    if (!Number.isFinite(pt.value) || !Number.isInteger(pt.value) || pt.value < 0) {
      rejectedCount++;
      reasons.push(`month ${month.monthStart}: value ${pt.value} is not a finite non-negative integer`);
      continue;
    }
    if (seen.has(pt.date)) {
      rejectedCount++;
      reasons.push(`duplicate date ${pt.date} in fetched batch`);
      continue;
    }
    seen.add(pt.date);
    rows.push({ date: pt.date, value: pt.value });
  }
  if (missingCount > 0 || rejectedCount > 0) {
    return { ok: false, reason: reasons.join("; "), missingCount, rejectedCount };
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { ok: true, rows };
}
