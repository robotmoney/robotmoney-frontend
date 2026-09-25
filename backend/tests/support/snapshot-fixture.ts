// The pinned earlier snapshot (snapshot N) and the scratch databases the
// schema tests build from it — issue #1026, smoke-production-spec.md §8.4.
//
// TEST SUPPORT ONLY. Three files use it: tests/snapshot-advance.test.ts
// (snapshot N + migrations = snapshot N+1), and the two wave-4 additive-column
// tests (delete-tombstone-columns, spoof-generation-schema), which need a
// database that held rows BEFORE a migration added a column — the only honest
// way to show "NULL on existing rows". A database bootstrapped from snapshot N
// is exactly that: it is at N, rows can be written, and the real migrate run
// then takes it to the current version.
//
// Every database here is created and dropped by the file that asked for it
// (one database per purpose, never a shared one reset by deleting rows).
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { config } from "../../src/config.ts";
import { bootstrapBlankDatabase, loadSnapshot, type Snapshot } from "../../src/db/schema-snapshot.ts";
import { runMigrate, type MigrateRunResult, type MigrateRunSeams } from "../../scripts/migrate-run.ts";
import { withTargetLock } from "./target-lock.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

/** Snapshot N: the fixture directory. Its layout is backend/'s (`schema/...`),
 *  so `loadSnapshot(FIXTURE_N)` reads it like the real one. */
export const FIXTURE_N = join(import.meta.dir, "..", "fixtures", "snapshots", "0083_clear_forged_member_operator");

/** Snapshot N's filename list, as its own metadata records it. */
export function fixtureFilenames(): string[] {
  return (JSON.parse(readFileSync(join(FIXTURE_N, "schema", "snapshot.json"), "utf8")) as { filenames: string[] })
    .filenames;
}

/** The smoke `--migrate` caller against a rehearsal database the test owns. */
const MIGRATE_OPTIONS = {
  caller: "smoke_flag",
  env: "stage",
  connection: "local",
  nonInteractive: true,
} as const;

/**
 * Scratch databases for one test file: created on demand, all dropped by
 * `dropAll()` in the file's afterAll.
 */
export class ScratchDatabases {
  private readonly names: string[] = [];
  private readonly pools: postgres.Sql<{}>[] = [];
  private scratch: string | null = null;

  urlFor(database: string): string {
    const url = new URL(config.databaseUrl);
    url.pathname = `/${database}`;
    return url.toString();
  }

  /** A superuser connection (the test container's login). */
  connect(database: string): postgres.Sql<{}> {
    const pool = postgres(this.urlFor(database), { max: 1, onnotice: () => {} });
    this.pools.push(pool);
    return pool;
  }

  private async create(statement: string, name: string): Promise<void> {
    const admin = postgres(this.urlFor("postgres"), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(statement);
    } finally {
      await admin.end({ timeout: 5 });
    }
    this.names.push(name);
  }

  /** An empty database owned by rm_owner with the provider's pgcrypto — what
   *  §5's `--local blank` hands the bootstrap. The session is `SET ROLE rm_owner`. */
  async blank(name: string): Promise<postgres.Sql<{}>> {
    await this.create(`CREATE DATABASE ${name} OWNER rm_owner`, name);
    const db = this.connect(name);
    await db.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await db.unsafe("SET ROLE rm_owner");
    return db;
  }

  /** A copy of the suite's template: every migration applied from 0001, the
   *  path every production database took. Superuser session. */
  async migrated(name: string): Promise<postgres.Sql<{}>> {
    await this.create(`CREATE DATABASE ${name} TEMPLATE "${process.env.RM_TEST_TEMPLATE_DB}"`, name);
    return this.connect(name);
  }

  /** A directory holding exactly `filenames`, copied from backend/migrations/. */
  migrationsDir(filenames: readonly string[]): string {
    this.scratch ??= mkdtempSync(join(tmpdir(), "rm-snapshot-fixture-"));
    const dir = mkdtempSync(join(this.scratch, "migrations-"));
    for (const name of filenames) copyFileSync(join(MIGRATIONS, name), join(dir, name));
    return dir;
  }

  /** Snapshot N, loaded and verified (content hash, and its filename list
   *  against the migrations it embodies). */
  async snapshotN(): Promise<Snapshot> {
    return loadSnapshot(FIXTURE_N, this.migrationsDir(fixtureFilenames()));
  }

  /** A blank database bootstrapped from snapshot N. The session stays rm_owner. */
  async atSnapshotN(name: string, snapshotN?: Snapshot): Promise<postgres.Sql<{}>> {
    const db = await this.blank(name);
    await bootstrapBlankDatabase(db, snapshotN ?? (await this.snapshotN()));
    return db;
  }

  /** The REAL migrate run (§8.3) on an rm_owner session, under the §2 lock. */
  async migrate(db: postgres.Sql<{}>, name: string, seams: MigrateRunSeams = {}): Promise<MigrateRunResult> {
    return withTargetLock(this.urlFor(name), (lock) => runMigrate(db, { ...MIGRATE_OPTIONS, lock }, seams));
  }

  async dropAll(): Promise<void> {
    for (const pool of this.pools) await pool.end({ timeout: 5 });
    const admin = postgres(this.urlFor("postgres"), { max: 1, onnotice: () => {} });
    try {
      for (const name of this.names) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    if (this.scratch) rmSync(this.scratch, { recursive: true, force: true });
  }
}
