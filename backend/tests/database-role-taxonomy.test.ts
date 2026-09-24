// Database role taxonomy (issue #692), exercised against the real ephemeral
// PostgreSQL harness. Runtime roles must be grantees, never DDL owners.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { APPEND_ONLY_TABLES } from "../src/db/append-only-guard.ts";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const passwords = { rm_app: "rm_app_ci_password", rm_worker: "rm_worker_ci_password", rm_readonly: "rm_readonly_ci_password" };
let app: postgres.Sql<{}>;
let worker: postgres.Sql<{}>;
let readonly: postgres.Sql<{}>;

function urlFor(role: keyof typeof passwords): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.username = role;
  url.password = passwords[role];
  return url.toString();
}

async function denied(query: Promise<unknown>): Promise<string | null> {
  try {
    await query;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

beforeAll(async () => {
  for (const [role, password] of Object.entries(passwords)) {
    await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}'`);
  }
  app = postgres(urlFor("rm_app"), { max: 1, onnotice: () => {} });
  worker = postgres(urlFor("rm_worker"), { max: 1, onnotice: () => {} });
  readonly = postgres(urlFor("rm_readonly"), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await Promise.all([app?.end({ timeout: 5 }), worker?.end({ timeout: 5 }), readonly?.end({ timeout: 5 })]);
});

test("rm_owner owns every protected table, and is a LOGIN role without CREATEROLE", async () => {
  const roles = await sql<{ tablename: string; tableowner: string }[]>`
    SELECT tablename, tableowner FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename = ANY(${APPEND_ONLY_TABLES as unknown as string[]})`;
  expect(roles).toHaveLength(APPEND_ONLY_TABLES.length);
  expect(roles.every((row) => row.tableowner === "rm_owner")).toBe(true);
  // rm_owner is the migration login (spec §3, D47): 0053 creates it LOGIN.
  // Its password is typed per run and never stored, and it never holds
  // CREATEROLE.
  const [owner] = await sql<{ rolcanlogin: boolean; rolcreaterole: boolean }[]>`
    SELECT rolcanlogin, rolcreaterole FROM pg_roles WHERE rolname = 'rm_owner'`;
  expect(owner.rolcanlogin).toBe(true);
  expect(owner.rolcreaterole).toBe(false);
});

test("rm_app and rm_worker cannot disable, drop triggers, or drop protected tables", async () => {
  for (const db of [app, worker]) {
    for (const table of APPEND_ONLY_TABLES) {
      expect(await denied(db.unsafe(`ALTER TABLE public.${table} DISABLE TRIGGER ${table}_append_only`))).toBe("42501");
      expect(await denied(db.unsafe(`DROP TRIGGER ${table}_append_only ON public.${table}`))).toBe("42501");
      expect(await denied(db.unsafe(`DROP TABLE public.${table}`))).toBe("42501");
    }
  }
});

test("rm_readonly can read but cannot write", async () => {
  const [row] = await readonly`SELECT COUNT(*)::int AS count FROM jobs`;
  expect(Number(row.count)).toBeGreaterThanOrEqual(0);
  expect(await denied(readonly`INSERT INTO jobs (kind, payload) VALUES ('role-test', '{}')`)).toBe("42501");
});

test("the bootstrap connection can assume the non-login owner for DDL", async () => {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx.unsafe("CREATE TABLE rm_role_taxonomy_migration_probe (id integer)");
    await tx.unsafe("DROP TABLE rm_role_taxonomy_migration_probe");
  });
});

test("rm_app can trigger overwrite capture but cannot fabricate or mutate evidence directly", async () => {
  const date = "2041-02-01";
  const indicator = "ROLE_CAPTURE_PROBE";
  await sql`
    INSERT INTO raw_indicator_history (date, indicator, value, source)
    VALUES (${date}, ${indicator}, 1, 'seed')`;

  await app`
    UPDATE raw_indicator_history SET value = 2, source = 'live'
    WHERE date = ${date} AND indicator = ${indicator}`;

  const rows = await sql<{
    table_name: string;
    operation: string;
    natural_key: Record<string, unknown>;
    previous_row: Record<string, unknown>;
    replacement_row: Record<string, unknown>;
  }[]>`
    SELECT table_name, operation, natural_key, previous_row, replacement_row
    FROM analytics_overwrite_events
    WHERE table_name = 'raw_indicator_history'
      AND natural_key = ${sql.json({ date, indicator } as never)}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    table_name: "raw_indicator_history",
    operation: "update",
    natural_key: { date, indicator },
    previous_row: { date, indicator, value: 1, source: "seed" },
    replacement_row: { date, indicator, value: 2, source: "live" },
  });

  expect(await denied(app`
    INSERT INTO analytics_overwrite_events
      (table_name, operation, natural_key, previous_row, replacement_row)
    VALUES ('raw_indicator_history', 'delete', '{}', '{}', NULL)`)).toBe("42501");
  expect(await denied(app`UPDATE analytics_overwrite_events SET natural_key = natural_key`)).toBe("42501");
  expect(await denied(app`DELETE FROM analytics_overwrite_events`)).toBe("42501");
  expect(await denied(app`TRUNCATE analytics_overwrite_events`)).toBe("42501");
});
