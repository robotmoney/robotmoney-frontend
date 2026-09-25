import { sql, jsonValue } from "../../db/client.ts";
import type { SourceAcquisitionEvidence, SourceValueEvidence } from "../source-ledger.ts";
import { withinTolerance } from "../source-tolerance.ts";

// Issue #1035: what one re-observation adds to the ledger, given the head it is
// compared against. `null` means NOTHING — no row at all.
//
// WHY A RE-OBSERVATION WRITES NO ROW. Every fetch re-reads a series' whole
// history, and this writer used to append a row per point per fetch: 'unchanged'
// when the value matched exactly, 'revision' when it differed by float32 noise.
// That was two thirds of the production ledger within four days of cutover, and
// none of it was information — the acquisition itself (source_acquisitions,
// source_fetches with each response's checksum) already proves the fetch
// happened and fingerprints what it returned. So a value within its source's tolerance (source-tolerance.ts,
// decision D56) of the head, carrying the same provenance label, leaves the head
// as it is.
//
// A label change on a value within tolerance is still recorded, as 'unchanged',
// carrying the HEAD's value and the new label: raw_indicator_history rewrites
// only its `source` in that case (store/raw-history-store.ts applies the same
// rule), and the two must move together or cutover/parity.ts reports a
// mismatch. The value of record changes only when a change exceeds tolerance;
// the fetch itself stays on the record in source_fetches either way.
type RevisionKind = "initial" | "unchanged" | "revision";

function classify(
  prior: { value: number; provenance: string | null } | undefined,
  value: SourceValueEvidence,
): RevisionKind | null {
  if (prior === undefined) return "initial";
  const same = withinTolerance(value.sourceKey, prior.value, value.value);
  if (same && prior.provenance === (value.provenance ?? null)) return null;
  return same ? "unchanged" : "revision";
}

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

    // WHY EVERY LOOP BELOW IS ONE STATEMENT, NOT ONE PER ROW
    // An EDGAR sweep is hundreds of requests, so a per-row INSERT meant
    // hundreds of sequential round trips inside this single transaction. The
    // api serves that submission on the same event loop it serves the site
    // from, so the whole stack stalled behind one acquisition: Bun.serve cut
    // the request at its 10s idle timeout and the site answered 502. The value
    // path below was already batched for this reason; these are the rest.
    if (evidence.events.length > 0) {
      const events = evidence.events.map((event, i) => ({
        acquisition_id: evidence.id,
        sequence: i + 1,
        event_type: event.type,
        detail: event.detail ?? null,
      }));
      await tx`
        INSERT INTO source_acquisition_events ${tx(events, "acquisition_id", "sequence", "event_type", "detail")}`;
    }

    // No response bodies are stored (issue #1035, decision D56): each
    // fetch keeps its response_checksum as a fingerprint of what came back.
    if (evidence.fetches.length > 0) {
      const fetches = evidence.fetches.map((fetch) => ({
        id: fetch.id,
        acquisition_id: evidence.id,
        sequence: fetch.sequence,
        request_identity: tx.json(jsonValue(fetch.requestIdentity)),
        cache_status: fetch.cacheStatus,
        response_status: fetch.responseStatus ?? null,
        response_checksum: fetch.responseChecksum ?? null,
        provider_release_id: fetch.providerReleaseId ?? null,
        error_detail: fetch.errorDetail ?? null,
      }));
      // Nine parameters a row against PostgreSQL's 65,535-parameter ceiling.
      const FETCH_INSERT_BATCH_SIZE = 2_000;
      for (let start = 0; start < fetches.length; start += FETCH_INSERT_BATCH_SIZE) {
        await tx`
          INSERT INTO source_fetches ${tx(fetches.slice(start, start + FETCH_INSERT_BATCH_SIZE), "id", "acquisition_id", "sequence", "request_identity", "cache_status", "response_status", "response_checksum", "provider_release_id", "error_detail")}`;
      }
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

    // Coordinate key used both to look up a value's own prior revision and to
    // detect within-batch duplicates (see below). '' stands in for NULL so two
    // distinct-but-absent fields don't collide with a present empty string
    // (market_date/market_instant are non-empty when present, so this is safe).
    // '|' is the separator, deliberately a PRINTABLE character: a literal NUL
    // here made this file diff as binary in git, so it could never be reviewed
    // in a pull request. It cannot collide — market_date is YYYY-MM-DD and
    // market_instant an ISO timestamp, neither of which contains '|'.
    const coordKey = (v: { sourceKey: string; marketDate: string | null; marketInstant: string | null }) =>
      `${v.sourceKey}|${v.marketDate ?? ""}|${v.marketInstant ?? ""}`;

    const hasWithinBatchDuplicate = new Set(evidence.values.map(coordKey)).size !== evidence.values.length;

    if (hasWithinBatchDuplicate) {
      // Rare (a single fetch response naming the same coordinate twice):
      // fall back to the original one-round-trip-per-value loop, which
      // correctly chains prior_version_id across values within this same
      // transaction. The bulk path below assumes distinct coordinates, so it
      // cannot be used here.
      for (const value of evidence.values) {
        const [prior] = await tx`
          SELECT id, value, provenance
          FROM source_value_versions
          WHERE source_key = ${value.sourceKey}
            AND market_date IS NOT DISTINCT FROM ${value.marketDate}::date
            AND market_instant IS NOT DISTINCT FROM ${value.marketInstant}::timestamptz
          ORDER BY knowledge_time DESC, id DESC
          LIMIT 1`;
        const revisionKind = classify(
          prior === undefined ? undefined : { value: Number(prior.value), provenance: prior.provenance ?? null },
          value,
        );
        if (revisionKind === null) continue;
        await tx`
          INSERT INTO source_value_versions
            (acquisition_id, source_key, market_date, market_instant, value,
             prior_version_id, revision_kind, provenance)
          VALUES
            (${evidence.id}::uuid, ${value.sourceKey}, ${value.marketDate ?? null}::date,
             ${value.marketInstant ?? null}::timestamptz, ${revisionKind === "unchanged" ? Number(prior!.value) : value.value}, ${prior?.id ?? null},
             ${revisionKind}, ${value.provenance ?? null})`;
      }
    } else if (evidence.values.length > 0) {
      // Common case (a full historical fetch can carry thousands of distinct
      // dates for one source_key): resolve every value's prior revision in ONE
      // round trip via a LATERAL join instead of one SELECT+INSERT pair per
      // value — the original per-value loop held this transaction (and its
      // advisory locks) open for one round trip per row, which is what made a
      // full backfill slow enough to starve the rest of the stack.
      // WHY THIS IS TWO QUERIES AND NOT ONE `IS NOT DISTINCT FROM`
      // The obvious single query matches both market-time columns with
      // `IS NOT DISTINCT FROM`, which reads correctly and is a trap: btree has
      // no operator strategy for it, so only `source_key = ` survives as an
      // index condition. Every lateral iteration then scans and sorts EVERY
      // prior row sharing that source_key. That is invisible at fixture scale
      // and quadratic in production, where each re-acquisition of a series adds
      // another generation of rows under the same key — the shape that made one
      // acquisition hold its connection long enough to starve the api.
      // A row has exactly one representation (CHECK in migration 0057), so
      // splitting on it gives plain equality plus an IS NULL, both of which
      // `source_value_versions_lookup_idx` can search.
      const priorByIdx = new Map<number, { id: number; value: number; provenance: string | null } | undefined>();
      const dated: { idx: number; v: SourceAcquisitionEvidence["values"][number] }[] = [];
      const instants: { idx: number; v: SourceAcquisitionEvidence["values"][number] }[] = [];
      evidence.values.forEach((v, i) => {
        (v.marketDate !== null && v.marketDate !== undefined ? dated : instants).push({ idx: i + 1, v });
      });

      if (dated.length > 0) {
        const rows = await tx`
          SELECT k.idx, svv.id, svv.value, svv.provenance
          FROM unnest(${dated.map((d) => d.v.sourceKey)}::text[], ${dated.map((d) => d.v.marketDate)}::date[], ${dated.map((d) => d.idx)}::int[])
            AS k(source_key, market_date, idx)
          LEFT JOIN LATERAL (
            SELECT id, value, provenance
            FROM source_value_versions v
            WHERE v.source_key = k.source_key
              AND v.market_date = k.market_date
              AND v.market_instant IS NULL
            ORDER BY v.knowledge_time DESC, v.id DESC
            LIMIT 1
          ) svv ON true`;
        for (const r of rows) priorByIdx.set(Number(r.idx), r.id === null ? undefined : { id: Number(r.id), value: Number(r.value), provenance: r.provenance ?? null });
      }
      if (instants.length > 0) {
        const rows = await tx`
          SELECT k.idx, svv.id, svv.value, svv.provenance
          FROM unnest(${instants.map((d) => d.v.sourceKey)}::text[], ${instants.map((d) => d.v.marketInstant)}::timestamptz[], ${instants.map((d) => d.idx)}::int[])
            AS k(source_key, market_instant, idx)
          LEFT JOIN LATERAL (
            SELECT id, value, provenance
            FROM source_value_versions v
            WHERE v.source_key = k.source_key
              AND v.market_instant = k.market_instant
              AND v.market_date IS NULL
            ORDER BY v.knowledge_time DESC, v.id DESC
            LIMIT 1
          ) svv ON true`;
        for (const r of rows) priorByIdx.set(Number(r.idx), r.id === null ? undefined : { id: Number(r.id), value: Number(r.value), provenance: r.provenance ?? null });
      }

      const rows = evidence.values.flatMap((value, i) => {
        const prior = priorByIdx.get(i + 1); // WITH ORDINALITY is 1-based
        const revisionKind = classify(prior, value);
        if (revisionKind === null) return [];
        return [{
          acquisition_id: evidence.id,
          source_key: value.sourceKey,
          market_date: value.marketDate ?? null,
          market_instant: value.marketInstant ?? null,
          value: revisionKind === "unchanged" ? prior!.value : value.value,
          prior_version_id: prior?.id ?? null,
          revision_kind: revisionKind,
          provenance: value.provenance ?? null,
        }];
      });
      // postgres.js binds one parameter per cell in the array insert. Keep
      // each statement comfortably below PostgreSQL's 65,535-parameter limit:
      // a historical acquisition can contain more than 8,000 values.
      const VALUE_INSERT_BATCH_SIZE = 5_000;
      for (let start = 0; start < rows.length; start += VALUE_INSERT_BATCH_SIZE) {
        await tx`
          INSERT INTO source_value_versions ${tx(rows.slice(start, start + VALUE_INSERT_BATCH_SIZE), "acquisition_id", "source_key", "market_date", "market_instant", "value", "prior_version_id", "revision_kind", "provenance")}`;
      }
    }

    return { acquisitionId: evidence.id, replayed: false };
  });
}
