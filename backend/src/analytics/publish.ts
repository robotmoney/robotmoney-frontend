// The publish stage of an analytics run (issue 1765, phase 3; proposal section
// 6.4): the run's place in the immutable ledger (issue #977), its vintage, its
// telemetry (issue #151) and its one terminal package (issue #978).
//
// A run begins in the ledger before any source call (beginLedgerRun), freezes
// the vintage of what it computed from (freezeRunVintage) and ends with one
// terminal package (finishLedgerRun). A producer tick begins one ledger run per
// live model, main line first, then extracts once for all of them; a single
// run (runAnalytics) begins, extracts and computes for itself. Each run keeps
// its own outcome: one run's failure never reaches another run's package.
import { randomUUID } from "node:crypto";
import type { AnalyticsPersistence, FreezeVintageResult } from "./persistence.ts";
import type { RegimeVersion } from "./analyze/regime-versions.ts";
import type { Logger } from "./access/data-source.ts";
import { resolveBuildIdentity } from "./build-identity.ts";
import type { MethodologyIdentity } from "./run-ledger.ts";
import { canonicalStringify } from "./output-snapshots.ts";
import type { TerminalRunPackageInput, ResearchSignalArtifact, WarningArtifact, LogArtifact, ExceptionArtifact } from "./output-snapshots.ts";
import type { RegimeSnapshotRow } from "./report/regime-projection.ts";
import { TelemetryCollector, submitTelemetrySafely, boundedPreview, type TelemetrySink, type TelemetryRunStatus } from "./telemetry.ts";

// Issue #180: research-signal payloads (channel-divergence/late-cycle-signals)
// carry a full multi-year daily series (research-signals.ts::seriesOf), unlike
// results.regime, which is already small scalars. Migration 0018 documents
// research_pipeline_runs.summary as "small result summary ... never a full
// series" — the same bound the artifact previews already get via
// boundedPreview() (telemetry.ts). Apply that same truncation to ONLY the
// research-signal entries of the telemetry summary, leaving regime (and any
// other) entries untouched so regime telemetry behavior is unperturbed.
// Exported (issue #614 AC4) so producer/index.ts's catch-up mechanism checks
// EXACTLY these two signal_keys rather than duplicating the literal list and
// risking drift.
export const RESEARCH_SIGNAL_TELEMETRY_KEYS = ["channel-divergence", "late-cycle-signals"] as const;

function boundedTelemetrySummary(raw: Record<string, unknown>): Record<string, unknown> {
  let out = raw;
  for (const key of RESEARCH_SIGNAL_TELEMETRY_KEYS) {
    if (key in raw) {
      if (out === raw) out = { ...raw };
      out[key] = boundedPreview(raw[key]);
    }
  }
  return out;
}

/** One run of the ledger, from its begin to its terminal package. */
export interface LedgerRun {
  readonly asof: string;
  /** The ledger tool id: the tool, the research group, or "suite". */
  readonly toolId: string;
  readonly sourceLabel: string;
  readonly jobId: number | null;
  readonly runId: string;
  readonly methodologyVersionId: string;
  readonly buildIdentity: string;
  /** Every stage this run executed (issue #151), submitted once at the end. */
  readonly collector: TelemetryCollector;
  /** The run's canonical results: its report (and its return value). */
  readonly results: Record<string, unknown>;
  /**
   * Issue #978: the complete regime-snapshot rows this run computed, captured
   * here and published NOWHERE ELSE. The terminal run package is the only
   * writer of both the immutable artifact and the current-view projection, so
   * the two can never disagree and a failed run publishes neither (AC2).
   */
  regimeRows: RegimeSnapshotRow[] | null;
  readonly researchSignals: ResearchSignalArtifact[];
  /** Issue 1765 (D-h): the ratios the regime's ratio step dropped as stored-only. */
  droppedRatios: string[];
  vintage: FreezeVintageResult | null;
  /** The run's failure (null while it is healthy): the first error wins. */
  failed: unknown;
}

/**
 * Begin one ledger run (issue #977) and record its `started` event. It MUST
 * succeed before the source is ever called: its failure is fatal to the run
 * and prevents both acquisition and every canonical output write. A
 * begin-run failure is not "this run degraded", it is "this run never
 * started", and it propagates to the caller unchanged.
 */
export async function beginLedgerRun(
  persistence: AnalyticsPersistence,
  input: { asof: string; toolId: string; sourceLabel: string; version: RegimeVersion; jobId: number | null },
): Promise<LedgerRun> {
  const collector = new TelemetryCollector();
  const buildIdentity = resolveBuildIdentity();
  const methodology: MethodologyIdentity = {
    toolId: input.toolId,
    versionLabel: input.version,
    config: { toolId: input.toolId, regimeVersion: input.version },
  };
  const { runId, methodologyVersionId } = await persistence.beginRun({
    runKey: randomUUID(),
    asof: input.asof,
    toolId: input.toolId,
    sourceLabel: input.sourceLabel,
    methodology,
    buildIdentity,
    jobId: input.jobId,
  });
  await persistence.appendRunEvent(runId, "started", null);
  return {
    asof: input.asof,
    toolId: input.toolId,
    sourceLabel: input.sourceLabel,
    jobId: input.jobId,
    runId,
    methodologyVersionId,
    buildIdentity,
    collector,
    results: {},
    regimeRows: null,
    researchSignals: [],
    droppedRatios: [],
    vintage: null,
    failed: null,
  };
}

/**
 * Issue #977: freeze the data vintage. Everything this run acquired (and
 * everything already in the ledger) is frozen as of the knowledge-time cutoff
 * and the as-of day (market-time cutoff): the complete, reproducible input
 * universe this run's outputs were computed against. The cutoff is the
 * database clock the regime read its inputs at (AN-16; in a tick, the one read
 * every model shares); a run that read none uses NOW. The regime-key members
 * are the exact versions that read returned under the model's own keys, never
 * re-selected by the cutoff (issue 1534); a run that read none sends no list.
 * A freeze failure fails the WHOLE run: it is part of the mandatory ledger,
 * not best-effort telemetry.
 */
export async function freezeRunVintage(
  persistence: AnalyticsPersistence,
  run: LedgerRun,
  read: { knowledgeTimeCutoff: string | null; regimeVersionIds?: readonly string[] },
): Promise<void> {
  run.vintage = await persistence.freezeVintage({
    runId: run.runId,
    toolId: run.toolId,
    knowledgeTimeCutoff: read.knowledgeTimeCutoff ?? new Date().toISOString(),
    marketTimeCutoff: run.asof,
    methodologyVersionId: run.methodologyVersionId,
    buildIdentity: run.buildIdentity,
    ...(read.regimeVersionIds ? { regimeVersionIds: read.regimeVersionIds } : {}),
  });
}

/**
 * End a run: submit its telemetry (best-effort), append its terminal event and
 * submit its one terminal package (both mandatory). Returns the run's results,
 * or throws the run's failure.
 */
export async function finishLedgerRun(
  persistence: AnalyticsPersistence,
  telemetry: TelemetrySink,
  run: LedgerRun,
  logger: Logger,
): Promise<Record<string, unknown>> {
  const { collector, results, runId, asof } = run;
  let runFailed = run.failed;
  // ── TELEMETRY SUBMISSION (issue #151, best-effort, non-fatal) ──────────────
  // submitTelemetrySafely never throws: a telemetry outage can never affect
  // the canonical analytics rows, nor this run's return value.
  const overallStatus: TelemetryRunStatus = runFailed
    ? "failed"
    : collector.warnings.length > 0
      ? "degraded"
      : "succeeded";
  const submission = collector.build({
    kind: run.toolId,
    asof,
    source: run.sourceLabel,
    status: overallStatus,
    summary: runFailed ? { error: (runFailed as any)?.message ?? String(runFailed) } : boundedTelemetrySummary(results),
    jobId: run.jobId,
  });
  const telemetryOutcome = await submitTelemetrySafely(telemetry, submission, logger);
  // Non-enumerable so `Object.keys(results)`/JSON-shape assertions of the
  // canonical tool outputs are never affected by telemetry outcome exposure:
  // the worker handlers fold it into job_runs.output.
  Object.defineProperty(results, "__telemetry", { value: telemetryOutcome, enumerable: false, writable: true, configurable: true });

  // Mandatory ledger event — NOT best-effort like telemetry above. Its own
  // failure escalates the run to failed even when everything else succeeded:
  // a run whose outcome the ledger could not record must not read as quiet
  // success (issue #977 AC5/AC10). overallStatus is one of "failed" |
  // "degraded" | "succeeded" only (never "running", the fourth
  // TelemetryRunStatus value), so it narrows to RunLifecycleEvent.
  const eventStatus = overallStatus as "succeeded" | "degraded" | "failed";
  try {
    await persistence.appendRunEvent(runId, eventStatus, runFailed ? String((runFailed as any)?.message ?? runFailed) : null);
  } catch (ledgerEventError) {
    if (!runFailed) runFailed = ledgerEventError;
  }

  // ── ISSUE #978: freeze the terminal output/report snapshot ──────────────
  // Mandatory, NOT best-effort like telemetry above — mirrors freezeVintage:
  // every run that reaches a terminal outcome (succeeded, degraded, or
  // failed) submits ONE complete package bound to this run's id, so a run that
  // completes leaves a real artifact for swarm_briefs.report_snapshot_id to
  // resolve to.
  //
  // NOT "never empty for a real run": this single submit is the run's only
  // chance to record anything, and analyticsApiClient.call has no timeout and
  // no retry, so a submit that fails (network, API down) leaves the run with
  // no artifact at all. That fails SAFE rather than silently: the error
  // escalates into `runFailed` below, the run throws red, and the
  // current-view projections keep their last good state because
  // applyCurrentProjections rides inside the very transaction that did not
  // commit. The gap is an absent record, never a wrong one.
  //
  // `overallStatus` (computed above, before the mandatory ledger event that
  // may have since escalated `runFailed`) decides the shape: a "degraded" run
  // still produced real regime/research outputs, so it freezes exactly like a
  // "succeeded" one — only a run whose OWN stages never reached a usable
  // output freezes its warnings/logs/exceptions instead.
  const terminalPackage: TerminalRunPackageInput =
    overallStatus === "failed"
      ? {
          runId,
          asof,
          status: "failed",
          warnings: collector.warnings as WarningArtifact[],
          logs: collector.stages.map(
            (s): LogArtifact => ({
              level: s.status === "error" ? "error" : s.status === "warn" ? "warn" : "info",
              message: `[${s.stage}] ${s.summary}`,
              at: s.finishedAt,
            }),
          ),
          exceptions: [
            {
              message: String((runFailed as any)?.message ?? runFailed),
              stack: (runFailed as any)?.stack ?? null,
            } satisfies ExceptionArtifact,
          ],
        }
      : {
          runId,
          asof,
          status: "succeeded",
          regimeSnapshots: run.regimeRows ?? [],
          researchSignals: run.researchSignals,
          // The report IS this run's own complete structured output — not a
          // second, independently-generated document — so a byte-exact
          // retrieval of it is exactly what the run computed and returned,
          // canonicalized the same way the run/vintage ledger canonicalizes
          // its own evidence.
          reportBytes: new TextEncoder().encode(canonicalStringify({ asof, toolId: run.toolId, results })),
        };
  try {
    await persistence.submitTerminalRunPackage(terminalPackage);
  } catch (packageError) {
    if (!runFailed) runFailed = packageError;
  }

  Object.defineProperty(results, "__runLedger", {
    value: { runId, methodologyVersionId: run.methodologyVersionId, buildIdentity: run.buildIdentity, vintage: run.vintage },
    enumerable: false,
    writable: true,
    configurable: true,
  });
  // Issue 1765 (D-h): non-enumerable like __runLedger, so the report bytes
  // (canonicalStringify of `results` above) and every published figure are
  // unchanged. Empty when no ratio was dropped or the run computed no regime.
  Object.defineProperty(results, "__droppedRatios", { value: run.droppedRatios, enumerable: false, writable: true, configurable: true });

  if (runFailed) throw runFailed;
  return results;
}
