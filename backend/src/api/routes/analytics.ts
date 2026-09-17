// Authenticated analytics ingestion boundary (issue #106). Updater processes
// (the worker's regime/research jobs, the follow-up EDGAR seed tooling) submit
// computed outputs HERE instead of writing SQL: the API process is the only
// runtime component that imports the analytics store writers.
//
// Every route requires the analytics-provider bearer credential
// (ANALYTICS_TOKEN, constant-time compared; ADMIN_TOKEN / member bearers are
// NEVER substitutes). Fail-closed: with no token configured the boundary opens
// only under config.allowInsecure (RM_ENV=ephemeral or explicit
// RM_ALLOW_INSECURE=1) — smoke/prod without a token stay locked.
//
// Mutation contract:
//   • the ENTIRE payload is validated before a transaction is opened — a
//     malformed, oversized, duplicate-conflicting, non-finite, or partially
//     invalid batch is rejected with zero row changes;
//   • each write runs inside ONE transaction (a mid-operation error rolls the
//     whole mutation back);
//   • writes are idempotent on their domain natural keys ((date, indicator),
//     (date), (signal_key, date)) — re-submitting a batch converges;
//   • there is NO generic SQL endpoint: each route maps to one typed domain
//     write behind the API-owned store services.
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../db/client.ts";
import { bearer, hasAnalyticsProviderRole } from "../auth.ts";
import type { RawIndicatorHistory } from "../../analytics/types.ts";
import type { RegimeSnapshotRow, JsonValue } from "../../analytics/report/regime-projection.ts";
import type { ResearchPayload } from "../../analytics/analyze/research.ts";
import { loadRawIndicatorHistory, saveRawIndicatorHistory } from "../../analytics/store/raw-history-store.ts";
import { applyRawFloorSeed } from "../../analytics/store/floor-seed.ts";
import { loadRecentResearchSignalDates } from "../../analytics/store/research-store.ts";
import { saveTelemetryRun } from "../../analytics/store/telemetry-store.ts";
import { saveSourceAcquisition } from "../../analytics/store/source-ledger-store.ts";
import type { SourceAcquisitionEvidence } from "../../analytics/source-ledger.ts";
import { payloadChecksum } from "../../analytics/source-ledger.ts";
import {
  beginRun,
  appendRunEvent,
  freezeVintage,
  findVintageByRunAndTool,
  loadFrozenVintage,
  VintageConflictError,
} from "../../analytics/store/run-ledger-store.ts";
import type { MethodologyIdentity, RunLifecycleEvent } from "../../analytics/run-ledger.ts";
import {
  submitTerminalRunPackage,
  loadReportSnapshot,
  TerminalRunPackageConflictError,
  RunAsofMismatchError,
} from "../../analytics/store/output-snapshot-store.ts";
import type {
  ExceptionArtifact,
  LogArtifact,
  ResearchSignalArtifact,
  TerminalRunPackageInput,
  TerminalRunStatus,
  WarningArtifact,
} from "../../analytics/output-snapshots.ts";
import { detectGaps } from "../../ops/gap-detector.ts";
import { getSeriesDef } from "../../ops/series-registry.ts";
import type {
  TelemetryArtifact,
  TelemetryRunStatus,
  TelemetryRunSubmission,
  TelemetryStage,
  TelemetryStageName,
  TelemetryStageStatus,
  TelemetryWarning,
} from "../../analytics/telemetry.ts";

const A = ROUTES.analytics;

// ── payload caps (validated BEFORE any transaction) ─────────────────────────
// The full raw floor is tens of thousands of (date,indicator) points and the
// full recomputed snapshot history is ~3k rows; the caps leave generous headroom
// while bounding memory/abuse.
const MAX_RAW_POINTS = 500_000;
const MAX_SNAPSHOT_ROWS = 20_000;
const MAX_SIGNALS = 50;
const MAX_INDICATOR_ID = 64;
const MAX_LABEL = 64;
const MAX_SIGNAL_KEY = 100;
const MAX_SIGNAL_PAYLOAD_BYTES = 2_000_000;

// Strict calendar date: matches the shape AND is a real day (rejects 2024-02-30).
function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isFiniteOrNull = (v: unknown): v is number | null => v == null || isFiniteNumber(v);
const isShortStringOrNull = (v: unknown, max = MAX_LABEL): v is string | null =>
  v == null || (typeof v === "string" && v.length <= max);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

type Invalid = { error: string };
const invalid = (error: string): Invalid => ({ error });
const isInvalid = (v: unknown): v is Invalid => isPlainObject(v) && typeof v.error === "string";

// Row-level provenance (issue #397): which AnalyticsDataSource actually wrote
// this batch/row — mirrors the analytics/index.ts sourceLabel + the vendored
// eq-snapshot importer's 'seed' tag. An absent/undefined `source` is accepted
// (older callers) and stored as `null` — genuinely unknown, never guessed.
const VALID_PROVENANCE = ["live", "hermetic", "fixture", "seed"] as const;
function isProvenanceOrNull(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || (typeof v === "string" && (VALID_PROVENANCE as readonly string[]).includes(v));
}

// ── raw-history / seed payload: { history: { [indicator]: {date,value}[] }, source? } ─
function parseRawHistory(body: unknown): RawIndicatorHistory | Invalid {
  if (!isPlainObject(body) || !isPlainObject(body.history)) return invalid("body must be { history: { [indicator]: {date,value}[] } }");
  const out: RawIndicatorHistory = {};
  let points = 0;
  const seen = new Set<string>();
  for (const [indicator, series] of Object.entries(body.history)) {
    if (!indicator || indicator.length > MAX_INDICATOR_ID) return invalid(`invalid indicator id ${JSON.stringify(indicator.slice(0, 80))}`);
    if (!Array.isArray(series)) return invalid(`history[${indicator}] must be an array of {date, value}`);
    const pts: { date: string; value: number }[] = [];
    for (const p of series) {
      if (!isPlainObject(p) || !isIsoDate(p.date)) return invalid(`history[${indicator}] has a point with an invalid date`);
      // Non-finite values are REJECTED (not skipped): an updater must never
      // smuggle NaN/Infinity (JSON `1e999`) or nulls into the persisted-real floor.
      if (!isFiniteNumber(p.value)) return invalid(`history[${indicator}][${p.date}] value must be a finite number`);
      // '|' separator, deliberately PRINTABLE: a literal NUL here made this
      // file diff as binary in git, so it could never be reviewed in a pull
      // request. `indicator` is caller-supplied, but `p.date` is already
      // validated as YYYY-MM-DD above, so no '|'-bearing indicator can forge
      // a collision with a different (indicator, date) pair.
      const key = `${indicator}|${p.date}`;
      if (seen.has(key)) return invalid(`duplicate (indicator, date) in payload: (${indicator}, ${p.date})`);
      seen.add(key);
      pts.push({ date: p.date, value: p.value });
      if (++points > MAX_RAW_POINTS) return invalid(`payload exceeds ${MAX_RAW_POINTS} points`);
    }
    out[indicator] = pts;
  }
  return out;
}

// Optional batch-level provenance tag on the raw-history POST body (issue
// #397). Rejects a garbage string loudly rather than silently coercing it.
function parseRawHistorySource(body: unknown): string | null | Invalid {
  const s = isPlainObject(body) ? body.source : undefined;
  if (!isProvenanceOrNull(s)) return invalid(`source must be one of ${VALID_PROVENANCE.join(", ")}, or omitted/null`);
  return s ?? null;
}

// ── regime snapshots payload: { snapshots: RegimeSnapshotRow[] } ─────────────
function parseSnapshotRow(v: unknown, i: number): RegimeSnapshotRow | Invalid {
  if (!isPlainObject(v)) return invalid(`snapshots[${i}] must be an object`);
  if (!isIsoDate(v.date)) return invalid(`snapshots[${i}].date must be a valid YYYY-MM-DD date`);
  for (const k of ["composite", "compositePercentile", "macroIndex", "onchainIndex", "factorIndex", "macroPercentile", "onchainPercentile", "factorPercentile"] as const) {
    if (!isFiniteOrNull(v[k])) return invalid(`snapshots[${i}].${k} must be a finite number or null`);
  }
  for (const k of ["regime", "macroRegime", "onchainRegime", "factorRegime", "version"] as const) {
    if (!isShortStringOrNull(v[k])) return invalid(`snapshots[${i}].${k} must be a short string or null`);
  }
  // Row-level provenance (issue #397) — omitted/null accepted (older callers);
  // any other value must be one of the recognized data-source labels.
  if (!isProvenanceOrNull(v.source)) return invalid(`snapshots[${i}].source must be one of ${VALID_PROVENANCE.join(", ")}, or omitted/null`);
  if (!isPlainObject(v.percentiles)) return invalid(`snapshots[${i}].percentiles must be an object`);
  for (const [pk, pv] of Object.entries(v.percentiles)) {
    if (pk.length > MAX_INDICATOR_ID || !isFiniteNumber(pv)) return invalid(`snapshots[${i}].percentiles[${pk.slice(0, 80)}] must be a finite number`);
  }
  if (!Array.isArray(v.indicators)) return invalid(`snapshots[${i}].indicators must be an array`);
  if (v.panelWeights != null && !isPlainObject(v.panelWeights)) return invalid(`snapshots[${i}].panelWeights must be an object or null`);
  if (v.panels != null && (!Array.isArray(v.panels) || !v.panels.every((p) => typeof p === "string" && p.length <= MAX_LABEL))) {
    return invalid(`snapshots[${i}].panels must be an array of short strings or null`);
  }
  for (const k of ["bucketThresholds", "backtest", "correlations", "extras"] as const) {
    if (v[k] != null && !isPlainObject(v[k])) return invalid(`snapshots[${i}].${k} must be an object or null`);
  }
  // Rebuild the row explicitly (never pass unknown client fields through).
  return {
    date: v.date,
    composite: (v.composite ?? null) as number | null,
    compositePercentile: (v.compositePercentile ?? null) as number | null,
    regime: (v.regime ?? null) as string | null,
    macroRegime: (v.macroRegime ?? null) as string | null,
    onchainRegime: (v.onchainRegime ?? null) as string | null,
    factorRegime: (v.factorRegime ?? null) as string | null,
    macroIndex: (v.macroIndex ?? null) as number | null,
    onchainIndex: (v.onchainIndex ?? null) as number | null,
    factorIndex: (v.factorIndex ?? null) as number | null,
    macroPercentile: (v.macroPercentile ?? null) as number | null,
    onchainPercentile: (v.onchainPercentile ?? null) as number | null,
    factorPercentile: (v.factorPercentile ?? null) as number | null,
    panelWeights: (v.panelWeights ?? null) as RegimeSnapshotRow["panelWeights"],
    version: (v.version ?? null) as string | null,
    source: (v.source ?? null) as string | null,
    percentiles: v.percentiles as Record<string, number>,
    indicators: v.indicators as JsonValue[],
    panels: (v.panels ?? null) as readonly string[] | null,
    bucketThresholds: v.bucketThresholds ?? null,
    backtest: v.backtest ?? null,
    correlations: v.correlations ?? null,
    extras: v.extras ?? null,
  };
}

// Exported (issue #361 Phase 4): POST /api/swarm/regime is now a genuine
// SUBMISSION gate that accepts the same { snapshots } payload this boundary's
// own regime-snapshots route accepts — one parser, two role-gated doors, zero
// server-side recomputation on either.
export function parseSnapshots(body: unknown): RegimeSnapshotRow[] | Invalid {
  if (!isPlainObject(body) || !Array.isArray(body.snapshots)) return invalid("body must be { snapshots: RegimeSnapshotRow[] }");
  if (body.snapshots.length > MAX_SNAPSHOT_ROWS) return invalid(`payload exceeds ${MAX_SNAPSHOT_ROWS} snapshot rows`);
  const rows: RegimeSnapshotRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < body.snapshots.length; i++) {
    const row = parseSnapshotRow(body.snapshots[i], i);
    if (isInvalid(row)) return row;
    if (seen.has(row.date)) return invalid(`duplicate snapshot date in payload: ${row.date}`);
    seen.add(row.date);
    rows.push(row);
  }
  return rows;
}

// ── research signals payload: { signals: [{key, date, payload}] } ────────────
interface SignalDto { key: string; date: string; payload: ResearchPayload; }
function parseSignals(body: unknown): SignalDto[] | Invalid {
  if (!isPlainObject(body) || !Array.isArray(body.signals)) return invalid("body must be { signals: [{key, date, payload}] }");
  if (body.signals.length > MAX_SIGNALS) return invalid(`payload exceeds ${MAX_SIGNALS} signals`);
  const out: SignalDto[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < body.signals.length; i++) {
    const s = body.signals[i];
    if (!isPlainObject(s)) return invalid(`signals[${i}] must be an object`);
    if (typeof s.key !== "string" || !s.key || s.key.length > MAX_SIGNAL_KEY) return invalid(`signals[${i}].key must be a non-empty string (≤${MAX_SIGNAL_KEY})`);
    if (!isIsoDate(s.date)) return invalid(`signals[${i}].date must be a valid YYYY-MM-DD date`);
    if (!isPlainObject(s.payload)) return invalid(`signals[${i}].payload must be an object`);
    if (JSON.stringify(s.payload).length > MAX_SIGNAL_PAYLOAD_BYTES) return invalid(`signals[${i}].payload exceeds ${MAX_SIGNAL_PAYLOAD_BYTES} bytes`);
    const nk = `${s.key}|${s.date}`;
    if (seen.has(nk)) return invalid(`duplicate (key, date) in payload: (${s.key}, ${s.date})`);
    seen.add(nk);
    out.push({ key: s.key, date: s.date, payload: s.payload as unknown as ResearchPayload });
  }
  return out;
}

// ── telemetry payload: { run: TelemetryRunSubmission } (issue #151) ──────────
const STAGE_NAMES: readonly TelemetryStageName[] = ["access", "extract", "transform", "analyze", "store", "report"];
const STAGE_STATUSES: readonly TelemetryStageStatus[] = ["ok", "warn", "error"];
const RUN_STATUSES: readonly TelemetryRunStatus[] = ["running", "succeeded", "degraded", "failed"];
const MAX_KIND = 64;
const MAX_SOURCE = 32;
const MAX_STAGE_SUMMARY = 2000;
const MAX_WARNING_MESSAGE = 2000;
const MAX_STAGES = 64;
const MAX_WARNINGS = 200;
const MAX_ARTIFACTS = 64;
const MAX_TELEMETRY_SUMMARY_BYTES = 2_000_000;
const MAX_ARTIFACT_PREVIEW_BYTES = 20_000; // generous headroom over the ~4KB in-process bound; still caps abuse

function parseSourceAcquisition(body: unknown): SourceAcquisitionEvidence | Invalid {
  const a = isPlainObject(body) ? body.acquisition : null;
  if (!isPlainObject(a)) return invalid("body must be { acquisition: SourceAcquisitionEvidence }");
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof a.id !== "string" || !UUID.test(a.id)) return invalid("acquisition.id must be a UUID");
  if (typeof a.provider !== "string" || !a.provider || a.provider.length > 64) return invalid("acquisition.provider is invalid");
  if (typeof a.parserVersion !== "string" || !a.parserVersion || a.parserVersion.length > 128) return invalid("acquisition.parserVersion is invalid");
  if (typeof a.cacheIdentity !== "string" || !a.cacheIdentity || a.cacheIdentity.length > 256) return invalid("acquisition.cacheIdentity is invalid");
  if (a.requestedByRunId !== null && (!Number.isSafeInteger(a.requestedByRunId) || Number(a.requestedByRunId) < 0)) return invalid("acquisition.requestedByRunId is invalid");
  if (!Array.isArray(a.events) || a.events.length < 2 || a.events.length > 20) return invalid("acquisition.events is invalid");
  const events: SourceAcquisitionEvidence["events"] = [];
  for (const event of a.events) {
    if (!isPlainObject(event) || !["started", "succeeded", "failed"].includes(String(event.type))) return invalid("acquisition event is invalid");
    if (event.detail !== null && (typeof event.detail !== "string" || event.detail.length > 2000)) return invalid("acquisition event detail is invalid");
    events.push({ type: event.type as any, detail: event.detail as string | null });
  }
  if (events[0]?.type !== "started" || !["succeeded", "failed"].includes(events.at(-1)!.type)) return invalid("acquisition event lifecycle is invalid");
  if (!Array.isArray(a.fetches) || a.fetches.length > 1000) return invalid("acquisition.fetches is invalid");
  const fetches: SourceAcquisitionEvidence["fetches"] = [];
  let payloadBytes = 0;
  for (let i = 0; i < a.fetches.length; i++) {
    const f = a.fetches[i];
    if (!isPlainObject(f) || typeof f.id !== "string" || !UUID.test(f.id) || !isPlainObject(f.requestIdentity)) return invalid(`fetches[${i}] is invalid`);
    const ri = f.requestIdentity;
    if (ri.method !== "GET" || typeof ri.url !== "string" || !isPlainObject(ri.headers)) return invalid(`fetches[${i}].requestIdentity is invalid`);
    const unsafeHeader = Object.entries(ri.headers).some(([key, value]) =>
      ["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "set-cookie"].includes(key.toLowerCase()) && value !== "[REDACTED]");
    if (unsafeHeader) return invalid(`fetches[${i}] contains an unredacted credential header`);
    const requestUrl = new URL(ri.url);
    for (const [key, value] of requestUrl.searchParams) {
      if (/^(api_?key|token|access_?token|secret|password|credential)$/i.test(key) && value !== "[REDACTED]") return invalid(`fetches[${i}] contains an unredacted credential query parameter`);
    }
    if (!Number.isInteger(f.sequence) || f.sequence !== i + 1) return invalid(`fetches[${i}].sequence is invalid`);
    if (!["disabled", "hit", "miss"].includes(String(f.cacheStatus))) return invalid(`fetches[${i}].cacheStatus is invalid`);
    if (f.responseStatus !== null && (!Number.isInteger(f.responseStatus) || Number(f.responseStatus) < 100 || Number(f.responseStatus) > 599)) return invalid(`fetches[${i}].responseStatus is invalid`);
    if ((f.responseChecksum === null) !== (f.payloadBase64 === null)) return invalid(`fetches[${i}] payload/checksum must both be null or supplied`);
    if (f.payloadBase64 !== null) {
      if (typeof f.payloadBase64 !== "string" || typeof f.responseChecksum !== "string" || !/^[0-9a-f]{64}$/.test(f.responseChecksum)) return invalid(`fetches[${i}] payload is invalid`);
      payloadBytes += Buffer.byteLength(f.payloadBase64, "base64");
      if (payloadBytes > 50_000_000) return invalid("acquisition payload bytes exceed 50000000");
      const decoded = new Uint8Array(Buffer.from(f.payloadBase64, "base64"));
      if (payloadChecksum(decoded) !== f.responseChecksum) return invalid(`fetches[${i}] payload checksum mismatch`);
    }
    fetches.push(f as unknown as SourceAcquisitionEvidence["fetches"][number]);
  }
  if (!Array.isArray(a.values) || a.values.length > MAX_RAW_POINTS) return invalid("acquisition.values is invalid");
  const values: SourceAcquisitionEvidence["values"] = [];
  for (let i = 0; i < a.values.length; i++) {
    const v = a.values[i];
    if (!isPlainObject(v) || typeof v.sourceKey !== "string" || !v.sourceKey || v.sourceKey.length > 128 || !isFiniteNumber(v.value)) return invalid(`values[${i}] is invalid`);
    const hasDate = isIsoDate(v.marketDate);
    const hasInstant = typeof v.marketInstant === "string" && !Number.isNaN(Date.parse(v.marketInstant));
    if (Number(hasDate) + Number(hasInstant) !== 1) return invalid(`values[${i}] must have exactly one market time`);
    values.push(v as unknown as SourceAcquisitionEvidence["values"][number]);
  }
  return { id: a.id, provider: a.provider, parserVersion: a.parserVersion, cacheIdentity: a.cacheIdentity,
    requestedByRunId: a.requestedByRunId as number | null, events, fetches, values };
}

function isIsoDateTime(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

// `jobs.id` is a Postgres `bigint` (bigserial) — postgres.js decodes bigint
// columns as JS strings by default (never silently narrowing a value that may
// exceed Number.MAX_SAFE_INTEGER), so a job-linked telemetry submission's
// jobId arrives here as a numeric string, not a `number` (issue #383). Accept
// either representation and never coerce string -> number: coercing would
// reintroduce exactly the precision loss postgres.js's string serialization
// exists to avoid for genuinely large ids.
const isJobId = (v: unknown): v is number | string =>
  (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^\d+$/.test(v));

function parseStage(v: unknown, i: number): TelemetryStage | Invalid {
  if (!isPlainObject(v)) return invalid(`stages[${i}] must be an object`);
  if (!STAGE_NAMES.includes(v.stage as TelemetryStageName)) return invalid(`stages[${i}].stage must be one of ${STAGE_NAMES.join(", ")}`);
  if (typeof v.sequence !== "number" || !Number.isInteger(v.sequence) || v.sequence < 1) return invalid(`stages[${i}].sequence must be a positive integer`);
  if (!STAGE_STATUSES.includes(v.status as TelemetryStageStatus)) return invalid(`stages[${i}].status must be one of ${STAGE_STATUSES.join(", ")}`);
  if (typeof v.summary !== "string" || v.summary.length > MAX_STAGE_SUMMARY) return invalid(`stages[${i}].summary must be a string (≤${MAX_STAGE_SUMMARY})`);
  if (!isIsoDateTime(v.startedAt) || !isIsoDateTime(v.finishedAt)) return invalid(`stages[${i}] startedAt/finishedAt must be valid timestamps`);
  return {
    stage: v.stage as TelemetryStageName,
    sequence: v.sequence,
    status: v.status as TelemetryStageStatus,
    summary: v.summary,
    startedAt: v.startedAt,
    finishedAt: v.finishedAt,
  };
}

function parseWarning(v: unknown, i: number): TelemetryWarning | Invalid {
  if (!isPlainObject(v)) return invalid(`warnings[${i}] must be an object`);
  if (typeof v.stage !== "string" || v.stage.length > MAX_KIND) return invalid(`warnings[${i}].stage must be a short string`);
  if (typeof v.message !== "string" || !v.message || v.message.length > MAX_WARNING_MESSAGE) return invalid(`warnings[${i}].message must be a non-empty string (≤${MAX_WARNING_MESSAGE})`);
  return { stage: v.stage as TelemetryStageName, message: v.message };
}

function parseArtifact(v: unknown, i: number): TelemetryArtifact | Invalid {
  if (!isPlainObject(v)) return invalid(`artifacts[${i}] must be an object`);
  if (typeof v.stage !== "string" || v.stage.length > MAX_KIND) return invalid(`artifacts[${i}].stage must be a short string`);
  if (typeof v.kind !== "string" || !v.kind || v.kind.length > MAX_KIND) return invalid(`artifacts[${i}].kind must be a non-empty short string`);
  if (v.checksum != null && typeof v.checksum !== "string") return invalid(`artifacts[${i}].checksum must be a string or null`);
  if (v.preview === undefined) return invalid(`artifacts[${i}].preview is required`);
  if (JSON.stringify(v.preview).length > MAX_ARTIFACT_PREVIEW_BYTES) return invalid(`artifacts[${i}].preview exceeds ${MAX_ARTIFACT_PREVIEW_BYTES} bytes — telemetry never persists a complete series`);
  return { stage: v.stage as TelemetryStageName, kind: v.kind, checksum: (v.checksum ?? null) as string | null, preview: v.preview };
}

function parseTelemetryRun(body: unknown): TelemetryRunSubmission | Invalid {
  if (!isPlainObject(body) || !isPlainObject(body.run)) return invalid("body must be { run: TelemetryRunSubmission }");
  const v = body.run;
  if (typeof v.kind !== "string" || !v.kind || v.kind.length > MAX_KIND) return invalid(`run.kind must be a non-empty string (≤${MAX_KIND})`);
  if (!isIsoDate(v.asof)) return invalid("run.asof must be a valid YYYY-MM-DD date");
  if (typeof v.source !== "string" || !v.source || v.source.length > MAX_SOURCE) return invalid(`run.source must be a non-empty string (≤${MAX_SOURCE})`);
  if (!RUN_STATUSES.includes(v.status as TelemetryRunStatus)) return invalid(`run.status must be one of ${RUN_STATUSES.join(", ")}`);
  if (!isIsoDateTime(v.startedAt) || !isIsoDateTime(v.finishedAt)) return invalid("run.startedAt/finishedAt must be valid timestamps");
  if (v.checksum != null && typeof v.checksum !== "string") return invalid("run.checksum must be a string or null");
  if (!isPlainObject(v.summary)) return invalid("run.summary must be an object");
  if (JSON.stringify(v.summary).length > MAX_TELEMETRY_SUMMARY_BYTES) return invalid(`run.summary exceeds ${MAX_TELEMETRY_SUMMARY_BYTES} bytes`);
  if (v.jobId != null && !isJobId(v.jobId)) return invalid("run.jobId must be an integer, a numeric string, or null");
  if (!Array.isArray(v.stages) || v.stages.length > MAX_STAGES) return invalid(`run.stages must be an array (≤${MAX_STAGES})`);
  if (!Array.isArray(v.warnings) || v.warnings.length > MAX_WARNINGS) return invalid(`run.warnings must be an array (≤${MAX_WARNINGS})`);
  if (!Array.isArray(v.artifacts) || v.artifacts.length > MAX_ARTIFACTS) return invalid(`run.artifacts must be an array (≤${MAX_ARTIFACTS})`);

  const stages: TelemetryStage[] = [];
  const seenSeq = new Set<number>();
  for (let i = 0; i < v.stages.length; i++) {
    const s = parseStage(v.stages[i], i);
    if (isInvalid(s)) return s;
    if (seenSeq.has(s.sequence)) return invalid(`duplicate stages[].sequence in payload: ${s.sequence}`);
    seenSeq.add(s.sequence);
    stages.push(s);
  }
  const warnings: TelemetryWarning[] = [];
  for (let i = 0; i < v.warnings.length; i++) {
    const w = parseWarning(v.warnings[i], i);
    if (isInvalid(w)) return w;
    warnings.push(w);
  }
  const artifacts: TelemetryArtifact[] = [];
  for (let i = 0; i < v.artifacts.length; i++) {
    const a = parseArtifact(v.artifacts[i], i);
    if (isInvalid(a)) return a;
    artifacts.push(a);
  }

  return {
    kind: v.kind,
    asof: v.asof,
    source: v.source,
    status: v.status as TelemetryRunStatus,
    startedAt: v.startedAt,
    finishedAt: v.finishedAt,
    checksum: (v.checksum ?? null) as string | null,
    summary: v.summary as Record<string, unknown>,
    stages,
    warnings,
    artifacts,
    jobId: (v.jobId ?? null) as number | string | null,
  };
}

// ── run-ledger payloads (issue #977) ────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_SOURCE_LABELS = ["live", "hermetic", "fixture"] as const;
const RUN_EVENT_TYPES: readonly RunLifecycleEvent[] = ["started", "succeeded", "degraded", "failed"];
const isBigIntString = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,30}$/.test(v);

function parseMethodology(v: unknown): MethodologyIdentity | Invalid {
  if (!isPlainObject(v)) return invalid("run.methodology must be an object");
  if (typeof v.toolId !== "string" || !v.toolId || v.toolId.length > 64) return invalid("run.methodology.toolId is invalid");
  if (typeof v.versionLabel !== "string" || !v.versionLabel || v.versionLabel.length > 128) return invalid("run.methodology.versionLabel is invalid");
  if (!isPlainObject(v.config)) return invalid("run.methodology.config must be an object");
  return { toolId: v.toolId, versionLabel: v.versionLabel, config: v.config };
}

interface BeginRunDto {
  runKey: string;
  asof: string;
  toolId: string;
  sourceLabel: string;
  methodology: MethodologyIdentity;
  buildIdentity: string;
  jobId: number | string | null;
}

function parseBeginRun(body: unknown): BeginRunDto | Invalid {
  const v = isPlainObject(body) ? body.run : null;
  if (!isPlainObject(v)) return invalid("body must be { run: {...} }");
  if (typeof v.runKey !== "string" || !UUID_RE.test(v.runKey)) return invalid("run.runKey must be a UUID");
  if (!isIsoDate(v.asof)) return invalid("run.asof must be a valid YYYY-MM-DD date");
  if (typeof v.toolId !== "string" || !v.toolId || v.toolId.length > 64) return invalid("run.toolId is invalid");
  if (!RUN_SOURCE_LABELS.includes(v.sourceLabel as (typeof RUN_SOURCE_LABELS)[number])) {
    return invalid(`run.sourceLabel must be one of ${RUN_SOURCE_LABELS.join(", ")}`);
  }
  const methodology = parseMethodology(v.methodology);
  if (isInvalid(methodology)) return methodology;
  if (typeof v.buildIdentity !== "string" || !v.buildIdentity || v.buildIdentity.length > 256) return invalid("run.buildIdentity is invalid");
  if (v.jobId !== undefined && v.jobId !== null && !isJobId(v.jobId)) return invalid("run.jobId must be an integer, a numeric string, or null");
  return {
    runKey: v.runKey, asof: v.asof, toolId: v.toolId, sourceLabel: v.sourceLabel as string,
    methodology, buildIdentity: v.buildIdentity, jobId: (v.jobId ?? null) as number | string | null,
  };
}

interface RunEventDto {
  runId: string;
  eventType: RunLifecycleEvent;
  detail: string | null;
}

function parseRunEvent(body: unknown): RunEventDto | Invalid {
  const v = isPlainObject(body) ? body.event : null;
  if (!isPlainObject(v)) return invalid("body must be { event: {...} }");
  if (!isBigIntString(String(v.runId ?? ""))) return invalid("event.runId must be a positive integer id");
  if (!RUN_EVENT_TYPES.includes(v.eventType as RunLifecycleEvent)) return invalid(`event.eventType must be one of ${RUN_EVENT_TYPES.join(", ")}`);
  if (v.detail !== null && v.detail !== undefined && (typeof v.detail !== "string" || v.detail.length > 2000)) return invalid("event.detail must be a string (≤2000) or null");
  return { runId: String(v.runId), eventType: v.eventType as RunLifecycleEvent, detail: (v.detail ?? null) as string | null };
}

interface FreezeVintageDto {
  runId: string;
  toolId: string;
  knowledgeTimeCutoff: string;
  marketTimeCutoff: string;
  methodologyVersionId: string;
  buildIdentity: string;
}

function parseFreezeVintage(body: unknown): FreezeVintageDto | Invalid {
  const v = isPlainObject(body) ? body.vintage : null;
  if (!isPlainObject(v)) return invalid("body must be { vintage: {...} }");
  if (!isBigIntString(String(v.runId ?? ""))) return invalid("vintage.runId must be a positive integer id");
  if (typeof v.toolId !== "string" || !v.toolId || v.toolId.length > 64) return invalid("vintage.toolId is invalid");
  if (!isIsoDateTime(v.knowledgeTimeCutoff)) return invalid("vintage.knowledgeTimeCutoff must be a valid timestamp");
  if (!isIsoDate(v.marketTimeCutoff)) return invalid("vintage.marketTimeCutoff must be a valid YYYY-MM-DD date");
  if (!isBigIntString(String(v.methodologyVersionId ?? ""))) return invalid("vintage.methodologyVersionId must be a positive integer id");
  if (typeof v.buildIdentity !== "string" || !v.buildIdentity || v.buildIdentity.length > 256) return invalid("vintage.buildIdentity is invalid");
  return {
    runId: String(v.runId), toolId: v.toolId, knowledgeTimeCutoff: v.knowledgeTimeCutoff,
    marketTimeCutoff: v.marketTimeCutoff, methodologyVersionId: String(v.methodologyVersionId), buildIdentity: v.buildIdentity,
  };
}

// ── terminal run package payloads (issue #978) ──────────────────────────────
const MAX_LOG_MESSAGE = 4000;
const MAX_EXCEPTION_MESSAGE = 4000;
const MAX_EXCEPTION_STACK = 20_000;
const MAX_LOGS = 5000;
const MAX_EXCEPTIONS = 500;
const MAX_REPORT_BYTES = 20_000_000;

function parseWarningArtifact(v: unknown, i: number): WarningArtifact | Invalid {
  if (!isPlainObject(v)) return invalid(`warnings[${i}] must be an object`);
  if (typeof v.stage !== "string" || v.stage.length > MAX_KIND) return invalid(`warnings[${i}].stage must be a short string`);
  if (typeof v.message !== "string" || !v.message || v.message.length > MAX_WARNING_MESSAGE) return invalid(`warnings[${i}].message must be a non-empty string (≤${MAX_WARNING_MESSAGE})`);
  return { stage: v.stage, message: v.message };
}

function parseLogArtifact(v: unknown, i: number): LogArtifact | Invalid {
  if (!isPlainObject(v)) return invalid(`logs[${i}] must be an object`);
  if (typeof v.level !== "string" || !v.level || v.level.length > MAX_KIND) return invalid(`logs[${i}].level must be a non-empty short string`);
  if (typeof v.message !== "string" || !v.message || v.message.length > MAX_LOG_MESSAGE) return invalid(`logs[${i}].message must be a non-empty string (≤${MAX_LOG_MESSAGE})`);
  if (!isIsoDateTime(v.at)) return invalid(`logs[${i}].at must be a valid timestamp`);
  return { level: v.level, message: v.message, at: v.at };
}

function parseExceptionArtifact(v: unknown, i: number): ExceptionArtifact | Invalid {
  if (!isPlainObject(v)) return invalid(`exceptions[${i}] must be an object`);
  if (typeof v.message !== "string" || !v.message || v.message.length > MAX_EXCEPTION_MESSAGE) return invalid(`exceptions[${i}].message must be a non-empty string (≤${MAX_EXCEPTION_MESSAGE})`);
  if (v.stack !== null && v.stack !== undefined && (typeof v.stack !== "string" || v.stack.length > MAX_EXCEPTION_STACK)) {
    return invalid(`exceptions[${i}].stack must be a string (≤${MAX_EXCEPTION_STACK}) or null`);
  }
  return { message: v.message, stack: (v.stack ?? null) as string | null };
}

function parseResearchSignalArtifacts(v: unknown): ResearchSignalArtifact[] | Invalid {
  const parsed = parseSignals({ signals: v });
  if (isInvalid(parsed)) return parsed;
  return parsed.map((s) => ({ key: s.key, date: s.date, payload: s.payload }));
}

// Whole-body validation, strictly before submitTerminalRunPackage opens its
// transaction (issue #978 AC1's malformed-payload-never-reaches-Postgres
// discipline, same as every other route in this file).
function parseTerminalRunPackage(body: unknown): TerminalRunPackageInput | Invalid {
  const v = isPlainObject(body) ? body.package : null;
  if (!isPlainObject(v)) return invalid("body must be { package: {...} }");
  if (!isBigIntString(String(v.runId ?? ""))) return invalid("package.runId must be a positive integer id");
  if (!isIsoDate(v.asof)) return invalid("package.asof must be a valid YYYY-MM-DD date");
  if (v.status !== "succeeded" && v.status !== "failed") return invalid(`package.status must be one of succeeded, failed`);
  const status = v.status as TerminalRunStatus;

  if (status === "succeeded") {
    if (!Array.isArray(v.regimeSnapshots)) return invalid("package.regimeSnapshots must be an array");
    const regimeSnapshots = parseSnapshots({ snapshots: v.regimeSnapshots });
    if (isInvalid(regimeSnapshots)) return regimeSnapshots;
    if (!Array.isArray(v.researchSignals)) return invalid("package.researchSignals must be an array");
    const researchSignals = parseResearchSignalArtifacts(v.researchSignals);
    if (isInvalid(researchSignals)) return researchSignals;
    if (typeof v.reportBase64 !== "string" || !v.reportBase64) return invalid("package.reportBase64 must be a non-empty base64 string");
    const reportBytes = new Uint8Array(Buffer.from(v.reportBase64, "base64"));
    if (reportBytes.length === 0) return invalid("package.reportBase64 decodes to zero bytes");
    if (reportBytes.length > MAX_REPORT_BYTES) return invalid(`package.reportBase64 decodes to more than ${MAX_REPORT_BYTES} bytes`);
    return { runId: String(v.runId), asof: v.asof, status, regimeSnapshots, researchSignals, reportBytes };
  }

  if (!Array.isArray(v.warnings) || v.warnings.length > MAX_WARNINGS) return invalid(`package.warnings must be an array (≤${MAX_WARNINGS})`);
  const warnings: WarningArtifact[] = [];
  for (let i = 0; i < v.warnings.length; i++) {
    const w = parseWarningArtifact(v.warnings[i], i);
    if (isInvalid(w)) return w;
    warnings.push(w);
  }
  if (!Array.isArray(v.logs) || v.logs.length > MAX_LOGS) return invalid(`package.logs must be an array (≤${MAX_LOGS})`);
  const logs: LogArtifact[] = [];
  for (let i = 0; i < v.logs.length; i++) {
    const l = parseLogArtifact(v.logs[i], i);
    if (isInvalid(l)) return l;
    logs.push(l);
  }
  if (!Array.isArray(v.exceptions) || v.exceptions.length > MAX_EXCEPTIONS) return invalid(`package.exceptions must be an array (≤${MAX_EXCEPTIONS})`);
  const exceptions: ExceptionArtifact[] = [];
  for (let i = 0; i < v.exceptions.length; i++) {
    const e = parseExceptionArtifact(v.exceptions[i], i);
    if (isInvalid(e)) return e;
    exceptions.push(e);
  }
  return { runId: String(v.runId), asof: v.asof, status, warnings, logs, exceptions };
}

// Returns { status, body } or null if the path isn't an analytics route.
export async function handleAnalytics(req: Request, url: URL): Promise<{ status: number; body: unknown } | null> {
  const p = url.pathname;
  const m = req.method;
  const isAnalyticsRoute =
    p === A.readiness ||
    p === A.rawHistory ||
    p === A.rawHistorySeed ||
    p === A.researchSignalDates ||
    p === A.rawHistoryGaps ||
    p === A.sourceAcquisitions ||
    p === A.researchEligibility ||
    p === A.telemetry ||
    p === A.runs ||
    p === A.runEvents ||
    p === A.vintages ||
    p === A.vintage ||
    p === A.runPackage ||
    p === A.reportSnapshot;
  if (!isAnalyticsRoute) return null;

  // Authenticate FIRST — reads and mutations alike are analytics-provider-only.
  // 401 when no credential was presented, 403 when one was presented but does
  // not match. Neither ADMIN_TOKEN nor member bearers are accepted here: the
  // comparison is strictly against ANALYTICS_TOKEN.
  if (!hasAnalyticsProviderRole(req)) {
    const presented = bearer(req);
    return presented
      ? { status: 403, body: { error: "analytics-provider role required" } }
      : { status: 401, body: { error: "missing analytics-provider bearer token" } };
  }

  // Read-only producer boot probe. Authentication above is the entire check:
  // no analytics data is loaded and no consumer schedule/job can be touched.
  if (m === "GET" && p === A.readiness) {
    return { status: 200, body: { ok: true, role: "analytics-provider" } };
  }

  if (m === "GET" && p === A.rawHistory) {
    return { status: 200, body: { history: await loadRawIndicatorHistory() } };
  }

  if (m === "POST" && p === A.sourceAcquisitions) {
    const parsed = parseSourceAcquisition(await req.json().catch(() => null));
    if (isInvalid(parsed)) return { status: 400, body: parsed };
    const result = await saveSourceAcquisition(parsed);
    return { status: 200, body: result };
  }

  if (m === "POST" && p === A.rawHistory) {
    const body = await req.json().catch(() => null);
    const parsed = parseRawHistory(body);
    if (isInvalid(parsed)) return { status: 400, body: parsed };
    const source = parseRawHistorySource(body);
    if (isInvalid(source)) return { status: 400, body: source };
    let rows = 0;
    for (const pts of Object.values(parsed)) rows += pts.length;
    await sql.begin((tx) => saveRawIndicatorHistory(parsed, tx, source ?? undefined));
    return { status: 200, body: { ok: true, rows } };
  }

  if (m === "POST" && p === A.rawHistorySeed) {
    const parsed = parseRawHistory(await req.json().catch(() => null));
    if (isInvalid(parsed)) return { status: 400, body: parsed };
    const res = await sql.begin((tx) => applyRawFloorSeed(parsed, tx));
    return { status: 200, body: { ok: true, ...res } };
  }

  // RETIRED (issue #978): `POST /api/analytics/regime-snapshots` and
  // `POST /api/analytics/research-signals`. Both upserted straight into the
  // current views with no run_id, no immutable output artifact and no report
  // snapshot, so anything holding ANALYTICS_TOKEN could publish regime rows
  // that no frozen report ever contained — and publishBrief, which derives its
  // binding from those rows, would then bind a signed brief to some OTHER
  // run's report. `POST /api/analytics/run-packages` is now the sole HTTP
  // publisher of both projections (see submitTerminalRunPackage). The only
  // in-process writers left are the store functions themselves, reached
  // directly by `db/import-regime-eq.ts` (the offline eq-snapshot import) and
  // `POST /api/swarm/regime` — neither of which ever went through these routes.
  //
  // GET /api/analytics/research-signals/dates?since=YYYY-MM-DD (issue #614
  // AC4) — the read side of the producer's catch-up mechanism: no payload
  // content, just which (signal_key, date) pairs already exist, so a
  // restarted producer (or one running its normal daily tick) can tell which
  // recent days it still needs to re-run instead of only ever computing
  // `new Date()`.
  if (m === "GET" && p === A.researchSignalDates) {
    const since = url.searchParams.get("since");
    if (!since || !isIsoDate(since)) return { status: 400, body: { error: "since must be a valid YYYY-MM-DD date" } };
    const dates = await loadRecentResearchSignalDates(since);
    return { status: 200, body: { dates } };
  }

  // GET /api/analytics/raw-history/gaps?since=YYYY-MM-DD (issue #646, closing
  // #614 AC4's Class A bullet) — the read side of the producer's INDICATOR
  // catch-up: which raw_indicator_history interior-gap dates exist on/after
  // `since`. Same reasoning as researchSignalDates above (the producer has no
  // DATABASE_URL), but driven by the shared gap detector instead of a bespoke
  // presence query, so this and GET /api/admin/gaps can never disagree about
  // which dates are missing.
  if (m === "GET" && p === A.rawHistoryGaps) {
    const since = url.searchParams.get("since");
    if (!since || !isIsoDate(since)) return { status: 400, body: { error: "since must be a valid YYYY-MM-DD date" } };
    const def = getSeriesDef("raw_indicator_history");
    if (!def) return { status: 500, body: { error: "raw_indicator_history is not registered in the series registry" } };
    const report = await detectGaps(def, sql);
    const dates = report.interiorGaps.map((iso) => iso.slice(0, 10)).filter((d) => d >= since);
    return { status: 200, body: { dates } };
  }

  // RETIRED: analytics scheduling belongs to the independent producer, not to
  // the consumer API or its Postgres queue (D25 / issue #361). Keep the old
  // authenticated path explicit so deployed bootstrap clients fail closed
  // instead of falling through ambiguously, but never update job_schedules or
  // enqueue research.refresh here. Seed ingestion remains available through
  // rawHistorySeed; the producer owns what runs after that ingestion succeeds.
  if (m === "POST" && p === A.researchEligibility) {
    return {
      status: 409,
      body: {
        error: "research scheduling is owned by the independent analytics producer",
        code: "producer_owned",
      },
    };
  }

  // POST /api/analytics/telemetry (issue #151) — structured research pipeline
  // telemetry for one runAnalytics execution: stage timeline, warnings, bounded
  // artifact previews, and the outcome. Submission failures here are the
  // updater's problem to surface non-fatally (analytics/telemetry.ts
  // submitTelemetrySafely) — this endpoint just validates + persists.
  if (m === "POST" && p === A.telemetry) {
    const parsed = parseTelemetryRun(await req.json().catch(() => null));
    if (isInvalid(parsed)) return { status: 400, body: parsed };
    const runId = await sql.begin((tx) => saveTelemetryRun(parsed, tx));
    return { status: 200, body: { ok: true, runId } };
  }

  // ── issue #977: the immutable analytics run/vintage ledger ────────────────
  // Whole-body validation happens above, in parse*, strictly before any of
  // beginRun/appendRunEvent/freezeVintage opens its own transaction — no
  // malformed payload ever reaches Postgres.
  if (m === "POST" && p === A.runs) {
    const parsed = parseBeginRun(await req.json().catch(() => null));
    if (isInvalid(parsed)) return { status: 400, body: parsed };
    const result = await beginRun(parsed);
    return { status: 200, body: result };
  }

  if (m === "POST" && p === A.runEvents) {
    const parsed = parseRunEvent(await req.json().catch(() => null));
    if (isInvalid(parsed)) return { status: 400, body: parsed };
    await appendRunEvent(parsed.runId, parsed.eventType, parsed.detail);
    return { status: 200, body: { ok: true } };
  }

  if (m === "POST" && p === A.vintages) {
    const parsed = parseFreezeVintage(await req.json().catch(() => null));
    if (isInvalid(parsed)) return { status: 400, body: parsed };
    try {
      const result = await freezeVintage(parsed);
      return { status: 200, body: result };
    } catch (err) {
      if (err instanceof VintageConflictError) {
        return { status: 409, body: { error: err.message, existing: err.existing } };
      }
      throw err;
    }
  }

  if (m === "GET" && p === A.vintage) {
    const runId = url.searchParams.get("runId");
    const toolId = url.searchParams.get("toolId");
    if (!runId || !isBigIntString(runId) || !toolId) return { status: 400, body: { error: "runId and toolId query params are required" } };
    const found = await findVintageByRunAndTool(runId, toolId);
    if (!found) return { status: 404, body: { error: "no vintage frozen for this (runId, toolId)" } };
    const vintage = await loadFrozenVintage(found.vintageId);
    return { status: 200, body: { vintage } };
  }

  // ── issue #978: the immutable analytics output/report snapshot layer ─────
  if (m === "POST" && p === A.runPackage) {
    const parsed = parseTerminalRunPackage(await req.json().catch(() => null));
    if (isInvalid(parsed)) return { status: 400, body: parsed };
    try {
      const result = await submitTerminalRunPackage(parsed);
      return { status: 200, body: result };
    } catch (err) {
      if (err instanceof TerminalRunPackageConflictError) {
        return { status: 409, body: { error: err.message, existing: err.existing } };
      }
      if (err instanceof RunAsofMismatchError) {
        return { status: 400, body: { error: err.message } };
      }
      throw err;
    }
  }

  if (m === "GET" && p === A.reportSnapshot) {
    const id = url.searchParams.get("id");
    if (!id || !isBigIntString(id)) return { status: 400, body: { error: "id query param must be a positive integer" } };
    const report = await loadReportSnapshot(id);
    if (!report) return { status: 404, body: { error: "no report snapshot for this id" } };
    return {
      status: 200,
      body: {
        report: {
          id: report.id,
          runId: report.runId,
          asof: report.asof,
          checksum: report.checksum,
          byteLength: report.byteLength,
          reportBase64: Buffer.from(report.bytes).toString("base64"),
        },
      },
    };
  }

  return { status: 405, body: { error: "method not allowed" } };
}
