// Store stage: research pipeline telemetry (issue #151; migration
// 0018_research_telemetry.sql). API-OWNED — only the API process (via
// api/routes/analytics.ts + store/telemetry-direct.ts) and tests may import
// this module. Updater/orchestrator/worker code submits through the
// TelemetrySink port (analytics/telemetry.ts) instead.
import { sql, jsonValue, type DbHandle } from "../../db/client.ts";
import type { TelemetryRunSubmission } from "../telemetry.ts";

// Inserts one run + its stages/warnings/artifacts inside a single transaction
// (the caller supplies the tx handle so a mid-insert failure rolls back
// everything — a partial telemetry record is worse than none). Returns the new
// run id.
export async function saveTelemetryRun(run: TelemetryRunSubmission, db: DbHandle = sql): Promise<number> {
  const [row] = await db`
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
    await db`INSERT INTO research_pipeline_stages ${db(stageRows, "run_id", "stage", "sequence", "status", "summary", "started_at", "finished_at")}`;
  }

  if (run.warnings.length > 0) {
    const warningRows = run.warnings.map((w) => ({ run_id: runId, stage: w.stage, message: w.message }));
    await db`INSERT INTO research_pipeline_warnings ${db(warningRows, "run_id", "stage", "message")}`;
  }

  for (const a of run.artifacts) {
    await db`
      INSERT INTO research_pipeline_artifacts (run_id, stage, kind, checksum, preview)
      VALUES (${runId}, ${a.stage}, ${a.kind}, ${a.checksum}, ${db.json(jsonValue(a.preview))})`;
  }

  return runId;
}
