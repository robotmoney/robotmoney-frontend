// Direct (SQL-backed) implementation of the TelemetrySink port (issue #151) —
// the API-owned domain path, mirroring analytics/store/direct.ts's
// directAnalyticsPersistence. ONLY the API process and tests may use this;
// updater/worker processes use analytics/telemetry-client.ts instead.
import { sql } from "../../db/client.ts";
import type { TelemetryRunSubmission, TelemetrySink, TelemetrySubmitResult } from "../telemetry.ts";
import { saveTelemetryRun } from "./telemetry-store.ts";

export const directTelemetrySink: TelemetrySink = {
  async submitRun(run: TelemetryRunSubmission): Promise<TelemetrySubmitResult> {
    const runId = await sql.begin((tx) => saveTelemetryRun(run, tx));
    return { ok: true, runId };
  },
};
