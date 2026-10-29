// Transform stage: reshape raw, gappy upstream series onto the dense daily grid
// the analyze stage expects. Pure (Point[] in → Point[] out); no I/O, no source
// knowledge. Split out of the old providers/fetcher.ts so the grid logic can be
// tested directly with canned series.
import type { Point } from "../types.ts";
import { dateBefore } from "./math.ts";

// Daily real series can have gaps (weekends/holidays) and may stop "today", while
// the tools expect a dense array of `lookbackDays` consecutive calendar days
// ending at `asof` (the shape the synthetic provider returns). Forward-fill the raw,
// gappy series onto that dense grid. Returns null when there is no usable data
// at/-before `asof`, signalling the caller to fall back to seeded.
export function shapeDaily(raw: Point[], asof: string, lookbackDays: number): Point[] | null {
  const filtered = raw
    .filter((p) => Number.isFinite(p.value) && p.date <= asof)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!filtered.length) return null;
  const out: Point[] = [];
  let ptr = 0;
  let last = filtered[0].value; // back-fill before the first observation
  for (let k = 0; k < lookbackDays; k++) {
    const date = dateBefore(asof, lookbackDays - 1 - k);
    while (ptr < filtered.length && filtered[ptr].date <= date) last = filtered[ptr++].value;
    out.push({ date, value: last });
  }
  return out;
}

// THE ratio function (analytics requirements 4.3, SDK-10): a/b on the dates
// both series share, in a's order, skipping any date where the denominator is
// 0, non-finite or missing. Matches the original's mergeRatioSeries in
// lib/fetch_all.js. The live fetch (extract/sources.ts) and the ratio step of
// a source-only run (series-ids.ts resolveInputHistory) both call it, so a
// ratio computed from stored legs equals the stored ratio byte for byte.
export function mergeRatioSeries(a: Point[], b: Point[]): Point[] {
  const bm = new Map(b.map((p) => [p.date, p.value]));
  const out: Point[] = [];
  for (const p of a) {
    const d = bm.get(p.date);
    if (Number.isFinite(d as number) && d !== 0 && d !== undefined) out.push({ date: p.date, value: p.value / d });
  }
  return out;
}
