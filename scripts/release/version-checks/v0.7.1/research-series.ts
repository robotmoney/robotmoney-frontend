// Q40-research-series/C28-research-series (PR 1524 part "collection floor and new series", issue
// 1514): the analytics run collects every series of the research-series inventory
// (packages/analyst-sdk/inventory/research-series.json) into the source ledger, each under its
// storage key, from the collection floor COLLECTION_START (2016-01-01) or the series' inception
// when that is later. Thirteen keys are new in this release; research:BTC-USD and research:QQQ were
// fetched from 2018-01-01 before it, so their earliest dated version moving to 2016 is the floor.
// The collection runs inside the scheduled regime run, so this check comes after
// Q38-committed-inputs/C26-committed-inputs, which waits for a regime run of this release.
// Reads only: source_value_versions, on the proven read-only session.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VersionCheck } from "../../version-check.ts";

export const INVENTORY = join(import.meta.dir, "../../../../packages/analyst-sdk/inventory/research-series.json");
/** How far past its expected start a series' earliest dated version may be: a week of holidays and a weekend, with margin. */
export const START_SLACK_DAYS = 14;

export interface Series {
  readonly id: string;
  readonly storageKey?: string;
  readonly requestedStart: string;
  readonly inception: string;
}

export interface KeyRow {
  readonly source_key: string;
  readonly earliest: string | null;
  readonly versions: string;
}

/** PURE. The storage key a series is recorded under: its own id unless it names another. */
export const storageKeyOf = (s: Series): string => s.storageKey ?? s.id;

/** PURE. The day a series' history should start: its requested start, or its inception when that is later. */
export const expectedStart = (s: Series): string => (s.inception > s.requestedStart ? s.inception : s.requestedStart);

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** PURE. Why the ledger does not hold the inventory's series from their start; empty when it does. */
export function seriesProblems(series: readonly Series[], rows: readonly KeyRow[]): string[] {
  if (series.length === 0) return ["the research-series inventory lists no series: the checkout was not read"];
  const out: string[] = [];
  const byKey = new Map(rows.map((r) => [r.source_key, r]));
  for (const s of series) {
    const key = storageKeyOf(s);
    const r = byKey.get(key);
    if (!r || Number(r.versions) === 0 || r.earliest === null) { out.push(`${s.id}: no dated version under ${key} in source_value_versions`); continue; }
    const latest = addDays(expectedStart(s), START_SLACK_DAYS);
    if (r.earliest > latest) out.push(`${s.id}: the earliest dated version under ${key} is ${r.earliest}, after ${latest} (expected start ${expectedStart(s)} plus ${START_SLACK_DAYS} days): the collection floor did not reach it`);
  }
  return out;
}

/** The inventory's series, from the checkout this runs in. */
export function loadSeries(path = INVENTORY): Series[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { series?: Series[] }).series ?? [];
}

export default (async (ctx) => {
  const series = loadSeries();
  const keys = series.map(storageKeyOf);
  // The keys come from the committed inventory; each is checked for shape before it is written into the statement.
  const bad = keys.filter((k) => !/^[A-Za-z0-9:=._^-]+$/.test(k));
  if (bad.length > 0) return { found: { keys }, problems: [`the inventory names storage keys this check will not quote: ${bad.join(", ")}`] };
  const db = await ctx.db();
  const rows = await db.query<KeyRow>(
    `SELECT source_key, min(market_date)::text AS earliest, count(*)::text AS versions FROM source_value_versions WHERE source_key IN (${keys.map((k) => `'${k}'`).join(", ")}) GROUP BY source_key ORDER BY source_key`,
  );
  return { found: { series: series.length, rows }, problems: seriesProblems(series, rows) };
}) satisfies VersionCheck;
