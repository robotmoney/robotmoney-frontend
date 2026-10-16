// Extract stage: publication-calendar validator for the raw floor seed
// (issue #616 / D6-D7). Classifies each registry indicator by which calendar
// its source can legitimately publish on, and flags any (date, indicator) row
// that the source could never have produced — the class of defect documented
// in docs/code-review/20260814-review-data-integrity-macro-index-discrepancy.md
// (v0's dense forward-fill persisted fabricated ICSA/DXY rows on dates their
// sources never publish; the vendored floor inherited them).
//
// Used by:
//   - floor-seed-generator.ts's full-universe purge mode, as a final safety
//     filter/assertion before writing the committed artifact
//   - store/seed-provenance.ts's one-time production cleanup
//   - tests/floor-seed-calendar-guard.test.ts, the required CI guard that
//     makes the defect class unrepresentable going forward
//
// Pure — no network, no SQL.
import { INDICATORS } from "../analyze/indicators.ts";
import type { Point, RawIndicatorHistory } from "../types.ts";

export type SourceCalendar = "any" | "business_day" | "weekly_saturday";

// Crypto tickers on yahoo trade every day of the week (BTC-USD / ETH-USD),
// unlike every other yahoo symbol here (equities, futures, ETFs), which only
// trade business days.
const CRYPTO_YAHOO_SYMBOLS = new Set(["BTC-USD", "ETH-USD"]);

function symbolsOf(series: string | string[] | { asset: string; metric: string } | undefined): string[] {
  if (!series) return [];
  if (Array.isArray(series)) return series;
  if (typeof series === "string") return [series];
  return [];
}

// One registry indicator id → its source's publication calendar.
//   - ICSA: FRED weekly series, week-ending Saturday — the D6 finding: 867/867
//     observations since 2010 land on a Saturday.
//   - Every other FRED series, and every yahoo symbol EXCEPT the two crypto
//     tickers, publish business days only (D6: DTWEXBGS/DXY is business-daily;
//     its floor should never carry weekend rows).
//   - Every 24/7 on-chain/crypto/DeFi source (coinmetrics, blockchain_com,
//     defillama_*, the two crypto yahoo tickers), the single-point-per-run
//     NEW_TOKENS accumulator, and the monthly SHILLER_CAPE valuation series
//     carry no weekday/weekend constraint.
export function sourceCalendar(indicatorId: string): SourceCalendar {
  const ind = INDICATORS.find((i) => i.id === indicatorId);
  if (!ind) return "any"; // unknown id: never flag rows for a series outside the registry
  if (indicatorId === "ICSA") return "weekly_saturday";
  if (ind.source === "fred") return "business_day";
  if (ind.source === "yahoo") {
    const syms = symbolsOf(ind.series);
    return syms.some((s) => CRYPTO_YAHOO_SYMBOLS.has(s)) ? "any" : "business_day";
  }
  return "any";
}

// UTC day-of-week: 0=Sunday..6=Saturday. Dates are plain YYYY-MM-DD strings
// (no timezone ambiguity — parsed as UTC midnight, matching every fetcher's
// isoDay() convention elsewhere in extract/).
function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isCalendarValidDate(date: string, calendar: SourceCalendar): boolean {
  const dow = dayOfWeek(date);
  if (Number.isNaN(dow)) return false;
  if (calendar === "weekly_saturday") return dow === 6;
  if (calendar === "business_day") return dow >= 1 && dow <= 5;
  return true;
}

export interface CalendarViolation {
  indicatorId: string;
  date: string;
  calendar: SourceCalendar;
  reason: string; // "non-saturday" | "weekend"
}

function violationReason(calendar: SourceCalendar): string {
  return calendar === "weekly_saturday" ? "non-saturday" : "weekend";
}

// Scan every (indicator, row) pair for a date its source calendar could never
// produce. Returns [] when clean. Never network, never DB — pure over an
// already-loaded RawIndicatorHistory.
export function validateFloorCalendar(floor: RawIndicatorHistory): CalendarViolation[] {
  const out: CalendarViolation[] = [];
  for (const indicatorId of Object.keys(floor)) {
    const calendar = sourceCalendar(indicatorId);
    if (calendar === "any") continue;
    for (const { date } of floor[indicatorId]) {
      if (!isCalendarValidDate(date, calendar)) {
        out.push({ indicatorId, date, calendar, reason: violationReason(calendar) });
      }
    }
  }
  return out;
}

// Filter one indicator's series down to calendar-valid rows only. Used by the
// purge generator's preserve-list merge (unrecoverable spans are preserved
// FILTERED to calendar-valid dates, never wholesale) and by the seed-
// provenance verifier.
export function filterCalendarValid(indicatorId: string, rows: Point[]): Point[] {
  const calendar = sourceCalendar(indicatorId);
  if (calendar === "any") return rows;
  return rows.filter((p) => isCalendarValidDate(p.date, calendar));
}
