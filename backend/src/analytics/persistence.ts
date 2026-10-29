// The analytics persistence PORT (issue #106). The orchestrator/updater stages
// (fetch → compute) never touch SQL: every read/write of the analytics data
// tables (raw_indicator_history, regime_snapshots, research_signals) goes
// through this interface. Two implementations exist:
//
//   • analytics/api-client.ts — the independent producer's HTTP client: typed
//     calls to the authenticated /api/analytics/* boundary with its scoped
//     bearer credential.
//   • analytics/store/direct.ts — the API-owned domain service backed by the
//     SQL store writers. ONLY the API process (and migration/smoke tooling with
//     its own DB credentials) may use it.
//
// Pure types — no I/O, no SQL, no config.
import type { RawIndicatorHistory } from "./types.ts";
import type { RegimeSnapshotRow } from "./report/regime-projection.ts";
import type { ResearchPayload } from "./analyze/research.ts";
import type { SaveSourceAcquisitionResult, SourceAcquisitionEvidence } from "./source-ledger.ts";
import type { MethodologyIdentity, RunLifecycleEvent, VintageManifest } from "./run-ledger.ts";
import type { OutputArtifactKind, TerminalRunPackageInput } from "./output-snapshots.ts";

export interface FloorSeedResult {
  seededPoints: number; // rows actually written this run (gap-fill only)
  existingPoints: number; // rows already present (skipped — DB floor wins)
  indicators: number; // distinct indicators touched by the seed
}

// AN-16: the database clock and, at it, the ledger heads of every storage key
// the regime reads (store/run-ledger-store.ts loadCommittedInputs).
export interface CommittedInputs {
  /** The database clock the heads were read at, ISO 8601 with microseconds. */
  knowledgeTimeCutoff: string;
  values: { versionId: string; sourceKey: string; marketDate: string; value: number }[];
}

export interface BeginRunResult {
  runId: string;
  methodologyVersionId: string;
  replayed: boolean;
}

export interface FreezeVintageResult {
  vintageId: string;
  manifest: VintageManifest;
  memberCount: number;
  replayed: boolean;
}

// Issue #978: the frozen output/report snapshot layer's own result shape —
// structurally identical to store/output-snapshot-store.ts's own
// OutputSnapshotRecord/TerminalRunPackageResult (same split as
// BeginRunResult/FreezeVintageResult above: this file stays pure/I/O-free so
// the producer's api-client.ts can import it without ever importing SQL).
export interface OutputSnapshotRecord {
  id: string;
  artifactKind: OutputArtifactKind;
  checksum: string;
  byteLength: number;
}

export interface TerminalRunPackageResult {
  outputSnapshots: OutputSnapshotRecord[];
  reportSnapshotId: string | null;
  replayed: boolean;
}

export interface AnalyticsPersistence {
  // Issue #977: the immutable run-ledger surface. `beginRun` MUST be called,
  // and MUST succeed, before an AnalyticsDataSource is ever called — its
  // failure is fatal and prevents both acquisition and every canonical
  // output write. `appendRunEvent`/`freezeVintage` are likewise mandatory
  // (never best-effort like telemetry submission below).
  beginRun(input: {
    runKey: string;
    asof: string;
    toolId: string;
    sourceLabel: string;
    methodology: MethodologyIdentity;
    buildIdentity: string;
    jobId?: number | string | null;
  }): Promise<BeginRunResult>;
  appendRunEvent(runId: string, eventType: RunLifecycleEvent, detail: string | null): Promise<void>;
  freezeVintage(input: {
    runId: string;
    toolId: string;
    knowledgeTimeCutoff: string;
    marketTimeCutoff: string;
    methodologyVersionId: string;
    buildIdentity: string;
  }): Promise<FreezeVintageResult>;
  // Issue #978: submit one terminal run package (see output-snapshots.ts's
  // header) bound to this run's id — the complete, immutable output/report
  // evidence for a run that reached a terminal outcome. Mandatory, like
  // freezeVintage above, NOT best-effort like telemetry: a run whose
  // outputs/report (or warning/log/exception artifacts) could not be
  // durably frozen must not read as quiet success.
  submitTerminalRunPackage(input: TerminalRunPackageInput): Promise<TerminalRunPackageResult>;
  // Append one complete provider acquisition atomically. The producer-generated
  // UUID is the replay key; prior evidence is never mutated on replay. The
  // result's `committed` is the ledger head of every submitted value after the
  // D56 tolerance decision (issue 1421): what downstream must compute from.
  saveSourceAcquisition?(evidence: SourceAcquisitionEvidence): Promise<SaveSourceAcquisitionResult>;
  // AN-16 (owner decision): a regime run computes from exactly the values its
  // vintage pins. This reads the database clock and, at it, the ledger heads
  // of every storage key the regime reads, dated on or before
  // `marketTimeCutoff`; the run computes from them and passes the returned
  // cutoff to freezeVintage. Optional like saveSourceAcquisition: a
  // persistence without a source ledger has nothing to read.
  loadCommittedInputs?(marketTimeCutoff: string): Promise<CommittedInputs>;
  // Read the whole persisted raw floor, grouped by indicator, sorted by date.
  loadRawHistory(): Promise<RawIndicatorHistory>;
  // Upsert merged raw history on (date, indicator); fetched wins on overlap
  // unless it is within the D56 tolerance of the stored value. The orchestrator
  // reads the committed floor back with loadRawHistory before computing
  // (issue 1421), so a skipped jitter rewrite never reaches downstream.
  // `source` (issue #397) tags the whole batch's provenance ('live' |
  // 'hermetic' | 'fixture'); omitted defaults to 'live' at the store.
  saveRawHistory(byIndicator: RawIndicatorHistory, source?: string): Promise<void>;
  // Cold-DB gap-fill: write only (date, indicator) points NOT already persisted
  // (existing rows always win). Idempotent — a warm floor makes this a no-op.
  seedRawHistory(byIndicator: RawIndicatorHistory): Promise<FloorSeedResult>;
  // RETIRED (issue #978): saveRegimeSnapshots / saveResearchSignal. Publishing
  // regime_snapshots or research_signals outside a terminal run package is no
  // longer expressible through this port — submitTerminalRunPackage above is
  // the single publisher, and it writes the immutable artifacts and the report
  // snapshot in the same transaction as the current-view rows.
  // Which (signal_key, date) pairs are persisted on/after `sinceDate` (issue
  // #614 AC4): the independent producer has no DATABASE_URL, so this is the
  // ONLY way it can tell which recent days it needs to catch up — the read
  // side of the producer catch-up mechanism in producer/index.ts.
  loadResearchSignalDates(sinceDate: string): Promise<{ signalKey: string; date: string }[]>;
  // Which raw_indicator_history dates are missing (interior gaps) on/after
  // `sinceDate` (issue #646, closing #614 AC4's Class A bullet). Same
  // reasoning as loadResearchSignalDates above — the independent producer has
  // no DATABASE_URL, so this is the only way it can tell which recent days it
  // needs to re-fetch — but driven by the shared gap detector rather than a
  // bespoke presence query, so this can never disagree with GET /api/admin/gaps.
  loadRawHistoryGapDates(sinceDate: string): Promise<string[]>;
}
