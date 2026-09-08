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

test("rm_owner is non-login owner of every protected table", async () => {
  const roles = await sql<{ tablename: string; tableowner: string }[]>`
    SELECT tablename, tableowner FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename = ANY(${APPEND_ONLY_TABLES as unknown as string[]})`;
  expect(roles).toHaveLength(APPEND_ONLY_TABLES.length);
  expect(roles.every((row) => row.tableowner === "rm_owner")).toBe(true);
  const [owner] = await sql<{ rolcanlogin: boolean }[]>`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner'`;
  expect(owner.rolcanlogin).toBe(false);
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
