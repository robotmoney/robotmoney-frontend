import type { TransactionSql } from "postgres";
import { sql, jsonValue } from "../../db/client.ts";
import { on, onStatement, registerQuery, registerStatement } from "../../db/registry.ts";
import type { CommittedSourceValue, SaveSourceAcquisitionResult, SourceAcquisitionEvidence, SourceValueEvidence } from "../source-ledger.ts";
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
// decision D56) of the head leaves the head as it is.
//
// A LABEL CHANGE ALONE IS NOT A CHANGE (owner, 2026-09-29). The live fetch
// stamps 'live' and the producer's gap catch-up stamps 'seed' on the SAME
// points, so recording a relabel wrote a row per point every time the two took
// turns: ~1.4M production rows, about 13 per point, none of them information.
// The head keeps the label it was written with until its VALUE changes.
// store/raw-history-store.ts applies the same rule to `source`, so the two
// still move together and cutover/parity.ts still matches.
type RevisionKind = "initial" | "revision";

function classify(
  prior: { value: number; provenance: string | null } | undefined,
  value: SourceValueEvidence,
): RevisionKind | null {
  if (prior === undefined) return "initial";
  return withinTolerance(value.sourceKey, prior.value, value.value) ? null : "revision";
}

/** The only entry module that reaches this store: the analytics ingestion route. */
const ANALYTICS_ROUTE = "src/api/routes/analytics";

const findAcquisition = registerQuery({
  role: "rm_app",
  object: "source_acquisitions",
  privileges: ["SELECT"],
  site: "src/analytics/store/source-ledger-store:saveSourceAcquisition.findAcquisition",
  purpose: "Detect a replayed acquisition submission by its producer-generated id.",
  callers: [ANALYTICS_ROUTE],
  probe: { statement: "SELECT id FROM source_acquisitions WHERE id = $1::uuid", params: ["00000000-0000-0000-0000-000000000000"] },
});

const insertAcquisition = registerQuery({
  role: "rm_app",
  object: "source_acquisitions",
  privileges: ["INSERT"],
  site: "src/analytics/store/source-ledger-store:saveSourceAcquisition.insertAcquisition",
  purpose: "Persist the header of one source acquisition, immutable from then on.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, requested_by_run_id)
      SELECT $1::uuid, $2, $3, $4, $5 WHERE false`,
    params: ["00000000-0000-0000-0000-000000000000", "probe", "probe", "probe", null],
  },
});

const insertAcquisitionEvents = registerQuery({
  role: "rm_app",
  object: "source_acquisition_events",
  privileges: ["INSERT"],
  site: "src/analytics/store/source-ledger-store:saveSourceAcquisition.insertEvents",
  purpose: "Persist an acquisition's ordered events in one statement.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `INSERT INTO source_acquisition_events (acquisition_id, sequence, event_type, detail)
        SELECT $1::uuid, $2::integer, $3, $4 WHERE false`,
    params: ["00000000-0000-0000-0000-000000000000", 1, "probe", null],
  },
});

const insertFetches = registerQuery({
  role: "rm_app",
  object: "source_fetches",
  privileges: ["INSERT"],
  site: "src/analytics/store/source-ledger-store:saveSourceAcquisition.insertFetches",
  purpose: "Persist an acquisition's fetch records, batched.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `INSERT INTO source_fetches (id, acquisition_id, sequence, request_identity, cache_status, response_status, response_checksum, provider_release_id, error_detail)
          SELECT $1::uuid, $2::uuid, $3::integer, $4::jsonb, $5, $6::integer, $7, $8, $9 WHERE false`,
    params: ["00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000", 1, "{}", "probe", null, null, null, null],
  },
});

const sourceKeyLock = registerStatement({
  role: "rm_app",
  shape: "sourceKeyLock",
  site: "src/analytics/store/source-ledger-store:saveSourceAcquisition.sourceKeyLock",
  purpose: "Serialize competing revisions of one source key without over-serializing unrelated series.",
  callers: [ANALYTICS_ROUTE],
});

const insertValues = registerQuery({
  role: "rm_app",
  object: "source_value_versions",
  // SELECT for RETURNING: the new rows' ids are the committed heads (issue 1514).
  privileges: ["INSERT", "SELECT"],
  site: "src/analytics/store/source-ledger-store:saveSourceAcquisition.insertValues",
  purpose: "Append source value revisions, one row or a batch, never updating a prior one; return each new row's id.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `INSERT INTO source_value_versions (acquisition_id, source_key, market_date, market_instant, value, prior_version_id, revision_kind, provenance)
          SELECT $1::uuid, $2, $3::date, $4::timestamptz, $5::float8, $6::bigint, $7, $8 WHERE false
          RETURNING id, source_key, value`,
    params: ["00000000-0000-0000-0000-000000000000", "probe", null, null, 1, null, "initial", null],
  },
});

const priorDated = registerQuery({
  role: "rm_app",
  object: "source_value_versions",
  privileges: ["SELECT"],
  site: "src/analytics/store/source-ledger-store:saveSourceAcquisition.priorDated",
  purpose: "Resolve every dated value's prior revision in one round trip.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `SELECT k.idx, svv.id, svv.value, svv.provenance
          FROM unnest($1::text[], $2::date[], $3::int[])
            AS k(source_key, market_date, idx)
          LEFT JOIN LATERAL (
            SELECT id, value, provenance
            FROM source_value_versions v
            WHERE v.source_key = k.source_key
              AND v.market_date = k.market_date
              AND v.market_instant IS NULL
            ORDER BY v.knowledge_time DESC, v.id DESC
            LIMIT 1
          ) svv ON true`,
    params: ["{}", "{}", "{}"],
  },
});

type PriorRevision = { id: number; value: number; provenance: string | null };

/**
 * Each entry's prior revision, keyed by its `idx`: `undefined` when the
 * coordinate has none. Dated and timestamped values are read by the two
 * indexable lateral lookups (priorDated, priorInstants), one round trip each.
 */
async function resolvePriors(
  tx: TransactionSql<{}>,
  entries: readonly { idx: number; v: SourceAcquisitionEvidence["values"][number] }[],
): Promise<Map<number, PriorRevision | undefined>> {
  const priorByIdx = new Map<number, PriorRevision | undefined>();
  const dated = entries.filter((e) => e.v.marketDate !== null && e.v.marketDate !== undefined);
  const instants = entries.filter((e) => e.v.marketDate === null || e.v.marketDate === undefined);
  const record = (rows: readonly Record<string, unknown>[]) => {
    for (const r of rows) {
      priorByIdx.set(Number(r.idx), r.id === null ? undefined : { id: Number(r.id), value: Number(r.value), provenance: (r.provenance as string | null) ?? null });
    }
  };

  if (dated.length > 0) {
    record(await on(tx, priorDated)`
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
      ) svv ON true`);
  }
  if (instants.length > 0) {
    record(await on(tx, priorInstants)`
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
      ) svv ON true`);
  }
  return priorByIdx;
}

const priorInstants = registerQuery({
  role: "rm_app",
  object: "source_value_versions",
  privileges: ["SELECT"],
  site: "src/analytics/store/source-ledger-store:saveSourceAcquisition.priorInstants",
  purpose: "Resolve every timestamped value's prior revision in one round trip.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `SELECT k.idx, svv.id, svv.value, svv.provenance
          FROM unnest($1::text[], $2::timestamptz[], $3::int[])
            AS k(source_key, market_instant, idx)
          LEFT JOIN LATERAL (
            SELECT id, value, provenance
            FROM source_value_versions v
            WHERE v.source_key = k.source_key
              AND v.market_instant = k.market_instant
              AND v.market_date IS NULL
            ORDER BY v.knowledge_time DESC, v.id DESC
            LIMIT 1
          ) svv ON true`,
    params: ["{}", "{}", "{}"],
  },
});

// Issue 1421 (review finding AN-15): the ledger head of every submitted value,
// so the caller computes from what the ledger holds rather than from what the
// provider just served. A value within tolerance of its head wrote no row, so
// its head is the stored version.
//
// A first submission no longer reads the heads back (issue 1514): the head of a
// value is the row it just wrote, or the prior it already read and kept. That
// second lookup was one more lateral read per value while the transaction held
// its batch connection and its source-key lock. Only a replay, which read no
// prior, looks the heads up here. One indexed round trip per representation
// (resolvePriors).
async function committedHeads(
  tx: TransactionSql<{}>,
  values: SourceAcquisitionEvidence["values"],
): Promise<CommittedSourceValue[]> {
  if (values.length === 0) return [];
  const heads = await resolvePriors(tx, values.map((v, i) => ({ idx: i + 1, v })));
  return values.map((v, i) => {
    const head = heads.get(i + 1);
    if (!head) throw new Error(`${v.sourceKey} ${v.marketDate ?? v.marketInstant}: no ledger head after the acquisition was saved`);
    return { versionId: String(head.id), value: head.value };
  });
}

type InsertedHead = { id: number | string; source_key: string; value: number | string };

/**
 * The committed head of each written row, in the order the rows were sent.
 * postgres.js sends a batch as one multi-row VALUES list, and Postgres returns
 * the RETURNING rows of such an INSERT in that order. The source key and value
 * of each returned row are checked against the row sent, so a reordering would
 * fail the acquisition rather than pair a value with another value's version.
 */
function insertedHeads(sent: readonly { source_key: string; value: number }[], returned: readonly InsertedHead[]): CommittedSourceValue[] {
  if (returned.length !== sent.length) throw new Error(`source value insert returned ${returned.length} rows for ${sent.length} sent`);
  return sent.map((row, i) => {
    const r = returned[i]!;
    if (r.source_key !== row.source_key || Number(r.value) !== row.value) {
      throw new Error(`source value insert returned ${r.source_key}=${r.value} where ${row.source_key}=${row.value} was sent`);
    }
    return { versionId: String(r.id), value: Number(r.value) };
  });
}

function headOrThrow(head: CommittedSourceValue | undefined, v: SourceValueEvidence): CommittedSourceValue {
  if (!head) throw new Error(`${v.sourceKey} ${v.marketDate ?? v.marketInstant}: no ledger head after the acquisition was saved`);
  return head;
}

/**
 * Persist one acquisition in one transaction. `db` is the pool it runs on: the
 * caller's (`sql`) in every production path; a test passes a wrapper to count
 * the statements the transaction issues (issue 1514).
 */
// `db` may be a transaction the caller already holds (TransactionSql), so a
// write to another table and its ledger rows commit together (the floor seed,
// AN-16); otherwise the acquisition is one transaction of its own.
export async function saveSourceAcquisition(
  evidence: SourceAcquisitionEvidence,
  db: Pick<typeof sql, "begin"> | TransactionSql<{}> = sql,
): Promise<SaveSourceAcquisitionResult> {
  const write = async (tx: TransactionSql<{}>): Promise<SaveSourceAcquisitionResult> => {
    // The producer-generated acquisition UUID is the idempotency key. A replay
    // is a read-only success; a partially persisted acquisition is impossible
    // because every first submission is one transaction.
    const existing = await on(tx, findAcquisition)`SELECT id FROM source_acquisitions WHERE id = ${evidence.id}::uuid`;
    if (existing.length > 0) return { acquisitionId: evidence.id, replayed: true, committed: await committedHeads(tx, evidence.values) };

    await on(tx, insertAcquisition)`
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
      await on(tx, insertAcquisitionEvents)`
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
        await on(tx, insertFetches)`
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
      await onStatement(tx, sourceKeyLock)`SELECT pg_advisory_xact_lock(hashtextextended(${sourceKey}, 0))`;
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
    let committed: CommittedSourceValue[] = [];

    if (hasWithinBatchDuplicate) {
      // Rare (a single fetch response naming the same coordinate twice):
      // fall back to the original one-round-trip-per-value loop, which
      // correctly chains prior_version_id across values within this same
      // transaction. The bulk path below assumes distinct coordinates, so it
      // cannot be used here.
      //
      // Each value's prior is read through the same indexable lookups as the
      // bulk path below, one value at a time, never an `IS NOT DISTINCT FROM`
      // (see the note there, issue 1034).
      //
      // A coordinate's head is the last row written for it or, when nothing
      // was written, the prior read for it; the loop sees them in order, so
      // the last one it records is the head the transaction commits.
      const headByCoord = new Map<string, CommittedSourceValue>();
      for (const value of evidence.values) {
        const prior = (await resolvePriors(tx, [{ idx: 1, v: value }])).get(1);
        const revisionKind = classify(prior, value);
        if (revisionKind === null) {
          if (prior) headByCoord.set(coordKey(value), { versionId: String(prior.id), value: prior.value });
          continue;
        }
        const row = { source_key: value.sourceKey, value: value.value };
        const returned = await on(tx, insertValues)<InsertedHead>`
          INSERT INTO source_value_versions
            (acquisition_id, source_key, market_date, market_instant, value,
             prior_version_id, revision_kind, provenance)
          VALUES
            (${evidence.id}::uuid, ${value.sourceKey}, ${value.marketDate ?? null}::date,
             ${value.marketInstant ?? null}::timestamptz, ${value.value}, ${prior?.id ?? null},
             ${revisionKind}, ${value.provenance ?? null})
          RETURNING id, source_key, value`;
        headByCoord.set(coordKey(value), insertedHeads([row], returned)[0]!);
      }
      committed = evidence.values.map((v) => headOrThrow(headByCoord.get(coordKey(v)), v));
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
      const priorByIdx = await resolvePriors(
        tx,
        evidence.values.map((v, i) => ({ idx: i + 1, v })),
      );

      // Each value's committed head: the prior it keeps, or the row it writes
      // (filled in from the insert's RETURNING below).
      const heads: (CommittedSourceValue | undefined)[] = [];
      const writtenAt: number[] = [];
      const rows = evidence.values.flatMap((value, i) => {
        const prior = priorByIdx.get(i + 1); // WITH ORDINALITY is 1-based
        const revisionKind = classify(prior, value);
        heads.push(prior ? { versionId: String(prior.id), value: prior.value } : undefined);
        if (revisionKind === null) return [];
        writtenAt.push(i);
        return [{
          acquisition_id: evidence.id,
          source_key: value.sourceKey,
          market_date: value.marketDate ?? null,
          market_instant: value.marketInstant ?? null,
          value: value.value,
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
        const batch = rows.slice(start, start + VALUE_INSERT_BATCH_SIZE);
        const returned = await on(tx, insertValues)<InsertedHead>`
          INSERT INTO source_value_versions ${tx(batch, "acquisition_id", "source_key", "market_date", "market_instant", "value", "prior_version_id", "revision_kind", "provenance")}
          RETURNING id, source_key, value`;
        insertedHeads(batch, returned).forEach((head, j) => { heads[writtenAt[start + j]!] = head; });
      }
      committed = evidence.values.map((v, i) => headOrThrow(heads[i], v));
    }

    return { acquisitionId: evidence.id, replayed: false, committed };
  };
  return "savepoint" in db ? write(db) : db.begin(write);
}
