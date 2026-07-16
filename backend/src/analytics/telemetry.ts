// Research pipeline telemetry (issue #151). Pure, I/O-free bookkeeping the
// orchestrator (analytics/index.ts runAnalytics) uses to record what each
// access/extract/transform/analyze/store/report stage actually did, so an
// admin can inspect stage behavior, bounded source artifacts, and freshness/
// fallback conditions instead of grepping job_runs.output text.
//
// PERSISTENCE BOUNDARY: exactly like AnalyticsPersistence (persistence.ts),
// this orchestrator never writes telemetry SQL directly — every submission
// goes through the injected TelemetrySink port. The default is the
// authenticated HTTP client (telemetry-client.ts); the API process and tests
// inject the direct SQL-backed sink (store/telemetry-direct.ts) instead.
//
// NON-FATAL CONTRACT (issue #151 AC3): a TelemetrySink failure must NEVER
// affect canonical analytics persistence or the orchestrator's return value —
// callers catch submitRun() rejections/failed results and only log+surface
// them, never throw. Collector methods below are pure in-memory pushes and can
// never throw.
import { createHash } from "node:crypto";

export type TelemetryStageName = "access" | "extract" | "transform" | "analyze" | "store" | "report";
export type TelemetryStageStatus = "ok" | "warn" | "error";
export type TelemetryRunStatus = "running" | "succeeded" | "degraded" | "failed";

export interface TelemetryStage {
  stage: TelemetryStageName;
  sequence: number;
  status: TelemetryStageStatus;
  summary: string;
  startedAt: string; // ISO
  finishedAt: string; // ISO
}

export interface TelemetryWarning {
  stage: TelemetryStageName;
  message: string;
}

export interface TelemetryArtifact {
  stage: TelemetryStageName;
  kind: string;
  checksum: string | null;
  preview: unknown; // ALREADY bounded by boundedPreview() — never a full series
}

export interface TelemetryRunSubmission {
  kind: string; // toolId submitted ('regime' | 'channel-divergence' | 'late-cycle-signals' | 'suite')
  asof: string;
  source: string; // 'live' | 'hermetic' | 'fixture'
  status: TelemetryRunStatus;
  startedAt: string;
  finishedAt: string;
  checksum: string | null;
  summary: Record<string, unknown>;
  stages: TelemetryStage[];
  warnings: TelemetryWarning[];
  artifacts: TelemetryArtifact[];
  jobId: number | null;
}

export interface TelemetrySubmitResult {
  ok: boolean;
  runId?: number;
  error?: string;
}

export interface TelemetrySink {
  submitRun(run: TelemetryRunSubmission): Promise<TelemetrySubmitResult>;
}

// A sink that records nothing — used where telemetry is explicitly not wired
// (kept out of production paths; see index.ts default which always resolves a
// real sink instead).
export const noopTelemetrySink: TelemetrySink = {
  async submitRun() {
    return { ok: true };
  },
};

const MAX_PREVIEW_BYTES = 4000;

// Deterministic stringify (object keys sorted) so the checksum is stable
// regardless of property insertion order.
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}

export function checksumOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

// Bound an artifact preview to `maxBytes` — NEVER persist a complete time
// series into telemetry (issue #151 explicit out-of-scope guard). Arrays are
// truncated to a head+tail sample; anything else falls back to a truncated
// JSON string.
export function boundedPreview(value: unknown, maxBytes: number = MAX_PREVIEW_BYTES): unknown {
  let full: string;
  try {
    full = JSON.stringify(value) ?? "null";
  } catch {
    return { truncated: true, note: "unserializable value" };
  }
  if (full.length <= maxBytes) return value;
  if (Array.isArray(value)) {
    const head = value.slice(0, 5);
    const tail = value.length > 10 ? value.slice(-5) : [];
    return { truncated: true, totalItems: value.length, head, tail };
  }
  return { truncated: true, preview: full.slice(0, maxBytes) };
}

// Collects stage/warning/artifact records during ONE runAnalytics call. Pure
// in-memory bookkeeping — no I/O, so it can never throw or fail the run.
export class TelemetryCollector {
  private seq = 0;
  readonly stages: TelemetryStage[] = [];
  readonly warnings: TelemetryWarning[] = [];
  readonly artifacts: TelemetryArtifact[] = [];
  readonly startedAt = new Date().toISOString();

  stage(
    stage: TelemetryStageName,
    status: TelemetryStageStatus,
    summary: string,
    startedAt: Date,
    finishedAt: Date = new Date(),
  ): void {
    this.stages.push({
      stage,
      sequence: ++this.seq,
      status,
      summary,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    });
  }

  warn(stage: TelemetryStageName, message: string): void {
    this.warnings.push({ stage, message });
  }

  artifact(stage: TelemetryStageName, kind: string, value: unknown): void {
    this.artifacts.push({ stage, kind, checksum: checksumOf(value), preview: boundedPreview(value) });
  }

  // `status` is the caller-decided overall outcome (succeeded/degraded/failed).
  build(input: {
    kind: string;
    asof: string;
    source: string;
    status: TelemetryRunStatus;
    summary: Record<string, unknown>;
    jobId?: number | null;
  }): TelemetryRunSubmission {
    return {
      kind: input.kind,
      asof: input.asof,
      source: input.source,
      status: input.status,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      checksum: checksumOf(input.summary),
      summary: input.summary,
      stages: this.stages,
      warnings: this.warnings,
      artifacts: this.artifacts,
      jobId: input.jobId ?? null,
    };
  }
}

// Best-effort submit: NEVER throws, NEVER affects the caller's control flow.
// Returns the sink's result (or a synthesized failure) purely for the caller
// to fold into its own non-fatal job-output/result reporting.
export async function submitTelemetrySafely(
  sink: TelemetrySink,
  run: TelemetryRunSubmission,
  logger: { warn?: (m: string) => void } = console,
): Promise<TelemetrySubmitResult> {
  try {
    const res = await sink.submitRun(run);
    if (!res.ok) logger.warn?.(`[analytics] telemetry submission reported failure: ${res.error ?? "unknown error"}`);
    return res;
  } catch (e: any) {
    const error = e?.message ?? String(e);
    logger.warn?.(`[analytics] telemetry submission failed (non-fatal, canonical analytics unaffected): ${error}`);
    return { ok: false, error };
  }
}
