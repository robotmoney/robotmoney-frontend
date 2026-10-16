// Issue #978 SQL writer: the immutable analytics output/report snapshot
// layer. Only the API process imports this (same rule as
// run-ledger-store.ts) — the updater/producer goes through the HTTP
// boundary.
import { sql, type DbHandle } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import {
  buildOutputArtifact,
  buildReportArtifact,
  type OutputArtifactKind,
  type TerminalRunPackageInput,
} from "../output-snapshots.ts";
import { saveRegimeSnapshots } from "./regime-store.ts";
import { persistResearchSignal } from "./research-store.ts";
import { loadRunAsof } from "./run-ledger-store.ts";

// Thrown when a terminal run package's `asof` disagrees with the `asof`
// already recorded on its run header (analytics_ledger_runs, issue #977) —
// the API route (issue #978 FIX3) turns this into a 400: a caller bug must
// never freeze a report snapshot under the wrong market date.
export class RunAsofMismatchError extends Error {
  constructor(
    public readonly runId: string,
    public readonly submittedAsof: string,
    public readonly recordedAsof: string,
  ) {
    super(
      `package.asof (${submittedAsof}) does not match run ${runId}'s recorded asof (${recordedAsof})`,
    );
    this.name = "RunAsofMismatchError";
  }
}

// Thrown by submitTerminalRunPackage when a run_id already has a DIFFERENT
// terminal package frozen — the API route (issue #978 FIX2) turns this into
// a 409, mirroring VintageConflictError/freezeVintage (run-ledger-store.ts):
// a replay must never silently return stale data for content that changed.
export class TerminalRunPackageConflictError extends Error {
  constructor(public readonly existing: TerminalRunPackageResult) {
    super(`a different terminal run package is already frozen for this run_id`);
    this.name = "TerminalRunPackageConflictError";
  }
}

/** The only entry module that reaches this store: the analytics ingestion route. */
const ANALYTICS_ROUTE = "src/api/routes/analytics";

const insertOutputSnapshot = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  // SELECT as well: RETURNING reads the columns of the row it wrote.
  privileges: ["INSERT", "SELECT"],
  site: "src/analytics/store/output-snapshot-store:insertOutputSnapshots",
  purpose: "Freeze one immutable output artifact of a terminal run package (issue #978).",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `INSERT INTO analytics_output_snapshots (run_id, artifact_kind, payload_bytes, checksum)
      SELECT $1::bigint, $2, $3, $4 WHERE false
      RETURNING id, byte_length`,
    params: [1, "regime_snapshots", "probe", "probe"],
  },
});

const insertReport = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["INSERT", "SELECT"],
  site: "src/analytics/store/output-snapshot-store:insertReportSnapshot",
  purpose: "Freeze the exact report bytes of a succeeded terminal run package (issue #978).",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum)
    SELECT $1::bigint, $2::date, $3, $4 WHERE false
    RETURNING id`,
    params: [1, "2000-01-01", "probe", "probe"],
  },
});

const readOutputsByRun = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/store/output-snapshot-store:findPackageByRun.outputs",
  purpose: "Read a run's frozen output artifacts, the idempotency check of a terminal package submission.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: "SELECT id, artifact_kind, checksum, byte_length FROM analytics_output_snapshots WHERE run_id = $1::bigint",
    params: [1],
  },
});

const readReportByRun = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/store/output-snapshot-store:findPackageByRun.report",
  purpose: "Read a run's frozen report snapshot id, the second half of the idempotency check.",
  callers: [ANALYTICS_ROUTE],
  probe: { statement: "SELECT id FROM analytics_report_snapshots WHERE run_id = $1::bigint", params: [1] },
});

const readReportChecksum = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/store/output-snapshot-store:assertReplayMatches",
  purpose: "Read a stored report's checksum, to compare a replayed submission against it.",
  callers: [ANALYTICS_ROUTE],
  probe: { statement: "SELECT checksum FROM analytics_report_snapshots WHERE id = $1::bigint", params: [1] },
});

const readReportSnapshot = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/store/output-snapshot-store:loadReportSnapshot",
  purpose: "Retrieve a report snapshot by its immutable id, byte-exact (issue #978 AC3).",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `SELECT id, run_id, asof::text AS asof, report_bytes, checksum, byte_length
    FROM analytics_report_snapshots WHERE id = $1::bigint`,
    params: [1],
  },
});

export interface OutputSnapshotRecord {
  id: string;
  artifactKind: OutputArtifactKind;
  checksum: string;
  byteLength: number;
}

// One immutable row per (kind) in this package. Exported on its own so a test
// can inject a failure BETWEEN this step and the next one (see
// backend/tests/api/analytics-run-snapshots.test.ts's rollback proof, AC2) —
// composing the same functions submitTerminalRunPackage uses in production,
// rather than a bespoke test-only hook.
export async function insertOutputSnapshots(
  input: TerminalRunPackageInput,
  tx: DbHandle,
): Promise<OutputSnapshotRecord[]> {
  const kinds: [OutputArtifactKind, readonly unknown[]][] =
    input.status === "succeeded"
      ? [
          ["regime_snapshots", input.regimeSnapshots ?? []],
          ["research_signals", input.researchSignals ?? []],
        ]
      : [
          ["warnings", input.warnings ?? []],
          ["logs", input.logs ?? []],
          ["exceptions", input.exceptions ?? []],
        ];
  const out: OutputSnapshotRecord[] = [];
  for (const [kind, rows] of kinds) {
    const artifact = buildOutputArtifact(kind, rows);
    const [row] = await on(tx, insertOutputSnapshot)`
      INSERT INTO analytics_output_snapshots (run_id, artifact_kind, payload_bytes, checksum)
      VALUES (${input.runId}::bigint, ${kind}, ${Buffer.from(artifact.bytes)}, ${artifact.checksum})
      RETURNING id, byte_length`;
    out.push({ id: String(row!.id), artifactKind: kind, checksum: artifact.checksum, byteLength: Number(row!.byte_length) });
  }
  return out;
}

// The exact report bytes for a SUCCEEDED run — never called for a failed one
// (see the header: analytics_report_snapshots has no row at all for a failed
// terminal package).
export async function insertReportSnapshot(input: TerminalRunPackageInput, tx: DbHandle): Promise<string> {
  const artifact = buildReportArtifact(input.reportBytes ?? new Uint8Array());
  const [row] = await on(tx, insertReport)`
    INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum)
    VALUES (${input.runId}::bigint, ${input.asof}::date, ${Buffer.from(artifact.bytes)}, ${artifact.checksum})
    RETURNING id`;
  return String(row!.id);
}

// The compatibility current-view dual-write (issue #978 AC1/AC7): the SAME
// rows just frozen above are ALSO upserted into regime_snapshots and
// research_signals through their existing, unmodified writers, in the SAME
// transaction as the immutable insert above. Never called for a failed
// package (issue #978 AC2: current projection rows must be untouched by a
// failed run).
export async function applyCurrentProjections(input: TerminalRunPackageInput, tx: DbHandle): Promise<void> {
  await saveRegimeSnapshots(input.regimeSnapshots ?? [], tx);
  for (const s of input.researchSignals ?? []) {
    await persistResearchSignal(s.key, s.date, s.payload, tx);
  }
}

export interface TerminalRunPackageResult {
  outputSnapshots: OutputSnapshotRecord[];
  reportSnapshotId: string | null;
  replayed: boolean;
}

// Read back an already-submitted package by run_id — the natural idempotency
// key (one terminal package per run, exactly like beginRun's run_key). Used
// both for the idempotent-replay check below and by the API's retrieval
// route.
export async function findPackageByRun(runId: string, db: DbHandle = sql): Promise<TerminalRunPackageResult | null> {
  const outputRows = await on(db, readOutputsByRun)<
    { id: string; artifact_kind: OutputArtifactKind; checksum: string; byte_length: string }
  >`
    SELECT id, artifact_kind, checksum, byte_length FROM analytics_output_snapshots WHERE run_id = ${runId}::bigint
  `;
  if (outputRows.length === 0) return null;
  const [report] = await on(db, readReportByRun)<{ id: string }>`SELECT id FROM analytics_report_snapshots WHERE run_id = ${runId}::bigint`;
  return {
    outputSnapshots: outputRows.map((r) => ({
      id: String(r.id),
      artifactKind: r.artifact_kind,
      checksum: r.checksum,
      byteLength: Number(r.byte_length),
    })),
    reportSnapshotId: report ? String(report.id) : null,
    replayed: true,
  };
}

// The checksums THIS input would produce if it were freshly inserted — used
// only to compare against what a prior submission for the same run_id
// already stored (assertReplayMatches below). Exactly the same
// kind-selection `insertOutputSnapshots` uses, kept in sync by construction
// (both read `input.status` the same way) rather than duplicated by hand.
function expectedArtifactChecksums(input: TerminalRunPackageInput): Record<OutputArtifactKind, string> {
  const kinds: [OutputArtifactKind, readonly unknown[]][] =
    input.status === "succeeded"
      ? [
          ["regime_snapshots", input.regimeSnapshots ?? []],
          ["research_signals", input.researchSignals ?? []],
        ]
      : [
          ["warnings", input.warnings ?? []],
          ["logs", input.logs ?? []],
          ["exceptions", input.exceptions ?? []],
        ];
  const out = {} as Record<OutputArtifactKind, string>;
  for (const [kind, rows] of kinds) out[kind] = buildOutputArtifact(kind, rows).checksum;
  return out;
}

// Issue #978 FIX2: a replay (either the pre-check below or the 23505 retry
// branch) must compare the NEW submission's content against what is already
// stored, not merely return it. Identical content replays as before (200,
// replayed: true); different content throws TerminalRunPackageConflictError
// (mapped to HTTP 409) rather than silently handing back stale data —
// mirroring freezeVintage's identical/differing split in run-ledger-store.ts.
async function assertReplayMatches(
  input: TerminalRunPackageInput,
  stored: TerminalRunPackageResult,
  db: DbHandle = sql,
): Promise<TerminalRunPackageResult> {
  const expected = expectedArtifactChecksums(input);
  const expectedKinds = Object.keys(expected).sort();
  const storedKinds = stored.outputSnapshots.map((o) => o.artifactKind).sort();
  const kindsMatch = expectedKinds.length === storedKinds.length && expectedKinds.every((k, i) => k === storedKinds[i]);
  const artifactsMatch = kindsMatch && stored.outputSnapshots.every((o) => expected[o.artifactKind] === o.checksum);

  let reportMatches: boolean;
  if (input.status === "succeeded") {
    const expectedReportChecksum = buildReportArtifact(input.reportBytes ?? new Uint8Array()).checksum;
    if (!stored.reportSnapshotId) {
      reportMatches = false;
    } else {
      const [row] = await on(db, readReportChecksum)<{ checksum: string }>`SELECT checksum FROM analytics_report_snapshots WHERE id = ${stored.reportSnapshotId}::bigint`;
      reportMatches = row?.checksum === expectedReportChecksum;
    }
  } else {
    reportMatches = stored.reportSnapshotId === null;
  }

  if (artifactsMatch && reportMatches) return stored;
  throw new TerminalRunPackageConflictError({ ...stored, replayed: false });
}

// Submit one terminal run package atomically: the immutable output
// artifact(s) and — for a SUCCEEDED run only — the immutable report snapshot
// AND the compatibility current-view dual-write, all in ONE transaction
// (issue #978 AC1/AC2). Idempotent on run_id (issue #977's established
// idempotency-key shape): a retried submission for an already-packaged run
// replays the existing result rather than raising a duplicate-key error, and
// a genuinely CONCURRENT duplicate is resolved the same way via retry-on-23505
// (mirroring run-ledger-store.ts's beginRun/freezeVintage, not merely a
// sequential retry). Every path — pre-check, 23505 retry, and the fresh
// insert itself — first cross-checks `input.asof` against the run's own
// recorded asof (issue #978 FIX3): a mismatch is a caller bug, refused with
// RunAsofMismatchError (mapped to HTTP 400) before anything is compared or
// written.
export async function submitTerminalRunPackage(input: TerminalRunPackageInput): Promise<TerminalRunPackageResult> {
  const recordedAsof = await loadRunAsof(input.runId);
  if (recordedAsof !== null && recordedAsof !== input.asof) {
    throw new RunAsofMismatchError(input.runId, input.asof, recordedAsof);
  }
  const existing = await findPackageByRun(input.runId);
  if (existing) return await assertReplayMatches(input, existing);
  try {
    return await sql.begin(async (tx) => {
      const outputSnapshots = await insertOutputSnapshots(input, tx);
      let reportSnapshotId: string | null = null;
      if (input.status === "succeeded") {
        reportSnapshotId = await insertReportSnapshot(input, tx);
        await applyCurrentProjections(input, tx);
      }
      return { outputSnapshots, reportSnapshotId, replayed: false };
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      const replay = await findPackageByRun(input.runId);
      /* istanbul ignore next -- a 23505 on this unique key means a row now exists; a miss here would be a bug, not a runtime case */
      if (!replay) throw err;
      return await assertReplayMatches(input, replay);
    }
    throw err;
  }
}

export interface ReportSnapshot {
  id: string;
  runId: string;
  asof: string;
  bytes: Uint8Array;
  checksum: string;
  byteLength: number;
}

// Retrieval by immutable ID (issue #978 AC3): byte-exact, never re-derived.
export async function loadReportSnapshot(id: string, db: DbHandle = sql): Promise<ReportSnapshot | null> {
  const [row] = await on(db, readReportSnapshot)<Record<string, any>>`
    SELECT id, run_id, asof::text AS asof, report_bytes, checksum, byte_length
    FROM analytics_report_snapshots WHERE id = ${id}::bigint`;
  if (!row) return null;
  return {
    id: String(row.id),
    runId: String(row.run_id),
    asof: row.asof,
    bytes: new Uint8Array(row.report_bytes as Buffer),
    checksum: row.checksum,
    byteLength: Number(row.byte_length),
  };
}
