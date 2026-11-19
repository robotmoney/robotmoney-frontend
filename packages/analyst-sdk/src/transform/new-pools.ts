// NEW_TOKENS from pool records (issue 1654). Pure: no HTTP call, no database,
// no environment.
//
// The producer's new-pools collector polls GeckoTerminal's new-pools feed every
// 60 s and stores every pool it sees (id, network, pool_created_at) and, per
// poll, the span of pool_created_at it read (oldest, newest). This module turns
// those records into a daily count:
//
//   - COVERAGE. Each poll must overlap the previous one: its oldest pool is at
//     or before the previous poll's newest. Covered time is the union of the
//     polls' spans, joined to the previous poll's span when the two overlap.
//     A poll that does not overlap starts a new span; the time between is a
//     coverage gap (the store records the same gap per poll).
//   - DAILY COUNT. A UTC day D has a reading only when one continuous covered
//     span contains both D 00:00 and D+1 00:00. Its value is the number of
//     unique pool ids created in [D 00:00, D+1 00:00). Any other day (before
//     coverage starts, touched by a gap, or not yet closed) has no reading:
//     no row, never 0 and never a partial count.
//
// Semantics: docs/technical/analytics-requirements.md section 4,
// docs/technical/regime-engine.md section 2.
import type { Point } from "../types.ts";

/** One stored pool record. `knowledgeTime` is when the store first saw it (database clock). */
export interface NewPoolRecord {
  id: string;
  network: string;
  createdAt: string;
  knowledgeTime?: string;
}

/** One stored poll: the span of pool_created_at it read. `knowledgeTime` is when the store saved it. */
export interface NewPoolPoll {
  oldestCreatedAt: string;
  newestCreatedAt: string;
  knowledgeTime?: string;
}

/**
 * The number of unique pools created on one UTC day, already counted by the
 * store (pool ids are its primary key, so a row count is a unique count). The
 * backend regime job reads these instead of every pool record.
 */
export interface NewPoolDayTally {
  date: string;
  pools: number;
}

/**
 * The pool-record input of a run. Give either `pools` (every record) or
 * `dayTallies` (per-day unique counts), plus every poll in poll order.
 * `knowledgeTimeCutoff`, when set, drops records and polls the store learned
 * after it (tallies are cut by the store that counted them).
 */
export interface NewPoolInputs {
  pools?: readonly NewPoolRecord[];
  dayTallies?: readonly NewPoolDayTally[];
  polls: readonly NewPoolPoll[];
  knowledgeTimeCutoff?: string;
}

/** A continuous covered span, or a gap between two spans, as ISO instants. */
export interface NewPoolSpan {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;

/** Epoch ms of an ISO instant. Fractions finer than a millisecond are dropped. */
export function instantMs(iso: string): number {
  const ms = Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));
  if (!Number.isFinite(ms)) throw new RangeError(`not an ISO instant: ${JSON.stringify(iso)}`);
  return ms;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The covered spans and the gaps between them, from the polls in poll order.
 * A poll overlaps when its oldest pool is at or before the previous poll's
 * newest; the first poll never has a gap.
 */
export function newPoolCoverage(polls: readonly NewPoolPoll[]): { spans: NewPoolSpan[]; gaps: NewPoolSpan[] } {
  const spans: { from: number; to: number }[] = [];
  const gaps: NewPoolSpan[] = [];
  let prevNewest: number | null = null;
  for (const p of polls) {
    const oldest = instantMs(p.oldestCreatedAt);
    const newest = instantMs(p.newestCreatedAt);
    const open = spans[spans.length - 1];
    if (open && prevNewest !== null && oldest <= prevNewest) {
      open.to = Math.max(open.to, newest);
    } else {
      if (prevNewest !== null) gaps.push({ from: iso(prevNewest), to: iso(oldest) });
      spans.push({ from: oldest, to: newest });
    }
    prevNewest = newest;
  }
  return { spans: spans.map((s) => ({ from: iso(s.from), to: iso(s.to) })), gaps };
}

/** The UTC days a span fully contains: D with D 00:00 >= from and D+1 00:00 <= to. */
function fullDays(span: NewPoolSpan): string[] {
  const from = instantMs(span.from);
  const to = instantMs(span.to);
  const out: string[] = [];
  for (let d = Math.ceil(from / DAY_MS) * DAY_MS; d + DAY_MS <= to; d += DAY_MS) out.push(iso(d).slice(0, 10));
  return out;
}

/**
 * The daily NEW_TOKENS reading: for each gap-free UTC day, the number of unique
 * pool ids created that day. Days with no reading are left out. Ascending by date.
 */
export function newPoolDailyCounts(input: { pools?: readonly NewPoolRecord[]; dayTallies?: readonly NewPoolDayTally[]; polls: readonly NewPoolPoll[] }): Point[] {
  const days = newPoolCoverage(input.polls).spans.flatMap(fullDays);
  if (days.length === 0) return [];
  const perDay = new Map<string, number>();
  if (input.pools) {
    const ids = new Map<string, Set<string>>();
    for (const p of input.pools) {
      const day = iso(instantMs(p.createdAt)).slice(0, 10);
      let s = ids.get(day);
      if (!s) ids.set(day, (s = new Set()));
      s.add(p.id);
    }
    for (const [day, s] of ids) perDay.set(day, s.size);
  } else {
    for (const t of input.dayTallies ?? []) perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.pools);
  }
  return [...new Set(days)].sort().map((date) => ({ date, value: perDay.get(date) ?? 0 }));
}

/** The records and polls known at `knowledgeTimeCutoff` (all of them when it is unset). */
export function newPoolInputsAt(input: NewPoolInputs): { pools?: NewPoolRecord[]; dayTallies?: NewPoolDayTally[]; polls: NewPoolPoll[] } {
  const cutoff = input.knowledgeTimeCutoff === undefined ? null : instantMs(input.knowledgeTimeCutoff);
  const known = (r: { knowledgeTime?: string }) => cutoff === null || r.knowledgeTime === undefined || instantMs(r.knowledgeTime) <= cutoff;
  return {
    ...(input.pools ? { pools: input.pools.filter(known) } : {}),
    ...(input.dayTallies ? { dayTallies: [...input.dayTallies] } : {}),
    polls: input.polls.filter(known),
  };
}
