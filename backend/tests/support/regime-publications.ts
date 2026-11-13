// Issue 1182 (decision D83): fixtures for the frozen-publication tests.
//
// A day's published figure depends on WHEN each run was written (on or before
// the day, or after it), and a test cannot move the clock. So a run "written"
// on a past day is recorded here with that created_at, straight into the
// ledger tables through the owner handle; a run written now goes through the
// production writer (submitTerminalRunPackage), which also writes the
// compatibility tables under migration 0132's guard triggers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

export function researchSignal(key: string, date: string, title: string): ResearchSignalArtifact {
  return { key, date, payload: { asof: date, title, question: "q", spec: {}, gauges: [] } } as unknown as ResearchSignalArtifact;
}

export interface RunSpec {
  asof: string;
  regime?: RegimeSnapshotRow[];
  research?: ResearchSignalArtifact[];
  sourceLabel?: "live" | "hermetic" | "fixture" | "replay";
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

/** A run written NOW, through the production writer: frozen artifacts and the guarded compatibility rows, one transaction. */
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
 * that created_at. Only the ledger is written; `compat` additionally writes the
 * compatibility rows now, through the production writers, which is what the
 * run would have written then whenever the guard gives the same answer for both
 * instants (the first run of a database, or rows for days not yet over then and
 * absent now).
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
 * Out-of-band writes the guard triggers would skip: the state the code before
 * migration 0132 left behind, or a corruption the parity sweep must catch.
 * Owner only; the triggers are re-armed before the transaction commits.
 */
export async function withoutPublicationGuards(run: (tx: typeof fixtureDb) => Promise<unknown>): Promise<void> {
  await fixtureDb.begin(async (tx) => {
    await tx.unsafe("ALTER TABLE regime_snapshots DISABLE TRIGGER regime_snapshots_publication_guard");
    await tx.unsafe("ALTER TABLE research_signals DISABLE TRIGGER research_signals_publication_guard");
    await run(tx as unknown as typeof fixtureDb);
    await tx.unsafe("ALTER TABLE regime_snapshots ENABLE ALWAYS TRIGGER regime_snapshots_publication_guard");
    await tx.unsafe("ALTER TABLE research_signals ENABLE ALWAYS TRIGGER research_signals_publication_guard");
  });
}

/** Re-apply migration 0132 as the owner, exactly as its file reads (it is idempotent). */
export async function applyMigration0132(): Promise<void> {
  const text = readFileSync(join(import.meta.dir, "..", "..", "migrations", "0132_regime_publications.sql"), "utf8");
  await fixtureDb.begin(async (tx) => {
    await tx.unsafe(text);
  });
}

/** The served composite of each day through the runtime role's eyes, for `range` days. */
export async function servedComposites(mode: "compatibility" | "ledger", range = 400): Promise<Record<string, number | null>> {
  await fixtureDb`UPDATE analytics_read_mode SET mode = ${mode}, updated_by = 'issue-1182-test' WHERE id = true`;
  const { fetchRegimeSnapshots } = await import("../../src/analytics/report/projections.ts");
  const { history, source } = await fetchRegimeSnapshots(range);
  if (source !== (mode === "ledger" ? "ledger" : "regime_snapshots")) throw new Error(`read mode ${mode} answered from ${source}`);
  return Object.fromEntries(history.map((h) => [h.date, h.composite]));
}

export { sql };
