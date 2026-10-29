// What the database revised in place, from its own revision log (`analytics_overwrite_events`).
//
// Every time the database overwrote a stored row it recorded the row before and after. This summarises that log:
// how many revisions per table and per day, and for raw indicator history how big the changes were, per indicator.
import { day, scanTable, type Ctx } from "./data.ts";

export interface IndicatorRevisions {
  indicator: string;
  events: number;
  distinctRows: number;
  medianRelChange: number;
  p90RelChange: number;
  maxRelChange: number;
  /** Events whose relative change is at most 1e-4 (provider restatement noise, not a real revision). */
  tiny: number;
}

export interface RevisionsAnalysis {
  totalEvents: number;
  byTable: { table: string; events: number; first: string; last: string }[];
  perDay: { day: string; table: string; events: number }[];
  indicators: IndicatorRevisions[];
  /** regime_snapshots revisions whose label changed. */
  regimeLabelChanges: number;
  regimeEvents: number;
}

const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

export async function analyseRevisions(ctx: Ctx): Promise<RevisionsAnalysis> {
  const byTable = new Map<string, { events: number; first: string; last: string }>();
  const perDay = new Map<string, number>();
  const rel = new Map<string, number[]>();
  const rows = new Map<string, Set<string>>();
  let total = 0;
  let regimeLabelChanges = 0;
  let regimeEvents = 0;

  await scanTable(ctx, "analytics_overwrite_events", (e) => {
    total += 1;
    const t = e.table_name!;
    const at = e.recorded_at!;
    const b = byTable.get(t);
    if (!b) byTable.set(t, { events: 1, first: at, last: at });
    else {
      b.events += 1;
      if (at < b.first) b.first = at;
      if (at > b.last) b.last = at;
    }
    const k = `${day(at)}|${t}`;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);

    if (t === "raw_indicator_history" && e.previous_row && e.replacement_row) {
      const p = JSON.parse(e.previous_row) as { indicator: string; date: string; value: number };
      const n = JSON.parse(e.replacement_row) as { value: number };
      const r = Math.abs(n.value - p.value) / Math.max(Math.abs(p.value), 1e-12);
      (rel.get(p.indicator) ?? rel.set(p.indicator, []).get(p.indicator)!).push(r);
      (rows.get(p.indicator) ?? rows.set(p.indicator, new Set()).get(p.indicator)!).add(p.date);
    } else if (t === "regime_snapshots" && e.previous_row && e.replacement_row) {
      regimeEvents += 1;
      const p = JSON.parse(e.previous_row) as { regime?: string };
      const n = JSON.parse(e.replacement_row) as { regime?: string };
      if (p.regime !== n.regime) regimeLabelChanges += 1;
    }
  });

  return {
    totalEvents: total,
    byTable: [...byTable.entries()].map(([table, v]) => ({ table, ...v })).sort((a, b) => b.events - a.events),
    perDay: [...perDay.entries()].sort().map(([k, events]) => {
      const [d, table] = k.split("|");
      return { day: d!, table: table!, events };
    }),
    indicators: [...rel.entries()]
      .map(([indicator, xs]) => ({
        indicator,
        events: xs.length,
        distinctRows: rows.get(indicator)!.size,
        medianRelChange: quantile(xs, 0.5),
        p90RelChange: quantile(xs, 0.9),
        maxRelChange: xs.reduce((m, x) => Math.max(m, x), 0),
        tiny: xs.filter((x) => x <= 1e-4).length,
      }))
      .sort((a, b) => b.events - a.events),
    regimeLabelChanges,
    regimeEvents,
  };
}
