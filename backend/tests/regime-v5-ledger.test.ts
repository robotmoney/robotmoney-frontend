// Issue 1753: methodology v5 runs through the ledger beside the main line.
// Three v5 runs for three consecutive as-of days go through the production
// orchestrator and the real persistence: the first walks forward from the axis
// start and freezes every day that has a composite mean, the later two read
// the kept days and freeze exactly one row each, all under the artifact kind
// `regime_beside_snapshots`. Nothing a main-line reader sees changes: the
// regime_snapshots table, the main-line response of GET
// /api/dashboards/regime-snapshots and the swarm brief's report lookup are
// byte-identical to their state before the v5 runs.
import { describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { getRegimeSnapshots } from "../src/api/routes/dashboards.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { findVintageByRunAndTool, resolveVintageMembers } from "../src/analytics/store/run-ledger-store.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import { runProducerOnce } from "../src/producer/index.ts";
import { ledgerKeptRegimeDays, ledgerPublishedRegimeDays, besideRegimeLine } from "../src/analytics/cutover/ledger-current.ts";
import type { AnalyticsPersistence } from "../src/analytics/persistence.ts";
import * as epoch from "../src/swarm/domain.ts";
import { buildBriefBody } from "../src/swarm/domain.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { liveOn } from "./support/committed-inputs.ts";
import { activeSubject } from "./support/epoch-fixtures.ts";
import { ASOF, DAYS, FIVE_KEYS, addDays, artifact, artifactKinds, regimeTable, runRegime, sourceFor, v5Observations } from "./support/regime-v5.ts";

useCleanDatabasePerTest(import.meta.file);

const mainLineBody = async (): Promise<string> =>
  JSON.stringify(await getRegimeSnapshots(new URL(`http://backend.test${ROUTES.dashboards.regimeSnapshots}?range=4000&include=backtest`)));

/** The swarm brief's regime block and the report snapshot it binds: the brief's lookup of the report a run froze. */
async function briefReport(): Promise<string> {
  await sql`UPDATE swarm_judge_config SET model = 'deepseek-v4.1-flash' WHERE id = 1`;
  const subjectId = await activeSubject(`v5_brief_${crypto.randomUUID().slice(0, 8)}`, 1800);
  const session = await epoch.openSession(subjectId);
  const [s] = await sql<any[]>`SELECT * FROM swarm_sessions WHERE id = ${session.id}`;
  const { body, reportSnapshotId } = await buildBriefBody(s, new Date().toISOString(), undefined, sql);
  return JSON.stringify({ regime: body["regime"] ?? null, reportSnapshotId });
}

describe("three v5 runs through the ledger (issue 1753)", () => {
  test("the first run walks forward and freezes every day with a composite mean, the later two freeze one row; the main line is untouched", async () => {
    const obs = await v5Observations();
    await directAnalyticsPersistence.saveRawHistory({ MNA: obs.mna }, "fixture");

    // The main line first: one v4 run, so there is a served line to leave alone.
    const source = sourceFor(obs);
    try {
      const main = await runRegime(ASOF, source);
      expect(await artifactKinds(main.runId)).toEqual(["regime_snapshots", "research_signals"]);
      const tableBefore = await regimeTable();
      const bodyBefore = await mainLineBody();
      const briefBefore = await briefReport();
      expect(JSON.parse(bodyBefore).history.length).toBeGreaterThan(1000);
      expect(JSON.parse(bodyBefore).methodology).toBeUndefined();
      expect(JSON.parse(briefBefore).reportSnapshotId).not.toBeNull();
      const mainDaysBefore = await ledgerPublishedRegimeDays();

      // Three v5 runs, one per consecutive as-of day.
      const runs = [];
      for (const day of DAYS) runs.push(await runRegime(day, source, "v5"));

      for (const [k, run] of runs.entries()) {
        const day = DAYS[k]!;
        // The run is stamped v5, and its regime_snapshots artifact is the empty list.
        const [header] = await sql<{ version_label: string; asof: string; tool_id: string }[]>`
          SELECT m.version_label, r.asof::text AS asof, r.tool_id FROM analytics_ledger_runs r
            JOIN analytics_ledger_methodology_versions m ON m.id = r.methodology_version_id WHERE r.id = ${run.runId}::bigint`;
        expect(header).toEqual({ version_label: "v5", asof: day, tool_id: "regime" });
        expect(await artifactKinds(run.runId)).toEqual(["regime_beside_snapshots", "regime_snapshots", "research_signals"]);
        const empty = (await artifact(run.runId, "regime_snapshots"))!;
        expect(empty.text).toBe("[]");
        expect(empty.naturalKeys).toEqual([]);

        const beside = (await artifact(run.runId, "regime_beside_snapshots"))!;
        // Its natural keys are its row dates, in order (migration 0136).
        expect(beside.naturalKeys).toEqual(beside.rows.map((r) => r.date));
        for (const row of beside.rows) {
          expect(row.version).toBe("v5");
          expect(row.compositePercentile).toBeNull();
          expect([row.macroPercentile, row.onchainPercentile, row.factorPercentile]).toEqual([null, null, null]);
        }
        const asofRow = beside.rows.at(-1)!;
        expect(asofRow.date).toBe(day);
        expect(asofRow.indicators.length).toBe(30);
        expect(asofRow.panels).toEqual(["macro", "onchain", "factor"]);
        expect(asofRow.panelWeights.weightFitDate).toBe(day);
        expect(Object.keys(asofRow.panelWeights).sort()).toEqual(["factor", "macro", "onchain", "weightFitDate"]);
        expect(Object.keys(asofRow.backtest).sort()).toEqual(["eth", "mixed", "sp500"]);
        expect(asofRow.backtest.eth.composite.sample_split_date).toBe("2024-01-31");
        expect(asofRow.correlations).not.toBeNull();
        expect(asofRow.regime).not.toBeNull();

        if (k === 0) {
          // The first run finds no kept day: a row for every day with a composite mean, from the axis start.
          expect(run.results.regime.kept).toMatchObject({ days: 0, artifactIds: [] });
          expect(beside.rows.length).toBeGreaterThan(1000);
          const dates = beside.rows.map((r) => r.date as string);
          expect([...dates].sort()).toEqual(dates);
          expect(new Set(dates).size).toBe(dates.length);
          // Every day from the first row to the as-of day is there: the fixture has no day without a panel index.
          expect(dates.length).toBe((Date.parse(day) - Date.parse(dates[0]!)) / 86_400_000 + 1);
          for (const row of beside.rows) expect([row.macroIndex, row.onchainIndex, row.factorIndex].some((v) => typeof v === "number")).toBe(true);
          // composite and regime are null before the 30th mean, so a later run can rebuild the record.
          const unlabelled = beside.rows.filter((r) => r.regime === null);
          expect(unlabelled.length).toBe(29);
          expect(beside.rows.slice(0, 29).every((r) => r.composite === null && r.regime === null)).toBe(true);
          expect(beside.rows.slice(29).every((r) => typeof r.composite === "number" && typeof r.regime === "string")).toBe(true);
          // Only the as-of row carries the heavy blobs.
          expect(beside.rows.slice(0, -1).every((r) => r.indicators.length === 0 && r.backtest === null && r.correlations === null && r.panels === null && r.panelWeights === null)).toBe(true);
        } else {
          // A later run computes only its own day and freezes exactly that row.
          expect(beside.rows.length).toBe(1);
          const first = (await artifact(runs[0]!.runId, "regime_beside_snapshots"))!;
          expect(run.results.regime.kept.days).toBe(first.rows.length + (k - 1));
          // Its report names the artifacts the kept days came from: one per earlier run, in order.
          expect(run.results.regime.kept.artifactIds).toEqual(await Promise.all(runs.slice(0, k).map(async (r) => (await artifact(r.runId, "regime_beside_snapshots"))!.id)));
        }
        expect(run.results.regime).toMatchObject({ asof: day, rows: beside.rows.length, methodology: "v5", compositePercentile: null, regime: asofRow.regime, composite: asofRow.composite });

        // Its vintage holds the five collected storage keys, among the regime keys.
        const vintage = (await findVintageByRunAndTool(run.runId, "regime"))!;
        const memberKeys = new Set((await resolveVintageMembers(vintage.vintageId)).map((m) => m.sourceKey));
        for (const key of FIVE_KEYS) expect({ key, member: memberKeys.has(key) }).toEqual({ key, member: true });
        expect(memberKeys.has("raw_indicator_history:VIX")).toBe(true);
        expect(memberKeys.has("backtest:^GSPC")).toBe(true);
      }

      // The v5 line: the first run's days, then each later run's own day.
      const first = (await artifact(runs[0]!.runId, "regime_beside_snapshots"))!;
      const line = await ledgerPublishedRegimeDays(sql, besideRegimeLine("v5"));
      expect(line).toEqual([...first.rows.map((r) => r.date as string), DAYS[1], DAYS[2]]);
      const kept = await ledgerKeptRegimeDays("v5", addDays(ASOF, 1));
      expect(kept.days.map((d) => d.date)).toEqual(line);
      expect(kept.artifactIds.length).toBe(3);

      // Nothing a reader of the main line sees has moved.
      expect(await regimeTable()).toBe(tableBefore);
      expect(await mainLineBody()).toBe(bodyBefore);
      expect(await briefReport()).toBe(briefBefore);
      expect(await ledgerPublishedRegimeDays()).toEqual(mainDaysBefore);
      const tableVersions = await sql<{ version: string | null }[]>`SELECT DISTINCT version FROM regime_snapshots`;
      expect(tableVersions.map((r) => r.version)).toEqual(["v4"]);
    } finally {
      source.restore();
    }
  }, 900_000);
});

describe("a failed v5 run (issue 1753)", () => {
  test("a v5 run that throws leaves no regime_beside_snapshots artifact, and the main-line run of the same producer tick still publishes", async () => {
    const obs = await v5Observations();
    await directAnalyticsPersistence.saveRawHistory({ MNA: obs.mna }, "fixture");
    const source = sourceFor(obs);
    // The v5 run's kept-days read fails; nothing else of the persistence changes.
    const failing: AnalyticsPersistence = {
      ...directAnalyticsPersistence,
      loadKeptRegimeDays: async () => {
        throw new Error("kept days unavailable");
      },
    };
    const started: string[] = [];
    try {
      const out = await runProducerOnce("regime", ASOF, {
        source,
        persistence: failing,
        runner: (date, tool, src, store, run) => {
          started.push(run?.regimeVersion ?? "main");
          return runAnalytics(date, tool, src, store, noopTelemetrySink, undefined, run?.regimeVersion, { ...liveOn(date), ...(run?.runSource ? { runSource: run.runSource } : {}) });
        },
      });
      // The tick ran both, in order, and answers with the main-line run's result.
      expect(started).toEqual(["main", "v5"]);
      expect((out as any).regime.asof).toBe(ASOF);
      expect((out as any).regime.methodology).toBeUndefined();
    } finally {
      source.restore();
    }
    const runs = await sql<{ id: string; version_label: string }[]>`
      SELECT r.id::text AS id, m.version_label FROM analytics_ledger_runs r
        JOIN analytics_ledger_methodology_versions m ON m.id = r.methodology_version_id ORDER BY r.id`;
    expect(runs.map((r) => r.version_label)).toEqual(["v4", "v5"]);
    const main = runs[0]!;
    const v5 = runs[1]!;
    // The main-line run published: a non-empty regime artifact and the table.
    expect(await artifactKinds(main.id)).toEqual(["regime_snapshots", "research_signals"]);
    expect((await artifact(main.id, "regime_snapshots"))!.rows.length).toBeGreaterThan(1000);
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM regime_snapshots WHERE version = 'v4'`;
    expect(n).toBeGreaterThan(1000);
    // The failed v5 run froze its failure, and no regime artifact of either kind.
    expect(await artifactKinds(v5.id)).toEqual(["exceptions", "logs", "warnings"]);
    const [{ beside }] = await sql<{ beside: number }[]>`SELECT COUNT(*)::int AS beside FROM analytics_output_snapshots WHERE artifact_kind = 'regime_beside_snapshots'`;
    expect(beside).toBe(0);
    const events = await sql<{ event_type: string }[]>`SELECT event_type FROM analytics_ledger_run_events WHERE run_id = ${v5.id}::bigint ORDER BY sequence`;
    expect(events.map((e) => e.event_type)).toEqual(["started", "failed"]);
    expect((await artifact(v5.id, "exceptions"))!.rows[0]!.message).toContain("kept days unavailable");
    // Nothing of v5 is served, on either line.
    expect(await ledgerPublishedRegimeDays(sql, besideRegimeLine("v5"))).toEqual([]);
    const [{ v5rows }] = await sql<{ v5rows: number }[]>`SELECT COUNT(*)::int AS v5rows FROM regime_snapshots WHERE version = 'v5'`;
    expect(v5rows).toBe(0);
  }, 900_000);
});
