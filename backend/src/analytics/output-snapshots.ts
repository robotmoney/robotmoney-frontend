// Issue #978: pure types + canonicalization for the immutable analytics
// output/report snapshot layer. No I/O, no SQL — mirrors the run-ledger.ts /
// store/run-ledger-store.ts split (this module is pure evidence-shaping; the
// SQL writer is store/output-snapshot-store.ts).
//
// Every terminal analytics run submits ONE package, keyed by the run_id
// already minted by beginRun (issue #977). A SUCCEEDED package's structured
// outputs (regime snapshots, research signals) are canonically serialized
// here before they are hashed and stored — the SAME canonicalization on both
// sides of the wire is what makes "recompute the checksum from the retrieved
// bytes" a real proof rather than a tautology. A report's bytes are never
// re-serialized: they are exactly what the caller submitted, so a byte
// comparison against the original fixture is meaningful.
import { sha256Hex } from "./run-ledger.ts";
import { canonicalArtifactBytes, canonicalStringify } from "../../../packages/analyst-sdk/src/report/canonical.ts";
import type { RegimeSnapshotRow } from "./report/regime-projection.ts";
import type { ResearchPayload } from "./analyze/research.ts";
import { REGIME_ARTIFACT_KIND as SDK_REGIME_ARTIFACT_KIND } from "./analyze/regime-versions.ts";

// `regime_beside_snapshots` (issue 1753, migration 0136): the regime rows of a
// run whose methodology is published beside the main line (REGIME_LINE, v5).
// The API picks the kind from the run's methodology label, never the client:
// such a run's `regime_snapshots` artifact is the empty list, and its rows
// are not written to the regime_snapshots table.
export type OutputArtifactKind = "regime_snapshots" | "regime_beside_snapshots" | "research_signals" | "warnings" | "logs" | "exceptions";

/**
 * The artifact kind the regime rows of a methodology line are frozen under.
 * The SDK states it (analyze/regime-versions.ts, issue 1765); each kind must be
 * an OutputArtifactKind.
 */
export const REGIME_ARTIFACT_KIND = SDK_REGIME_ARTIFACT_KIND satisfies Readonly<Record<string, OutputArtifactKind>>;

// Issue 1753: the published line of a methodology that keeps its history
// (REGIME_KEPT_HISTORY, v5), before a run's as-of day: each kept day's date and
// three panel indices, and the frozen artifacts they were read from, in
// publication order (cutover/ledger-current.ts ledgerKeptRegimeDays).
export interface KeptRegimeDays {
  days: { date: string; macroIndex: number | null; onchainIndex: number | null; factorIndex: number | null }[];
  /** The ids of the analytics_output_snapshots artifacts the days came from: the run's report names them. */
  artifactIds: string[];
}

export interface ResearchSignalArtifact {
  key: string;
  date: string;
  payload: ResearchPayload;
}

export interface WarningArtifact {
  stage: string;
  message: string;
}

export interface LogArtifact {
  level: string;
  message: string;
  at: string;
}

export interface ExceptionArtifact {
  message: string;
  stack: string | null;
}

// The canonical bytes for one artifact kind. Deterministic key order
// (canonicalStringify, shared with the #977 run ledger) so the same logical
// content always produces the same bytes regardless of how the caller built
// the array in memory. The function lives in the SDK (issue 1751).
export { canonicalArtifactBytes };

export interface OutputArtifact {
  kind: OutputArtifactKind;
  bytes: Uint8Array;
  checksum: string;
}

export function buildOutputArtifact(kind: OutputArtifactKind, rows: readonly unknown[]): OutputArtifact {
  const bytes = canonicalArtifactBytes(rows);
  return { kind, bytes, checksum: sha256Hex(bytes) };
}

export interface ReportArtifact {
  bytes: Uint8Array;
  checksum: string;
}

// The report is NEVER re-serialized — it is stored and later returned as
// exactly the bytes the caller submitted (issue #978 AC1/AC3's byte-exact
// retrieval proof would be meaningless against a re-encoded copy).
export function buildReportArtifact(bytes: Uint8Array): ReportArtifact {
  return { bytes, checksum: sha256Hex(bytes) };
}

export type TerminalRunStatus = "succeeded" | "failed";

export interface TerminalRunPackageInput {
  runId: string;
  asof: string;
  status: TerminalRunStatus;
  // Required when status === "succeeded":
  regimeSnapshots?: RegimeSnapshotRow[];
  researchSignals?: ResearchSignalArtifact[];
  reportBytes?: Uint8Array;
  // Required when status === "failed":
  warnings?: WarningArtifact[];
  logs?: LogArtifact[];
  exceptions?: ExceptionArtifact[];
}

export { canonicalStringify, sha256Hex };
