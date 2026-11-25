// Q43-source-data/C31-source-data (PR 1671, PR 1674; issues 1644, 1653): ingestion stores the ratio legs and BAA10Y as source
// data. Read-only: two counts as rm_readonly.
//
// WHAT IT REQUIRES:
//   - every ratio leg the SDK registry names (yahoo:<SYMBOL>.close and .adjclose for the fourteen ratio symbols, 28 keys,
//     registryRatioLegs) has at least one version in source_value_versions, and its newest market day is within 10 days;
//   - BAA10Y has the history the ordinary FRED fetch gives a live upgrade in raw_indicator_history: its first day is 2010-01-15 or
//     earlier (the daily fetch asks FRED for cosd 2010-01-01), at least 4000 rows, and its newest day is within 10 days. The
//     1986 to 2009 rows are delivered only by the committed seed, never by ordinary ingestion: an owner-accepted deviation from
//     issue 1653's full-history aim (owner, 2026-11-19);
//   - BAA10Y is no input of the regime composite: the SDK registry (INDICATORS) holds no BAA10Y indicator.
// Ingestion writes the legs and BAA10Y at each analytics run, so the check polls for them (stage hourly, production 3-hourly,
// D87) until --wait-minutes passes. The cap is not a wait: the check returns the moment its assertions hold. Default cap: 90
// minutes on the stage target (one hourly tick plus margin), 200 elsewhere (production's 3-hourly tick).
import { INDICATORS } from "../../../../packages/analyst-sdk/src/analyze/indicators.ts";
import { registryRatioLegs } from "../../../../packages/analyst-sdk/src/extract/sources.ts";
import type { VersionCheck } from "../../version-check.ts";

export const MAX_STALE_DAYS = 10;
export const BAA10Y_FIRST_BY = "2010-01-15";
export const BAA10Y_MIN_ROWS = 4000;
export const STAGE_WAIT_MINUTES = 90;
export const DEFAULT_WAIT_MINUTES = 200;

export interface LegRow {
  readonly key: string;
  readonly newest: string;
}
export interface Baa10yRead {
  readonly first: string | null;
  readonly newest: string | null;
  readonly rows: number;
}

const days = (from: string, to: string): number => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** PURE. Why the ratio legs are not all stored and fresh; empty when they are. */
export function legProblems(want: readonly string[], rows: readonly LegRow[], today: string): string[] {
  const out: string[] = [];
  const byKey = new Map(rows.map((r) => [r.key, r.newest]));
  const missing = want.filter((k) => !byKey.has(k));
  if (missing.length > 0) out.push(`${missing.length} of ${want.length} ratio leg(s) have no stored version: ${missing.slice(0, 6).join(", ")}`);
  const stale = want.filter((k) => byKey.has(k) && days(byKey.get(k)!, today) > MAX_STALE_DAYS);
  if (stale.length > 0) out.push(`${stale.length} ratio leg(s) are older than ${MAX_STALE_DAYS} days: ${stale.slice(0, 6).join(", ")}`);
  return out;
}

/** PURE. Why BAA10Y is not stored with full, fresh history; empty when it is. */
export function baa10yProblems(r: Baa10yRead, today: string): string[] {
  const out: string[] = [];
  if (r.rows === 0 || r.first === null || r.newest === null) return ["raw_indicator_history holds no BAA10Y row"];
  if (r.first > BAA10Y_FIRST_BY) out.push(`BAA10Y starts ${r.first}, after ${BAA10Y_FIRST_BY}: its history is shorter than the ordinary fetch gives`);
  if (r.rows < BAA10Y_MIN_ROWS) out.push(`BAA10Y holds ${r.rows} rows, fewer than ${BAA10Y_MIN_ROWS}`);
  if (days(r.newest, today) > MAX_STALE_DAYS) out.push(`BAA10Y's newest day ${r.newest} is older than ${MAX_STALE_DAYS} days`);
  return out;
}

/** PURE. Why BAA10Y feeds the composite; empty when it does not. */
export function compositeInputProblems(ids: readonly string[]): string[] {
  return ids.includes("BAA10Y") ? ["BAA10Y is an indicator of the regime registry; it must stay source data outside the composite"] : [];
}

const flag = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const quote = (k: string): string => `'${k.replace(/'/g, "''")}'`;

export default (async (ctx) => {
  const db = await ctx.db();
  const want = registryRatioLegs().map((l) => l.id);
  const today = new Date().toISOString().slice(0, 10);
  const read = async () => {
    const legs = await db.query<{ key: string; newest: string }>(`SELECT source_key AS key, max(market_date)::text AS newest FROM source_value_versions WHERE source_key IN (${want.map(quote).join(",")}) GROUP BY source_key`);
    const [b] = await db.query<{ first: string | null; newest: string | null; rows: string }>("SELECT min(date)::text AS first, max(date)::text AS newest, count(*)::text AS rows FROM raw_indicator_history WHERE indicator = 'BAA10Y'");
    const baa: Baa10yRead = { first: b?.first ?? null, newest: b?.newest ?? null, rows: Number(b?.rows ?? 0) };
    return { legs, baa, problems: [...legProblems(want, legs, today), ...baa10yProblems(baa, today)] };
  };
  const deadline = Date.now() + flag("--wait-minutes", ctx.instance === "stage_target" ? STAGE_WAIT_MINUTES : DEFAULT_WAIT_MINUTES) * 60_000;
  let r = await read();
  while (r.problems.length > 0 && Date.now() < deadline) {
    await Bun.sleep(5 * 60_000);
    r = await read();
  }
  return { found: { legsWanted: want.length, legsStored: r.legs.length, baa10y: r.baa }, problems: [...r.problems, ...compositeInputProblems(INDICATORS.map((i) => i.id))] };
}) satisfies VersionCheck;
