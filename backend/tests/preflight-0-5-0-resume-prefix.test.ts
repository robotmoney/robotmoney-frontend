// v0.5.0 preflight's `clean-target` / `clean-target-tables` checks — graded in
// BOTH directions.
//
// WHY THIS FILE EXISTS. Both checks were written on the premise that
// production sat at a clean `0044`, so ANY recorded v0.5.0 migration, and ANY
// existing v0.5.0 table, meant a wrong target. Production does not: migrations
// `0045`-`0048` were applied 2026-09-08T14:43:24Z by an ordinary deploy whose
// build carried them, verified against the replica's `schema_migrations
// .applied_at`. Under the old rule the release could never preflight clean —
// it reported a legitimate, resumable forward state as drift, and the only way
// past it would have been to distrust the gate.
//
// A check that passes everything is no better than the one that failed
// everything (the reason preflight-0-3-0-append-only-safety.test.ts states for
// its own pairing), so every fixture here is asserted in a PAIR: the resumable
// shape must stay green, and the shape `migrate.ts` genuinely cannot produce —
// a GAP in the applied prefix, or an out-of-order record — must turn it red.
//
// Runs against the suite's ephemeral Postgres (tests/preload.ts), building its
// OWN throwaway database per case (the db-preflight.test.ts pattern) so
// nothing here can disturb a sibling test file's fixtures.
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type CheckResult, createChecker } from "../scripts/lib/checks.ts";
import type { Db } from "../scripts/lib/preflight-utils.ts";
import { NEW_RELEASE_TABLES_BY_MIGRATION, PRIOR_RELEASE_MIGRATIONS, RELEASE_MIGRATIONS } from "../scripts/upgrades/0.4.0-to-0.5.0/release.ts";
import { runChecks } from "../scripts/upgrades/0.4.0-to-0.5.0/preflight.ts";

const ADMIN_URL = process.env.DATABASE_URL!;
const V4_TABLES = ["swarm_judge_config", "swarm_session_judgements", "swarm_consensus_receipts"];
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// `no-schema-delta` compares the ledger against the REAL migrations directory,
// so "a fully migrated v0.4.0 database" means every .sql on disk that is not
// part of this release — 0001-0044, not just PRIOR_RELEASE_MIGRATIONS' six.
// Seeding only the six made all 38 earlier files read as unexpected-pending.
let BASELINE: string[] = [];
// The v0.5.0 candidate's migration files: what is on disk minus v0.5.1's.
let V050_FILES: string[] = [];

// v0.5.1's migrations. They are on disk now but were never part of a v0.4.0
// database, so the v0.4.0 baseline must leave them out exactly as it leaves out
// v0.5.0's own. (0062 was applied to production out of band during the 0.5.0
// cycle and is carried by v0.5.1; see docs/runbooks/v0-5-1-rollout.md D6.)
const LATER_RELEASE_MIGRATIONS: readonly string[] = [
  "0061_rm_worker_wallet_backfill_grant.sql",
  "0062_rm_readonly_sequence_select.sql",
  "0063_swarm_judge_model_default.sql",
];

let admin: ReturnType<typeof postgres>;
const made: string[] = [];

beforeAll(async () => {
  const onDisk = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith(".sql")).sort();
  V050_FILES = onDisk.filter((n) => !LATER_RELEASE_MIGRATIONS.includes(n));
  BASELINE = onDisk.filter(
    (n) => !RELEASE_MIGRATIONS.includes(n as (typeof RELEASE_MIGRATIONS)[number]) && !LATER_RELEASE_MIGRATIONS.includes(n),
  );
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  for (const name of made) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  await admin.end();
});

/** A throwaway database whose ledger records exactly `appliedMigrations`, and
 *  whose v0.5.0 tables are exactly those the applied ones create. */
async function fixture(label: string, appliedMigrations: readonly string[], opts: { extraTables?: string[]; dropTables?: string[] } = {}): Promise<CheckResult[]> {
  const name = `rm_pf050_${label}_${Math.random().toString(36).slice(2, 10)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  made.push(name);
  const db = postgres(ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${name}$1`), { max: 1, onnotice: () => {} }) as unknown as Db;

  await db`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const m of appliedMigrations) await db`INSERT INTO schema_migrations (name) VALUES (${m})`;
  for (const t of V4_TABLES) await db.unsafe(`CREATE TABLE ${t} (id int)`);

  const shouldExist = new Set<string>();
  for (const [migration, tables] of Object.entries(NEW_RELEASE_TABLES_BY_MIGRATION)) {
    if (appliedMigrations.includes(migration)) for (const t of tables) shouldExist.add(t);
  }
  for (const t of opts.extraTables ?? []) shouldExist.add(t);
  for (const t of opts.dropTables ?? []) shouldExist.delete(t);
  for (const t of shouldExist) await db.unsafe(`CREATE TABLE ${t} (id int)`);

  const checker = createChecker("");
  await runChecks(db, checker, { roleReadiness: false, migrationFiles: V050_FILES });
  await (db as unknown as ReturnType<typeof postgres>).end();
  return checker.results;
}

const statusOf = (rs: CheckResult[], id: string) => rs.find((r) => r.name === id)?.status;
const detailOf = (rs: CheckResult[], id: string) => JSON.stringify(rs.find((r) => r.name === id)?.detail ?? "");

describe("v0.5.0 preflight clean-target: a gap-free prefix resumes, a gap blocks", () => {
  test("GREEN — nothing applied yet (the original clean-0044 premise still passes)", async () => {
    const rs = await fixture("clean", BASELINE);
    expect(statusOf(rs, "clean-target")).toBe("PASS");
    expect(detailOf(rs, "clean-target")).toContain("no v0.5.0 migration recorded yet");
    expect(statusOf(rs, "clean-target-tables")).toBe("PASS");
  });

  test("GREEN — production's real shape: 0045-0048 applied as a gap-free prefix", async () => {
    const rs = await fixture("resume", [...BASELINE, ...RELEASE_MIGRATIONS.slice(0, 4)]);
    expect(statusOf(rs, "clean-target")).toBe("PASS");
    const detail = detailOf(rs, "clean-target");
    expect(detail).toContain("RESUMING");
    expect(detail).toContain("4 of 18");
    // The still-pending set must be named, not merely counted.
    expect(detail).toContain("0049_swarm_recommendations_signing_key.sql");
    expect(detail).toContain("0061_source_value_provenance.sql");
    // 0045/0046's tables legitimately exist and must NOT read as drift.
    expect(statusOf(rs, "clean-target-tables")).toBe("PASS");
  });

  test("RED — a GAP in the prefix (0045-0048 + 0050, 0049 missing) blocks", async () => {
    const gapped = [...BASELINE, ...RELEASE_MIGRATIONS.slice(0, 4), RELEASE_MIGRATIONS[5]!];
    const rs = await fixture("gap", gapped);
    expect(statusOf(rs, "clean-target")).toBe("FAIL");
    expect(detailOf(rs, "clean-target")).toContain("OUT OF ORDER");
  });

  test("RED — a later migration applied with none of the prefix blocks", async () => {
    const rs = await fixture("tail", [...BASELINE, RELEASE_MIGRATIONS[10]!]);
    expect(statusOf(rs, "clean-target")).toBe("FAIL");
    expect(detailOf(rs, "clean-target")).toContain("OUT OF ORDER");
  });

  test("RED — a PENDING migration's table already exists", async () => {
    // analytics_read_mode belongs to 0060, which is pending here.
    const rs = await fixture("earlytable", [...BASELINE, ...RELEASE_MIGRATIONS.slice(0, 4)], { extraTables: ["analytics_read_mode"] });
    expect(statusOf(rs, "clean-target-tables")).toBe("FAIL");
    expect(detailOf(rs, "clean-target-tables")).toContain("analytics_read_mode");
  });

  test("RED — an APPLIED migration's table is missing (schema disagrees with its own ledger)", async () => {
    const rs = await fixture("losttable", [...BASELINE, ...RELEASE_MIGRATIONS.slice(0, 4)], { dropTables: ["asset_prices"] });
    expect(statusOf(rs, "clean-target-tables")).toBe("FAIL");
    expect(detailOf(rs, "clean-target-tables")).toContain("asset_prices");
  });
});

describe("v0.5.0 preflight no-schema-delta: counts what is pending, not the release size", () => {
  test("a resumed target reports 14 pending, not 18", async () => {
    const rs = await fixture("count", [...BASELINE, ...RELEASE_MIGRATIONS.slice(0, 4)]);
    expect(statusOf(rs, "no-schema-delta")).toBe("PASS");
    // The bug this pins: the old text read RELEASE_MIGRATIONS.length (18) in
    // the same verdict where clean-target reported 4 already applied.
    expect(detailOf(rs, "no-schema-delta")).toContain("14 v0.5.0 migration(s) not yet applied");
    expect(detailOf(rs, "no-schema-delta")).not.toContain("18 v0.5.0 migration(s) not yet applied");
  });

  test("an untouched target still reports the full 18", async () => {
    const rs = await fixture("count18", BASELINE);
    expect(detailOf(rs, "no-schema-delta")).toContain("18 v0.5.0 migration(s) not yet applied");
  });
});

test("the baseline ledger really is a fully-migrated v0.4.0 (guards the fixture itself)", () => {
  // If this drifts, every case above silently degrades into "everything is
  // unexpectedly pending" rather than testing what it claims to.
  for (const m of PRIOR_RELEASE_MIGRATIONS) expect(BASELINE).toContain(m);
  for (const m of RELEASE_MIGRATIONS) expect(BASELINE).not.toContain(m);
  expect(BASELINE.at(-1)).toBe(PRIOR_RELEASE_MIGRATIONS.at(-1));
});
