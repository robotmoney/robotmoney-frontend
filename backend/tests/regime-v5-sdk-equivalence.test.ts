// Issue 1753: what the backend publishes for methodology v5 is what the SDK
// computes. Three v5 runs for three consecutive as-of days go through the
// production orchestrator and the real persistence; the same inputs go through
// the SDK's kept-record functions alone. Every published row equals the SDK's
// row, field for field and exactly as doubles (the frozen artifact's bytes are
// the SDK rows' canonical JSON). The third run then replays from its frozen
// vintage plus the artifacts its report names. The backtest on the published
// v5 as-of row is computeBacktest under REGIME_BACKTEST_RULES.v5, and a v4 run
// on the same inputs stores the backtest computeBacktest gives with no options.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { findVintageByRunAndTool, resolveVintageMembers } from "../src/analytics/store/run-ledger-store.ts";
import { loadReportSnapshot } from "../src/analytics/store/output-snapshot-store.ts";
import { canonicalStringify, sha256Hex } from "../src/analytics/output-snapshots.ts";
import { computeKeptRegime, keptRegimeRows, type KeptDay, type KeptRegimeRun } from "../../packages/analyst-sdk/src/analyze/kept-regime.ts";
import { computeBacktest, stripDailyFromSnapshot, REGIME_BACKTEST_RULES } from "../../packages/analyst-sdk/src/analyze/backtest.ts";
import { computeCorrelations } from "../../packages/analyst-sdk/src/analyze/correlations.ts";
import { computeRegime } from "../../packages/analyst-sdk/src/analyze/compute.ts";
import { PANELS } from "../../packages/analyst-sdk/src/analyze/indicators.ts";
import { cutAtAsof, prepareRegimeInputs } from "../../packages/analyst-sdk/src/prepare.ts";
import { inputHistoryFromStorage, resolveInputHistory } from "../../packages/analyst-sdk/src/series-ids.ts";
import { seriesMappingFor, storedUnderFor } from "../../packages/analyst-sdk/src/model/index.ts";
import { ratioDeclarationsFor, ratiosFromLegs } from "../../packages/analyst-sdk/src/transform/ratios.ts";
import type { RegimeVersion } from "../../packages/analyst-sdk/src/analyze/regime-versions.ts";
import type { RawIndicatorHistory } from "../../packages/analyst-sdk/src/types.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { ASOF, DAYS, artifact, runRegime, sdkInput, sourceFor, v5Observations } from "./support/regime-v5.ts";

useCleanDatabasePerTest(import.meta.file);

const START = "2018-01-01";

/** An input by the names it is acquired under, as the ids the computation of `version` reads. */
function resolved(input: RawIndicatorHistory, version: RegimeVersion): RawIndicatorHistory {
  return ratiosFromLegs(input, resolveInputHistory(input, seriesMappingFor(version), storedUnderFor(version)), ratioDeclarationsFor(version));
}

/** The rows the SDK publishes for one run, in the stored row shape. */
function sdkRows(run: KeptRegimeRun, input: RawIndicatorHistory, asof: string) {
  const { record } = run;
  const extras = { spx: cutAtAsof(input["SPX"] ?? [], asof), eth: cutAtAsof(input["ETH"] ?? [], asof), tbill3m: cutAtAsof(input["TBILL3M"] ?? [], asof) };
  const labels = { regime: record.regime, panelRegimes: record.panelRegimes, panels: PANELS };
  const backtest = stripDailyFromSnapshot(computeBacktest(record.dateAxis, labels, extras, REGIME_BACKTEST_RULES.v5));
  const correlations = computeCorrelations(record.dateAxis, { composite: record.composite, panelIndices: record.panelIndices, panels: PANELS }, extras);
  const rows = keptRegimeRows(run, { source: "fixture", backtest, correlations });
  return { rows, backtest, labels, extras };
}

const keptOf = (rows: readonly Record<string, any>[]): KeptDay[] =>
  rows.map((r) => ({ date: r.date, panelIndices: { macro: r.macroIndex ?? NaN, onchain: r.onchainIndex ?? NaN, factor: r.factorIndex ?? NaN } }));

describe("the backend's v5 rows are the SDK's (issue 1753)", () => {
  test("three runs publish exactly the SDK's rows; the third replays from its vintage and the artifacts its report names; the backtests are their rule rows'", async () => {
    const obs = await v5Observations();
    await directAnalyticsPersistence.saveRawHistory({ MNA: obs.mna }, "fixture");
    const source = sourceFor(obs);
    try {
      // A v4 run on the same inputs, in the same test.
      const v4 = await runRegime(ASOF, source);
      const runs = [];
      for (const day of DAYS) runs.push(await runRegime(day, source, "v5"));

      // ── The SDK alone, on the same inputs ──────────────────────────────────
      const input = resolved(sdkInput(obs), "v5");
      const published: Record<string, any>[] = [];
      let sdkThird: ReturnType<typeof sdkRows> | null = null;
      for (const [k, run] of runs.entries()) {
        const day = DAYS[k]!;
        const sdkRun = computeKeptRegime(input, { asof: day, start: START, version: "v5", kept: keptOf(published) });
        const sdk = sdkRows(sdkRun, input, day);
        const frozen = (await artifact(run.runId, "regime_beside_snapshots"))!;
        // Field for field and exactly as doubles: the frozen bytes are the SDK rows' canonical JSON.
        expect(frozen.rows.length).toBe(sdk.rows.length);
        for (const [i, row] of frozen.rows.entries()) {
          const mine = JSON.parse(canonicalStringify(sdk.rows[i]!)) as Record<string, unknown>;
          expect(Object.keys(row).sort()).toEqual(Object.keys(mine).sort());
          for (const field of Object.keys(mine)) {
            if (!Object.is(JSON.stringify(row[field]), JSON.stringify(mine[field]))) expect({ day, date: row.date, field, backend: row[field] }).toEqual({ day, date: row.date, field, backend: mine[field] });
          }
        }
        expect(frozen.text === canonicalStringify(sdk.rows)).toBe(true);
        expect(k === 0 ? frozen.rows.length > 1000 : frozen.rows.length === 1).toBe(true);
        published.push(...frozen.rows);
        if (k === 2) sdkThird = sdk;
      }

      // ── The third run again, from its vintage and the artifacts its report names ──
      const third = runs[2]!;
      const vintage = (await findVintageByRunAndTool(third.runId, "regime"))!;
      const members = await resolveVintageMembers(vintage.vintageId);
      const fromVintage = inputHistoryFromStorage(members.filter((m) => m.marketDate !== null).map((m) => ({ sourceKey: m.sourceKey, marketDate: m.marketDate, value: m.value })), seriesMappingFor("v5"));
      const replayInput = ratiosFromLegs(fromVintage, fromVintage, ratioDeclarationsFor("v5"));
      const [{ report_id }] = await sql<{ report_id: string }[]>`SELECT id::text AS report_id FROM analytics_report_snapshots WHERE run_id = ${third.runId}::bigint`;
      const report = JSON.parse(new TextDecoder().decode((await loadReportSnapshot(report_id))!.bytes)) as { asof: string; results: { regime: { methodology: string; kept: { days: number; artifactIds: string[]; sha256: string } } } };
      expect(report.asof).toBe(DAYS[2]);
      expect(report.results.regime.methodology).toBe("v5");
      const named = report.results.regime.kept.artifactIds;
      expect(named.length).toBe(2);
      // The kept days are the named artifacts' rows dated before the as-of day, a later artifact's row replacing an earlier one's.
      const byDate = new Map<string, Record<string, any>>();
      for (const id of named) {
        const [{ payload_bytes, artifact_kind }] = await sql<{ payload_bytes: Uint8Array; artifact_kind: string }[]>`SELECT payload_bytes, artifact_kind FROM analytics_output_snapshots WHERE id = ${id}::bigint`;
        expect(artifact_kind).toBe("regime_beside_snapshots");
        for (const row of JSON.parse(new TextDecoder().decode(payload_bytes)) as Record<string, any>[]) if (row.date < DAYS[2]) byDate.set(row.date, row);
      }
      const keptRows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      expect(keptRows.length).toBe(report.results.regime.kept.days);
      const keptDays = keptRows.map((r) => ({ date: r.date, macroIndex: r.macroIndex ?? null, onchainIndex: r.onchainIndex ?? null, factorIndex: r.factorIndex ?? null }));
      expect(sha256Hex(canonicalStringify(keptDays))).toBe(report.results.regime.kept.sha256);
      const replay = computeKeptRegime(replayInput, { asof: DAYS[2], start: START, version: "v5", kept: keptOf(keptRows) });
      const replayed = sdkRows(replay, replayInput, DAYS[2]);
      const publishedThird = (await artifact(third.runId, "regime_beside_snapshots"))!;
      expect(replayed.rows.length).toBe(1);
      expect(canonicalStringify(replayed.rows) === publishedThird.text).toBe(true);

      // ── The published v5 backtest is computeBacktest under REGIME_BACKTEST_RULES.v5 ──
      const asofRow = publishedThird.rows[0]!;
      const { labels, extras } = sdkThird!;
      const dateAxis = replay.record.dateAxis;
      const expected = stripDailyFromSnapshot(computeBacktest(dateAxis, labels, extras, REGIME_BACKTEST_RULES.v5));
      expect(asofRow.backtest).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(canonicalStringify(asofRow.backtest)).toBe(canonicalStringify(expected));
      // It is not the default rule set: the v4 row gives other figures on the same labels and prices.
      expect(canonicalStringify(asofRow.backtest)).not.toBe(canonicalStringify(stripDailyFromSnapshot(computeBacktest(dateAxis, labels, extras, REGIME_BACKTEST_RULES.v4))));
      expect(REGIME_BACKTEST_RULES.v5).toEqual({ splitDate: "2024-01-31", lagSessions: 0, calendars: { eth: "continuous", sp500: "continuous" }, cashBasis: "yield", sharpeBasis: "returns" });

      // ── The v4 run stores the backtest it stored before: computeBacktest with no options ──
      const v4Rows = (await artifact(v4.runId, "regime_snapshots"))!.rows;
      const v4Asof = v4Rows.at(-1)!;
      expect(v4Asof.date).toBe(ASOF);
      expect(v4Asof.version).toBe("v4");
      const v4Input = resolved(sdkInput(obs), "v4");
      const prepared = prepareRegimeInputs(v4Input, { start: START, asof: ASOF, version: "v4" });
      const r2 = computeRegime(prepared.transformed, prepared.dateAxis, PANELS, prepared.ages, undefined, "v4", undefined, undefined, undefined, prepared.carried);
      const v4Extras = { spx: cutAtAsof(v4Input["SPX"]!, ASOF), eth: cutAtAsof(v4Input["ETH"]!, ASOF), tbill3m: cutAtAsof(v4Input["TBILL3M"]!, ASOF) };
      const before = stripDailyFromSnapshot(computeBacktest(prepared.dateAxis, r2, v4Extras));
      expect(canonicalStringify(v4Asof.backtest)).toBe(canonicalStringify(before));
      expect(v4Asof.backtest.eth.composite.sample_split_date).toBe(REGIME_BACKTEST_RULES.v4.splitDate);
      // The v4 artifact carries nothing of v5: 26 indicators, VIX in macro, no kept block in its report.
      expect(v4Asof.indicators.length).toBe(26);
      expect(v4Asof.indicators.find((i: any) => i.id === "VIX").panel).toBe("macro");
      expect(v4.results.regime.methodology).toBeUndefined();
      expect(v4.results.regime.kept).toBeUndefined();
      expect(Object.keys(v4.results.regime).sort()).toEqual(["asof", "composite", "compositePercentile", "regime", "rows"]);
    } finally {
      source.restore();
    }
  }, 900_000);
});
