// Issue #979 AC1: dual-write parity checking. Compares each compatibility
// current-view table against its ledger-derived reconstruction on natural
// keys, canonical values, row counts and a content checksum, then records the
// result as an immutable analytics_parity_observations row, which is what the
// cutover gate (gate.ts) later reads.
//
// ONE SET-BASED STATEMENT PER DOMAIN (issue 1375). The comparison runs in
// Postgres. Each domain's statement returns one row: both row counts, a sha256
// over each side's ordered canonical rows, the mismatch count and at most
// MAX_MISMATCH_DETAIL mismatching keys. Nothing proportional to the data ever
// reaches this process. The code it replaces loaded both sides of every domain
// into the api: on the 2026-10-15 production dump one sweep took the api from
// 71 MiB to 5.9 GiB in 30 s on a 7.75 GiB host. That code is kept as the test
// oracle (tests/support/parity-oracle.ts), and
// tests/analytics-parity-sql-equivalence.test.ts holds these statements to its
// verdicts, counts and keys.
//
// One statement also reads both sides in ONE snapshot, so no domain can
// straddle a writer's transaction and record a spurious, and because the
// observation table is append-only permanent, matched:false.
//
// WHAT EACH DOMAIN COMPARES is unchanged:
//   - raw_indicator_history: every (indicator, date) against the head of its
//     source_value_versions chain; values match within the source's tolerance
//     (withinTolerance(), D56), else after rounding at 1e-9.
//   - regime_snapshots, research_signals: the settled as-of days only (see
//     SETTLED below); the ledger row is the newest artifact element for the
//     natural key, by run_id, which is what replaying every artifact in run
//     order ("last write wins") produces.
//   - swarm_briefs: sessions whose compatibility row was written at or after
//     migration 0059 (see BRIEF_LEDGER_MIGRATION), against each session's
//     newest revision.
//
// WHAT THE STATEMENTS READ INSTEAD OF PAYLOADS. Migration 0123 stores, when a
// ledger row is written, what the comparison needs from its payload:
// analytics_output_snapshots.natural_keys (a regime element's date; a research
// element's date, key and a jsonb hash of its payload) and
// swarm_brief_revisions.body_hash. So a sweep parses one regime artifact (the
// newest that carries the settled days) and no research payload or brief body
// on the ledger side. A research payload or brief body matches when the two
// jsonb hashes match (jsonb_hash_extended, consistent with jsonb `=`); a NULL
// hash, a payload Postgres could not read as jsonb, is a mismatch.
//
// SETTLED (issue #979 fix). A regime or research date is compared only once a
// terminal run package has been frozen for it (analytics_report_snapshots
// holds one row per run, keyed by the run's `asof`). Out-of-band compat rows
// (the v0 seed archive, a legacy subject) can land before their ledger
// counterpart, and a sweep in that window would record a spurious, permanent
// matched:false. An in-flight date is invisible on EITHER side until it
// settles; a settled divergence still blocks cutover.
import { sql, type DbHandle } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import { SOURCE_TOLERANCES } from "../source-tolerance.ts";
import type { ParityDomain } from "./parity-domains.ts";

export { ALL_PARITY_DOMAINS, isParityDomain, type ParityDomain } from "./parity-domains.ts";

// Registered queries (smoke-production-spec.md §7.1). The sweep runs only
// behind the analytics parity route (the worker triggers it over HTTP, one
// request per domain, never through this module), so every site names that
// one caller. A statement over several relations registers one declaration
// per relation, each carrying the same probe.
const PARITY_ROUTE = "src/api/routes/analytics";

/** The most mismatching natural keys one observation carries. */
export const MAX_MISMATCH_DETAIL = 20;

const RAW_PARITY_SQL = `WITH tolerance AS (
      SELECT key AS indicator, value::float8 AS relative FROM jsonb_each_text($1::jsonb)
    ),
    ledger AS (
      SELECT DISTINCT ON (svv.source_key COLLATE "C", svv.market_date)
             substr(svv.source_key, 23) AS indicator, svv.market_date AS date, svv.value
        FROM source_value_versions svv
       WHERE svv.source_key LIKE 'raw_indicator_history:%' AND svv.market_date IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM source_value_versions nxt WHERE nxt.prior_version_id = svv.id)
       ORDER BY svv.source_key COLLATE "C", svv.market_date, svv.knowledge_time DESC, svv.id DESC
    ),
    joined AS (
      SELECT coalesce(l.indicator, r.indicator) AS indicator, coalesce(l.date, r.date)::text AS date,
             l.indicator IS NOT NULL AS in_legacy, r.indicator IS NOT NULL AS in_ledger,
             floor(l.value * 1e9 + 0.5) / 1e9 AS legacy_value, floor(r.value * 1e9 + 0.5) / 1e9 AS ledger_value,
             (l.value = r.value
               OR abs(r.value - l.value) <= coalesce(t.relative, 0) * greatest(abs(r.value), abs(l.value))) AS within
        FROM raw_indicator_history l
        FULL JOIN ledger r ON r.indicator = l.indicator AND r.date = l.date
        LEFT JOIN tolerance t ON t.indicator = coalesce(l.indicator, r.indicator)
    ),
    compared AS (
      SELECT indicator, date, in_legacy, in_ledger,
             indicator || chr(31) || date || chr(31) || legacy_value::text AS legacy_text,
             indicator || chr(31) || date || chr(31)
               || (CASE WHEN in_legacy AND within THEN legacy_value ELSE ledger_value END)::text AS ledger_text,
             CASE WHEN NOT in_ledger THEN 'legacy_only' WHEN NOT in_legacy THEN 'ledger_only'
                  WHEN within OR legacy_value = ledger_value THEN NULL ELSE 'differs' END AS reason
        FROM joined
    )
    SELECT count(*) FILTER (WHERE in_legacy)::int AS legacy_rows,
           count(*) FILTER (WHERE in_ledger)::int AS ledger_rows,
           encode(sha256(convert_to(coalesce(string_agg(legacy_text, chr(10) ORDER BY indicator COLLATE "C", date) FILTER (WHERE in_legacy), ''), 'UTF8')), 'hex') AS legacy_checksum,
           encode(sha256(convert_to(coalesce(string_agg(ledger_text, chr(10) ORDER BY indicator COLLATE "C", date) FILTER (WHERE in_ledger), ''), 'UTF8')), 'hex') AS ledger_checksum,
           count(*) FILTER (WHERE reason IS NOT NULL)::int AS mismatch_count,
           (SELECT coalesce(jsonb_agg(jsonb_build_array(m.indicator, m.date, m.reason) ORDER BY m.indicator COLLATE "C", m.date), '[]'::jsonb)
              FROM (SELECT indicator, date, reason FROM compared WHERE reason IS NOT NULL
                     ORDER BY indicator COLLATE "C", date LIMIT $2) m) AS mismatches
      FROM compared`;

const rawProbe = { statement: RAW_PARITY_SQL, params: ["{}", MAX_MISMATCH_DETAIL] };

const rawLegacy = registerQuery({
  role: "rm_app",
  object: "raw_indicator_history",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/parity:checkRawIndicatorHistoryParity.legacy",
  purpose: "Compare the compatibility raw-indicator floor with the source-value ledger's heads in one set-based statement.",
  callers: [PARITY_ROUTE],
  probe: rawProbe,
});

const rawLedger = registerQuery({
  role: "rm_app",
  object: "source_value_versions",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/parity:checkRawIndicatorHistoryParity.ledger",
  purpose: "Read each raw-indicator point's head version inside the raw-history parity statement.",
  callers: [PARITY_ROUTE],
  probe: rawProbe,
});

const REGIME_PARITY_SQL = `WITH settled AS MATERIALIZED (
      SELECT DISTINCT asof::text AS date FROM analytics_report_snapshots
    ),
    winner AS MATERIALIZED (
      SELECT s.date, w.id
        FROM settled s
       CROSS JOIN LATERAL (
         SELECT aos.id FROM analytics_output_snapshots aos
          WHERE aos.artifact_kind = 'regime_snapshots' AND aos.natural_keys @> ARRAY[s.date]
          ORDER BY aos.run_id DESC, aos.id DESC
          LIMIT 1) w
    ),
    element AS MATERIALIZED (
      SELECT aos.id, e.elem ->> 'date' AS date, e.ord, e.elem
        FROM analytics_output_snapshots aos
       CROSS JOIN LATERAL jsonb_array_elements(convert_from(aos.payload_bytes, 'UTF8')::jsonb) WITH ORDINALITY AS e(elem, ord)
       WHERE aos.id IN (SELECT id FROM winner)
    ),
    ledger AS (
      SELECT DISTINCT ON (w.date) w.date, (x.elem ->> 'composite')::float8 AS composite, x.elem -> 'regime' AS regime
        FROM winner w JOIN element x ON x.id = w.id AND x.date = w.date
       ORDER BY w.date, x.ord DESC
    ),
    legacy AS (
      SELECT rs.date::text AS date, rs.composite::float8 AS composite, coalesce(to_jsonb(rs.regime), 'null'::jsonb) AS regime
        FROM regime_snapshots rs
       WHERE rs.date::text IN (SELECT date FROM settled)
    ),
    joined AS (
      SELECT coalesce(l.date, r.date) AS date, l.date IS NOT NULL AS in_legacy, r.date IS NOT NULL AS in_ledger,
             coalesce(l.date, r.date) || chr(31) || coalesce((floor(l.composite * 1e9 + 0.5) / 1e9)::text, 'null')
               || chr(31) || coalesce(l.regime::text, '') AS legacy_text,
             coalesce(l.date, r.date) || chr(31) || coalesce((floor(r.composite * 1e9 + 0.5) / 1e9)::text, 'null')
               || chr(31) || coalesce(r.regime::text, '') AS ledger_text
        FROM legacy l FULL JOIN ledger r ON r.date = l.date
    ),
    compared AS (
      SELECT *, CASE WHEN NOT in_ledger THEN 'legacy_only' WHEN NOT in_legacy THEN 'ledger_only'
                     WHEN legacy_text = ledger_text THEN NULL ELSE 'differs' END AS reason
        FROM joined
    )
    SELECT count(*) FILTER (WHERE in_legacy)::int AS legacy_rows,
           count(*) FILTER (WHERE in_ledger)::int AS ledger_rows,
           encode(sha256(convert_to(coalesce(string_agg(legacy_text, chr(10) ORDER BY date COLLATE "C") FILTER (WHERE in_legacy), ''), 'UTF8')), 'hex') AS legacy_checksum,
           encode(sha256(convert_to(coalesce(string_agg(CASE WHEN reason IS NULL THEN legacy_text ELSE ledger_text END, chr(10) ORDER BY date COLLATE "C") FILTER (WHERE in_ledger), ''), 'UTF8')), 'hex') AS ledger_checksum,
           (count(*) FILTER (WHERE reason IS NOT NULL)
             + (SELECT count(*) FROM analytics_output_snapshots u WHERE u.artifact_kind = 'regime_snapshots' AND u.natural_keys IS NULL))::int AS mismatch_count,
           (SELECT coalesce(jsonb_agg(jsonb_build_array(m.date, m.reason) ORDER BY m.date COLLATE "C"), '[]'::jsonb)
              FROM (SELECT date, reason FROM compared WHERE reason IS NOT NULL ORDER BY date COLLATE "C" LIMIT $1) m) AS mismatches,
           (SELECT coalesce(jsonb_agg(u.id ORDER BY u.id), '[]'::jsonb) FROM analytics_output_snapshots u
             WHERE u.artifact_kind = 'regime_snapshots' AND u.natural_keys IS NULL) AS unindexed
      FROM compared`;

const regimeProbe = { statement: REGIME_PARITY_SQL, params: [MAX_MISMATCH_DETAIL] };

const regimeSettled = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/parity:checkRegimeSnapshotsParity.settled",
  purpose: "List the settled as-of days inside the regime parity statement, so an in-flight day is not compared.",
  callers: [PARITY_ROUTE],
  probe: regimeProbe,
});

const regimeArtifacts = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/parity:checkRegimeSnapshotsParity.ledger",
  purpose: "Find the newest regime artifact carrying each settled day, and read only those, inside the regime parity statement.",
  callers: [PARITY_ROUTE],
  probe: regimeProbe,
});

const regimeLegacy = registerQuery({
  role: "rm_app",
  object: "regime_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/parity:checkRegimeSnapshotsParity.legacy",
  purpose: "Compare the compatibility regime table with the regime artifacts in one set-based statement.",
  callers: [PARITY_ROUTE],
  probe: regimeProbe,
});

const RESEARCH_PARITY_SQL = `WITH settled AS MATERIALIZED (
      SELECT DISTINCT asof::text AS date FROM analytics_report_snapshots
    ),
    token AS (
      SELECT split_part(t.tok, chr(31), 1) AS date, split_part(t.tok, chr(31), 2) AS signal_key,
             nullif(split_part(t.tok, chr(31), 3), '') AS hash, aos.run_id, aos.id, t.ord
        FROM analytics_output_snapshots aos
       CROSS JOIN LATERAL unnest(aos.natural_keys) WITH ORDINALITY AS t(tok, ord)
       WHERE aos.artifact_kind = 'research_signals'
    ),
    ledger AS (
      SELECT DISTINCT ON (signal_key, date) signal_key, date, hash
        FROM token
       WHERE date IN (SELECT date FROM settled)
       ORDER BY signal_key, date, run_id DESC, id DESC, ord DESC
    ),
    legacy AS (
      SELECT rs.signal_key, rs.date::text AS date, jsonb_hash_extended(coalesce(rs.payload, 'null'::jsonb), 0)::text AS hash
        FROM research_signals rs
       WHERE rs.date::text IN (SELECT date FROM settled)
    ),
    joined AS (
      SELECT coalesce(l.signal_key, r.signal_key) || ' ' || coalesce(l.date, r.date) AS natural_key,
             l.signal_key IS NOT NULL AS in_legacy, r.signal_key IS NOT NULL AS in_ledger,
             l.hash AS legacy_hash, r.hash AS ledger_hash
        FROM legacy l FULL JOIN ledger r ON r.signal_key = l.signal_key AND r.date = l.date
    ),
    compared AS (
      SELECT *, CASE WHEN NOT in_ledger THEN 'legacy_only' WHEN NOT in_legacy THEN 'ledger_only'
                     WHEN ledger_hash IS NOT NULL AND legacy_hash = ledger_hash THEN NULL ELSE 'differs' END AS reason
        FROM joined
    )
    SELECT count(*) FILTER (WHERE in_legacy)::int AS legacy_rows,
           count(*) FILTER (WHERE in_ledger)::int AS ledger_rows,
           encode(sha256(convert_to(coalesce(string_agg(natural_key || chr(31) || legacy_hash, chr(10) ORDER BY natural_key COLLATE "C") FILTER (WHERE in_legacy), ''), 'UTF8')), 'hex') AS legacy_checksum,
           encode(sha256(convert_to(coalesce(string_agg(natural_key || chr(31) || coalesce(ledger_hash, 'unreadable'), chr(10) ORDER BY natural_key COLLATE "C") FILTER (WHERE in_ledger), ''), 'UTF8')), 'hex') AS ledger_checksum,
           (count(*) FILTER (WHERE reason IS NOT NULL)
             + (SELECT count(*) FROM analytics_output_snapshots u WHERE u.artifact_kind = 'research_signals' AND u.natural_keys IS NULL))::int AS mismatch_count,
           (SELECT coalesce(jsonb_agg(jsonb_build_array(m.natural_key, m.reason) ORDER BY m.natural_key COLLATE "C"), '[]'::jsonb)
              FROM (SELECT natural_key, reason FROM compared WHERE reason IS NOT NULL ORDER BY natural_key COLLATE "C" LIMIT $1) m) AS mismatches,
           (SELECT coalesce(jsonb_agg(u.id ORDER BY u.id), '[]'::jsonb) FROM analytics_output_snapshots u
             WHERE u.artifact_kind = 'research_signals' AND u.natural_keys IS NULL) AS unindexed
      FROM compared`;

const researchProbe = { statement: RESEARCH_PARITY_SQL, params: [MAX_MISMATCH_DETAIL] };

const researchSettled = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/parity:checkResearchSignalsParity.settled",
  purpose: "List the settled as-of days inside the research parity statement, so an in-flight day is not compared.",
  callers: [PARITY_ROUTE],
  probe: researchProbe,
});

const researchArtifacts = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/parity:checkResearchSignalsParity.ledger",
  purpose: "Read each research artifact's stored natural keys and payload hashes inside the research parity statement.",
  callers: [PARITY_ROUTE],
  probe: researchProbe,
});

const researchLegacy = registerQuery({
  role: "rm_app",
  object: "research_signals",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/parity:checkResearchSignalsParity.legacy",
  purpose: "Compare the compatibility research table with the research artifacts in one set-based statement.",
  callers: [PARITY_ROUTE],
  probe: researchProbe,
});

const migrationAppliedAt = registerQuery({
  role: "rm_app",
  object: "schema_migrations",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/parity:migrationAppliedAt",
  purpose: "Read when a ledger migration was applied, the instant from which its rows are comparable.",
  callers: [PARITY_ROUTE],
  probe: {
    statement: "SELECT EXTRACT(EPOCH FROM applied_at) AS applied_epoch FROM schema_migrations WHERE name = $1",
    params: ["0061_source_value_provenance.sql"],
  },
});

const BRIEFS_PARITY_SQL = `WITH pre_ledger AS MATERIALIZED (
      SELECT session_id FROM swarm_briefs
       WHERE session_id IS NOT NULL AND EXTRACT(EPOCH FROM created_at) * 1000 < $1
    ),
    legacy AS (
      SELECT session_id, jsonb_hash_extended(coalesce(body, 'null'::jsonb), 0) AS hash
        FROM swarm_briefs
       WHERE session_id IS NOT NULL AND EXTRACT(EPOCH FROM created_at) * 1000 >= $2
    ),
    ledger AS (
      SELECT DISTINCT ON (r.session_id) r.session_id, r.body_hash AS hash
        FROM swarm_brief_revisions r
       WHERE NOT EXISTS (SELECT 1 FROM pre_ledger p WHERE p.session_id = r.session_id)
       ORDER BY r.session_id, r.revision DESC
    ),
    joined AS (
      SELECT coalesce(l.session_id, r.session_id)::text AS natural_key,
             l.session_id IS NOT NULL AS in_legacy, r.session_id IS NOT NULL AS in_ledger,
             l.hash AS legacy_hash, r.hash AS ledger_hash
        FROM legacy l FULL JOIN ledger r ON r.session_id = l.session_id
    ),
    compared AS (
      SELECT *, CASE WHEN NOT in_ledger THEN 'legacy_only' WHEN NOT in_legacy THEN 'ledger_only'
                     WHEN ledger_hash IS NOT NULL AND legacy_hash = ledger_hash THEN NULL ELSE 'differs' END AS reason
        FROM joined
    )
    SELECT count(*) FILTER (WHERE in_legacy)::int AS legacy_rows,
           count(*) FILTER (WHERE in_ledger)::int AS ledger_rows,
           encode(sha256(convert_to(coalesce(string_agg(natural_key || chr(31) || legacy_hash::text, chr(10) ORDER BY natural_key COLLATE "C") FILTER (WHERE in_legacy), ''), 'UTF8')), 'hex') AS legacy_checksum,
           encode(sha256(convert_to(coalesce(string_agg(natural_key || chr(31) || coalesce(ledger_hash::text, 'unreadable'), chr(10) ORDER BY natural_key COLLATE "C") FILTER (WHERE in_ledger), ''), 'UTF8')), 'hex') AS ledger_checksum,
           count(*) FILTER (WHERE reason IS NOT NULL)::int AS mismatch_count,
           (SELECT coalesce(jsonb_agg(jsonb_build_array(m.natural_key, m.reason) ORDER BY m.natural_key COLLATE "C"), '[]'::jsonb)
              FROM (SELECT natural_key, reason FROM compared WHERE reason IS NOT NULL ORDER BY natural_key COLLATE "C" LIMIT $3) m) AS mismatches
      FROM compared`;

const briefsProbe = { statement: BRIEFS_PARITY_SQL, params: [0, 0, MAX_MISMATCH_DETAIL] };

const briefsLegacy = registerQuery({
  role: "rm_app",
  object: "swarm_briefs",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/parity:checkSwarmBriefsParity.legacy",
  purpose: "Compare each ledger-era compatibility brief with its session's newest revision in one set-based statement.",
  callers: [PARITY_ROUTE],
  probe: briefsProbe,
});

const briefsLedger = registerQuery({
  role: "rm_app",
  object: "swarm_brief_revisions",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/parity:checkSwarmBriefsParity.ledger",
  purpose: "Read each session's newest brief revision hash inside the brief parity statement.",
  callers: [PARITY_ROUTE],
  probe: briefsProbe,
});

const insertObservation = registerQuery({
  role: "rm_app",
  object: "analytics_parity_observations",
  // SELECT because of RETURNING. The table is immutable: never UPDATE,
  // DELETE or TRUNCATE (D53 decision 6).
  privileges: ["INSERT", "SELECT"],
  site: "src/analytics/cutover/parity:recordParityObservation",
  purpose: "Append one immutable parity observation, which the cutover gate later reads.",
  callers: [PARITY_ROUTE],
  probe: {
    statement: `INSERT INTO analytics_parity_observations
        (domain, legacy_row_count, ledger_row_count, legacy_checksum, ledger_checksum, matched, detail)
      VALUES ($1, $2::integer, $3::integer, $4, $5, $6::boolean, $7::jsonb)
      RETURNING id`,
    params: [
      "regime_snapshots",
      0,
      0,
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0000000000000000000000000000000000000000000000000000000000000000",
      true,
      "{\"mismatches\":[]}",
    ],
  },
});

export interface ParityResult {
  domain: ParityDomain;
  legacyRowCount: number;
  ledgerRowCount: number;
  legacyChecksum: string;
  ledgerChecksum: string;
  matched: boolean;
  /** Every mismatching natural key, counted; `mismatches` carries the first MAX_MISMATCH_DETAIL. */
  mismatchCount: number;
  // Bounded (never the whole dataset): the first mismatching natural keys in
  // key order, for a human or a test assertion to read directly rather than
  // re-deriving from two opaque checksums.
  mismatches: { naturalKey: string; reason: string }[];
}

interface DomainRow {
  legacy_rows: number;
  ledger_rows: number;
  legacy_checksum: string;
  ledger_checksum: string;
  mismatch_count: number;
  mismatches: string[][];
  unindexed?: number[];
}

const REASON: Record<string, string> = {
  legacy_only: "present in compatibility table, missing from ledger",
  ledger_only: "present in ledger, missing from compatibility table",
  differs: "canonical value differs between compatibility and ledger",
};

function toResult(domain: ParityDomain, row: DomainRow, naturalKey: (parts: string[]) => string): ParityResult {
  const mismatches = row.mismatches.map((m) => ({ naturalKey: naturalKey(m.slice(0, -1)), reason: REASON[m[m.length - 1]!]! }));
  // An artifact whose payload Postgres could not index (migration 0123) holds
  // keys this statement cannot see. That is never a match.
  for (const id of row.unindexed ?? []) {
    if (mismatches.length >= MAX_MISMATCH_DETAIL) break;
    mismatches.push({ naturalKey: `analytics_output_snapshots ${id}`, reason: "ledger artifact payload could not be indexed" });
  }
  return {
    domain,
    legacyRowCount: Number(row.legacy_rows),
    ledgerRowCount: Number(row.ledger_rows),
    legacyChecksum: row.legacy_checksum,
    ledgerChecksum: row.ledger_checksum,
    matched: Number(row.mismatch_count) === 0,
    mismatchCount: Number(row.mismatch_count),
    mismatches,
  };
}

// The tolerance each raw indicator's ledger value is held to, keyed by
// indicator: withinTolerance()'s table (source-tolerance.ts, D56), the one
// both writers use. An indicator with no entry is compared exactly.
// Passed as an object: postgres.js serializes a jsonb parameter itself.
function rawTolerances(): Record<string, number> {
  const prefix = "raw_indicator_history:";
  const out: Record<string, number> = {};
  for (const [key, t] of Object.entries(SOURCE_TOLERANCES)) {
    if (key.startsWith(prefix) && t.relative > 0) out[key.slice(prefix.length)] = t.relative;
  }
  return out;
}

// WHAT COUNTS AS A MATCH (owner, 2026-09-29; decision D56's amendment).
//
// VALUES match when they are within the source's tolerance of each other —
// withinTolerance(), the ONE rule both writers use to decide whether a value is
// new information, written here in SQL `double precision` exactly as
// source-tolerance.ts states it. Otherwise they match when equal after
// rounding at an absolute 1e-9 (JavaScript's Math.round, as floor(x + 0.5)).
// A ledger value within tolerance enters the ledger checksum as the
// compatibility value, so the two checksums agree exactly when every row
// matches.
//
// `source` IS NOT COMPARED: a row keeps the label of the write that last
// changed its value, and the two tables can take that write from different
// writers at the same value.
//
// The ledger side is the head of each (source_key, market_date) chain: the
// version no other version names as its prior.
export async function checkRawIndicatorHistoryParity(db: DbHandle = sql): Promise<ParityResult> {
  const [row] = await on(db, rawLegacy, rawLedger)<DomainRow>`WITH tolerance AS (
      SELECT key AS indicator, value::float8 AS relative FROM jsonb_each_text(${rawTolerances()}::jsonb)
    ),
    ledger AS (
      SELECT DISTINCT ON (svv.source_key COLLATE "C", svv.market_date)
             substr(svv.source_key, 23) AS indicator, svv.market_date AS date, svv.value
        FROM source_value_versions svv
       WHERE svv.source_key LIKE 'raw_indicator_history:%' AND svv.market_date IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM source_value_versions nxt WHERE nxt.prior_version_id = svv.id)
       ORDER BY svv.source_key COLLATE "C", svv.market_date, svv.knowledge_time DESC, svv.id DESC
    ),
    joined AS (
      SELECT coalesce(l.indicator, r.indicator) AS indicator, coalesce(l.date, r.date)::text AS date,
             l.indicator IS NOT NULL AS in_legacy, r.indicator IS NOT NULL AS in_ledger,
             floor(l.value * 1e9 + 0.5) / 1e9 AS legacy_value, floor(r.value * 1e9 + 0.5) / 1e9 AS ledger_value,
             (l.value = r.value
               OR abs(r.value - l.value) <= coalesce(t.relative, 0) * greatest(abs(r.value), abs(l.value))) AS within
        FROM raw_indicator_history l
        FULL JOIN ledger r ON r.indicator = l.indicator AND r.date = l.date
        LEFT JOIN tolerance t ON t.indicator = coalesce(l.indicator, r.indicator)
    ),
    compared AS (
      SELECT indicator, date, in_legacy, in_ledger,
             indicator || chr(31) || date || chr(31) || legacy_value::text AS legacy_text,
             indicator || chr(31) || date || chr(31)
               || (CASE WHEN in_legacy AND within THEN legacy_value ELSE ledger_value END)::text AS ledger_text,
             CASE WHEN NOT in_ledger THEN 'legacy_only' WHEN NOT in_legacy THEN 'ledger_only'
                  WHEN within OR legacy_value = ledger_value THEN NULL ELSE 'differs' END AS reason
        FROM joined
    )
    SELECT count(*) FILTER (WHERE in_legacy)::int AS legacy_rows,
           count(*) FILTER (WHERE in_ledger)::int AS ledger_rows,
           encode(sha256(convert_to(coalesce(string_agg(legacy_text, chr(10) ORDER BY indicator COLLATE "C", date) FILTER (WHERE in_legacy), ''), 'UTF8')), 'hex') AS legacy_checksum,
           encode(sha256(convert_to(coalesce(string_agg(ledger_text, chr(10) ORDER BY indicator COLLATE "C", date) FILTER (WHERE in_ledger), ''), 'UTF8')), 'hex') AS ledger_checksum,
           count(*) FILTER (WHERE reason IS NOT NULL)::int AS mismatch_count,
           (SELECT coalesce(jsonb_agg(jsonb_build_array(m.indicator, m.date, m.reason) ORDER BY m.indicator COLLATE "C", m.date), '[]'::jsonb)
              FROM (SELECT indicator, date, reason FROM compared WHERE reason IS NOT NULL
                     ORDER BY indicator COLLATE "C", date LIMIT ${MAX_MISMATCH_DETAIL}) m) AS mismatches
      FROM compared`;
  // The natural key joins indicator and date with a NUL, so no indicator id or
  // date can forge another pair's key (recordParityObservation makes it visible).
  return toResult("raw_indicator_history", row!, ([indicator, date]) => `${indicator}\u0000${date}`);
}

export async function checkRegimeSnapshotsParity(db: DbHandle = sql): Promise<ParityResult> {
  const [row] = await on(db, regimeArtifacts, regimeSettled, regimeLegacy)<DomainRow>`WITH settled AS MATERIALIZED (
      SELECT DISTINCT asof::text AS date FROM analytics_report_snapshots
    ),
    winner AS MATERIALIZED (
      SELECT s.date, w.id
        FROM settled s
       CROSS JOIN LATERAL (
         SELECT aos.id FROM analytics_output_snapshots aos
          WHERE aos.artifact_kind = 'regime_snapshots' AND aos.natural_keys @> ARRAY[s.date]
          ORDER BY aos.run_id DESC, aos.id DESC
          LIMIT 1) w
    ),
    element AS MATERIALIZED (
      SELECT aos.id, e.elem ->> 'date' AS date, e.ord, e.elem
        FROM analytics_output_snapshots aos
       CROSS JOIN LATERAL jsonb_array_elements(convert_from(aos.payload_bytes, 'UTF8')::jsonb) WITH ORDINALITY AS e(elem, ord)
       WHERE aos.id IN (SELECT id FROM winner)
    ),
    ledger AS (
      SELECT DISTINCT ON (w.date) w.date, (x.elem ->> 'composite')::float8 AS composite, x.elem -> 'regime' AS regime
        FROM winner w JOIN element x ON x.id = w.id AND x.date = w.date
       ORDER BY w.date, x.ord DESC
    ),
    legacy AS (
      SELECT rs.date::text AS date, rs.composite::float8 AS composite, coalesce(to_jsonb(rs.regime), 'null'::jsonb) AS regime
        FROM regime_snapshots rs
       WHERE rs.date::text IN (SELECT date FROM settled)
    ),
    joined AS (
      SELECT coalesce(l.date, r.date) AS date, l.date IS NOT NULL AS in_legacy, r.date IS NOT NULL AS in_ledger,
             coalesce(l.date, r.date) || chr(31) || coalesce((floor(l.composite * 1e9 + 0.5) / 1e9)::text, 'null')
               || chr(31) || coalesce(l.regime::text, '') AS legacy_text,
             coalesce(l.date, r.date) || chr(31) || coalesce((floor(r.composite * 1e9 + 0.5) / 1e9)::text, 'null')
               || chr(31) || coalesce(r.regime::text, '') AS ledger_text
        FROM legacy l FULL JOIN ledger r ON r.date = l.date
    ),
    compared AS (
      SELECT *, CASE WHEN NOT in_ledger THEN 'legacy_only' WHEN NOT in_legacy THEN 'ledger_only'
                     WHEN legacy_text = ledger_text THEN NULL ELSE 'differs' END AS reason
        FROM joined
    )
    SELECT count(*) FILTER (WHERE in_legacy)::int AS legacy_rows,
           count(*) FILTER (WHERE in_ledger)::int AS ledger_rows,
           encode(sha256(convert_to(coalesce(string_agg(legacy_text, chr(10) ORDER BY date COLLATE "C") FILTER (WHERE in_legacy), ''), 'UTF8')), 'hex') AS legacy_checksum,
           encode(sha256(convert_to(coalesce(string_agg(CASE WHEN reason IS NULL THEN legacy_text ELSE ledger_text END, chr(10) ORDER BY date COLLATE "C") FILTER (WHERE in_ledger), ''), 'UTF8')), 'hex') AS ledger_checksum,
           (count(*) FILTER (WHERE reason IS NOT NULL)
             + (SELECT count(*) FROM analytics_output_snapshots u WHERE u.artifact_kind = 'regime_snapshots' AND u.natural_keys IS NULL))::int AS mismatch_count,
           (SELECT coalesce(jsonb_agg(jsonb_build_array(m.date, m.reason) ORDER BY m.date COLLATE "C"), '[]'::jsonb)
              FROM (SELECT date, reason FROM compared WHERE reason IS NOT NULL ORDER BY date COLLATE "C" LIMIT ${MAX_MISMATCH_DETAIL}) m) AS mismatches,
           (SELECT coalesce(jsonb_agg(u.id ORDER BY u.id), '[]'::jsonb) FROM analytics_output_snapshots u
             WHERE u.artifact_kind = 'regime_snapshots' AND u.natural_keys IS NULL) AS unindexed
      FROM compared`;
  return toResult("regime_snapshots", row!, ([date]) => date!);
}

export async function checkResearchSignalsParity(db: DbHandle = sql): Promise<ParityResult> {
  const [row] = await on(db, researchArtifacts, researchSettled, researchLegacy)<DomainRow>`WITH settled AS MATERIALIZED (
      SELECT DISTINCT asof::text AS date FROM analytics_report_snapshots
    ),
    token AS (
      SELECT split_part(t.tok, chr(31), 1) AS date, split_part(t.tok, chr(31), 2) AS signal_key,
             nullif(split_part(t.tok, chr(31), 3), '') AS hash, aos.run_id, aos.id, t.ord
        FROM analytics_output_snapshots aos
       CROSS JOIN LATERAL unnest(aos.natural_keys) WITH ORDINALITY AS t(tok, ord)
       WHERE aos.artifact_kind = 'research_signals'
    ),
    ledger AS (
      SELECT DISTINCT ON (signal_key, date) signal_key, date, hash
        FROM token
       WHERE date IN (SELECT date FROM settled)
       ORDER BY signal_key, date, run_id DESC, id DESC, ord DESC
    ),
    legacy AS (
      SELECT rs.signal_key, rs.date::text AS date, jsonb_hash_extended(coalesce(rs.payload, 'null'::jsonb), 0)::text AS hash
        FROM research_signals rs
       WHERE rs.date::text IN (SELECT date FROM settled)
    ),
    joined AS (
      SELECT coalesce(l.signal_key, r.signal_key) || ' ' || coalesce(l.date, r.date) AS natural_key,
             l.signal_key IS NOT NULL AS in_legacy, r.signal_key IS NOT NULL AS in_ledger,
             l.hash AS legacy_hash, r.hash AS ledger_hash
        FROM legacy l FULL JOIN ledger r ON r.signal_key = l.signal_key AND r.date = l.date
    ),
    compared AS (
      SELECT *, CASE WHEN NOT in_ledger THEN 'legacy_only' WHEN NOT in_legacy THEN 'ledger_only'
                     WHEN ledger_hash IS NOT NULL AND legacy_hash = ledger_hash THEN NULL ELSE 'differs' END AS reason
        FROM joined
    )
    SELECT count(*) FILTER (WHERE in_legacy)::int AS legacy_rows,
           count(*) FILTER (WHERE in_ledger)::int AS ledger_rows,
           encode(sha256(convert_to(coalesce(string_agg(natural_key || chr(31) || legacy_hash, chr(10) ORDER BY natural_key COLLATE "C") FILTER (WHERE in_legacy), ''), 'UTF8')), 'hex') AS legacy_checksum,
           encode(sha256(convert_to(coalesce(string_agg(natural_key || chr(31) || coalesce(ledger_hash, 'unreadable'), chr(10) ORDER BY natural_key COLLATE "C") FILTER (WHERE in_ledger), ''), 'UTF8')), 'hex') AS ledger_checksum,
           (count(*) FILTER (WHERE reason IS NOT NULL)
             + (SELECT count(*) FROM analytics_output_snapshots u WHERE u.artifact_kind = 'research_signals' AND u.natural_keys IS NULL))::int AS mismatch_count,
           (SELECT coalesce(jsonb_agg(jsonb_build_array(m.natural_key, m.reason) ORDER BY m.natural_key COLLATE "C"), '[]'::jsonb)
              FROM (SELECT natural_key, reason FROM compared WHERE reason IS NOT NULL ORDER BY natural_key COLLATE "C" LIMIT ${MAX_MISMATCH_DETAIL}) m) AS mismatches,
           (SELECT coalesce(jsonb_agg(u.id ORDER BY u.id), '[]'::jsonb) FROM analytics_output_snapshots u
             WHERE u.artifact_kind = 'research_signals' AND u.natural_keys IS NULL) AS unindexed
      FROM compared`;
  return toResult("research_signals", row!, ([naturalKey]) => naturalKey!);
}

// 0059 creates swarm_brief_revisions and DOES NOT BACKFILL it ("no backfill —
// same documented cutover shape as 0049"). So a brief written before 0059
// landed has, by design, no ledger row, and comparing over all history would
// report every one as "present in compatibility table, missing from ledger"
// forever: measured on a smoke-twin restored from production, legacy 226 rows
// vs ledger 1, which made the cutover gate unpassable there.
//
// The boundary is 0059's own `applied_at`, and a session is excluded from BOTH
// sides when its compatibility row predates it — never from one, or the
// exclusion would manufacture a divergence in the opposite direction (a
// pre-0059 brief revised after the cutover has a ledger row).
//
// This cannot hide a real regression: scope is decided by WHEN the brief was
// written, never by what it says. A writer that stops populating the ledger
// lands an in-scope legacy row with no ledger row; a session in the ledger
// with no compatibility row stays in scope.
const BRIEF_LEDGER_MIGRATION = "0059_analytics_output_and_report_snapshots.sql";

async function briefLedgerFromMs(db: DbHandle): Promise<number | null> {
  const rows = await on(db, migrationAppliedAt)<{ applied_epoch: string | number }>`
    SELECT EXTRACT(EPOCH FROM applied_at) AS applied_epoch
    FROM schema_migrations WHERE name = ${BRIEF_LEDGER_MIGRATION}
  `;
  if (rows.length === 0) return null; // 0059 unapplied here: the ledger table cannot exist
  return Math.round(Number(rows[0]!.applied_epoch) * 1000);
}

export async function checkSwarmBriefsParity(db: DbHandle = sql): Promise<ParityResult> {
  const fromMs = await briefLedgerFromMs(db);
  if (fromMs === null) {
    // Nothing is comparable before the ledger exists. An empty-vs-empty result
    // is honest; the gate additionally requires a minimum observation count
    // and window before it will arm.
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // sha256 of no rows
    return { domain: "swarm_briefs", legacyRowCount: 0, ledgerRowCount: 0, legacyChecksum: empty, ledgerChecksum: empty, matched: true, mismatchCount: 0, mismatches: [] };
  }
  const [row] = await on(db, briefsLegacy, briefsLedger)<DomainRow>`WITH pre_ledger AS MATERIALIZED (
      SELECT session_id FROM swarm_briefs
       WHERE session_id IS NOT NULL AND EXTRACT(EPOCH FROM created_at) * 1000 < ${fromMs}
    ),
    legacy AS (
      SELECT session_id, jsonb_hash_extended(coalesce(body, 'null'::jsonb), 0) AS hash
        FROM swarm_briefs
       WHERE session_id IS NOT NULL AND EXTRACT(EPOCH FROM created_at) * 1000 >= ${fromMs}
    ),
    ledger AS (
      SELECT DISTINCT ON (r.session_id) r.session_id, r.body_hash AS hash
        FROM swarm_brief_revisions r
       WHERE NOT EXISTS (SELECT 1 FROM pre_ledger p WHERE p.session_id = r.session_id)
       ORDER BY r.session_id, r.revision DESC
    ),
    joined AS (
      SELECT coalesce(l.session_id, r.session_id)::text AS natural_key,
             l.session_id IS NOT NULL AS in_legacy, r.session_id IS NOT NULL AS in_ledger,
             l.hash AS legacy_hash, r.hash AS ledger_hash
        FROM legacy l FULL JOIN ledger r ON r.session_id = l.session_id
    ),
    compared AS (
      SELECT *, CASE WHEN NOT in_ledger THEN 'legacy_only' WHEN NOT in_legacy THEN 'ledger_only'
                     WHEN ledger_hash IS NOT NULL AND legacy_hash = ledger_hash THEN NULL ELSE 'differs' END AS reason
        FROM joined
    )
    SELECT count(*) FILTER (WHERE in_legacy)::int AS legacy_rows,
           count(*) FILTER (WHERE in_ledger)::int AS ledger_rows,
           encode(sha256(convert_to(coalesce(string_agg(natural_key || chr(31) || legacy_hash::text, chr(10) ORDER BY natural_key COLLATE "C") FILTER (WHERE in_legacy), ''), 'UTF8')), 'hex') AS legacy_checksum,
           encode(sha256(convert_to(coalesce(string_agg(natural_key || chr(31) || coalesce(ledger_hash::text, 'unreadable'), chr(10) ORDER BY natural_key COLLATE "C") FILTER (WHERE in_ledger), ''), 'UTF8')), 'hex') AS ledger_checksum,
           count(*) FILTER (WHERE reason IS NOT NULL)::int AS mismatch_count,
           (SELECT coalesce(jsonb_agg(jsonb_build_array(m.natural_key, m.reason) ORDER BY m.natural_key COLLATE "C"), '[]'::jsonb)
              FROM (SELECT natural_key, reason FROM compared WHERE reason IS NOT NULL ORDER BY natural_key COLLATE "C" LIMIT ${MAX_MISMATCH_DETAIL}) m) AS mismatches
      FROM compared`;
  return toResult("swarm_briefs", row!, ([sessionId]) => sessionId!);
}

export async function checkDomainParity(domain: ParityDomain, db: DbHandle = sql): Promise<ParityResult> {
  switch (domain) {
    case "raw_indicator_history":
      return checkRawIndicatorHistoryParity(db);
    case "regime_snapshots":
      return checkRegimeSnapshotsParity(db);
    case "research_signals":
      return checkResearchSignalsParity(db);
    case "swarm_briefs":
      return checkSwarmBriefsParity(db);
  }
}

// Record a parity check as immutable evidence. Every observation is a NEW
// row — analytics_parity_observations refuses UPDATE/DELETE/TRUNCATE
// (migration 0060) — so a re-check after fixing a mismatch is a fresh,
// separately-timestamped data point, never an edit of the failed one.
export async function recordParityObservation(result: ParityResult, db: DbHandle = sql): Promise<string> {
  // The raw natural key joins indicator and date with a NUL, but Postgres
  // jsonb refuses \u0000 ("unsupported Unicode escape sequence"), so every
  // raw_indicator_history observation WITH a mismatch failed to insert
  // (production, 2026-09-23/25). The evidence carries the visible U+241F
  // SYMBOL FOR UNIT SEPARATOR instead; the in-memory key is unchanged.
  const mismatches = result.mismatches.map((m) => ({ ...m, naturalKey: m.naturalKey.replaceAll("\u0000", "␟") }));
  const [row] = await on(db, insertObservation)<{ id: string }>`
    INSERT INTO analytics_parity_observations
      (domain, legacy_row_count, ledger_row_count, legacy_checksum, ledger_checksum, matched, detail)
    VALUES (${result.domain}, ${result.legacyRowCount}, ${result.ledgerRowCount},
            ${result.legacyChecksum}, ${result.ledgerChecksum}, ${result.matched},
            ${db.json(({ mismatches, mismatchCount: result.mismatchCount } as unknown) as never)})
    RETURNING id
  `;
  return String(row!.id);
}
