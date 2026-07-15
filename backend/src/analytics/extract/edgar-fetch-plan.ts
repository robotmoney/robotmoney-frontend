// Extract stage: PURE incremental fetch-planning + batch validation for the
// live EDGAR/MNA research refresh (issue #109). Building on the committed
// seed floor (#108) and the persisted raw-history read (#106), a scheduled
// research refresh must fetch ONLY the months missing from the persisted
// floor plus a small trailing "revision window" — never the whole
// January-2010-to-present range on every run (the prior behavior: ~199
// requests, forever).
//
// No I/O here — enumerateMonths lives in ./edgar.ts; this module is pure
// planning (given known persisted state) + pure validation (given a fetched
// batch). The stateful fetch loop that ties these together under a hard
// deadline lives in ../edgar-incremental-refresh.ts.
import { enumerateMonths } from "./edgar.ts";
import type { Point } from "../types.ts";

// The declared floor start — the SAME baseline the committed seed artifact
// (#108) and the legacy full-crawl (data-source.ts's prior LATECYCLE_START)
// both use. Exported so the planner, the orchestrator, and tests all share
// ONE constant (never redeclared, never allowed to drift apart).
export const EDGAR_FLOOR_START = "2010-01-01";

// Trailing months (counting back from asof's month, inclusive) that are
// ALWAYS re-fetched even when already persisted: SEC's full-text-search
// index keeps ingesting S-4 filings for a few weeks after month-end, so a
// month's true count can still grow after it was first recorded. Fixed and
// documented here — not a per-run knob — so the AC1 planning test can pin
// down an exact, stable expected month set.
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
  persistedMonths: readonly string[]; // YYYY-MM keys already present in the persisted floor
  floorStart?: string; // YYYY-MM-DD, defaults to EDGAR_FLOOR_START
  revisionWindowMonths?: number; // defaults to EDGAR_REVISION_WINDOW_MONTHS
}

// PURE: the exact, ordered (chronological, deduplicated) set of months a
// research refresh must fetch — every month NOT already in the persisted
// floor, plus the trailing revision window, bounded to
// [floorStart, month(asOf)]. Never produces a month before floorStart or
// after asOf's month (AC1). An already-current floor (nothing missing, asof
// not yet past the revision window boundary again) yields an EMPTY plan —
// the caller then performs ZERO EDGAR requests.
export function planEdgarFetch(opts: PlanEdgarFetchOptions): EdgarPlanMonth[] {
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

export type EdgarBatchValidation = { ok: true; rows: EdgarPointRow[] } | { ok: false; reason: string };

// PURE: validate a fetched batch against its plan BEFORE it is ever
// submitted or used to recompute a signal. Every planned month must have
// EXACTLY one finite, non-negative-integer point stamped on EXACTLY that
// month's last calendar day (in the SAME position as the plan), with that
// month's key (YYYY-MM) inside [floorStart, month(asof)] — no missing month
// (`null` in `fetched`), no duplicate date, no invalid value, no
// mismatched/out-of-range date. Bounds are compared at MONTH granularity
// (not the literal `asof` day) so the current, still-incomplete month —
// always legitimately planned/stamped on its own month-end — is never
// rejected merely because `asof` falls mid-month. A single bad entry fails
// the WHOLE batch — never a partial commit.
export function validateEdgarBatch(
  plan: readonly EdgarPlanMonth[],
  fetched: readonly (Point | null)[],
  opts: { floorStart?: string; asOf: string },
): EdgarBatchValidation {
  if (fetched.length !== plan.length) {
    return { ok: false, reason: `fetched ${fetched.length} result(s) for a ${plan.length}-month plan` };
  }
  const floorMonth = monthKey(opts.floorStart ?? EDGAR_FLOOR_START);
  const asOfMonth = monthKey(opts.asOf);
  const seen = new Set<string>();
  const rows: EdgarPointRow[] = [];
  for (let i = 0; i < plan.length; i++) {
    const month = plan[i]!;
    const pt = fetched[i];
    if (pt == null) return { ok: false, reason: `month ${month.monthStart} is missing (unrecovered/canceled)` };
    if (pt.date !== month.monthEnd) {
      return { ok: false, reason: `month ${month.monthStart}: expected date ${month.monthEnd}, got ${JSON.stringify(pt.date)}` };
    }
    const ptMonth = monthKey(pt.date);
    if (ptMonth < floorMonth || ptMonth > asOfMonth) {
      return { ok: false, reason: `month ${month.monthStart}: date ${pt.date} is out of range [${floorMonth}, ${asOfMonth}]` };
    }
    if (!Number.isFinite(pt.value) || !Number.isInteger(pt.value) || pt.value < 0) {
      return { ok: false, reason: `month ${month.monthStart}: value ${pt.value} is not a finite non-negative integer` };
    }
    if (seen.has(pt.date)) return { ok: false, reason: `duplicate date ${pt.date} in fetched batch` };
    seen.add(pt.date);
    rows.push({ date: pt.date, value: pt.value });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { ok: true, rows };
}
