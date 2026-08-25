// Direct PostgreSQL 18 execution test for migration 0038. The suite preload has
// already migrated its template, so this clone removes only 0038's objects,
// seeds the exact P0 shape, and executes the migration SQL verbatim.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { AUM_GUARD_TRIGGERS } from "../scripts/upgrades/0.2.2-to-0.3.0/release.ts";
import { checkAppendOnlyIntact } from "../scripts/upgrades/0.2.2-to-0.3.0/postflight.ts";
import { createChecker } from "../scripts/lib/checks.ts";

useCleanDatabase(import.meta.file);

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "0038_wallet_aum_snapshot_foundation.sql",
);
const LEGACY_DAY = "2018-04-03";
const ATTACHED_DAY = "2018-04-04";
const HASH = (digit: string): string => `0x${digit.repeat(64)}`;

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let observed: string | null = null;
  try {
    await action();
  } catch (error) {
    observed = (error as { code?: string }).code ?? null;
  }
  expect(observed).toBe(state);
}

test("0038 preserves P0 evidence, leaves legacy rows unverified, and enforces immutable snapshot identity on PostgreSQL 18", async () => {
  const [server] = await sql<{ major: number }[]>`
    SELECT current_setting('server_version_num')::int / 10000 AS major
  `;
  expect(server!.major).toBe(18);

  await sql.unsafe(`
    DROP TRIGGER wallet_balance_samples_snapshot_final_guard ON wallet_balance_samples;
    DROP TRIGGER wallet_sleeve_samples_snapshot_final_guard ON wallet_sleeve_samples;
    DROP TRIGGER wallet_balance_sample_evidence_snapshot_final_guard ON wallet_balance_sample_evidence;
    DROP TRIGGER wallet_sleeve_sample_evidence_snapshot_final_guard ON wallet_sleeve_sample_evidence;
    ALTER TABLE wallet_balance_samples
      DROP COLUMN snapshot_run_id, DROP COLUMN amount_observed_at,
      DROP COLUMN price_observed_at, DROP COLUMN recorded_at;
    ALTER TABLE wallet_sleeve_samples
      DROP COLUMN snapshot_run_id, DROP COLUMN amount_observed_at,
      DROP COLUMN price_observed_at, DROP COLUMN recorded_at;
    ALTER TABLE wallet_balance_sample_evidence
      DROP COLUMN snapshot_run_id, DROP COLUMN amount_observed_at,
      DROP COLUMN price_observed_at, DROP COLUMN recorded_at;
    ALTER TABLE wallet_sleeve_sample_evidence
      DROP COLUMN snapshot_run_id, DROP COLUMN amount_observed_at,
      DROP COLUMN price_observed_at, DROP COLUMN recorded_at;
    DROP TABLE wallet_aum_snapshot_runs;
    DROP FUNCTION rm_wallet_aum_snapshot_finalize_guard();
    DROP FUNCTION rm_wallet_aum_snapshot_constituent_guard();
    DROP FUNCTION rm_wallet_aum_snapshot_run_guard();
    DROP FUNCTION rm_text_array_is_canonical_set(text[]);
    ALTER TABLE chain_day_blocks DROP CONSTRAINT chain_day_blocks_proof_shape;
    ALTER TABLE chain_day_blocks
      DROP COLUMN block_hash, DROP COLUMN boundary_next_block_number,
      DROP COLUMN boundary_next_block_hash, DROP COLUMN boundary_next_block_timestamp;
  `);

  const [active] = await sql<{ id: string }[]>`
    INSERT INTO wallet_balance_samples
      (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${LEGACY_DAY}, 'USDC', 5, 1, 5, 'live', '2018-04-03T23:59:58Z')
    RETURNING id
  `;
  const [evidence] = await sql<{ evidence_id: string }[]>`
    INSERT INTO wallet_balance_sample_evidence
      (original_id, sample_date, symbol, amount, price_usd, value_usd,
       provenance, sampled_at, evidence_reason)
    VALUES
      (900001, ${LEGACY_DAY}, 'WETH', 2, 3000, 6000,
       'backfilled-quarantined', '2018-04-03T23:59:58Z', 'fixture-p0-evidence')
    RETURNING evidence_id
  `;
  const [activeSleeve] = await sql<{ id: string }[]>`
    INSERT INTO wallet_sleeve_samples
      (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${LEGACY_DAY}, '0xlegacy', 'USDC', 3, 1, 3, 'live', '2018-04-03T23:59:57Z')
    RETURNING id
  `;
  const [evidenceSleeve] = await sql<{ evidence_id: string }[]>`
    INSERT INTO wallet_sleeve_sample_evidence
      (original_id, sample_date, wallet_address, symbol, amount, price_usd,
       value_usd, provenance, sampled_at, evidence_reason)
    VALUES
      (900004, ${LEGACY_DAY}, '0xlegacy', 'WETH', 2, 3000, 6000,
       'backfilled-quarantined', '2018-04-03T23:59:56Z', 'fixture-p0-sleeve-evidence')
    RETURNING evidence_id
  `;
  await sql`
    INSERT INTO chain_day_blocks (sample_date, block_number, block_timestamp)
    VALUES (${LEGACY_DAY}, 100, '2018-04-03T23:59:58Z')
  `;

  const ddl = await readFile(migrationPath, "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(ddl);
  });

  const [legacyActive] = await sql<{
    id: string;
    sampled_at: string;
    snapshot_run_id: string | null;
    amount_observed_at: Date | null;
    price_observed_at: Date | null;
    recorded_at: Date | null;
  }[]>`
    SELECT id, sampled_at::text, snapshot_run_id, amount_observed_at, price_observed_at, recorded_at
      FROM wallet_balance_samples WHERE id = ${active!.id}
  `;
  expect(legacyActive).toEqual({
    id: active!.id,
    sampled_at: "2018-04-03 23:59:58+00",
    snapshot_run_id: null,
    amount_observed_at: null,
    price_observed_at: null,
    recorded_at: null,
  });

  const [legacyEvidence] = await sql<{
    evidence_id: string;
    evidence_reason: string;
    sampled_at: string;
    snapshot_run_id: string | null;
    amount_observed_at: Date | null;
    price_observed_at: Date | null;
    recorded_at: Date | null;
  }[]>`
    SELECT evidence_id, evidence_reason, sampled_at::text, snapshot_run_id,
           amount_observed_at, price_observed_at, recorded_at
      FROM wallet_balance_sample_evidence WHERE evidence_id = ${evidence!.evidence_id}
  `;
  expect(legacyEvidence).toEqual({
    evidence_id: evidence!.evidence_id,
    evidence_reason: "fixture-p0-evidence",
    sampled_at: "2018-04-03 23:59:58+00",
    snapshot_run_id: null,
    amount_observed_at: null,
    price_observed_at: null,
    recorded_at: null,
  });

  const [legacyActiveSleeve] = await sql<{
    id: string;
    sampled_at: string;
    snapshot_run_id: string | null;
    amount_observed_at: Date | null;
    price_observed_at: Date | null;
    recorded_at: Date | null;
  }[]>`
    SELECT id, sampled_at::text, snapshot_run_id,
           amount_observed_at, price_observed_at, recorded_at
      FROM wallet_sleeve_samples WHERE id = ${activeSleeve!.id}
  `;
  expect(legacyActiveSleeve).toEqual({
    id: activeSleeve!.id,
    sampled_at: "2018-04-03 23:59:57+00",
    snapshot_run_id: null,
    amount_observed_at: null,
    price_observed_at: null,
    recorded_at: null,
  });

  const [legacyEvidenceSleeve] = await sql<{
    evidence_id: string;
    sampled_at: string;
    snapshot_run_id: string | null;
    amount_observed_at: Date | null;
    price_observed_at: Date | null;
    recorded_at: Date | null;
  }[]>`
    SELECT evidence_id, sampled_at::text, snapshot_run_id,
           amount_observed_at, price_observed_at, recorded_at
      FROM wallet_sleeve_sample_evidence WHERE evidence_id = ${evidenceSleeve!.evidence_id}
  `;
  expect(legacyEvidenceSleeve).toEqual({
    evidence_id: evidenceSleeve!.evidence_id,
    sampled_at: "2018-04-03 23:59:56+00",
    snapshot_run_id: null,
    amount_observed_at: null,
    price_observed_at: null,
    recorded_at: null,
  });

  const [legacyCache] = await sql<{
    block_hash: string | null;
    boundary_next_block_number: string | null;
    boundary_next_block_hash: string | null;
    boundary_next_block_timestamp: Date | null;
  }[]>`
    SELECT block_hash, boundary_next_block_number, boundary_next_block_hash,
           boundary_next_block_timestamp
      FROM chain_day_blocks WHERE sample_date = ${LEGACY_DAY}
  `;
  expect(legacyCache).toEqual({
    block_hash: null,
    boundary_next_block_number: null,
    boundary_next_block_hash: null,
    boundary_next_block_timestamp: null,
  });

  const guardRows = await sql<{ table_name: string; trigger_name: string; tgenabled: string }[]>`
    SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
       AND c.relname = ANY(${[...new Set(AUM_GUARD_TRIGGERS.map((guard) => guard.table))]})
  `;
  expect(guardRows
    .filter((row) => AUM_GUARD_TRIGGERS.some(
      (guard) => guard.table === row.table_name && guard.trigger === row.trigger_name,
    ))
    .map((row) => `${row.table_name}.${row.trigger_name}:${row.tgenabled}`)
    .sort())
    .toEqual(AUM_GUARD_TRIGGERS
      .map((guard) => `${guard.table}.${guard.trigger}:A`)
      .sort());

  const intact = createChecker("");
  await checkAppendOnlyIntact(sql, intact);
  expect(intact.results.find((result) => result.name === "append-only-intact")?.status).toBe("PASS");
  expect(intact.results.find((result) => result.name === "append-only-intact")?.detail.join(" "))
    .toContain(`all ${AUM_GUARD_TRIGGERS.length} P0/P1 AUM trigger(s)`);

  await sql`ALTER TABLE wallet_aum_snapshot_runs DISABLE TRIGGER wallet_aum_snapshot_runs_finalize`;
  const bypassable = createChecker("");
  await checkAppendOnlyIntact(sql, bypassable);
  expect(bypassable.results.find((result) => result.name === "append-only-intact")?.status).toBe("FAIL");
  expect(bypassable.results.find((result) => result.name === "append-only-intact")?.detail.join(" "))
    .toContain("wallet_aum_snapshot_runs.wallet_aum_snapshot_runs_finalize");
  await sql`ALTER TABLE wallet_aum_snapshot_runs ENABLE ALWAYS TRIGGER wallet_aum_snapshot_runs_finalize`;

  const [unavailable] = await sql<{ run_id: string; snapshot_id: string | null }[]>`
    INSERT INTO wallet_aum_snapshot_runs
      (sample_date, time_basis, state, manifest_version, manifest_json,
       manifest_hash, config_identity, producer_revision_status,
       producer_revision_unavailable_reason, failure_code)
    VALUES
      (${LEGACY_DAY}, 'utc-daily-close', 'unavailable', 'v1', ${sql.json({ version: "v1" })},
       ${"a".repeat(64)}, 'fixture-config', 'unavailable',
       'AUM_PRODUCER_REVISION is unset or blank', 'producer-revision-unavailable')
    RETURNING run_id, snapshot_id
  `;
  expect(unavailable!.snapshot_id).toBeNull();
  await expectSqlState(
    async () => await sql`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, value_usd, provenance, sampled_at, snapshot_run_id)
      VALUES ('2018-04-06', 'USDC', 1, 'backfilled', now(), ${unavailable!.run_id})
    `,
    "23514",
  );

  const [reserved] = await sql<{ run_id: string }[]>`
    SELECT nextval(pg_get_serial_sequence('wallet_aum_snapshot_runs', 'run_id')) AS run_id
  `;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at,
         snapshot_run_id, amount_observed_at, price_observed_at, recorded_at)
      VALUES
        (${ATTACHED_DAY}, 'USDC', 7, 1, 7, 'backfilled', '2018-04-04T23:59:58Z',
         ${reserved!.run_id}, '2018-04-04T23:59:58Z', '2018-04-04T23:59:59Z', '2018-04-05T00:01:00Z')
    `;
    await tx`
      INSERT INTO wallet_sleeve_samples
        (sample_date, wallet_address, symbol, amount, price_usd, value_usd,
         provenance, sampled_at, snapshot_run_id, amount_observed_at,
         price_observed_at, recorded_at)
      VALUES
        (${ATTACHED_DAY}, '0xAaA', 'USDC', 7, 1, 7, 'backfilled', '2018-04-04T23:59:58Z',
         ${reserved!.run_id}, '2018-04-04T23:59:58Z', '2018-04-04T23:59:59Z', '2018-04-05T00:01:00Z')
    `;
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
        (${reserved!.run_id}, ${ATTACHED_DAY}, 'utc-daily-close', 'complete', 'v1', ${tx.json({ version: "v1" })},
         ${"b".repeat(64)}, 'fixture-config', ${"c".repeat(64)},
         ARRAY['USDC'], ARRAY['USDC'], ARRAY['["0xaaa","USDC"]'], ARRAY['["0xaaa","USDC"]'],
         '2018-04-04T23:59:58Z', '2018-04-05T00:01:00Z', 8453, 200, ${HASH("2")},
         '2018-04-04T23:59:58Z', 201, ${HASH("3")}, '2018-04-05T00:00:00Z',
         'available', 'git-fixture-123')
    `;
  });
  const published = reserved!;

  await expectSqlState(
    async () => await sql`
      UPDATE wallet_aum_snapshot_runs SET failure_detail = 'mutation' WHERE run_id = ${published!.run_id}
    `,
    "0A000",
  );
  await expectSqlState(
    async () => await sql`
      UPDATE wallet_balance_samples SET value_usd = 8 WHERE snapshot_run_id = ${published.run_id}
    `,
    "0A000",
  );
  await expectSqlState(
    async () => await sql`
      UPDATE wallet_balance_samples SET snapshot_run_id = NULL,
        amount_observed_at = NULL, price_observed_at = NULL, recorded_at = NULL
       WHERE snapshot_run_id = ${published.run_id}
    `,
    "0A000",
  );
  await expectSqlState(
    async () => await sql`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, value_usd, provenance, sampled_at, snapshot_run_id,
         amount_observed_at, price_observed_at, recorded_at)
      VALUES
        (${ATTACHED_DAY}, 'WETH', 1, 'backfilled', now(), ${published.run_id}, now(), now(), now())
    `,
    "0A000",
  );
  await expectSqlState(
    async () => await sql`
      INSERT INTO wallet_aum_snapshot_runs
        (sample_date, time_basis, state, manifest_version, manifest_json,
         manifest_hash, config_identity, producer_revision_status,
         producer_revision_unavailable_reason, expected_balance_keys)
      VALUES
        ('2018-04-06', 'live', 'unavailable', 'v1', ${sql.json({ version: "v1" })},
         ${"d".repeat(64)}, 'fixture-config', 'unavailable', 'fixture', ARRAY['USDC', 'USDC'])
    `,
    "23514",
  );
  await expectSqlState(
    async () => await sql`
      INSERT INTO wallet_aum_snapshot_runs
        (sample_date, time_basis, state, manifest_version, manifest_json,
         manifest_hash, config_identity, snapshot_id,
         expected_balance_keys, present_balance_keys,
         observed_at, published_at, chain_id, block_number, block_hash,
         block_timestamp, producer_revision_status, producer_revision)
      VALUES
        ('2018-04-07', 'live', 'complete', 'v1', ${sql.json({ version: "v1" })},
         ${"e".repeat(64)}, 'fixture-config', ${"f".repeat(64)},
         ARRAY['USDC'], ARRAY['USDC'], now(), now(), 8453, 300, ${HASH("4")}, now(),
         'available', 'fixture-revision')
    `,
    "23514",
  );
  await expectSqlState(
    async () => await sql`
      INSERT INTO wallet_sleeve_sample_evidence
        (original_id, sample_date, wallet_address, symbol, value_usd,
         provenance, sampled_at, evidence_reason, snapshot_run_id,
         amount_observed_at, price_observed_at, recorded_at)
      VALUES
        (900003, ${ATTACHED_DAY}, '0xaaa', 'USDC', 1, 'backfilled', now(), 'bad-fk', 999999999,
         now(), now(), now())
    `,
    "23503",
  );
});
