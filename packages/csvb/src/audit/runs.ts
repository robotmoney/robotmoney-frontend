// Run-ledger health: did the jobs run, did they succeed, and which days have no successful run?
//
// This is the check that would have caught the 2026-09-28 to 09-29 outage (92 consecutive regime runs failed, and no
// run for as-of 2026-09-29 ever succeeded) the day it started.
import { dbDate, day, loadTable, type Ctx } from "./data.ts";

export interface RunInfo {
  id: number;
  asof: string;
  tool: string;
  source: string;
  createdAt: string;
  status: "succeeded" | "failed" | "unfinished";
  error: string;
  finishedAt: string | null;
}

export async function loadRuns(ctx: Ctx): Promise<RunInfo[]> {
  const events = new Map<number, { type: string; time: string; detail: string }[]>();
  for (const e of await loadTable(ctx, "analytics_ledger_run_events")) {
    const id = Number(e.run_id);
    (events.get(id) ?? events.set(id, []).get(id)!).push({ type: e.event_type!, time: e.knowledge_time!, detail: e.detail ?? "" });
  }
  const runs: RunInfo[] = [];
  for (const r of await loadTable(ctx, "analytics_ledger_runs")) {
    const ev = events.get(Number(r.id)) ?? [];
    const last = ev[ev.length - 1];
    const status = last?.type === "succeeded" ? "succeeded" : last?.type === "failed" ? "failed" : "unfinished";
    runs.push({ id: Number(r.id), asof: r.asof!, tool: r.tool_id!, source: r.source_label ?? "", createdAt: r.created_at!, status, error: status === "failed" ? last!.detail : "", finishedAt: last && last.type !== "started" ? last.time : null });
  }
  return runs.sort((a, b) => a.id - b.id);
}

export interface Streak {
  firstRunId: number;
  lastRunId: number;
  runs: number;
  start: string;
  end: string;
  firstError: string;
  /** The first success after the streak, if any. */
  recoveredByRunId: number | null;
  recoveredAt: string | null;
  recoveredAsof: string | null;
}

export interface RunsAnalysis {
  tool: string;
  total: number;
  succeeded: number;
  failed: number;
  unfinished: number;
  /** Consecutive failed runs of the tool, in id order, at least `minStreak` long. */
  streaks: Streak[];
  /** As-of days from the first run's to the last run's with no successful run for that as-of. */
  missedDays: string[];
  /** Successful runs per as-of day. */
  perDay: { asof: string; succeeded: number; failed: number }[];
  /** Replay-labelled runs (source_label = 'replay'). */
  replays: number;
}

export function analyseRuns(all: RunInfo[], tool: string, minStreak = 3): RunsAnalysis {
  const runs = all.filter((r) => r.tool === tool);
  const streaks: Streak[] = [];
  let cur: RunInfo[] = [];
  const close = (next: RunInfo | undefined): void => {
    if (cur.length >= minStreak) {
      const first = cur[0]!;
      const lastRun = cur[cur.length - 1]!;
      streaks.push({
        firstRunId: first.id,
        lastRunId: lastRun.id,
        runs: cur.length,
        start: first.createdAt,
        end: lastRun.finishedAt ?? lastRun.createdAt,
        firstError: first.error,
        recoveredByRunId: next?.id ?? null,
        recoveredAt: next?.finishedAt ?? null,
        recoveredAsof: next?.asof ?? null,
      });
    }
    cur = [];
  };
  for (const r of runs) {
    if (r.status === "failed") cur.push(r);
    else {
      if (cur.length && r.status === "succeeded") close(r);
      else if (cur.length) close(undefined);
    }
  }
  close(undefined);

  const per = new Map<string, { succeeded: number; failed: number }>();
  for (const r of runs) {
    const p = per.get(r.asof) ?? per.set(r.asof, { succeeded: 0, failed: 0 }).get(r.asof)!;
    if (r.status === "succeeded") p.succeeded += 1;
    else if (r.status === "failed") p.failed += 1;
  }
  const missed: string[] = [];
  if (runs.length) {
    const first = runs.reduce((m, r) => (r.asof < m ? r.asof : m), runs[0]!.asof);
    const last = runs.reduce((m, r) => (r.asof > m ? r.asof : m), runs[0]!.asof);
    for (let d = new Date(`${first}T00:00:00Z`); d <= new Date(`${last}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
      const s = d.toISOString().slice(0, 10);
      if (!(per.get(s)?.succeeded ?? 0)) missed.push(s);
    }
  }
  return {
    tool,
    total: runs.length,
    succeeded: runs.filter((r) => r.status === "succeeded").length,
    failed: runs.filter((r) => r.status === "failed").length,
    unfinished: runs.filter((r) => r.status === "unfinished").length,
    streaks,
    missedDays: missed,
    perDay: [...per.entries()].sort().map(([asof, v]) => ({ asof, ...v })),
    replays: runs.filter((r) => r.source === "replay").length,
  };
}

export const hours = (a: string, b: string): number => Math.round(((dbDate(b).getTime() - dbDate(a).getTime()) / 3_600_000) * 10) / 10;
export { day };
