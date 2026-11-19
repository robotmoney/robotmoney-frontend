// Ratio leg backfill (issue 1644, analytics requirements 4.3). Each run since
// issue 1644 records both Yahoo closes of every ratio symbol as legs
// (`yahoo:<SYMBOL>.close`, raw, and `yahoo:<SYMBOL>.adjclose`, adjusted). This
// command gives each of the 28 legs its full history: it fetches each of the
// fourteen symbols once from full history (period1=0), derives both closes from
// that one response and, for every (leg key, market date) that has no version
// in source_value_versions, writes one through saveSourceAcquisition with
// provenance 'backfill'.
//
// IDEMPOTENT. A (key, date) that already has a version is never touched, so a
// second run writes nothing and exits 0.
//
// KNOWLEDGE TIME. The command never supplies a knowledge_time: every row gets
// the column default, the database clock at write time. No earlier run or
// vintage can appear to have read a backfilled row (decision D74, the backfill
// rule in docs/technical/analytics-requirements.md).
//
// Usage: bun backend/scripts/ratio-legs-backfill.ts
import { sql, closeDb, type DbHandle } from "../src/db/client.ts";
import { writeMissingLedgerVersions, type LedgerGapFillResult } from "../src/analytics/store/floor-seed.ts";
import { registryRatioLegs } from "../../packages/analyst-sdk/src/extract/sources.ts";
import { fetchYahooChart, parseYahoo, parseYahooClose } from "../../packages/analyst-sdk/src/extract/yahoo.ts";
import type { Point } from "../src/analytics/types.ts";

export interface RatioLegsBackfillDeps {
  /** One symbol's Yahoo chart JSON from full history. Default: Yahoo (fetchYahooChart). */
  fetchChart?: (symbol: string) => Promise<unknown>;
  db?: DbHandle;
  log?: (line: string) => void;
}

export async function runRatioLegsBackfill(deps: RatioLegsBackfillDeps = {}): Promise<LedgerGapFillResult> {
  const fetchChart = deps.fetchChart ?? ((symbol: string) => fetchYahooChart(symbol, 0, Math.floor(Date.now() / 1000), 60_000));
  const log = deps.log ?? ((line: string) => console.log(line));
  const byKey: Record<string, Point[]> = {};
  const charts = new Map<string, unknown>();
  for (const { id, symbol, close } of registryRatioLegs()) {
    if (!charts.has(symbol)) charts.set(symbol, await fetchChart(symbol));
    let points: Point[];
    try {
      points = (close === "close" ? parseYahooClose : parseYahoo)(charts.get(symbol));
    } catch (e) {
      throw new Error(`ratio-legs-backfill: ${symbol} ${close}: ${e instanceof Error ? e.message : e}`);
    }
    // A leg with no history would leave its ratio uncomputable: fail loudly.
    if (points.length === 0) throw new Error(`ratio-legs-backfill: ${symbol} returned no ${close}`);
    byKey[id] = points;
    log(`[ratio-legs-backfill] fetched ${id}: ${points.length} value(s) ${points[0]!.date}..${points.at(-1)!.date}`);
  }
  // One acquisition per key, each with its close's parser version.
  const part = (suffix: string) => Object.fromEntries(Object.entries(byKey).filter(([k]) => k.endsWith(suffix)));
  const raw = await writeMissingLedgerVersions(part(".close"), { provider: "yahoo", parserVersion: "yahoo-close:1", provenance: "backfill" }, deps.db ?? sql);
  const adj = await writeMissingLedgerVersions(part(".adjclose"), { provider: "yahoo", parserVersion: "yahoo-adjclose:1", provenance: "backfill" }, deps.db ?? sql);
  const result: LedgerGapFillResult = { written: { ...raw.written, ...adj.written }, existing: raw.existing + adj.existing };
  for (const [key, n] of Object.entries(result.written)) log(`[ratio-legs-backfill] ${key}: wrote ${n} version(s)`);
  log(`[ratio-legs-backfill] done: ${Object.values(result.written).reduce((a, b) => a + b, 0)} written, ${result.existing} already present`);
  return result;
}

if (import.meta.main) {
  runRatioLegsBackfill()
    .catch((err) => {
      console.error(`[ratio-legs-backfill] FAILED: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
