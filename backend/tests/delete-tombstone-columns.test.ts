// The D55 (6) tombstone columns are additive — issue #1026, migrations 0084,
// 0085 and 0086, smoke-production-spec.md §8.4.
//
// D55 (6): "only `rm_owner` may `DELETE` or `TRUNCATE`", and every runtime
// delete becomes "a tombstone column that every read filters on, a read that
// filters out expired rows ... or an upsert that replaces the row in place".
// Wave 4 adds only the columns; wave 5 (w5-owner-only-deletes,
// w5-wallet-samples-upsert) switches the code and revokes the DELETE. Between
// the two, §8.4's additive rule binds: code built before the columns must keep
// working against a database that has them. This file proves, against real
// databases:
//
//   1. each column exists, nullable with no default, on all three paths a
//      database reaches the current version by: a blank bootstrap from
//      backend/schema/, the full migration replay (the suite's template), and
//      snapshot N + the real migrate run;
//   2. rows that existed BEFORE the migration read NULL after it — shown on a
//      database bootstrapped from the pinned snapshot N
//      (tests/fixtures/snapshots/), given rows, then migrated;
//   3. today's statements (copied from the code that runs them, each cited)
//      still run, as the role that runs them, and leave the new columns NULL;
//   4. the tombstone writes wave 5 will make are possible for the role that
//      will make them, with no new privilege, and the published-snapshot guard
//      (rm_wallet_aum_snapshot_constituent_guard, 0038) permits
//      `superseded_at` on a row that is not part of a published run and refuses
//      it on one that is.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { bootstrapBlankDatabase, loadSnapshot } from "../src/db/schema-snapshot.ts";
import { ScratchDatabases } from "./support/snapshot-fixture.ts";

const suffix = crypto.randomUUID().slice(0, 8);
const dbs = new ScratchDatabases();

/** Every tombstone column wave 4 adds: table, column. */
const TOMBSTONES: readonly (readonly [string, string])[] = [
  ["admin_session", "revoked_at"],
  ["admin_passkey", "revoked_at"],
  ["admin_webauthn_challenge", "consumed_at"],
  ["wallet_balance_samples", "superseded_at"],
  ["wallet_sleeve_samples", "superseded_at"],
];

let fresh: postgres.Sql<{}>;
let migrated: postgres.Sql<{}>;
let advanced: postgres.Sql<{}>;

const DAY = "2019-03-01";
const HASH = (digit: string): string => `0x${digit.repeat(64)}`;

beforeAll(async () => {
  fresh = await dbs.blank(`rm_tomb_fresh_${suffix}`);
  await bootstrapBlankDatabase(fresh, await loadSnapshot());
  await fresh.unsafe("RESET ROLE");

  migrated = await dbs.migrated(`rm_tomb_migrated_${suffix}`);

  // Snapshot N predates every tombstone column: write one row per table there,
  // then run the real migrate, which applies 0079 onward.
  const name = `rm_tomb_advanced_${suffix}`;
  advanced = await dbs.atSnapshotN(name);
  await advanced.unsafe(`
    INSERT INTO admin_session (token, expires_at) VALUES ('pre-session', now() + interval '1 day');
    INSERT INTO admin_passkey (id, public_key, counter, transports) VALUES ('pre-passkey', '\\x01', 0, '{}');
    INSERT INTO admin_webauthn_challenge (flow, challenge, expires_at)
      VALUES ('authentication', 'pre-challenge', now() + interval '5 minutes');
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, value_usd, provenance, sampled_at)
      VALUES ('${DAY}', 'PRE', 1, 1, 'live', now());
    INSERT INTO wallet_sleeve_samples (sample_date, wallet_address, symbol, amount, value_usd, provenance, sampled_at)
      VALUES ('${DAY}', '0x00000000000000000000000000000000000000aa', 'PRE', 1, 1, 'live', now());`);
  const run = await dbs.migrate(advanced, name);
  expect(run.applied).toContain("0086_wallet_sample_superseded_at.sql");
  await advanced.unsafe("RESET ROLE");
}, 180_000);

afterAll(async () => {
  await dbs.dropAll();
});

async function columnShape(db: postgres.Sql<{}>, table: string, column: string) {
  const [row] = (await db`
    SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, ad.adbin IS NOT NULL AS has_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attrelid = ${`public.${table}`}::regclass AND a.attname = ${column} AND NOT a.attisdropped`) as unknown as {
    type: string;
    not_null: boolean;
    has_default: boolean;
  }[];
  return row ?? null;
}

/** Run `body` as `role` in a transaction that always rolls back. */
async function asRole<T>(db: postgres.Sql<{}>, role: string, body: (tx: postgres.TransactionSql<{}>) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db
    .begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      result = await body(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return result as T;
}
class Rollback extends Error {}

async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-sqlstate";
  }
}

describe("each tombstone column exists on every path to the current version (spec §8.4)", () => {
  for (const [table, column] of TOMBSTONES) {
    test(`${table}.${column} is a nullable timestamptz with no default — blank bootstrap, full replay, snapshot N + migrate`, async () => {
      for (const db of [fresh, migrated, advanced]) {
        expect(await columnShape(db, table, column)).toEqual({ type: "timestamp with time zone", not_null: false, has_default: false });
      }
    });
  }

  test("the live-row partial unique indexes exist on the wallet samples, keyed like the total constraints", async () => {
    for (const db of [fresh, migrated, advanced]) {
      const rows = (await db`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN ('wallet_balance_samples_live_key', 'wallet_sleeve_samples_live_key')
        ORDER BY indexname`) as unknown as { indexname: string; indexdef: string }[];
      expect(rows.map((r) => r.indexdef)).toEqual([
        "CREATE UNIQUE INDEX wallet_balance_samples_live_key ON public.wallet_balance_samples USING btree (sample_date, symbol) WHERE (superseded_at IS NULL)",
        "CREATE UNIQUE INDEX wallet_sleeve_samples_live_key ON public.wallet_sleeve_samples USING btree (sample_date, wallet_address, symbol) WHERE (superseded_at IS NULL)",
      ]);
    }
  });

  test("the migrations are compat: additive in the ledger the real migrate run wrote", async () => {
    const rows = (await advanced`
      SELECT name, compat FROM schema_migrations
      WHERE name IN ('0084_admin_revocation_tombstones.sql', '0085_webauthn_challenge_consumed_at.sql',
                     '0086_wallet_sample_superseded_at.sql')
      ORDER BY name`) as unknown as { name: string; compat: string }[];
    expect(rows.map((r) => r.compat)).toEqual(["additive", "additive", "additive"]);
  });
});

describe("rows written before the migration read NULL after it", () => {
  test("every pre-existing row's tombstone is NULL — live, as it was", async () => {
    const counts = (await advanced.unsafe(`
      SELECT 'admin_session' AS t, count(*) FILTER (WHERE revoked_at IS NULL) AS nulls, count(*) AS total FROM admin_session
      UNION ALL SELECT 'admin_passkey', count(*) FILTER (WHERE revoked_at IS NULL), count(*) FROM admin_passkey
      UNION ALL SELECT 'admin_webauthn_challenge', count(*) FILTER (WHERE consumed_at IS NULL), count(*) FROM admin_webauthn_challenge
      UNION ALL SELECT 'wallet_balance_samples', count(*) FILTER (WHERE superseded_at IS NULL), count(*) FROM wallet_balance_samples
      UNION ALL SELECT 'wallet_sleeve_samples', count(*) FILTER (WHERE superseded_at IS NULL), count(*) FROM wallet_sleeve_samples
    `)) as unknown as { t: string; nulls: string; total: string }[];
    for (const row of counts) {
      expect({ table: row.t, total: Number(row.total) > 0, nulls: row.nulls }).toEqual({ table: row.t, total: true, nulls: row.total });
    }
  });
});

describe("today's statements still work against the new columns (additive, spec §8.4)", () => {
  test("rm_app's admin session, passkey and challenge statements run unchanged and leave the tombstones NULL", async () => {
    // Statements copied from the code that runs them as rm_app, against the
    // migration-built database every production database is.
    const outcome = await asRole(migrated, "rm_app", async (tx) => {
      // src/api/routes/admin-webauthn.ts, the sign-in: passkey registered,
      // session minted.
      await tx`INSERT INTO admin_passkey (id, public_key, counter, transports) VALUES ('pk-old-code', ${Buffer.from([1])}, 0, ${["usb"]})`;
      await tx`UPDATE admin_passkey SET counter = 1, last_used_at = now() WHERE id = 'pk-old-code'`;
      await tx`INSERT INTO admin_session (token, expires_at) VALUES ('tok-old-code', now() + interval '1 day')`;
      // src/api/auth.ts: the session check.
      const session = await tx`SELECT 1 FROM admin_session WHERE token = 'tok-old-code' AND expires_at > now()`;
      const tombstones = await tx`
        SELECT (SELECT revoked_at FROM admin_session WHERE token = 'tok-old-code') AS session,
               (SELECT revoked_at FROM admin_passkey WHERE id = 'pk-old-code') AS passkey`;
      // src/api/routes/admin-webauthn.ts storeChallenge / consumeChallenge.
      await tx`DELETE FROM admin_webauthn_challenge WHERE expires_at <= now()`;
      await tx`INSERT INTO admin_webauthn_challenge (flow, challenge, expires_at) VALUES ('authentication', 'ch-old-code', now() + interval '5 minutes')`;
      const challengeTombstone = await tx`SELECT consumed_at FROM admin_webauthn_challenge WHERE challenge = 'ch-old-code'`;
      const consumed = await tx`
        DELETE FROM admin_webauthn_challenge
        WHERE flow = 'authentication' AND challenge = 'ch-old-code' AND expires_at > now()
        RETURNING challenge`;
      // src/api/routes/admin.ts, the password change: revoke everything.
      await tx`DELETE FROM admin_passkey`;
      await tx`DELETE FROM admin_session`;
      return { session: session.length, tombstones: tombstones[0], challengeTombstone: challengeTombstone[0], consumed: consumed.length };
    });
    expect(outcome).toEqual({
      session: 1,
      tombstones: { session: null, passkey: null },
      challengeTombstone: { consumed_at: null },
      consumed: 1,
    });
  });

  test("rm_worker's wallet upserts and the repair pass's delete-and-insert run unchanged and leave superseded_at NULL", async () => {
    const outcome = await asRole(migrated, "rm_worker", async (tx) => {
      // src/worker/handlers/wallet.ts sampleWalletBalances / sampleWalletSleeves,
      // twice, so the second write takes the ON CONFLICT path: the total
      // constraint is still the arbiter, not the partial index.
      for (const amount of [1, 2]) {
        await tx`
          INSERT INTO wallet_balance_samples
            (sample_date, symbol, amount, value_usd, provenance, strategy_nav_idle_only, sampled_at)
          VALUES (${DAY}, 'OLDCODE', ${amount}, ${amount}, 'live', false, now())
          ON CONFLICT (sample_date, symbol) DO UPDATE SET
            amount = EXCLUDED.amount, value_usd = EXCLUDED.value_usd, provenance = EXCLUDED.provenance,
            strategy_nav_idle_only = EXCLUDED.strategy_nav_idle_only, sampled_at = EXCLUDED.sampled_at`;
        await tx`
          INSERT INTO wallet_sleeve_samples
            (sample_date, wallet_address, symbol, amount, value_usd, provenance, sampled_at)
          VALUES (${DAY}, '0x00000000000000000000000000000000000000bb', 'OLDCODE', ${amount}, ${amount}, 'live', now())
          ON CONFLICT (sample_date, wallet_address, symbol) DO UPDATE SET
            amount = EXCLUDED.amount, value_usd = EXCLUDED.value_usd, provenance = EXCLUDED.provenance,
            sampled_at = EXCLUDED.sampled_at`;
      }
      const upserted = await tx`
        SELECT (SELECT count(*)::int FROM wallet_balance_samples WHERE sample_date = ${DAY} AND symbol = 'OLDCODE') AS balance_rows,
               (SELECT amount::int FROM wallet_balance_samples WHERE sample_date = ${DAY} AND symbol = 'OLDCODE') AS balance_amount,
               (SELECT superseded_at FROM wallet_balance_samples WHERE sample_date = ${DAY} AND symbol = 'OLDCODE') AS balance_tombstone,
               (SELECT superseded_at FROM wallet_sleeve_samples WHERE sample_date = ${DAY} AND symbol = 'OLDCODE') AS sleeve_tombstone`;
      // src/ops/wallet-backfill.ts, the repair pass: delete the day, re-insert.
      await tx`DELETE FROM wallet_balance_samples WHERE sample_date = ${DAY}`;
      await tx`DELETE FROM wallet_sleeve_samples WHERE sample_date = ${DAY}`;
      await tx`
        INSERT INTO wallet_balance_samples (sample_date, symbol, amount, value_usd, provenance, sampled_at)
        VALUES (${DAY}, 'OLDCODE', 3, 3, 'backfilled', now())`;
      const repaired = await tx`SELECT amount::int AS amount, superseded_at FROM wallet_balance_samples WHERE sample_date = ${DAY}`;
      return { upserted: upserted[0], repaired: [...repaired] };
    });
    expect(outcome).toEqual({
      upserted: { balance_rows: 1, balance_amount: 2, balance_tombstone: null, sleeve_tombstone: null },
      repaired: [{ amount: 3, superseded_at: null }],
    });
  });
});

describe("the tombstone writes wave 5 makes need no new privilege", () => {
  test("rm_app revokes a session and a passkey by UPDATE, and a challenge is consumed once by a conditional UPDATE", async () => {
    const outcome = await asRole(migrated, "rm_app", async (tx) => {
      await tx`INSERT INTO admin_session (token, expires_at) VALUES ('tok-new-code', now() + interval '1 day')`;
      await tx`INSERT INTO admin_passkey (id, public_key, counter, transports) VALUES ('pk-new-code', ${Buffer.from([1])}, 0, '{}')`;
      await tx`UPDATE admin_session SET revoked_at = now() WHERE revoked_at IS NULL`;
      await tx`UPDATE admin_passkey SET revoked_at = now() WHERE revoked_at IS NULL`;
      const live = await tx`
        SELECT 1 FROM admin_session WHERE token = 'tok-new-code' AND expires_at > now() AND revoked_at IS NULL`;
      await tx`INSERT INTO admin_webauthn_challenge (flow, challenge, expires_at) VALUES ('registration', 'ch-new-code', now() + interval '5 minutes')`;
      const consume = () => tx`
        UPDATE admin_webauthn_challenge SET consumed_at = now()
        WHERE flow = 'registration' AND challenge = 'ch-new-code' AND expires_at > now() AND consumed_at IS NULL
        RETURNING challenge`;
      const first = await consume();
      const second = await consume();
      return { live: live.length, first: first.length, second: second.length };
    });
    expect(outcome).toEqual({ live: 0, first: 1, second: 0 });
  });

  test("rm_worker supersedes a live sample by UPDATE, and the upsert wave 5 writes revives it in place", async () => {
    const outcome = await asRole(migrated, "rm_worker", async (tx) => {
      await tx`
        INSERT INTO wallet_balance_samples (sample_date, symbol, amount, value_usd, provenance, sampled_at)
        VALUES (${DAY}, 'SUPERSEDE', 1, 1, 'live', now())`;
      await tx`UPDATE wallet_balance_samples SET superseded_at = now() WHERE sample_date = ${DAY} AND symbol = 'SUPERSEDE'`;
      const live = await tx`
        SELECT count(*)::int AS n FROM wallet_balance_samples
        WHERE sample_date = ${DAY} AND symbol = 'SUPERSEDE' AND superseded_at IS NULL`;
      // The upsert wave 5 writes brings the row back to life in place.
      await tx`
        INSERT INTO wallet_balance_samples (sample_date, symbol, amount, value_usd, provenance, sampled_at)
        VALUES (${DAY}, 'SUPERSEDE', 2, 2, 'backfilled', now())
        ON CONFLICT (sample_date, symbol) DO UPDATE SET
          amount = EXCLUDED.amount, value_usd = EXCLUDED.value_usd, superseded_at = NULL`;
      const revived = await tx`
        SELECT amount::int AS amount, superseded_at FROM wallet_balance_samples WHERE sample_date = ${DAY} AND symbol = 'SUPERSEDE'`;
      return { liveAfterSupersede: live[0]!.n, revived: [...revived] };
    });
    expect(outcome).toEqual({ liveAfterSupersede: 0, revived: [{ amount: 2, superseded_at: null }] });
  });

  test("the published-snapshot guard permits superseded_at on a row outside a published run and refuses it inside one", async () => {
    // A published run built as tests/aum-snapshot-foundation-migration.test.ts
    // builds one: the constituents are written first against a reserved
    // run_id (the FK is DEFERRABLE INITIALLY DEFERRED), then the header in
    // state 'complete'. Superuser session, rolled back.
    const day = "2019-03-02";
    const outcome = await asRole(migrated, "rm_owner", async (tx) => {
      const [reserved] = (await tx`
        SELECT nextval(pg_get_serial_sequence('wallet_aum_snapshot_runs', 'run_id'))::text AS run_id`) as unknown as {
        run_id: string;
      }[];
      const runId = reserved!.run_id;
      await tx`
        INSERT INTO wallet_balance_samples
          (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at,
           snapshot_run_id, amount_observed_at, price_observed_at, recorded_at)
        VALUES (${day}, 'USDC', 7, 1, 7, 'backfilled', '2019-03-02T23:59:58Z',
                ${runId}, '2019-03-02T23:59:58Z', '2019-03-02T23:59:59Z', '2019-03-03T00:01:00Z')`;
      await tx`
        INSERT INTO wallet_sleeve_samples
          (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at,
           snapshot_run_id, amount_observed_at, price_observed_at, recorded_at)
        VALUES (${day}, '0xAaA', 'USDC', 7, 1, 7, 'backfilled', '2019-03-02T23:59:58Z',
                ${runId}, '2019-03-02T23:59:58Z', '2019-03-02T23:59:59Z', '2019-03-03T00:01:00Z')`;
      // Not yet published: the run header does not exist, so the guard allows it.
      await tx`SAVEPOINT before_unpublished`;
      const unpublished = await sqlState(() => tx`UPDATE wallet_sleeve_samples SET superseded_at = now() WHERE snapshot_run_id = ${runId}`);
      await tx`ROLLBACK TO SAVEPOINT before_unpublished`;
      // A legacy row with no run: allowed.
      await tx`
        INSERT INTO wallet_balance_samples (sample_date, symbol, amount, value_usd, provenance, sampled_at)
        VALUES (${day}, 'LEGACY', 1, 1, 'live', now())`;
      const legacy = await sqlState(() => tx`UPDATE wallet_balance_samples SET superseded_at = now() WHERE sample_date = ${day} AND symbol = 'LEGACY'`);
      await tx`
        INSERT INTO wallet_aum_snapshot_runs
          (run_id, sample_date, time_basis, state, manifest_version, manifest_json,
           manifest_hash, config_identity, snapshot_id,
           expected_balance_keys, present_balance_keys,
           expected_sleeve_keys, present_sleeve_keys,
           observed_at, published_at, chain_id, block_number, block_hash,
           block_timestamp, boundary_next_block_number, boundary_next_block_hash,
           boundary_next_block_timestamp, producer_revision_status, producer_revision)
        VALUES
          (${runId}, ${day}, 'utc-daily-close', 'complete', 'v1', ${tx.json({ version: "v1" })},
           ${"b".repeat(64)}, 'fixture-config', ${"c".repeat(64)},
           ARRAY['USDC'], ARRAY['USDC'], ARRAY['["0xaaa","USDC"]'], ARRAY['["0xaaa","USDC"]'],
           '2019-03-02T23:59:58Z', '2019-03-03T00:01:00Z', 8453, 200, ${HASH("2")},
           '2019-03-02T23:59:58Z', 201, ${HASH("3")}, '2019-03-03T00:00:00Z',
           'available', 'git-fixture-123')`;
      await tx`SAVEPOINT before_published`;
      const published = await sqlState(() => tx`UPDATE wallet_balance_samples SET superseded_at = now() WHERE snapshot_run_id = ${runId}`);
      await tx`ROLLBACK TO SAVEPOINT before_published`;
      return { unpublished, legacy, published };
    });
    expect(outcome).toEqual({ unpublished: null, legacy: null, published: "0A000" });
  });

  test("no runtime role gained DELETE or TRUNCATE on a tombstoned table from these migrations", async () => {
    // The blank bootstrap is grants.sql's word on the intended privileges
    // (cause B of schema-equivalence.test.ts is the migrated side's leftover
    // 0053 DELETE, revoked in wave 5). rm_worker's wallet DELETE is 0054's,
    // held until wave 5 revokes it with the repair pass's rewrite.
    const rows = (await fresh`
      SELECT t AS table, r AS role
      FROM unnest(${TOMBSTONES.map(([table]) => table)}::text[]) AS t, unnest(ARRAY['rm_app', 'rm_readonly']) AS r
      WHERE has_table_privilege(r, 'public.' || t, 'DELETE') OR has_table_privilege(r, 'public.' || t, 'TRUNCATE')`) as unknown as {
      table: string;
      role: string;
    }[];
    expect(rows).toEqual([]);
    const worker = (await fresh`
      SELECT t AS table FROM unnest(${TOMBSTONES.map(([table]) => table)}::text[]) AS t
      WHERE has_table_privilege('rm_worker', 'public.' || t, 'DELETE') OR has_table_privilege('rm_worker', 'public.' || t, 'TRUNCATE')
      ORDER BY t`) as unknown as { table: string }[];
    expect(worker.map((r) => r.table)).toEqual(["wallet_balance_samples", "wallet_sleeve_samples"]);
  });
});
