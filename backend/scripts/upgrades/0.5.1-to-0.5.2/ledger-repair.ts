// One-time repair of the analytics ledger for v0.5.2 (issues #1035, #1050):
// leave source_value_versions, analytics_vintage_members,
// analytics_overwrite_events and raw_indicator_history exactly as the FIXED
// writers would have left them, as if the old writers had never run.
//
// WHY A SCRIPT, NOT MIGRATION 0080 (owner, 2026-09-29). Only production, and
// twins restored from it, hold the old writers' rows. As a migration the repair
// ran on every fresh and CI database for nothing, and on production's volume
// its replay was one statement past the api's 5-minute statement_timeout
// (stage-2 twin rehearsal, 2026-09-28). As a script it runs once, on purpose,
// with the writers stopped (runbook R4.3h on the twin, R6.4c in production),
// prints its progress per series, and leaves a receipt.
//
// THE RULES IT REPLAYS (decision D56, and the owner's calls of 2026-09-29):
//   * A version is kept only if its value is outside its source's tolerance of
//     the coordinate's head, the last version KEPT before it. A label change
//     alone ('live' vs 'seed') is not a change. store/source-ledger-store.ts's
//     classify() applies the same rule to every new acquisition.
//   * Every coordinate is ordered by (knowledge_time, id), the order the
//     writer's own head lookup uses, and re-linked into one chain in that
//     order. That includes the ~25k "irregular" coordinates whose stored links
//     did not follow it: the ledger is append-only, so nothing else ever would.
//   * A vintage member is re-pointed to the kept version its coordinate's head
//     was at that moment: the last kept version at or before it. Each vintage
//     keeps one member per coordinate, so its member count cannot change, and
//     its manifest and digest are recomputed from the members it now resolves.
//   * raw_indicator_history's overwrite evidence is replayed the same way: a
//     rewrite within tolerance, whatever its label, was never made.
//
// HOW. Everything runs in ONE transaction: any failure, or any proof below that
// does not hold, rolls all of it back and the guards were never off. The three
// ledger tables are rebuilt by TRUNCATE and re-insert of the rows that stay,
// with their original ids, so the space returns at commit and no VACUUM FULL is
// needed. --dry-run does all of it, proofs included, then rolls back: the
// rehearsal's timing without the change.
//
// Usage (repo root):
//   bun backend/scripts/upgrades/0.5.1-to-0.5.2/ledger-repair.ts \
//     [--database-url URL] [--dry-run] [--emit-receipt --step R6.4c.ledger-repair --backup-dir DIR]
// The URL defaults to MIGRATE_DATABASE_URL, then DATABASE_URL. The session
// switches to rm_owner, the tables' owner, as the migration runner does.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOURCE_TOLERANCES, rawIndicatorSourceKey, toleranceFor } from "../../../src/analytics/source-tolerance.ts";
import { TAG_GLOB } from "./release.ts";

type Db = postgres.Sql<{}>;
type Tx = postgres.TransactionSql<{}>;

export interface LedgerRepairReport {
  dryRun: boolean;
  seconds: Record<string, number>;
  before: { versions: number; members: number; overwriteEvents: number };
  after: { versions: number; members: number; overwriteEvents: number };
  coordinates: number;
  vintages: number;
  manifestsRewritten: number;
  rawEvents: { replayed: number; dropped: number; rewritten: number; rowsRestored: number };
}

// Thrown to roll a --dry-run back after every step and proof has run.
class DryRunRollback extends Error {}

// Every guard the rebuild must disarm, re-armed ENABLE ALWAYS before commit —
// the state src/db/analytics-ledger-guard.ts and append-only-guard.ts check.
// raw_indicator_history's capture trigger is disarmed because the repair's own
// rewrite of a row is not an overwrite the fixed writer made.
const GUARDS: readonly (readonly [string, string])[] = [
  ["source_value_versions", "source_value_versions_immutable"],
  ["source_value_versions", "source_value_versions_immutable_row"],
  ["analytics_vintage_members", "analytics_vintage_members_immutable"],
  ["analytics_vintage_members", "analytics_vintage_members_immutable_row"],
  ["analytics_overwrite_events", "analytics_overwrite_events_append_only"],
  ["analytics_overwrite_events", "analytics_overwrite_events_append_only_row"],
  ["analytics_overwrite_events", "analytics_overwrite_events_immutable"],
  ["analytics_overwrite_events", "analytics_overwrite_events_immutable_row"],
  ["raw_indicator_history", "raw_indicator_history_capture_overwrite"],
];

// Scratch state. TEMP ... ON COMMIT DROP: it lives for this transaction only.
const SCRATCH = `
CREATE TEMP TABLE ledger_repair_dropped (id bigint NOT NULL, kept_id bigint NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE ledger_repair_kept (
  id bigint PRIMARY KEY, prior_version_id bigint, revision_kind text NOT NULL
) ON COMMIT DROP;
CREATE TEMP TABLE ledger_repair_ev_drop (id bigint NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE ledger_repair_ev_fix (id bigint PRIMARY KEY, previous_row jsonb NOT NULL, replacement_row jsonb) ON COMMIT DROP;
CREATE TEMP TABLE ledger_repair_raw (indicator text NOT NULL, date date NOT NULL, value double precision NOT NULL, source text) ON COMMIT DROP;
`;

// One series: walk each coordinate oldest first, holding the head the fixed
// writer would have had, and record every version as kept (with its new link
// and kind) or dropped (with the kept head it maps to). A loop, because each
// verdict depends on the head the previous verdicts left; one call per
// source_key keeps every statement short and the progress visible.
//
// Only the columns the rule needs are read, in the order
// source_value_versions_lookup_idx serves for one key. Scratch rows are
// flushed in batches so memory stays bounded however long the series.
const SERIES_FN = `
CREATE OR REPLACE FUNCTION pg_temp.ledger_repair_series(k text, rel double precision)
RETURNS TABLE (versions bigint, kept bigint, coordinates bigint)
LANGUAGE plpgsql AS $fn$
DECLARE
  batch constant integer := 50000;
  r record;
  started boolean := false;
  cur_date date;
  cur_instant timestamptz;
  head_id bigint;
  head_value double precision;
  prior bigint;
  drop_ids bigint[] := '{}';
  drop_to bigint[] := '{}';
  keep_ids bigint[] := '{}';
  keep_prior bigint[] := '{}';
  keep_kind text[] := '{}';
  n_versions bigint := 0;
  n_kept bigint := 0;
  n_coords bigint := 0;
BEGIN
  FOR r IN
    SELECT s.id, s.acquisition_id, s.market_date, s.market_instant, s.value
    FROM source_value_versions s
    WHERE s.source_key = k
    ORDER BY s.market_date, s.market_instant, s.knowledge_time, s.id
  LOOP
    n_versions := n_versions + 1;
    IF started AND r.market_date IS NOT DISTINCT FROM cur_date AND r.market_instant IS NOT DISTINCT FROM cur_instant THEN
      IF r.value = head_value OR abs(r.value - head_value) <= rel * greatest(abs(r.value), abs(head_value)) THEN
        drop_ids := array_append(drop_ids, r.id);
        drop_to := array_append(drop_to, head_id);
        IF cardinality(drop_ids) >= batch THEN
          INSERT INTO ledger_repair_dropped (id, kept_id) SELECT * FROM unnest(drop_ids, drop_to);
          drop_ids := '{}';
          drop_to := '{}';
        END IF;
        CONTINUE;
      END IF;
      prior := head_id;
    ELSE
      started := true;
      cur_date := r.market_date;
      cur_instant := r.market_instant;
      prior := NULL;
      n_coords := n_coords + 1;
    END IF;
    keep_ids := array_append(keep_ids, r.id);
    keep_prior := array_append(keep_prior, prior);
    -- 0057's CHECK ties legacy_baseline to a NULL acquisition, so a baseline
    -- keeps its kind wherever it falls; every other first version is 'initial'.
    keep_kind := array_append(keep_kind, CASE
      WHEN r.acquisition_id IS NULL THEN 'legacy_baseline'
      WHEN prior IS NULL THEN 'initial'
      ELSE 'revision' END);
    n_kept := n_kept + 1;
    head_id := r.id;
    head_value := r.value;
    IF cardinality(keep_ids) >= batch THEN
      INSERT INTO ledger_repair_kept (id, prior_version_id, revision_kind) SELECT * FROM unnest(keep_ids, keep_prior, keep_kind);
      keep_ids := '{}';
      keep_prior := '{}';
      keep_kind := '{}';
    END IF;
  END LOOP;
  INSERT INTO ledger_repair_dropped (id, kept_id) SELECT * FROM unnest(drop_ids, drop_to);
  INSERT INTO ledger_repair_kept (id, prior_version_id, revision_kind) SELECT * FROM unnest(keep_ids, keep_prior, keep_kind);
  RETURN QUERY SELECT n_versions, n_kept, n_coords;
END;
$fn$;
`;

// raw_indicator_history and its overwrite evidence. Every rewrite of a row is
// on record since 0056 (the capture trigger is ENABLE ALWAYS), so its evidence,
// oldest first, is the sequence of values the old raw writer was handed.
// Replay store/raw-history-store.ts's fixed rule over it, holding the row as
// the fixed writer would have stored it (state):
//   * within tolerance, whatever the label → no rewrite, so no evidence: dropped;
//   * outside tolerance                    → value and label move;
// and every kept event records the rewrite the fixed writer made, from the
// state it held. A delete ends the row: the next event starts from its own
// previous_row.
const RAW_FN = `
CREATE OR REPLACE FUNCTION pg_temp.ledger_repair_raw(tol jsonb)
RETURNS TABLE (events bigint, dropped bigint, rewritten bigint, restored bigint)
LANGUAGE plpgsql AS $fn$
DECLARE
  e record;
  ev_indicator text;
  ev_date text;
  state jsonb;
  recorded jsonb;
  next_state jsonb;
  relative double precision;
  sv double precision;
  rv double precision;
  n_events bigint := 0;
  ev_drop bigint[] := '{}';
  ev_fix_ids bigint[] := '{}';
  ev_fix_previous jsonb[] := '{}';
  ev_fix_replacement jsonb[] := '{}';
  raw_indicator text[] := '{}';
  raw_date date[] := '{}';
  raw_value double precision[] := '{}';
  raw_source text[] := '{}';
BEGIN
  FOR e IN
    SELECT id, operation, natural_key ->> 'indicator' AS indicator, natural_key ->> 'date' AS date,
           previous_row, replacement_row
    FROM analytics_overwrite_events
    WHERE table_name = 'raw_indicator_history'
    ORDER BY natural_key ->> 'indicator', natural_key ->> 'date', id
  LOOP
    n_events := n_events + 1;
    IF ev_indicator IS DISTINCT FROM e.indicator OR ev_date IS DISTINCT FROM e.date THEN
      IF state IS NOT NULL AND state IS DISTINCT FROM recorded THEN
        raw_indicator := array_append(raw_indicator, ev_indicator);
        raw_date := array_append(raw_date, ev_date::date);
        raw_value := array_append(raw_value, (state ->> 'value')::double precision);
        raw_source := array_append(raw_source, state ->> 'source');
      END IF;
      ev_indicator := e.indicator;
      ev_date := e.date;
      state := NULL;
      recorded := NULL;
    END IF;

    IF e.operation = 'delete' THEN
      IF state IS NOT NULL AND e.previous_row IS DISTINCT FROM state THEN
        ev_fix_ids := array_append(ev_fix_ids, e.id);
        ev_fix_previous := array_append(ev_fix_previous, state);
        ev_fix_replacement := array_append(ev_fix_replacement, NULL::jsonb);
      END IF;
      state := NULL;
      recorded := NULL;
      CONTINUE;
    END IF;

    IF state IS NULL THEN
      state := e.previous_row;
    END IF;
    recorded := e.replacement_row;
    relative := COALESCE((tol ->> ('raw_indicator_history:' || e.indicator))::double precision, 0);
    sv := (state ->> 'value')::double precision;
    rv := (e.replacement_row ->> 'value')::double precision;
    IF rv = sv OR abs(rv - sv) <= relative * greatest(abs(rv), abs(sv)) THEN
      ev_drop := array_append(ev_drop, e.id);
      CONTINUE;
    END IF;
    next_state := jsonb_set(jsonb_set(state, '{source}', COALESCE(e.replacement_row -> 'source', 'null'::jsonb)),
                            '{value}', e.replacement_row -> 'value');
    IF e.previous_row IS DISTINCT FROM state OR e.replacement_row IS DISTINCT FROM next_state THEN
      ev_fix_ids := array_append(ev_fix_ids, e.id);
      ev_fix_previous := array_append(ev_fix_previous, state);
      ev_fix_replacement := array_append(ev_fix_replacement, next_state);
    END IF;
    state := next_state;
  END LOOP;
  IF state IS NOT NULL AND state IS DISTINCT FROM recorded THEN
    raw_indicator := array_append(raw_indicator, ev_indicator);
    raw_date := array_append(raw_date, ev_date::date);
    raw_value := array_append(raw_value, (state ->> 'value')::double precision);
    raw_source := array_append(raw_source, state ->> 'source');
  END IF;

  INSERT INTO ledger_repair_ev_drop (id) SELECT unnest(ev_drop);
  INSERT INTO ledger_repair_ev_fix (id, previous_row, replacement_row)
  SELECT * FROM unnest(ev_fix_ids, ev_fix_previous, ev_fix_replacement);
  INSERT INTO ledger_repair_raw (indicator, date, value, source)
  SELECT * FROM unnest(raw_indicator, raw_date, raw_value, raw_source);
  RETURN QUERY SELECT n_events, cardinality(ev_drop)::bigint, cardinality(ev_fix_ids)::bigint, cardinality(raw_indicator)::bigint;
END;
$fn$;
`;

// Re-point every member id to the kept version it maps to (itself if kept),
// then gather the mapped ids back into runs of consecutive ids per (vintage,
// source_key), exactly as memberRanges (store/run-ledger-store.ts) stores a new
// freeze. A hash join on the scratch table is right here: it is read once, in
// full, against every member.
const REPOINT_MEMBERS = `
CREATE TEMP TABLE ledger_repair_members ON COMMIT DROP AS
SELECT o.vintage_id, o.source_key, min(o.version_id) AS first_id, max(o.version_id) AS last_id
FROM (
  SELECT m.vintage_id, m.source_key, m.version_id,
         m.version_id - row_number() OVER (PARTITION BY m.vintage_id, m.source_key ORDER BY m.version_id) AS run_key
  FROM (
    SELECT vm.vintage_id, vm.source_key, COALESCE(d.kept_id, g.id) AS version_id
    FROM analytics_vintage_members vm
    CROSS JOIN LATERAL generate_series(
      vm.source_value_version_id,
      COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) AS g(id)
    LEFT JOIN ledger_repair_dropped d ON d.id = g.id
  ) m
) o
GROUP BY o.vintage_id, o.source_key, o.run_key
`;

async function count(tx: Tx, table: string): Promise<number> {
  const [row] = (await tx.unsafe(`SELECT count(*)::bigint AS n FROM ${table}`)) as unknown as { n: string }[];
  return Number(row!.n);
}

export async function repairLedger(db: Db, opts: { dryRun?: boolean; log?: (line: string) => void } = {}): Promise<LedgerRepairReport> {
  const log = opts.log ?? (() => {});
  const seconds: Record<string, number> = {};
  const time = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    log(`${step}…`);
    const out = await work();
    seconds[step] = Math.round((Date.now() - started) / 100) / 10;
    log(`${step}: ${seconds[step]}s`);
    return out;
  };
  // Imported here, not at the top: store/run-ledger-store.ts pulls in
  // src/db/client.ts, which needs DATABASE_URL set, and main() sets it first.
  const { rebuildVintageManifests } = await import("../../../src/analytics/store/run-ledger-store.ts");
  let report: LedgerRepairReport | undefined;

  try {
    await db.begin(async (tx) => {
      // An operator-run repair on production's volume: no statement limit, but
      // never a silent wait behind a writer that is still running.
      await tx.unsafe("SET LOCAL statement_timeout = 0");
      await tx.unsafe("SET LOCAL lock_timeout = '30s'");
      await tx.unsafe("SET LOCAL work_mem = '256MB'");
      await tx.unsafe("SET LOCAL ROLE rm_owner");

      const [applied] = (await tx`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '0080_analytics_ledger_compaction.sql'`) as unknown as { n: number }[];
      if (applied!.n !== 1) throw new Error("migration 0080 is not recorded: boot v0.5.2 (which applies it) before repairing the ledger");

      await time("lock", () => tx.unsafe(`
        LOCK TABLE source_value_versions, analytics_vintage_members, analytics_overwrite_events,
                   raw_indicator_history, analytics_data_vintages IN ACCESS EXCLUSIVE MODE`));
      const before = {
        versions: await count(tx, "source_value_versions"),
        members: await count(tx, "analytics_vintage_members"),
        overwriteEvents: await count(tx, "analytics_overwrite_events"),
      };
      log(`before: ${JSON.stringify(before)}`);

      // What must NOT change, taken before anything moves: each vintage's
      // resolved member count (every member row stands for last - first + 1 ids).
      await tx.unsafe(`
        CREATE TEMP TABLE ledger_repair_member_counts ON COMMIT DROP AS
        SELECT vintage_id, sum(COALESCE(last_source_value_version_id - source_value_version_id + 1, 1))::bigint AS members
        FROM analytics_vintage_members GROUP BY vintage_id`);

      await tx.unsafe(SCRATCH);
      await tx.unsafe(SERIES_FN);
      await tx.unsafe(RAW_FN);

      // ── 1. Replay every series ───────────────────────────────────────────
      const keys = (await tx`
        WITH RECURSIVE k AS (
          SELECT min(source_key) AS key FROM source_value_versions
          UNION ALL
          SELECT (SELECT min(source_key) FROM source_value_versions WHERE source_key > k.key) FROM k WHERE k.key IS NOT NULL
        )
        SELECT key FROM k WHERE key IS NOT NULL`) as unknown as { key: string }[];
      let coordinates = 0;
      await time("replay versions", async () => {
        for (const [i, { key }] of keys.entries()) {
          const started = Date.now();
          const [r] = (await tx`SELECT * FROM pg_temp.ledger_repair_series(${key}, ${toleranceFor(key).relative})`) as unknown as
            { versions: string; kept: string; coordinates: string }[];
          coordinates += Number(r!.coordinates);
          log(`  [${i + 1}/${keys.length}] ${key}: ${r!.versions} versions → ${r!.kept} kept over ${r!.coordinates} points (${((Date.now() - started) / 1000).toFixed(1)}s)`);
        }
      });
      await tx.unsafe("ANALYZE ledger_repair_dropped");
      await tx.unsafe("ANALYZE ledger_repair_kept");

      // ── 2. Re-point every vintage ────────────────────────────────────────
      await time("re-point vintage members", () => tx.unsafe(REPOINT_MEMBERS));

      // ── 3. Replay raw_indicator_history's evidence ───────────────────────
      const rawTol = Object.fromEntries(
        Object.entries(SOURCE_TOLERANCES).filter(([k, t]) => k.startsWith(rawIndicatorSourceKey("")) && t.relative > 0).map(([k, t]) => [k, t.relative]),
      );
      const [raw] = (await time("replay raw history evidence", () =>
        tx`SELECT * FROM pg_temp.ledger_repair_raw(${tx.json(rawTol)})`)) as unknown as
        { events: string; dropped: string; rewritten: string; restored: string }[];

      // ── 4. Rebuild the three tables from what stays ──────────────────────
      await time("rebuild tables", async () => {
        await tx.unsafe(`
          CREATE TEMP TABLE ledger_repair_versions ON COMMIT DROP AS
          SELECT s.* FROM source_value_versions s WHERE s.id IN (SELECT id FROM ledger_repair_kept)`);
        await tx.unsafe(`
          UPDATE ledger_repair_versions v SET prior_version_id = k.prior_version_id, revision_kind = k.revision_kind
          FROM ledger_repair_kept k WHERE k.id = v.id`);
        await tx.unsafe(`
          CREATE TEMP TABLE ledger_repair_events ON COMMIT DROP AS
          SELECT e.* FROM analytics_overwrite_events e
          WHERE NOT EXISTS (SELECT 1 FROM ledger_repair_ev_drop d WHERE d.id = e.id)`);
        await tx.unsafe(`
          UPDATE ledger_repair_events e SET previous_row = f.previous_row, replacement_row = f.replacement_row
          FROM ledger_repair_ev_fix f WHERE f.id = e.id`);

        for (const [table, trigger] of GUARDS) await tx.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
        // One statement for the two ledger tables: members reference versions.
        await tx.unsafe("TRUNCATE analytics_vintage_members, source_value_versions");
        await tx.unsafe("TRUNCATE analytics_overwrite_events");
        // Original ids, so every reference into these tables still resolves.
        // A version's link can point at a LATER id once its coordinate is
        // re-ordered by knowledge_time; the self foreign key is checked at the
        // end of the statement, when every kept row is in.
        await tx.unsafe("INSERT INTO source_value_versions OVERRIDING SYSTEM VALUE SELECT * FROM ledger_repair_versions ORDER BY id");
        await tx.unsafe(`
          INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, last_source_value_version_id, source_key)
          SELECT vintage_id, first_id, NULLIF(last_id, first_id), source_key
          FROM ledger_repair_members ORDER BY vintage_id, first_id`);
        await tx.unsafe("INSERT INTO analytics_overwrite_events OVERRIDING SYSTEM VALUE SELECT * FROM ledger_repair_events ORDER BY id");
        await tx.unsafe(`
          UPDATE raw_indicator_history h SET value = f.value, source = f.source
          FROM ledger_repair_raw f WHERE h.indicator = f.indicator AND h.date = f.date`);
      });

      // ── 5. Proof, inside the transaction: refuse to commit a changed shape ─
      await time("prove", async () => {
        const [changed] = (await tx`
          SELECT count(*)::int AS n
          FROM ledger_repair_member_counts b
          FULL JOIN (
            SELECT vm.vintage_id, count(*) FILTER (WHERE svv.source_key = vm.source_key) AS members
            FROM analytics_vintage_members vm
            CROSS JOIN LATERAL generate_series(
              vm.source_value_version_id,
              COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) AS g(id)
            JOIN source_value_versions svv ON svv.id = g.id
            GROUP BY vm.vintage_id
          ) a ON a.vintage_id = b.vintage_id
          WHERE a.members IS DISTINCT FROM b.members`) as unknown as { n: number }[];
        if (changed!.n > 0) throw new Error(`the repair would change the member count of ${changed!.n} vintage(s)`);

        // One chain per coordinate: one root, one head, and every link to the
        // version just before it in (knowledge_time, id) order.
        const [shape] = (await tx`
          WITH c AS (
            SELECT id, prior_version_id,
                   lag(id) OVER (PARTITION BY source_key, market_date, market_instant ORDER BY knowledge_time, id) AS previous_id
            FROM source_value_versions
          )
          SELECT count(*) FILTER (WHERE prior_version_id IS NULL)::int AS roots,
                 count(*) FILTER (WHERE prior_version_id IS DISTINCT FROM previous_id)::int AS misordered,
                 (SELECT count(*)::int FROM source_value_versions s
                  WHERE NOT EXISTS (SELECT 1 FROM source_value_versions n WHERE n.prior_version_id = s.id)) AS heads
          FROM c`) as unknown as { roots: number; misordered: number; heads: number }[];
        if (shape!.misordered > 0) throw new Error(`${shape!.misordered} version(s) are not linked to the version before them`);
        if (shape!.roots !== coordinates || shape!.heads !== coordinates) {
          throw new Error(`expected one chain per point (${coordinates}), found ${shape!.roots} roots and ${shape!.heads} heads`);
        }
      });

      // ── 6. Re-arm, then recompute every vintage's manifest ───────────────
      for (const [table, trigger] of GUARDS) await tx.unsafe(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${trigger}`);
      const manifests = await time("rebuild vintage manifests", () => rebuildVintageManifests(tx));
      await tx.unsafe("DROP FUNCTION pg_temp.ledger_repair_series(text, double precision)");
      await tx.unsafe("DROP FUNCTION pg_temp.ledger_repair_raw(jsonb)");

      report = {
        dryRun: opts.dryRun ?? false,
        seconds,
        before,
        after: {
          versions: await count(tx, "source_value_versions"),
          members: await count(tx, "analytics_vintage_members"),
          overwriteEvents: await count(tx, "analytics_overwrite_events"),
        },
        coordinates,
        vintages: manifests.vintages,
        manifestsRewritten: manifests.rewritten,
        rawEvents: { replayed: Number(raw!.events), dropped: Number(raw!.dropped), rewritten: Number(raw!.rewritten), rowsRestored: Number(raw!.restored) },
      };
      log(`after: ${JSON.stringify(report.after)}`);
      if (opts.dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
    log("dry run: rolled back, nothing changed");
  }
  // Fresh statistics for the planner: the tables are a small fraction of what
  // they were. Outside the transaction, and harmless after a dry run.
  if (!opts.dryRun) {
    for (const table of ["source_value_versions", "analytics_vintage_members", "analytics_overwrite_events", "raw_indicator_history"]) {
      await db.unsafe(`ANALYZE public.${table}`);
    }
  }
  return report!;
}

async function main(): Promise<number> {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const url = arg("--database-url") ?? process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("[ledger-repair] no database: pass --database-url, or set MIGRATE_DATABASE_URL");
    return 2;
  }
  process.env.DATABASE_URL ??= url;
  const dryRun = process.argv.includes("--dry-run");
  const startedAt = new Date().toISOString();
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} [ledger-repair] ${line}`);
  const db = postgres(url, { max: 1, onnotice: () => {} });
  let code = 0;
  let note = "";
  try {
    const report = await repairLedger(db, { dryRun, log });
    note = JSON.stringify(report);
    console.log(JSON.stringify(report, null, 2));
    if (!dryRun) {
      // Read-only confirmation on the committed result: both guards armed, and
      // raw_indicator_history agrees with the ledger's heads.
      const { checkAnalyticsLedgerGuard } = await import("../../../src/db/analytics-ledger-guard.ts");
      const { checkAppendOnlyGuard } = await import("../../../src/db/append-only-guard.ts");
      const { checkRawIndicatorHistoryParity } = await import("../../../src/analytics/cutover/parity.ts");
      const ledger = await checkAnalyticsLedgerGuard(db);
      const appendOnly = await checkAppendOnlyGuard(db);
      const parity = await checkRawIndicatorHistoryParity(db);
      log(`analytics ledger guard: ${ledger.status}; append-only guard: ${appendOnly.status}; raw history parity: ${parity.matched ? "matched" : `${parity.mismatches.length} mismatch(es)`}`);
      if (ledger.status !== "armed" || appendOnly.status !== "armed") code = 1;
      if (!parity.matched) {
        for (const m of parity.mismatches.slice(0, 10)) log(`  parity mismatch: ${JSON.stringify(m)}`);
        code = 1;
      }
    }
    log(code === 0 ? (dryRun ? "DRY RUN OK" : "LEDGER REPAIRED") : "LEDGER REPAIRED, CHECKS FAILED");
  } catch (err) {
    console.error(err);
    log("REPAIR FAILED — rolled back, nothing changed");
    code = 1;
  } finally {
    await db.end({ timeout: 5 });
  }
  if (process.argv.includes("--emit-receipt")) {
    const { deriveHostRole, emitReceipt, gitFacts } = await import("../../lib/rollout-receipt.ts");
    const { path } = emitReceipt({
      step: arg("--step") ?? "ledger-repair", exit: code,
      verdict: code === 0 ? (dryRun ? "DRY RUN OK" : "LEDGER REPAIRED") : "LEDGER REPAIR FAILED",
      startedAt, repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role, git: gitFacts(repoRoot, TAG_GLOB), note,
      backupDir: arg("--backup-dir"),
    });
    log(`receipt: ${path}`);
  }
  return code;
}

if (import.meta.main) process.exitCode = await main();
