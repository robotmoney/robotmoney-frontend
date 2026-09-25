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

// The run header's own recorded `asof` (issue #978 FIX3): the cross-check a
// terminal run package submission uses to catch a caller binding a report
// snapshot to the wrong market date. Returns null only if runId names no
// real run — submitTerminalRunPackage's own FK insert is what actually
// refuses that case.
export async function loadRunAsof(runId: string, db: DbHandle = sql): Promise<string | null> {
  const [row] = await db`SELECT asof::text AS asof FROM analytics_ledger_runs WHERE id = ${runId}::bigint`;
  return row ? (row.asof as string) : null;
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
// both the manifest and its membership (as runs of consecutive ids — see
// memberRanges) atomically. Idempotent on
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
      // One row per RUN of consecutive version ids, not one per member (issue
      // #1035): see memberRanges below. Still batched, never one round trip per
      // row: `sql.begin` holds one of the api's 10 pooled connections for the
      // whole transaction. postgres.js binds one parameter per cell, so keep
      // each statement well below PostgreSQL's 65,535-parameter limit (4
      // columns per row).
      const MEMBER_INSERT_BATCH_SIZE = 10_000;
      const memberRows = memberRanges(members).map((range) => ({
        vintage_id: vintageId,
        source_value_version_id: range.firstVersionId,
        last_source_value_version_id: range.lastVersionId,
        source_key: range.sourceKey,
      }));
      for (let start = 0; start < memberRows.length; start += MEMBER_INSERT_BATCH_SIZE) {
        await tx`
          INSERT INTO analytics_vintage_members ${tx(memberRows.slice(start, start + MEMBER_INSERT_BATCH_SIZE), "vintage_id", "source_value_version_id", "last_source_value_version_id", "source_key")}`;
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

// Issue #1035: a vintage's membership, stored as runs of CONSECUTIVE
// source_value_versions ids that share one source_key, instead of one row per
// member.
//
// WHY. Every vintage selects the ledger head of every series — ~172k members in
// production — and the old one-row-per-member copy wrote all of them again on
// every freeze: 3.3M analytics_vintage_members rows a day, 1.7 GB in four days.
// But one acquisition inserts a series' points in one statement, so their ids
// are consecutive, and a vintage's members are overwhelmingly long unbroken
// runs of them. A run [first, last] is exact: it contains EVERY id from first
// to last, and each of those ids is a member. Only strictly consecutive
// integers are merged — a gap in the id sequence (an aborted insert, or an
// insert still in flight when the vintage froze) always ends a run, so no id
// that was not a member at freeze time can ever fall inside one.
//
// The resolved membership is therefore the IDENTICAL set of versionIds, and
// buildVintageManifest over it reproduces manifest_digest bit for bit — which
// is what loadFrozenVintage's replay proof, and every vintage frozen before
// this change (one row each, last_source_value_version_id NULL), depend on.
export interface MemberRange {
  firstVersionId: string;
  /** NULL for a single-member row — the shape every pre-#1035 row has. */
  lastVersionId: string | null;
  sourceKey: string;
}

export function memberRanges(members: readonly FrozenSourceValue[]): MemberRange[] {
  const sorted = [...members]
    .map((m) => ({ id: BigInt(m.versionId), sourceKey: m.sourceKey }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ranges: { first: bigint; last: bigint; sourceKey: string }[] = [];
  for (const m of sorted) {
    const open = ranges[ranges.length - 1];
    if (open && open.sourceKey === m.sourceKey && m.id === open.last + 1n) open.last = m.id;
    else ranges.push({ first: m.id, last: m.id, sourceKey: m.sourceKey });
  }
  return ranges.map((r) => ({
    firstVersionId: r.first.toString(),
    lastVersionId: r.last === r.first ? null : r.last.toString(),
    sourceKey: r.sourceKey,
  }));
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

// A vintage's members, resolved from its stored runs (memberRanges above); a
// single-id row is the one-id run [first, first]. Runs are expanded with
// generate_series and joined on the id ALONE: a source_key term (or a
// `BETWEEN` range) in the join lets the planner scan every version of the
// run's key per member instead of probing the primary key, and the LIMIT 1
// LATERAL keeps the probe from being flattened into a per-member hash join
// (see migration 0080's fingerprint for the same shape). The source_key match
// is checked on the result as a guard: a run can only be written over one key,
// so a row it drops would be a corrupted run — and the callers' count checks
// then refuse a membership that no longer matches what was frozen.
export async function resolveVintageMembers(vintageId: string, db: DbHandle = sql): Promise<FrozenSourceValue[]> {
  const resolved = (await db`
    SELECT svv.id, svv.source_key, svv.market_date::text AS market_date,
           svv.market_instant::text AS market_instant, svv.value, vm.source_key AS run_key
    FROM analytics_vintage_members vm
    CROSS JOIN LATERAL generate_series(
      vm.source_value_version_id,
      COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) AS g(id)
    CROSS JOIN LATERAL (
      SELECT v.id, v.source_key, v.market_date, v.market_instant, v.value
      FROM source_value_versions v WHERE v.id = g.id LIMIT 1
    ) svv
    WHERE vm.vintage_id = ${vintageId}::bigint`) as unknown as (SourceValueRow & { run_key: string })[];
  return resolved.filter((r) => r.source_key === r.run_key).map(toFrozen);
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
  const members = await resolveVintageMembers(vintageId, db);
  if (members.length !== Number(vintage.member_count)) {
    throw new Error(
      `vintage ${vintageId} resolves to ${members.length} members but was frozen with ${vintage.member_count} — ` +
        "its membership can no longer reproduce its manifest digest",
    );
  }
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
    members,
  };
}

// Issue #1050: recompute every stored vintage's manifest, series fingerprints,
// member_count and manifest_digest from the members it resolves to NOW.
//
// WHY. Migration 0080 re-points every vintage to the source_value_versions rows
// the fixed ledger writer would have written (decision D56, amendment for
// #1050), so the digests frozen over the old writer's rows no longer describe
// their members. The owner's rule is that the database ends as if the old
// writer had never run — so each vintage gets exactly the manifest freezeVintage
// would have stored for these members, and the old digest is overwritten, not
// kept anywhere.
//
// Runs ONLY from the migration runner, inside the transaction that applied
// 0080 (IN_TRANSACTION_AFTER_MIGRATION in src/db/migrate.ts), as rm_owner. A
// canonical-JSON SHA-256 in plpgsql would have to reproduce JavaScript's number
// formatting byte for byte; this reuses buildVintageManifest instead, the one
// function every freeze and every replay already uses. analytics_data_vintages
// is immutable, so its guard is disarmed for these UPDATEs and re-armed (ENABLE
// ALWAYS) before returning; an error rolls the whole migration back with it.
export async function rebuildVintageManifests(db: DbHandle): Promise<{ vintages: number; rewritten: number }> {
  const vintages = (await db`
    SELECT id::text AS id, knowledge_time_cutoff::text AS knowledge_time_cutoff,
           market_time_cutoff::text AS market_time_cutoff, methodology_version_id::text AS methodology_version_id,
           build_identity, manifest_digest, member_count
    FROM analytics_data_vintages ORDER BY id`) as unknown as {
    id: string;
    knowledge_time_cutoff: string;
    market_time_cutoff: string;
    methodology_version_id: string;
    build_identity: string;
    manifest_digest: string;
    member_count: number;
  }[];
  if (vintages.length === 0) return { vintages: 0, rewritten: 0 };
  await db.unsafe("ALTER TABLE analytics_data_vintages DISABLE TRIGGER analytics_data_vintages_immutable");
  await db.unsafe("ALTER TABLE analytics_data_vintages DISABLE TRIGGER analytics_data_vintages_immutable_row");
  let rewritten = 0;
  for (const v of vintages) {
    const members = await resolveVintageMembers(v.id, db);
    const { manifest } = buildVintageManifest(
      members, v.methodology_version_id, v.build_identity, v.knowledge_time_cutoff, v.market_time_cutoff,
    );
    if (manifest.manifestDigest === v.manifest_digest && members.length === Number(v.member_count)) continue;
    await db`
      UPDATE analytics_data_vintages
      SET manifest = ${db.json(jsonValue(manifest))}, manifest_digest = ${manifest.manifestDigest},
          member_count = ${members.length}
      WHERE id = ${v.id}::bigint`;
    rewritten++;
  }
  await db.unsafe("ALTER TABLE analytics_data_vintages ENABLE ALWAYS TRIGGER analytics_data_vintages_immutable");
  await db.unsafe("ALTER TABLE analytics_data_vintages ENABLE ALWAYS TRIGGER analytics_data_vintages_immutable_row");
  return { vintages: vintages.length, rewritten };
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
