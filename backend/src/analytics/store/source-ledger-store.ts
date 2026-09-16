import { sql, jsonValue } from "../../db/client.ts";
import type { SourceAcquisitionEvidence } from "../source-ledger.ts";

export async function saveSourceAcquisition(
  evidence: SourceAcquisitionEvidence,
): Promise<{ acquisitionId: string; replayed: boolean }> {
  return sql.begin(async (tx) => {
    // The producer-generated acquisition UUID is the idempotency key. A replay
    // is a read-only success; a partially persisted acquisition is impossible
    // because every first submission is one transaction.
    const existing = await tx`SELECT id FROM source_acquisitions WHERE id = ${evidence.id}::uuid`;
    if (existing.length > 0) return { acquisitionId: evidence.id, replayed: true };

    await tx`
      INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, requested_by_run_id)
      VALUES (${evidence.id}::uuid, ${evidence.provider}, ${evidence.parserVersion},
              ${evidence.cacheIdentity}, ${evidence.requestedByRunId ?? null})`;

    for (let i = 0; i < evidence.events.length; i++) {
      const event = evidence.events[i]!;
      await tx`
        INSERT INTO source_acquisition_events (acquisition_id, sequence, event_type, detail)
        VALUES (${evidence.id}::uuid, ${i + 1}, ${event.type}, ${event.detail ?? null})`;
    }

    for (const fetch of evidence.fetches) {
      if (fetch.payloadBase64 !== null && fetch.responseChecksum !== null) {
        const bytes = Buffer.from(fetch.payloadBase64, "base64");
        await tx`
          INSERT INTO source_payloads (checksum, payload_bytes)
          VALUES (${fetch.responseChecksum}, ${bytes})
          ON CONFLICT (checksum) DO NOTHING`;
      }
      await tx`
        INSERT INTO source_fetches
          (id, acquisition_id, sequence, request_identity, cache_status,
           response_status, response_checksum, provider_release_id, error_detail)
        VALUES
          (${fetch.id}::uuid, ${evidence.id}::uuid, ${fetch.sequence},
           ${tx.json(jsonValue(fetch.requestIdentity))}, ${fetch.cacheStatus},
           ${fetch.responseStatus ?? null}, ${fetch.responseChecksum ?? null},
           ${fetch.providerReleaseId ?? null}, ${fetch.errorDetail ?? null})`;
    }

    // One transaction-level advisory lock per source key serializes competing
    // revisions of the same series without over-serializing unrelated series.
    // Every value in an acquisition belongs to one sourceKey, so this bounds the
    // lock count per transaction to the distinct keys present (never one lock per
    // row — a full FRED/Yahoo daily series would otherwise exhaust Postgres's
    // max_locks_per_transaction and fail with SQLSTATE 53200 "out of shared memory").
    const sourceKeys = Array.from(new Set(evidence.values.map((v) => v.sourceKey)));
    for (const sourceKey of sourceKeys) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sourceKey}, 0))`;
    }

    // Coordinates duplicated in one acquisition need sequential handling so
    // later values link to earlier values from that same transaction.
    const coordKey = (v: { sourceKey: string; marketDate: string | null; marketInstant: string | null }) =>
      `${v.sourceKey}\u0001${v.marketDate ?? ""}\u0001${v.marketInstant ?? ""}`;
    const hasWithinBatchDuplicate = new Set(evidence.values.map(coordKey)).size !== evidence.values.length;

    if (hasWithinBatchDuplicate) {
      for (const value of evidence.values) {
        const [prior] = await tx`
          SELECT id, value
          FROM source_value_versions
          WHERE source_key = ${value.sourceKey}
            AND market_date IS NOT DISTINCT FROM ${value.marketDate}::date
            AND market_instant IS NOT DISTINCT FROM ${value.marketInstant}::timestamptz
          ORDER BY knowledge_time DESC, id DESC
          LIMIT 1`;
        const revisionKind = prior === undefined
          ? "initial"
          : Number(prior.value) === value.value ? "unchanged" : "revision";
        await tx`
          INSERT INTO source_value_versions
            (acquisition_id, source_key, market_date, market_instant, value,
             prior_version_id, revision_kind)
          VALUES
            (${evidence.id}::uuid, ${value.sourceKey}, ${value.marketDate ?? null}::date,
             ${value.marketInstant ?? null}::timestamptz, ${value.value}, ${prior?.id ?? null},
             ${revisionKind})`;
      }
    } else if (evidence.values.length > 0) {
      const sourceKeyArr = evidence.values.map((v) => v.sourceKey);
      const marketDateArr = evidence.values.map((v) => v.marketDate ?? null);
      const marketInstantArr = evidence.values.map((v) => v.marketInstant ?? null);
      const priorRows = await tx`
        SELECT k.idx, svv.id, svv.value
        FROM unnest(${sourceKeyArr}::text[], ${marketDateArr}::date[], ${marketInstantArr}::timestamptz[])
          WITH ORDINALITY AS k(source_key, market_date, market_instant, idx)
        LEFT JOIN LATERAL (
          SELECT id, value
          FROM source_value_versions v
          WHERE v.source_key = k.source_key
            AND v.market_date IS NOT DISTINCT FROM k.market_date
            AND v.market_instant IS NOT DISTINCT FROM k.market_instant
          ORDER BY v.knowledge_time DESC, v.id DESC
          LIMIT 1
        ) svv ON true`;
      const priorByIdx = new Map(priorRows.map((r) => [Number(r.idx), r.id === null ? undefined : { id: r.id, value: r.value }]));
      const rows = evidence.values.map((value, i) => {
        const prior = priorByIdx.get(i + 1);
        const revisionKind = prior === undefined
          ? "initial"
          : Number(prior.value) === value.value ? "unchanged" : "revision";
        return {
          acquisition_id: evidence.id,
          source_key: value.sourceKey,
          market_date: value.marketDate ?? null,
          market_instant: value.marketInstant ?? null,
          value: value.value,
          prior_version_id: prior?.id ?? null,
          revision_kind: revisionKind,
        };
      });
      const VALUE_INSERT_BATCH_SIZE = 5_000;
      for (let start = 0; start < rows.length; start += VALUE_INSERT_BATCH_SIZE) {
        await tx`
          INSERT INTO source_value_versions ${tx(rows.slice(start, start + VALUE_INSERT_BATCH_SIZE), "acquisition_id", "source_key", "market_date", "market_instant", "value", "prior_version_id", "revision_kind")}`;
      }
    }

    return { acquisitionId: evidence.id, replayed: false };
  });
}
