// Issue 1753: the shared harness of the methodology v5 backend tests
// (tests/regime-v5-ledger.test.ts, tests/regime-v5-sdk-equivalence.test.ts,
// tests/api/regime-snapshots.test.ts). It drives the production orchestrator
// over the real persistence (the ledger, the vintage, the terminal package)
// with the committed-input fixture source, plus the five collected series
// v5's derived indicators read. Those five are deterministic series built on
// the fixture's own dates: no network, and nothing is skipped.
import { sql } from "../../src/db/client.ts";
import { runAnalytics } from "../../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../../src/analytics/store/direct.ts";
import { noopTelemetrySink } from "../../src/analytics/telemetry.ts";
import type { AnalyticsPersistence } from "../../src/analytics/persistence.ts";
import type { RegimeVersion } from "../../src/analytics/analyze/regime-versions.ts";
import type { Point, RawIndicatorHistory } from "../../src/analytics/types.ts";
import { ASOF, baseObservations, liveOn, poisonedSource, type Observations, type PoisonedSource } from "./committed-inputs.ts";

export { ASOF };

const DAY_MS = 86_400_000;
export const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Three consecutive as-of days ending on the fixture's last day. */
export const DAYS: readonly [string, string, string] = [addDays(ASOF, -2), addDays(ASOF, -1), ASOF];

export const FIVE = ["FED_SURPLUS_MONTHLY", "US_GDP", "CBOE_VIX3M", "CBOE_SKEW", "SPX_VOLUME"] as const;
export const FIVE_KEYS: readonly string[] = FIVE.map((id) => `raw_indicator_history:${id}`);

/** The five collected series, on the fixture's own dates. */
export function fiveSeries(base: Observations): Record<(typeof FIVE)[number], Point[]> {
  const vix = base.registry["VIX"]!;
  const months: Point[] = [];
  for (let k = 0; ; k++) {
    const date = `${2020 + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}-01`;
    if (date > ASOF) break;
    months.push({ date, value: -(150_000 + Math.round(40_000 * Math.sin(k / 5)) + 900 * k) });
  }
  const quarters: Point[] = [];
  for (let k = 0; ; k++) {
    const date = `${2019 + Math.floor(k / 4)}-${String((k % 4) * 3 + 1).padStart(2, "0")}-01`;
    if (date > ASOF) break;
    quarters.push({ date, value: 21_000 + 310 * k });
  }
  return {
    FED_SURPLUS_MONTHLY: months,
    US_GDP: quarters,
    CBOE_VIX3M: vix.map((p, i) => ({ date: p.date, value: Number((p.value * (1.06 + 0.09 * Math.sin(i / 37))).toFixed(4)) })),
    CBOE_SKEW: vix.map((p, i) => ({ date: p.date, value: Number((128 + 14 * Math.sin(i / 53) + 3 * Math.cos(i / 7)).toFixed(2)) })),
    SPX_VOLUME: base.extras.spx.map((p, i) => ({ date: p.date, value: 3_000_000_000 + Math.round(900_000_000 * Math.abs(Math.sin(i / 11))) })),
  };
}

/** The base observations with the five collected series in the registry fetch, as production acquires them. */
export async function v5Observations(): Promise<Observations> {
  const base = await baseObservations();
  return { ...base, registry: { ...base.registry, ...fiveSeries(base) } };
}

/** The whole input a run reads, by the name it is acquired under: what the SDK is given for the same inputs. */
export function sdkInput(obs: Observations): RawIndicatorHistory {
  return { ...obs.registry, SPX: obs.extras.spx, ETH: obs.extras.eth, TBILL3M: obs.extras.tbill3m };
}

export interface LedgerRun {
  runId: string;
  results: Record<string, any>;
}

/**
 * One regime run of `version` (default: the main line's) for `asof`, live on
 * that day, through the real persistence. `source` acquires through the
 * production capture path, so the run computes from the ledger.
 */
export async function runRegime(asof: string, source: PoisonedSource, version?: RegimeVersion, persistence: AnalyticsPersistence = directAnalyticsPersistence): Promise<LedgerRun> {
  const results = await runAnalytics(asof, "regime", source, persistence, noopTelemetrySink, undefined, version, liveOn(asof));
  const ledger = (results as { __runLedger?: { runId: string } }).__runLedger!;
  return { runId: ledger.runId, results };
}

/** A fixture source for one run: it never poisons (two runs of a tick may share it). */
export const sourceFor = (obs: Observations): PoisonedSource => poisonedSource(obs, 99);

/** The frozen artifact of one kind for a run: its text, and its rows. null when the run froze none of that kind. */
export async function artifact(runId: string, kind: string): Promise<{ id: string; text: string; rows: Record<string, any>[]; naturalKeys: string[] | null } | null> {
  const [row] = await sql<{ id: string; payload_bytes: Uint8Array; natural_keys: string[] | null }[]>`
    SELECT id::text AS id, payload_bytes, natural_keys FROM analytics_output_snapshots WHERE run_id = ${runId}::bigint AND artifact_kind = ${kind}`;
  if (!row) return null;
  const text = new TextDecoder().decode(row.payload_bytes);
  return { id: row.id, text, rows: JSON.parse(text) as Record<string, any>[], naturalKeys: row.natural_keys };
}

/** Every artifact kind a run froze, sorted. */
export async function artifactKinds(runId: string): Promise<string[]> {
  const rows = await sql<{ artifact_kind: string }[]>`SELECT artifact_kind FROM analytics_output_snapshots WHERE run_id = ${runId}::bigint ORDER BY artifact_kind`;
  return rows.map((r) => r.artifact_kind);
}

/** The regime_snapshots table as text, every column of every row in date order. */
export async function regimeTable(): Promise<string> {
  const rows = await sql`SELECT * FROM regime_snapshots ORDER BY date`;
  return JSON.stringify(rows);
}
