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

    for (const value of evidence.values) {
      // One transaction-level advisory lock per observation serializes competing
      // revisions without locking unrelated series or dates.
      const marketKey = value.marketDate ?? value.marketInstant!;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${value.sourceKey}\u001f${marketKey}`}, 0))`;
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

    return { acquisitionId: evidence.id, replayed: false };
  });
}
