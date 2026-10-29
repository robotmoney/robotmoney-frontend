// How the published regime figures moved after they were published.
//
// `regime_snapshots` is a current view: every run recomputes the whole history and overwrites it. The only record of
// what was published is the frozen output of each run (`analytics_output_snapshots`, kind regime_snapshots). This
// compares those frozen outputs, run by run, with each other and with the table as it stands now.
import { loadRuns } from "./runs.ts";
import { loadTable, num, scanTable, type Ctx } from "./data.ts";

export interface DayDrift {
  asof: string;
  runs: number;
  firstComposite: number;
  firstLabel: string;
  lastComposite: number;
  lastLabel: string;
  finalComposite: number;
  finalLabel: string;
  /** |final - what the day's last run published|. */
  lastDiff: number;
  /** The label published by the day's last run is not the label the table holds now. */
  flipped: boolean;
}

export interface RunMove {
  runId: number;
  createdAt: string;
  asof: string;
  /** Historical dates (before this run's as-of) whose composite differs from the previous run's payload. */
  changedDates: number;
  earliestChanged: string | null;
  maxAbsDiff: number;
  /** Dates whose label differs from the previous run's payload. */
  labelChanges: number;
  /** Dates in the payload that the previous run's did not have (other than the new as-of day). */
  newDates: number;
}

export interface DriftAnalysis {
  runsCompared: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
  days: DayDrift[];
  moves: RunMove[];
  summary: {
    days: number;
    daysWhoseLastRunDiffersFromNow: number;
    maxLastDiff: number;
    labelFlips: number;
    flippedDays: string[];
    runsThatRewroteHistory: number;
    runsThatFlippedHistoricalLabels: number;
  };
}

interface PubRow {
  date: string;
  composite: number;
  label: string;
}

export async function analyseDrift(ctx: Ctx, tool = "regime"): Promise<DriftAnalysis> {
  const runs = new Map((await loadRuns(ctx)).filter((r) => r.tool === tool && r.status === "succeeded").map((r) => [r.id, r]));

  const perDay = new Map<string, { first: PubRow; last: PubRow; n: number }>();
  const moves: RunMove[] = [];
  let prev: Map<string, PubRow> | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let compared = 0;

  await scanTable(ctx, "analytics_output_snapshots", (s) => {
    if (s.artifact_kind !== "regime_snapshots") return;
    const run = runs.get(Number(s.run_id));
    if (!run || !s.payload_json || s.payload_json === "[]") return;
    const rows = JSON.parse(s.payload_json) as { date: string; composite: number | null; regime: string | null }[];
    if (!rows.length) return;
    compared += 1;
    firstAt ??= run.createdAt;
    lastAt = run.createdAt;
    const cur = new Map<string, PubRow>();
    for (const r of rows) cur.set(r.date, { date: r.date, composite: r.composite ?? NaN, label: r.regime ?? "" });

    const own = cur.get(run.asof);
    if (own) {
      const d = perDay.get(run.asof);
      if (!d) perDay.set(run.asof, { first: own, last: own, n: 1 });
      else {
        d.last = own;
        d.n += 1;
      }
    }
    if (prev) {
      let changed = 0;
      let labels = 0;
      let newDates = 0;
      let maxDiff = 0;
      let earliest: string | null = null;
      for (const [date, row] of cur) {
        const p = prev.get(date);
        if (!p) {
          if (date !== run.asof) newDates += 1;
          continue;
        }
        const diff = Math.abs(row.composite - p.composite);
        if (diff > 1e-12) {
          changed += 1;
          if (diff > maxDiff) maxDiff = diff;
          if (earliest === null || date < earliest) earliest = date;
        }
        if (row.label !== p.label) labels += 1;
      }
      moves.push({ runId: run.id, createdAt: run.createdAt, asof: run.asof, changedDates: changed, earliestChanged: earliest, maxAbsDiff: maxDiff, labelChanges: labels, newDates });
    }
    prev = cur;
  });

  const final = new Map<string, PubRow>();
  for (const r of await loadTable(ctx, "regime_snapshots")) final.set(r.date!, { date: r.date!, composite: num(r.composite), label: r.regime ?? "" });

  const days: DayDrift[] = [];
  for (const [asof, d] of [...perDay.entries()].sort()) {
    const f = final.get(asof);
    if (!f) continue;
    days.push({
      asof,
      runs: d.n,
      firstComposite: d.first.composite,
      firstLabel: d.first.label,
      lastComposite: d.last.composite,
      lastLabel: d.last.label,
      finalComposite: f.composite,
      finalLabel: f.label,
      lastDiff: Math.abs(f.composite - d.last.composite),
      flipped: f.label !== d.last.label,
    });
  }
  return {
    runsCompared: compared,
    firstRunAt: firstAt,
    lastRunAt: lastAt,
    days,
    moves,
    summary: {
      days: days.length,
      daysWhoseLastRunDiffersFromNow: days.filter((d) => d.lastDiff > 1e-12).length,
      maxLastDiff: days.reduce((m, d) => Math.max(m, d.lastDiff), 0),
      labelFlips: days.filter((d) => d.flipped).length,
      flippedDays: days.filter((d) => d.flipped).map((d) => d.asof),
      runsThatRewroteHistory: moves.filter((m) => m.changedDates > 0).length,
      runsThatFlippedHistoricalLabels: moves.filter((m) => m.labelChanges > 0).length,
    },
  };
}
