// Store stage: research pipeline telemetry (issue #151; migration
// 0018_research_telemetry.sql). API-OWNED — only the API process (via
// api/routes/analytics.ts + store/telemetry-direct.ts) and tests may import
// this module. Updater/orchestrator/worker code submits through the
// TelemetrySink port (analytics/telemetry.ts) instead.
import { sql, jsonValue, type DbHandle } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import type { TelemetryRunSubmission } from "../telemetry.ts";

// Registered queries (smoke-production-spec.md §7.1), one per relation the run
// record spans, all reached only through the analytics telemetry route.
const TELEMETRY_ROUTE = "src/api/routes/analytics";

const insertRun = registerQuery({
  role: "rm_app",
  object: "research_pipeline_runs",
  // SELECT because of RETURNING.
  privileges: ["INSERT", "SELECT"],
  site: "src/analytics/store/telemetry-store:saveTelemetryRun.run",
  purpose: "Insert one research pipeline run and return its id for the stage, warning and artifact rows.",
  callers: [TELEMETRY_ROUTE],
  probe: {
    statement: `INSERT INTO research_pipeline_runs (job_id, kind, asof, source, status, started_at, finished_at, checksum, summary)
      VALUES ($1::bigint, $2, $3::date, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9::jsonb)
      RETURNING id`,
    params: [null, "research.refresh", "2026-01-01", "live", "succeeded", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", null, "{}"],
  },
});

// The three child inserts reference a run by foreign key; each probe inserts
// from a query that yields no row, which still needs (and is checked for)
// INSERT on every listed column without inventing a parent.
const insertStages = registerQuery({
  role: "rm_app",
  object: "research_pipeline_stages",
  privileges: ["INSERT"],
  site: "src/analytics/store/telemetry-store:saveTelemetryRun.stages",
  purpose: "Insert a run's per-stage status rows in one multi-row statement.",
  callers: [TELEMETRY_ROUTE],
  probe: {
    statement: `INSERT INTO research_pipeline_stages (run_id, stage, sequence, status, summary, started_at, finished_at)
      SELECT $1::bigint, $2, $3::integer, $4, $5, $6::timestamptz, $7::timestamptz WHERE false`,
    params: [1, "extract", 1, "ok", "probe", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z"],
  },
});

const insertWarnings = registerQuery({
  role: "rm_app",
  object: "research_pipeline_warnings",
  privileges: ["INSERT"],
  site: "src/analytics/store/telemetry-store:saveTelemetryRun.warnings",
  purpose: "Insert a run's warnings in one multi-row statement.",
  callers: [TELEMETRY_ROUTE],
  probe: {
    statement: "INSERT INTO research_pipeline_warnings (run_id, stage, message) SELECT $1::bigint, $2, $3 WHERE false",
    params: [1, "extract", "probe"],
  },
});

const insertArtifact = registerQuery({
  role: "rm_app",
  object: "research_pipeline_artifacts",
  privileges: ["INSERT"],
  site: "src/analytics/store/telemetry-store:saveTelemetryRun.artifact",
  purpose: "Insert one artifact preview of a run.",
  callers: [TELEMETRY_ROUTE],
  probe: {
    statement: `INSERT INTO research_pipeline_artifacts (run_id, stage, kind, checksum, preview)
      SELECT $1::bigint, $2, $3, $4, $5::jsonb WHERE false`,
    params: [1, "extract", "probe", null, "{}"],
  },
});

// Inserts one run + its stages/warnings/artifacts inside a single transaction
// (the caller supplies the tx handle so a mid-insert failure rolls back
// everything — a partial telemetry record is worse than none). Returns the new
// run id.
export async function saveTelemetryRun(run: TelemetryRunSubmission, db: DbHandle = sql): Promise<number> {
  const [row] = await on(db, insertRun)<{ id: string }>`
    INSERT INTO research_pipeline_runs (job_id, kind, asof, source, status, started_at, finished_at, checksum, summary)
    VALUES (${run.jobId}, ${run.kind}, ${run.asof}, ${run.source}, ${run.status},
            ${run.startedAt}, ${run.finishedAt}, ${run.checksum}, ${db.json(jsonValue(run.summary))})
    RETURNING id`;
  const runId = Number(row.id);

  if (run.stages.length > 0) {
    const stageRows = run.stages.map((s) => ({
      run_id: runId,
      stage: s.stage,
      sequence: s.sequence,
      status: s.status,
      summary: s.summary,
      started_at: s.startedAt,
      finished_at: s.finishedAt,
    }));
    await on(db, insertStages)`INSERT INTO research_pipeline_stages ${db(stageRows, "run_id", "stage", "sequence", "status", "summary", "started_at", "finished_at")}`;
  }

  if (run.warnings.length > 0) {
    const warningRows = run.warnings.map((w) => ({ run_id: runId, stage: w.stage, message: w.message }));
    await on(db, insertWarnings)`INSERT INTO research_pipeline_warnings ${db(warningRows, "run_id", "stage", "message")}`;
  }

  for (const a of run.artifacts) {
    await on(db, insertArtifact)`
      INSERT INTO research_pipeline_artifacts (run_id, stage, kind, checksum, preview)
      VALUES (${runId}, ${a.stage}, ${a.kind}, ${a.checksum}, ${db.json(jsonValue(a.preview))})`;
  }

  return runId;
}
