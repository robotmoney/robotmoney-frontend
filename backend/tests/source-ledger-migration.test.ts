import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import postgres from "postgres";
import { POSTGRES_IMAGE } from "../../scripts/lib/postgres-image.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0057_source_acquisition_ledger.sql";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)); });
  });
}

test("0057 backfills one legacy baseline per current raw row at one migration knowledge time and reapplies idempotently", async () => {
  const port = await freePort();
  const container = `rmtest_source_ledger_migration_${crypto.randomUUID().slice(0, 8)}`;
  const up = Bun.spawnSync(["docker", "run", "-d", "--rm", "--name", container,
    "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
    "-p", `${port}:5432`, POSTGRES_IMAGE]);
  if (up.exitCode !== 0) throw new Error(`source ledger migration test requires Docker+Postgres:\n${up.stderr.toString()}`);
  const db = postgres(`postgres://robotmoney:robotmoney@localhost:${port}/robotmoney`, { max: 1, onnotice: () => {} });
  try {
    const started = Date.now();
    for (;;) {
      try { await db`SELECT 1`; break; }
      catch (error) { if (Date.now() - started > 30_000) throw error; await Bun.sleep(200); }
    }
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
    await apply();
    await apply();
    const rows = await db`
      SELECT source_key, market_date::text, value, acquisition_id, revision_kind, knowledge_time
      FROM source_value_versions ORDER BY source_key`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.revision_kind)).toEqual(["legacy_baseline", "legacy_baseline"]);
    expect(rows.every((r) => r.acquisition_id === null)).toBe(true);
    expect(new Set(rows.map((r) => new Date(r.knowledge_time).toISOString())).size).toBe(1);
    const [{ acquisitions, fetches, payloads }] = await db`
      SELECT (SELECT count(*) FROM source_acquisitions)::int AS acquisitions,
             (SELECT count(*) FROM source_fetches)::int AS fetches,
             (SELECT count(*) FROM source_payloads)::int AS payloads`;
    expect({ acquisitions, fetches, payloads }).toEqual({ acquisitions: 0, fetches: 0, payloads: 0 });
  } finally {
    await db.end({ timeout: 5 });
    Bun.spawnSync(["docker", "rm", "-f", container]);
  }
}, 120_000);
