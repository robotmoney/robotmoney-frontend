// X2 of docs/plans/merge-0-5-x-into-main.md: production's migration history
// and main's unapplied migrations meet cleanly.
//
// WHY THIS FILE EXISTS. The 0.5.x -> main merge carries TWO migration
// histories under one directory. Production (v0.5.2, cut from releases-0.5.x)
// has recorded one set of files; main added its judge migrations
// (0056_swarm_judge_requires_model … 0059_swarm_judgement_completion_usage) and
// a second 0062 (`0062_rm_worker_analytics_ledger_read_grant`) that production
// has never seen, and the merge adds 0081 (the bare judge model id, X3). The
// runner applies unrecorded files in filename order, so on production's next
// boot those files run INTERLEAVED BEHIND files that were applied weeks
// earlier — an order no fresh database ever sees.
//
// So this proves, against a real Postgres, both halves of X2:
//   1. a database migrated with EXACTLY production's v0.5.2 file set, carrying
//      production's judge config (enforce, `opencode/deepseek-v4-flash` from
//      0063), then migrated with the full merged directory, SUCCEEDS; and
//   2. it ends with the SAME schema (tables, columns, constraints, indexes,
//      triggers, table grants) as a database migrated fresh from 0001.
//
// Production's set is taken from the upgrade tooling that shipped it (R13):
// every file below 0039 (v0.4.0's baseline, which 0.4.0-to-0.5.0 certifies by
// its last six), plus each release's PRIOR/RELEASE lists through v0.5.2.
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrationFile } from "../src/db/migrate.ts";
import {
  PRIOR_RELEASE_MIGRATIONS as V051_RECORDED,
  RELEASE_MIGRATIONS as V052,
} from "../scripts/upgrades/0.5.1-to-0.5.2/release.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { POST_V052_MIGRATIONS } from "./support/post-v052-migrations.ts";

useCleanDatabase(import.meta.file);

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const DB_URL = process.env.DATABASE_URL;
// Loud, never skipped: without tests/preload.ts there is no Postgres to migrate.
if (!DB_URL) throw new Error("DATABASE_URL is unset — tests/preload.ts must provision the ephemeral Postgres first");

/** The files production has NOT recorded at v0.5.2 (see the support module). */
const NOT_IN_PRODUCTION = POST_V052_MIGRATIONS;

type Db = ReturnType<typeof postgres>;
let admin: Db;
const made: { name: string; db: Db }[] = [];
let onDisk: string[] = [];
let production: string[] = [];

function urlFor(database: string): string {
  const url = new URL(DB_URL!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function freshDatabase(label: string): Promise<Db> {
  const name = `tmp_mig_merge_${label}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const db = postgres(urlFor(name), { max: 1, onnotice: () => {} });
  made.push({ name, db });
  await db`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  return db;
}

/** What migrate() does: every file on disk not yet recorded, in filename order. */
async function migrateRemaining(db: Db): Promise<string[]> {
  const applied = new Set((await db<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const now: string[] = [];
  for (const file of onDisk) {
    if (applied.has(file)) continue;
    await applyMigrationFile(db, file);
    now.push(file);
  }
  return now;
}

/** The schema, as sorted text rows, with nothing a database name or an OID leaks into. */
async function schemaOf(db: Db): Promise<Record<string, string[]>> {
  const rows = async (q: Promise<Record<string, unknown>[]>) =>
    (await q).map((r) => Object.values(r).map((v) => String(v)).join(" | ")).sort();
  return {
    tables: await rows(db`
      SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public'`),
    columns: await rows(db`
      SELECT table_name, column_name, data_type, udt_name, is_nullable, coalesce(column_default, '') AS d,
             coalesce(character_maximum_length::text, '') AS len
        FROM information_schema.columns WHERE table_schema = 'public'`),
    constraints: await rows(db`
      SELECT c.conrelid::regclass::text AS rel, c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public'`),
    indexes: await rows(db`
      SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`),
    triggers: await rows(db`
      SELECT event_object_table, trigger_name, event_manipulation, action_timing, action_statement
        FROM information_schema.triggers WHERE trigger_schema = 'public'`),
    functions: await rows(db`
      SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS body
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`),
    grants: await rows(db`
      SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND grantee LIKE 'rm\\_%'`),
    sequenceGrants: await rows(db`
      SELECT c.relname, a.privilege_type, r.rolname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
             LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
       WHERE n.nspname = 'public' AND c.relkind = 'S' AND r.rolname LIKE 'rm\\_%'`),
  };
}

let upgraded: Db;
let fresh: Db;
let appliedOnUpgrade: string[] = [];

beforeAll(async () => {
  admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  onDisk = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const recorded = new Set<string>([...V051_RECORDED, ...V052]);
  production = onDisk.filter((f) => f < "0039" || recorded.has(f));

  // Production at v0.5.2, then what it looked like on 2026-09-25: the judge on
  // with 0063's provider-qualified model.
  upgraded = await freshDatabase("prod");
  for (const file of production) await applyMigrationFile(upgraded, file);
  await upgraded`UPDATE swarm_judge_config SET mode = 'enforce', model = 'opencode/deepseek-v4-flash' WHERE id = 1`;
  appliedOnUpgrade = await migrateRemaining(upgraded);

  fresh = await freshDatabase("fresh");
  await migrateRemaining(fresh);
}, 300_000);

afterAll(async () => {
  for (const { name, db } of made) {
    await db.end({ timeout: 5 }).catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  }
  await admin?.end({ timeout: 5 });
});

describe("X2 — production's v0.5.2 migration history meets the merged directory", () => {
  test("production's recorded set is on disk, and exactly the named files are not in it", () => {
    for (const f of [...V051_RECORDED, ...V052]) expect(onDisk).toContain(f);
    expect(onDisk.filter((f) => !production.includes(f))).toEqual([...NOT_IN_PRODUCTION]);
  });

  test("the upgrade applies exactly the files production lacks, in filename order", () => {
    expect(appliedOnUpgrade).toEqual([...NOT_IN_PRODUCTION]);
  });

  test("both databases record every file on disk", async () => {
    for (const db of [upgraded, fresh]) {
      const names = (await db<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`).map((r) => r.name);
      expect(names).toEqual(onDisk);
    }
  });

  test("the upgraded database has the same schema as a fresh one", async () => {
    const [a, b] = [await schemaOf(upgraded), await schemaOf(fresh)];
    for (const key of Object.keys(b)) {
      expect({ [key]: a[key] }).toEqual({ [key]: b[key] });
    }
    // Not vacuous: the judge columns main added are present in both.
    expect(a.columns.some((c) => c.startsWith("swarm_judge_config | policy_updated_at"))).toBe(true);
    expect(a.columns.some((c) => c.startsWith("swarm_session_judgements | usage_cost_usd"))).toBe(true);
  });

  test("X3 — the judge keeps its mode and ends on the bare model id, on both paths", async () => {
    const [u] = await upgraded`SELECT mode, model FROM swarm_judge_config WHERE id = 1`;
    expect(u).toEqual({ mode: "enforce", model: "deepseek-v4-flash" });
    const [f] = await fresh`SELECT model FROM swarm_judge_config WHERE id = 1`;
    expect(f!.model).toBe("deepseek-v4-flash");
  });
});
