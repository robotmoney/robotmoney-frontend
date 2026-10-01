import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createHistoryDatabase } from "./support/history-database.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0057_source_acquisition_ledger.sql";

test("0057 backfills one legacy baseline per current raw row at one migration knowledge time and reapplies idempotently", async () => {
  const history = await createHistoryDatabase("source-ledger-migration", { max: 1 });
  const db = history.db;
  try {
    await db`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files.filter((f) => f < MIGRATION)) {
      await db.begin(async (tx) => {
        if (file >= "0054_rm_worker_allowlist.sql") await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
    }
    await db`INSERT INTO raw_indicator_history (date, indicator, value, source) VALUES
      ('2020-01-01', 'LEGACY_A', 1, 'legacy'), ('2020-01-02', 'LEGACY_B', 2, NULL)`;

    const apply = async () => {
      const [present] = await db`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name=${MIGRATION}) AS yes`;
      if (present.yes) return;
      await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx.unsafe(await readFile(join(migrationsDir, MIGRATION), "utf8"));
        await tx`INSERT INTO schema_migrations (name) VALUES (${MIGRATION})`;
      });
    };
    const beforeFirstApply = Date.now();
    await apply();
    const afterFirstApply = Date.now();
    const afterOne = await db`SELECT source_key, knowledge_time FROM source_value_versions ORDER BY source_key`;
    await apply();
    const rows = await db`
      SELECT source_key, market_date::text, value, acquisition_id, revision_kind, knowledge_time
      FROM source_value_versions ORDER BY source_key`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.revision_kind)).toEqual(["legacy_baseline", "legacy_baseline"]);
    expect(rows.every((r) => r.acquisition_id === null)).toBe(true);
    // One instant, and it is the instant the migration ran. Asserting only
    // "all the same" would pass just as happily on a fabricated constant, which
    // is exactly the kind of invented provenance this table exists to rule out.
    expect(new Set(rows.map((r) => new Date(r.knowledge_time).toISOString())).size).toBe(1);
    const knowledgeTime = new Date(rows[0]!.knowledge_time).getTime();
    expect(knowledgeTime).toBeGreaterThanOrEqual(beforeFirstApply - 1000);
    expect(knowledgeTime).toBeLessThanOrEqual(afterFirstApply + 1000);
    // The second apply is a no-op on the rows themselves: a re-run must not
    // restamp the baseline with a later knowledge time, which would silently
    // rewrite when this was known.
    expect(rows.map((r) => new Date(r.knowledge_time).toISOString()))
      .toEqual(afterOne.map((r) => new Date(r.knowledge_time).toISOString()));
    const [{ acquisitions, fetches, payloads }] = await db`
      SELECT (SELECT count(*) FROM source_acquisitions)::int AS acquisitions,
             (SELECT count(*) FROM source_fetches)::int AS fetches,
             (SELECT count(*) FROM source_payloads)::int AS payloads`;
    expect({ acquisitions, fetches, payloads }).toEqual({ acquisitions: 0, fetches: 0, payloads: 0 });
  } finally {
    await history.drop();
  }
}, 120_000);
