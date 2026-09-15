// Issue #977 SQL writer: the immutable analytics run/vintage ledger. Only the
// API process imports this (same rule as source-ledger-store.ts) — the
// updater/producer goes through analytics/api-client.ts's HTTP boundary.
import { sql, jsonValue, type DbHandle } from "../../db/client.ts";
import {
  buildVintageManifest,
  configDigest,
  type FrozenSourceValue,
  type MethodologyIdentity,
  type RunLifecycleEvent,
  type VintageManifest,
} from "../run-ledger.ts";

export interface BeginRunInput {
  runKey: string;
  asof: string;
  toolId: string;
  sourceLabel: string;
  methodology: MethodologyIdentity;
  buildIdentity: string;
  jobId?: number | string | null;
}

export interface BeginRunResult {
  runId: string;
  methodologyVersionId: string;
  replayed: boolean;
}

// The immutable run HEADER — written once, before any acquisition (issue #977
// AC1). One transaction: the methodology-version lookup/insert and the run
// row are inseparable (a run always names a real methodology version).
// `runKey` is the idempotency key (AC8): a retried begin-run submission with
// the same key returns the already-persisted header (`replayed: true`)
// instead of creating a second one.
export async function beginRun(input: BeginRunInput): Promise<BeginRunResult> {
  const [existingRun] = await sql`SELECT id, methodology_version_id FROM analytics_ledger_runs WHERE run_key = ${input.runKey}`;
  if (existingRun) {
    return { runId: String(existingRun.id), methodologyVersionId: String(existingRun.methodology_version_id), replayed: true };
  }
  try {
    return await sql.begin(async (tx) => {
      const digest = configDigest(input.methodology.config);
      const [existingMethodology] = await tx`
        SELECT id FROM analytics_ledger_methodology_versions
        WHERE tool_id = ${input.methodology.toolId} AND config_digest = ${digest}`;
      let methodologyVersionId: string;
      if (existingMethodology) {
        methodologyVersionId = String(existingMethodology.id);
      } else {
        const [row] = await tx`
          INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest)
          VALUES (${input.methodology.toolId}, ${input.methodology.versionLabel},
                  ${tx.json(jsonValue(input.methodology.config))}, ${digest})
          RETURNING id`;
        methodologyVersionId = String(row!.id);
      }
      const [run] = await tx`
        INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity, job_id)
        VALUES (${input.runKey}, ${input.asof}::date, ${input.toolId}, ${input.sourceLabel},
                ${methodologyVersionId}::bigint, ${input.buildIdentity}, ${input.jobId ?? null})
        RETURNING id`;
      return { runId: String(run!.id), methodologyVersionId, replayed: false };
    });
  } catch (err) {
    // A genuine race (two concurrent begin-run submissions for the same
    // run_key) trips the UNIQUE(run_key) constraint (23505) — resolve it the
    // same way a sequential retry would (AC8's idempotent replay), rather
    // than surfacing a raw SQL error, mirroring freezeVintage below.
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") return beginRun(input);
    throw err;
  }
}

// Append-only, ordered lifecycle events (issue #977 AC5). Never updates the
// header — there is no status/finished_at/warning/error column on it to
// update. Serialized per run_id via an advisory xact lock so two concurrent
// appends for the SAME run can never race onto the same sequence number.
export async function appendRunEvent(
  runId: string,
  eventType: RunLifecycleEvent,
  detail: string | null,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('analytics_ledger_run_events:' || ${runId}, 0))`;
    const [{ next }] = await tx`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next
      FROM analytics_ledger_run_events WHERE run_id = ${runId}::bigint`;
    await tx`
      INSERT INTO analytics_ledger_run_events (run_id, sequence, event_type, detail)
      VALUES (${runId}::bigint, ${next}, ${eventType}, ${detail})`;
  });
}

interface SourceValueRow {
  id: string | number;
  source_key: string;
  market_date: string | null;
  market_instant: string | null;
  value: number | string;
}

function toFrozen(row: SourceValueRow): FrozenSourceValue {
  return {
    versionId: String(row.id),
    sourceKey: row.source_key,
    marketDate: row.market_date,
    marketInstant: row.market_instant,
    value: Number(row.value),
  };
}

// Typed selection #1 (issue #977 AC3): the CURRENT known state — the newest
// revision per (source_key, market coordinate), with NO knowledge-time or
// market-time cutoff. Never used to freeze a vintage; it answers "what do we
// know right now".
export async function loadCurrentSourceValues(db: DbHandle = sql): Promise<FrozenSourceValue[]> {
  const rows = (await db`
    SELECT DISTINCT ON (source_key, market_date, market_instant)
      id, source_key, market_date::text AS market_date, market_instant::text AS market_instant, value
    FROM source_value_versions
    ORDER BY source_key, market_date, market_instant, knowledge_time DESC, id DESC
  `) as unknown as SourceValueRow[];
  return rows.map(toFrozen);
}

// Typed selection #2 (issue #977 AC2/AC3): the HISTORICAL, cutoff-bound
// state — the newest revision per (source_key, market coordinate) that was
// already known at `knowledgeTimeCutoff` (an ISO timestamp) AND whose market
// coordinate falls on or before `marketTimeCutoff` (a YYYY-MM-DD date). A
// revision recorded strictly after the knowledge-time cutoff, or dated
// strictly after the market-time cutoff, is excluded — this is the operation
// freezeVintage below uses, and it is intentionally a SEPARATE function from
// loadCurrentSourceValues rather than an optional-cutoff overload of it, so
// the two can never be confused at a call site.
export async function loadHistoricalSourceValues(
  knowledgeTimeCutoff: string,
  marketTimeCutoff: string,
  db: DbHandle = sql,
): Promise<FrozenSourceValue[]> {
  const rows = (await db`
    SELECT DISTINCT ON (source_key, market_date, market_instant)
      id, source_key, market_date::text AS market_date, market_instant::text AS market_instant, value
    FROM source_value_versions
    WHERE knowledge_time <= ${knowledgeTimeCutoff}::timestamptz
      AND (market_date IS NULL OR market_date <= ${marketTimeCutoff}::date)
      AND (market_instant IS NULL OR (market_instant AT TIME ZONE 'UTC')::date <= ${marketTimeCutoff}::date)
    ORDER BY source_key, market_date, market_instant, knowledge_time DESC, id DESC
  `) as unknown as SourceValueRow[];
  return rows.map(toFrozen);
}

export interface FreezeVintageInput {
  runId: string;
  toolId: string;
  knowledgeTimeCutoff: string;
  marketTimeCutoff: string;
  methodologyVersionId: string;
  buildIdentity: string;
}

export interface FreezeVintageResult {
  vintageId: string;
  manifest: VintageManifest;
  memberCount: number;
  replayed: boolean;
}

// Thrown by freezeVintage when a (run, tool) already has a DIFFERENT frozen
// vintage — the API route (issue #977 AC8) turns this into a 409, never a
// silent overwrite (impossible anyway: analytics_data_vintages is immutable
// and UNIQUE(run_id, tool_id)).
export class VintageConflictError extends Error {
  constructor(public readonly existing: FreezeVintageResult) {
    super(`a different data vintage is already frozen for this (run, tool)`);
    this.name = "VintageConflictError";
  }
}

// Freeze one data vintage: select the boundary-eligible source-value-version
// ids (loadHistoricalSourceValues), build the canonical manifest, and persist
// both the manifest and its flat membership atomically. Idempotent on
// (run_id, tool_id) (issue #977 AC8): resubmitting the SAME cutoffs +
// methodology + build for an already-frozen (run, tool) replays the existing
// vintage rather than erroring; resubmitting DIFFERENT ones raises
// VintageConflictError.
export async function freezeVintage(input: FreezeVintageInput): Promise<FreezeVintageResult> {
  const existing = await findVintageByRunAndTool(input.runId, input.toolId);
  if (existing) {
    const frozen = await loadFrozenVintage(existing.vintageId);
    /* istanbul ignore next -- just inserted; a lookup miss would be a bug, not a runtime case */
    if (!frozen) throw new Error(`vintage ${existing.vintageId} vanished between lookup and reload`);
    const identical =
      new Date(frozen.knowledgeTimeCutoff).getTime() === new Date(input.knowledgeTimeCutoff).getTime() &&
      frozen.marketTimeCutoff === input.marketTimeCutoff &&
      frozen.methodologyVersionId === input.methodologyVersionId &&
      frozen.buildIdentity === input.buildIdentity;
    if (identical) {
      return { vintageId: frozen.vintageId, manifest: frozen.manifest, memberCount: frozen.memberCount, replayed: true };
    }
    throw new VintageConflictError({ vintageId: frozen.vintageId, manifest: frozen.manifest, memberCount: frozen.memberCount, replayed: false });
  }

  const members = await loadHistoricalSourceValues(input.knowledgeTimeCutoff, input.marketTimeCutoff);
  const { manifest } = buildVintageManifest(
    members,
    input.methodologyVersionId,
    input.buildIdentity,
    input.knowledgeTimeCutoff,
    input.marketTimeCutoff,
  );
  try {
    return await sql.begin(async (tx) => {
      const [vintage] = await tx`
        INSERT INTO analytics_data_vintages
          (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id,
           build_identity, manifest, manifest_digest, member_count)
        VALUES (${input.runId}::bigint, ${input.toolId}, ${input.knowledgeTimeCutoff}::timestamptz,
                ${input.marketTimeCutoff}::date, ${input.methodologyVersionId}::bigint, ${input.buildIdentity},
                ${tx.json(jsonValue(manifest))}, ${manifest.manifestDigest}, ${members.length})
        RETURNING id`;
      const vintageId = String(vintage!.id);
      for (const member of members) {
        await tx`
          INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key)
          VALUES (${vintageId}::bigint, ${member.versionId}::bigint, ${member.sourceKey})`;
      }
      return { vintageId, manifest, memberCount: members.length, replayed: false };
    });
  } catch (err) {
    // A genuine race (two concurrent freezes for the same (run, tool)) trips
    // the UNIQUE(run_id, tool_id) constraint (23505) — resolve it the same
    // way a sequential retry would, rather than surfacing a raw SQL error.
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") return freezeVintage(input);
    throw err;
  }
}

export interface FrozenVintage {
  vintageId: string;
  runId: string;
  toolId: string;
  knowledgeTimeCutoff: string;
  marketTimeCutoff: string;
  methodologyVersionId: string;
  buildIdentity: string;
  manifest: VintageManifest;
  manifestDigest: string;
  memberCount: number;
  members: FrozenSourceValue[];
}

// Reload a previously-frozen vintage from the ledger ALONE — no network, no
// AnalyticsDataSource call (issue #977 AC7's offline replay). Recomputing
// buildVintageManifest over `members` here must reproduce `manifestDigest`
// bit-for-bit; that equality is the replay proof.
export async function loadFrozenVintage(vintageId: string, db: DbHandle = sql): Promise<FrozenVintage | null> {
  const [vintage] = await db`
    SELECT id, run_id, tool_id, knowledge_time_cutoff::text AS knowledge_time_cutoff,
           market_time_cutoff::text AS market_time_cutoff, methodology_version_id, build_identity,
           manifest, manifest_digest, member_count
    FROM analytics_data_vintages WHERE id = ${vintageId}::bigint`;
  if (!vintage) return null;
  const members = (await db`
    SELECT svv.id, svv.source_key, svv.market_date::text AS market_date,
           svv.market_instant::text AS market_instant, svv.value
    FROM analytics_vintage_members vm
    JOIN source_value_versions svv ON svv.id = vm.source_value_version_id
    WHERE vm.vintage_id = ${vintageId}::bigint`) as unknown as SourceValueRow[];
  return {
    vintageId: String(vintage.id),
    runId: String(vintage.run_id),
    toolId: vintage.tool_id,
    knowledgeTimeCutoff: vintage.knowledge_time_cutoff,
    marketTimeCutoff: vintage.market_time_cutoff,
    methodologyVersionId: String(vintage.methodology_version_id),
    buildIdentity: vintage.build_identity,
    manifest: vintage.manifest as VintageManifest,
    manifestDigest: vintage.manifest_digest,
    memberCount: vintage.member_count,
    members: members.map(toFrozen),
  };
}

// Read-back by (run_id, tool_id) — the natural key the API's idempotent
// freeze route (issue #977 AC8) resolves a retry/conflict against.
export async function findVintageByRunAndTool(
  runId: string,
  toolId: string,
  db: DbHandle = sql,
): Promise<{ vintageId: string; manifestDigest: string } | null> {
  const [row] = await db`
    SELECT id, manifest_digest FROM analytics_data_vintages
    WHERE run_id = ${runId}::bigint AND tool_id = ${toolId}`;
  return row ? { vintageId: String(row.id), manifestDigest: row.manifest_digest } : null;
}
