// The generic gap detector (issue #614 AC3 — "the core of this issue"). One
// function, driven entirely by series-registry.ts, replaces what the
// Motivation section found: "No generate_series, no LAG(date) OVER (…), no
// expected-vs-actual comparison anywhere in .ts or .sql." and "Latest-point
// age alone... is not sufficient" (report/regime-projection.ts,
// admin/overview.ts's pre-#614 MONITORED_KINDS check) — this reports interior
// gaps and a stale head SEPARATELY, per series.
//
// DESIGN NOTE — why the expected/observed diff happens in JS, not SQL
// generate_series: every daily-cadence column in the registry is a plain
// Postgres `date` (no timezone), and the hourly columns are timestamptz
// values the writer ALREADY truncated to a UTC hour boundary
// (worker/handlers/vault.ts: `sampleHour.setUTCMinutes(0,0,0)`). Comparing
// those against a SQL-side `generate_series` boundary computed from a literal
// depends on the Postgres session's `TimeZone` setting for date/timestamptz
// casts — correct only as long as that setting is UTC. Building both the
// expected-slot list and the "which slot is this row in" answer from JS
// `Date`'s explicit UTC methods removes that dependency entirely: the only
// SQL responsibility left is "return the distinct persisted slots", which is
// tz-agnostic once cast to timestamptz and compared as epoch millis.
import { sql as defaultSql, type DbHandle } from "../db/client.ts";
import { SERIES_REGISTRY, type Cadence, type RemediationClass, type SeriesDef } from "./series-registry.ts";

export interface GapReport {
  key: string;
  label: string;
  table: string;
  remediationClass: RemediationClass;
  cadence: Cadence;
  seriesStart: string; // ISO
  expectedHead: string; // ISO — the latest slot that should exist by `now`
  headDate: string | null; // ISO — the latest slot actually observed; null = zero rows
  interiorGaps: string[]; // ISO slots missing strictly at-or-before the observed head
  interiorGapCount: number; // interiorGaps.length, surfaced separately so a huge array is not the only signal
  staleHead: boolean; // the observed head is behind expectedHead by more than the slack budget
  clean: boolean; // no interior gaps and not stale
}

function truncateToSlot(d: Date, cadence: Cadence): Date {
  const t = new Date(d.getTime());
  if (cadence === "hourly") t.setUTCMinutes(0, 0, 0);
  else t.setUTCHours(0, 0, 0, 0);
  return t;
}

const STEP_MS: Record<Cadence, number> = { daily: 86_400_000, hourly: 3_600_000 };
// Slack before a fresh-but-behind head counts as "stale" — generous enough
// that an ordinary tick/worker-restart delay (or the sampler simply not
// having fired yet for the CURRENT slot) never flickers the alert; tight
// enough that a genuinely wedged producer is still caught quickly relative to
// its own cadence.
const STALE_TICKS = 2;

export async function detectGaps(def: SeriesDef, db: DbHandle = defaultSql, now: Date = new Date()): Promise<GapReport> {
  const seriesStart = truncateToSlot(new Date(def.seriesStart), def.cadence);
  const expectedHead = truncateToSlot(now, def.cadence);
  const stepMs = STEP_MS[def.cadence];

  // A row the serving layer is not allowed to serve does not cover its slot
  // (SeriesDef.uncounted). Filtering here keeps quarantine aligned between the
  // operator report and repair planner. `expectedKeys` additionally makes the
  // P0 planner reject partial snapshots; publishing completeness is P1 scope.
  const uncounted = def.uncounted;
  const expectedKeys = def.expectedKeys;
  const rows = await db<(Record<string, unknown> & { slot: Date })[]>`
    SELECT DISTINCT ${db(def.dateColumn)}::timestamptz AS slot
           ${expectedKeys ? db`, ${db([...expectedKeys.columns])}` : db``}
      FROM ${db(def.table)}
     WHERE ${db(def.dateColumn)}::timestamptz >= ${seriesStart}
       ${uncounted ? db`AND ${db(uncounted.column)} <> ALL (${db.array([...uncounted.values])})` : db``}
     ORDER BY slot
  `;
  const keyToken = (parts: readonly string[]): string => JSON.stringify(parts);
  const expected = expectedKeys ? new Set(expectedKeys.resolve().map((parts) => keyToken(parts))) : null;
  const observedBySlot = new Map<number, Set<string>>();
  for (const row of rows) {
    const slot = new Date(row.slot).getTime();
    let keys = observedBySlot.get(slot);
    if (!keys) {
      keys = new Set();
      observedBySlot.set(slot, keys);
    }
    if (expectedKeys) keys.add(keyToken(expectedKeys.columns.map((column) => String(row[column]))));
  }
  const observed = new Set<number>();
  for (const [slot, keys] of observedBySlot) {
    if (!expected || [...expected].every((key) => keys.has(key))) observed.add(slot);
  }
  const headMs = observed.size > 0 ? Math.max(...observed) : null;

  const interiorGaps: string[] = [];
  for (let t = seriesStart.getTime(); t <= expectedHead.getTime(); t += stepMs) {
    // A slot AFTER the observed head is stale-head territory (the series
    // hasn't caught up to `now` yet), never counted as an interior gap — an
    // interior gap is specifically a HOLE the series jumped over.
    if (headMs != null && t > headMs) break;
    if (!observed.has(t)) interiorGaps.push(new Date(t).toISOString());
  }

  const staleHead = headMs == null
    ? expectedHead.getTime() >= seriesStart.getTime() // an expected series with zero rows at all
    : expectedHead.getTime() - headMs > stepMs * STALE_TICKS;

  return {
    key: def.key,
    label: def.label,
    table: def.table,
    remediationClass: def.remediationClass,
    cadence: def.cadence,
    seriesStart: seriesStart.toISOString(),
    expectedHead: expectedHead.toISOString(),
    headDate: headMs == null ? null : new Date(headMs).toISOString(),
    interiorGaps,
    interiorGapCount: interiorGaps.length,
    staleHead,
    clean: interiorGaps.length === 0 && !staleHead,
  };
}

/** Every registered series, detected in parallel — the operator-surface feed
 *  (GET /api/admin/gaps). */
export async function detectAllGaps(db: DbHandle = defaultSql, now: Date = new Date()): Promise<GapReport[]> {
  return Promise.all(SERIES_REGISTRY.map((def) => detectGaps(def, db, now)));
}
