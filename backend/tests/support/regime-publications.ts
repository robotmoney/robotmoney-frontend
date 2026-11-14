// Issue 1182 (decision D83): fixtures for the frozen-publication tests.
//
// A day's published figure depends on WHEN each run's artifact was written
// (during the day, or after it), and a test cannot move the clock. So a run
// "written" on a past day is recorded here with that created_at, straight
// into the ledger tables through the owner handle; a run written now goes
// through the production writer (submitTerminalRunPackage), which also
// upserts the compatibility tables (last write wins, as in production).
import { sql } from "../../src/db/client.ts";
import { beginRun } from "../../src/analytics/store/run-ledger-store.ts";
import { submitTerminalRunPackage } from "../../src/analytics/store/output-snapshot-store.ts";
import { buildOutputArtifact, buildReportArtifact, type ResearchSignalArtifact } from "../../src/analytics/output-snapshots.ts";
import type { RegimeSnapshotRow } from "../../src/analytics/report/regime-projection.ts";
import { fixtureDb } from "./fixture-db.ts";

/** A UTC day `offset` days from today, as YYYY-MM-DD. */
export function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Noon UTC of a day, as an ISO instant. */
export const noon = (d: string): string => `${d}T12:00:00Z`;

export function regimeRow(date: string, composite: number, regime = "risk_on"): RegimeSnapshotRow {
  return {
    date, composite, compositePercentile: 0.5, regime,
    macroRegime: null, onchainRegime: null, factorRegime: null,
    macroIndex: null, onchainIndex: null, factorIndex: null,
    macroPercentile: null, onchainPercentile: null, factorPercentile: null,
    panelWeights: null, version: "v-test", source: "fixture",
    percentiles: {}, indicators: [], panels: null, bucketThresholds: null,
    backtest: null, correlations: null, extras: null,
  };
}

/**
 * A regime row with every rich column populated (issue 1182, folded-in 995):
 * backtest, correlations, indicators, percentiles, panels, panel weights,
 * bucket thresholds and extras, plus every panel figure and label.
 */
export function richRegimeRow(date: string, composite: number): RegimeSnapshotRow {
  return {
    ...regimeRow(date, composite),
    macroRegime: "neutral", onchainRegime: "risk_on", factorRegime: "risk_off",
    macroIndex: 0.41, onchainIndex: 0.73, factorIndex: 0.22,
    macroPercentile: 0.44, onchainPercentile: 0.81, factorPercentile: 0.19,
    panelWeights: { macro: { VIX: 0.55 }, onchain: { DEFI_TVL: 0.45 } },
    percentiles: { VIX: 0.31, DEFI_TVL: 0.88 },
    indicators: [
      { id: "VIX", raw_value: 17.2, raw_date: date, transformed_value: 17.2, percentile: 0.31, signed_percentile: 0.69, panel_weight: 0.12, sparkline: [16.9, 17.2] },
    ],
    panels: ["macro", "onchain"],
    bucketThresholds: { risk_off: 0.35, risk_on: 0.6 },
    backtest: { strategies: [{ id: "regime", cagr: 0.18, maxDrawdown: -0.31 }], asof: date },
    correlations: { concurrent: { composite: { eth: { rho: 0.42, n: 900 } } } },
    extras: { staleness: { VIX: 0 }, note: "issue-995 fixture" },
  };
}

export function researchSignal(key: string, date: string, title: string): ResearchSignalArtifact {
  return { key, date, payload: { asof: date, title, question: "q", spec: {}, gauges: [] } } as unknown as ResearchSignalArtifact;
}

export interface RunSpec {
  asof: string;
  regime?: RegimeSnapshotRow[];
  research?: ResearchSignalArtifact[];
  sourceLabel?: string;
}

async function begin(spec: RunSpec): Promise<string> {
  const { runId } = await beginRun({
    runKey: crypto.randomUUID(),
    asof: spec.asof,
    toolId: "regime",
    sourceLabel: spec.sourceLabel ?? "live",
    methodology: { toolId: "regime", versionLabel: "v-test", config: { issue: 1182 } },
    buildIdentity: "issue-1182-test",
  });
  return runId;
}

/** A run written NOW, through the production writer: frozen artifacts and the compatibility rows, one transaction. */
export async function publishNow(spec: RunSpec): Promise<{ runId: string; reportSnapshotId: string }> {
  const runId = await begin(spec);
  const result = await submitTerminalRunPackage({
    runId,
    asof: spec.asof,
    status: "succeeded",
    regimeSnapshots: spec.regime ?? [],
    researchSignals: spec.research ?? [],
    reportBytes: new TextEncoder().encode(`report ${runId} ${spec.asof}`),
  });
  return { runId, reportSnapshotId: result.reportSnapshotId! };
}

/**
 * A run WRITTEN at `writtenAt` (an ISO instant): its artifacts and report carry
 * that created_at. Only the ledger is written, unless `compat`, which also
 * upserts the compatibility rows now through the production writers, as the
 * run did when it was written.
 */
export async function recordWrittenAt(spec: RunSpec & { writtenAt: string; compat?: boolean }): Promise<string> {
  const runId = await begin(spec);
  const regime = buildOutputArtifact("regime_snapshots", spec.regime ?? []);
  const research = buildOutputArtifact("research_signals", spec.research ?? []);
  const report = buildReportArtifact(new TextEncoder().encode(`report ${runId} ${spec.asof}`));
  await fixtureDb.begin(async (tx) => {
    for (const [kind, artifact] of [["regime_snapshots", regime], ["research_signals", research]] as const) {
      await tx`
        INSERT INTO analytics_output_snapshots (run_id, artifact_kind, payload_bytes, checksum, created_at)
        VALUES (${runId}::bigint, ${kind}, ${Buffer.from(artifact.bytes)}, ${artifact.checksum}, ${spec.writtenAt}::timestamptz)`;
    }
    await tx`
      INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum, created_at)
      VALUES (${runId}::bigint, ${spec.asof}::date, ${Buffer.from(report.bytes)}, ${report.checksum}, ${spec.writtenAt}::timestamptz)`;
  });
  if (spec.compat) {
    const { saveRegimeSnapshots } = await import("../../src/analytics/store/regime-store.ts");
    const { persistResearchSignal } = await import("../../src/analytics/store/research-store.ts");
    await saveRegimeSnapshots(spec.regime ?? []);
    for (const s of spec.research ?? []) await persistResearchSignal(s.key, s.date, s.payload);
  }
  return runId;
}

/**
 * Admit `source_label = 'replay'` (issue 1162's label) in this test file's own
 * database, so a test can record a replay run before 1162 lands. Owner only,
 * on the per-file clone; no migration and no production schema changes.
 */
export async function admitReplayLabel(): Promise<void> {
  await fixtureDb.unsafe(`ALTER TABLE analytics_ledger_runs DROP CONSTRAINT IF EXISTS analytics_ledger_runs_source_label_check`);
}

/** Set the read mode, as the owner. */
export async function setReadMode(mode: "compatibility" | "ledger"): Promise<void> {
  await fixtureDb`UPDATE analytics_read_mode SET mode = ${mode}, updated_by = 'issue-1182-test' WHERE id = true`;
}

/** The served composite of each day, through the endpoint's projection, in one read mode. */
export async function servedComposites(mode: "compatibility" | "ledger", range = 400): Promise<Record<string, number | null>> {
  await setReadMode(mode);
  const { fetchRegimeSnapshots } = await import("../../src/analytics/report/projections.ts");
  const { history } = await fetchRegimeSnapshots(range);
  return Object.fromEntries(history.map((h) => [h.date, h.composite]));
}

export { sql };
