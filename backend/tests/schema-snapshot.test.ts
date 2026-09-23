// The snapshot (spec §8.1) — the hand-maintained canonical description of the
// schema, and the only way a blank database becomes a working one without
// replaying five years of migrations.
//
// These tests are the specification for src/db/schema-snapshot.ts. Every
// function there throws `NOT IMPLEMENTED` today, so every test here fails —
// #1026 W2 step 2's deliverable.
//
// THE FIXTURE DIRECTORY IS THE POINT OF `loadSnapshot(dir?)`. The module
// documents the override as the same affordance `checkSchemaCurrent(dir)` in
// scripts/schema-current.ts already provides, so these tests build a snapshot
// on disk and point at it instead of depending on `backend/schema/` — which
// W2.5 creates and which does not exist while this file is being written.
//
// The bootstrap tests use a genuinely fresh, unmigrated database on the suite's
// ephemeral Postgres (the pattern tests/db-preflight.test.ts established for the
// same reason): "blank" cannot be produced on the shared migrated database
// without sabotaging every other file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { hashManifest, MANIFEST_FORMAT_VERSION } from "../src/db/schema-manifest.ts";
import {
  PROVIDER_MANAGED_EXCLUSIONS,
  SNAPSHOT_FILES,
  baselineLedger,
  bootstrapBlankDatabase,
  loadSnapshot,
} from "../src/db/schema-snapshot.ts";
import { runPreflight, type PreflightContext } from "../src/db/preflight.ts";
import type { RmRole } from "../src/db/registry.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
const ON_DISK = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

const DECLARATION_SQL = [
  "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());",
  "CREATE TABLE job_schedules (kind text PRIMARY KEY, cron text NOT NULL, enabled boolean NOT NULL DEFAULT false);",
  "CREATE TABLE deployment_identity (identity text NOT NULL, singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton));",
].join("\n");
const BOOTSTRAP_DATA_SQL = "INSERT INTO job_schedules (kind, cron, enabled) VALUES ('swarm.open_session', '0 13 * * 1-5', false);";
const GRANTS_SQL = "GRANT SELECT ON ALL TABLES IN SCHEMA public TO rm_readonly;";

let fixtures = "";

/** Write a complete, valid snapshot into a fresh directory and return its path. */
function writeSnapshot(
  name: string,
  over: Partial<{
    declarationSql: string;
    bootstrapDataSql: string;
    grantsSql: string;
    filenames: readonly string[];
    contentHash: string;
    formatVersion: number;
    omit: keyof typeof SNAPSHOT_FILES;
  }> = {},
): string {
  const dir = join(fixtures, name);
  mkdirSync(join(dir, "schema"), { recursive: true });
  const declarationSql = over.declarationSql ?? DECLARATION_SQL;
  const filenames = over.filenames ?? ON_DISK;

  const parts: [keyof typeof SNAPSHOT_FILES, string][] = [
    ["declaration", declarationSql],
    ["bootstrapData", over.bootstrapDataSql ?? BOOTSTRAP_DATA_SQL],
    ["grants", over.grantsSql ?? GRANTS_SQL],
    [
      "metadata",
      JSON.stringify(
        {
          formatVersion: over.formatVersion ?? MANIFEST_FORMAT_VERSION,
          filenames,
          contentHash: over.contentHash ?? hashManifest({ text: declarationSql }, filenames),
        },
        null,
        2,
      ),
    ],
  ];

  for (const [key, contents] of parts) {
    if (over.omit === key) continue;
    writeFileSync(join(dir, SNAPSHOT_FILES[key]), `${contents}\n`, "utf8");
  }
  return dir;
}

/** A genuinely empty database on the suite's Postgres instance. */
async function withBlankDatabase(body: (db: postgres.Sql<{}>, name: string) => Promise<void>): Promise<void> {
  const base = new URL(config.databaseUrl);
  const name = `rm_snapshot_blank_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end({ timeout: 5 });

  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  const db = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await body(db, name);
  } finally {
    await db.end({ timeout: 5 });
    const cleanup = postgres(base.toString(), { max: 1, onnotice: () => {} });
    await cleanup.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end({ timeout: 5 });
  }
}

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "rm-snapshot-fixtures-"));
});

afterAll(() => {
  if (fixtures) rmSync(fixtures, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// loadSnapshot — the three parts plus their metadata
// ───────────────────────────────────────────────────────────────────────────

describe("loadSnapshot — three parts, three application rules, one identity", () => {
  test("loads the declaration, the bootstrap data and the grants as three separate strings", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("complete"));
    expect(snapshot.declarationSql).toContain("CREATE TABLE schema_migrations");
    expect(snapshot.bootstrapDataSql).toContain("INSERT INTO job_schedules");
    expect(snapshot.grantsSql).toContain("GRANT SELECT ON ALL TABLES");
    // They must not be concatenated: the declaration is "never applied to a
    // populated database" while the grants run on EVERY migrate run, populated
    // or not (§8.1/§8.3). One file would have to obey the stricter rule.
    expect(snapshot.declarationSql).not.toContain("GRANT SELECT ON ALL TABLES");
    expect(snapshot.declarationSql).not.toContain("INSERT INTO job_schedules");
  });

  test("the grants part creates no roles — rm_owner never holds CREATEROLE (§3)", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("no-role-creation"));
    expect(snapshot.grantsSql).not.toMatch(/CREATE\s+ROLE/i);
  });

  test("the filename list is the snapshot's identity, carried through verbatim", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("identity"));
    expect(snapshot.filenames).toEqual(ON_DISK);
    expect(snapshot.manifest.filenames).toEqual(ON_DISK);
    expect(snapshot.manifest.formatVersion).toBe(MANIFEST_FORMAT_VERSION);
  });

  test("the list names BOTH 0059 migrations — a number alone is not an identity", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("two-0059s"));
    const theTwo = snapshot.filenames.filter((f) => f.startsWith("0059_"));
    expect(theTwo.sort()).toEqual([
      "0059_analytics_output_and_report_snapshots.sql",
      "0059_swarm_framework_subject_snapshot_cleanup.sql",
    ]);
  });

  test("the manifest it publishes is already hashed over the declaration and the list", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("hashed"));
    expect(snapshot.manifest.contentHash).toBe(hashManifest(snapshot.manifest.declaration, snapshot.filenames));
  });

  test("refuses when the declaration file is missing", async () => {
    await expect(loadSnapshot(writeSnapshot("no-declaration", { omit: "declaration" }))).rejects.toThrow(
      SNAPSHOT_FILES.declaration,
    );
  });

  test("refuses when the bootstrap-data file is missing", async () => {
    await expect(loadSnapshot(writeSnapshot("no-bootstrap", { omit: "bootstrapData" }))).rejects.toThrow(
      SNAPSHOT_FILES.bootstrapData,
    );
  });

  test("refuses when the grants file is missing", async () => {
    await expect(loadSnapshot(writeSnapshot("no-grants", { omit: "grants" }))).rejects.toThrow(SNAPSHOT_FILES.grants);
  });

  test("refuses when the metadata file is missing", async () => {
    await expect(loadSnapshot(writeSnapshot("no-metadata", { omit: "metadata" }))).rejects.toThrow(
      SNAPSHOT_FILES.metadata,
    );
  });

  test("refuses a contentHash that does not verify against the declaration and the list", async () => {
    await expect(loadSnapshot(writeSnapshot("bad-hash", { contentHash: "0".repeat(64) }))).rejects.toThrow(/hash/i);
  });

  test("refuses a list naming a migration that is not in backend/migrations/", async () => {
    const dir = writeSnapshot("extra-name", { filenames: [...ON_DISK, "9999_imaginary.sql"] });
    await expect(loadSnapshot(dir)).rejects.toThrow("9999_imaginary.sql");
  });

  test("refuses a migration on disk the list does not name — half a change was committed (§8.2)", async () => {
    const dropped = ON_DISK[ON_DISK.length - 1] ?? "";
    const dir = writeSnapshot("missing-name", { filenames: ON_DISK.slice(0, -1) });
    await expect(loadSnapshot(dir)).rejects.toThrow(dropped);
  });

  test("defaults to backend/schema/ when no directory is given", async () => {
    // W2.5 creates those four paths; until it does, the default load refuses by
    // naming the file it could not read, which is the correct message either way.
    const snapshot = await loadSnapshot();
    expect(snapshot.filenames).toEqual(ON_DISK);
  });
});

describe("PROVIDER_MANAGED_EXCLUSIONS — narrow on purpose, because an entry too many is a blind spot", () => {
  test("the list is specific names and extension memberships, and never a §3 taxonomy role", async () => {
    expect(PROVIDER_MANAGED_EXCLUSIONS.roles).toEqual(["doadmin", "postgres"]);
    expect(PROVIDER_MANAGED_EXCLUSIONS.extensions).toEqual(["pgcrypto", "plpgsql"]);
    // Never a pattern: a pattern would silently exempt an application table the
    // day someone names one badly.
    for (const entry of [...PROVIDER_MANAGED_EXCLUSIONS.roles, ...PROVIDER_MANAGED_EXCLUSIONS.extensions]) {
      expect(entry).not.toMatch(/[*%_]$/);
    }
    for (const role of ["rm_owner", "rm_app", "rm_worker", "rm_readonly"]) {
      expect(PROVIDER_MANAGED_EXCLUSIONS.roles as readonly string[]).not.toContain(role);
    }
    // And the snapshot it guards excludes none of the taxonomy's own grants.
    const snapshot = await loadSnapshot(writeSnapshot("exclusions-taxonomy"));
    expect(snapshot.grantsSql).toContain("rm_readonly");
  });

  test("an extension-owned function is skipped by check 3a, resolved through pg_depend deptype 'e'", async () => {
    // The identical test 0053's two ownership loops already use, for the
    // identical reason: re-owning an extension's function fails with "must be
    // owner of function digest" for a non-superuser.
    const rows = await sql<{ proname: string }[]>`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
      JOIN pg_extension e ON e.oid = d.refobjid
      WHERE e.extname = ANY(${[...PROVIDER_MANAGED_EXCLUSIONS.extensions]})`;
    expect(rows.length).toBeGreaterThan(0);

    const snapshot = await loadSnapshot(writeSnapshot("exclusions"));
    for (const row of rows) {
      expect(snapshot.declarationSql).not.toContain(`FUNCTION ${row.proname}`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// bootstrapBlankDatabase / baselineLedger
// ───────────────────────────────────────────────────────────────────────────

describe("bootstrapBlankDatabase — one transaction, blank in, version M out", () => {
  test("applies declaration, bootstrap data and grants, baselines the ledger and publishes the manifest", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("bootstrap-happy"));
    await withBlankDatabase(async (db) => {
      await db.unsafe("SET ROLE rm_owner");
      const result = await bootstrapBlankDatabase(db, snapshot);
      expect(result.baselined).toEqual(snapshot.filenames);
      expect(result.manifest).toEqual(snapshot.manifest);

      const ledger = await db<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
      expect(ledger.map((r) => r.name)).toEqual([...snapshot.filenames].sort());
      const [schedule] = await db<{ kind: string }[]>`SELECT kind FROM job_schedules`;
      expect(schedule?.kind).toBe("swarm.open_session");
    });
  });

  test("writes deployment_identity = rehearsal, never production", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("bootstrap-identity"));
    await withBlankDatabase(async (db) => {
      await db.unsafe("SET ROLE rm_owner");
      await bootstrapBlankDatabase(db, snapshot);
      const rows = await db<{ identity: string }[]>`SELECT identity FROM deployment_identity`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.identity).toBe("rehearsal");
    });
  });

  test("does NOT seed — `--seed` is explicit and never implied by any mode (§5)", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("bootstrap-no-seed"));
    await withBlankDatabase(async (db) => {
      await db.unsafe("SET ROLE rm_owner");
      await bootstrapBlankDatabase(db, snapshot);
      // Only the operational bootstrap row exists. Demo fixtures overwrite by
      // design (`ON CONFLICT DO UPDATE`), so they must not travel with this.
      const [count] = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM job_schedules`;
      expect(count?.count).toBe(1);
    });
  });

  test("a snapshot-created database boots and passes preflight WITHOUT --seed", async () => {
    // Spec §8.4's CI proof, and §10 W2's "snapshot bootstrap boots without
    // `--seed`". The gate is meaningless unless bootstrap never seeds.
    const snapshot = await loadSnapshot(writeSnapshot("bootstrap-preflight"));
    await withBlankDatabase(async (db) => {
      await db.unsafe("SET ROLE rm_owner");
      await bootstrapBlankDatabase(db, snapshot);
      await db.unsafe("RESET ROLE");

      const context: PreflightContext = {
        env: "stage",
        connection: "local",
        roles: ["rm_app"] as readonly RmRole[],
        codeFilenames: snapshot.filenames,
        envFilePath: join(fixtures, "bootstrap-preflight.env"),
      };
      writeFileSync(context.envFilePath, "rm_app=token\n", "utf8");
      const report = await runPreflight(db, context, "container", new Map([["rm_app", "token"]]));
      expect(report.passed).toBe(true);
    });
  });

  test("rolls back entirely on failure — a half-bootstrapped database is unrecoverable by the resume path", async () => {
    const broken = await loadSnapshot(
      writeSnapshot("bootstrap-broken", { bootstrapDataSql: "INSERT INTO table_that_does_not_exist VALUES (1);" }),
    );
    await withBlankDatabase(async (db) => {
      await db.unsafe("SET ROLE rm_owner");
      await expect(bootstrapBlankDatabase(db, broken)).rejects.toThrow();
      const [count] = await db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      expect(count?.count).toBe(0);
    });
  });

  test("refuses a populated database — the declaration is never applied to one", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("bootstrap-populated"));
    // The suite's own database is migrated and therefore populated. Emptiness
    // is the same test scripts/db-preflight.ts uses (information_schema.tables,
    // table_type = 'BASE TABLE'), so the two agree on what "empty" means.
    await expect(bootstrapBlankDatabase(sql, snapshot)).rejects.toThrow(/not blank|populated/i);
  });

  test("refuses when the effective role is not rm_owner", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("bootstrap-not-owner"));
    await withBlankDatabase(async (db) => {
      await expect(bootstrapBlankDatabase(db, snapshot)).rejects.toThrow("rm_owner");
    });
  });

  test("refuses when deployment_identity already says production", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("bootstrap-production"));
    await withBlankDatabase(async (db) => {
      await db.unsafe(`
        CREATE TABLE deployment_identity (identity text NOT NULL,
          singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton))`);
      await db.unsafe("INSERT INTO deployment_identity (identity) VALUES ('production')");
      await db.unsafe("SET ROLE rm_owner");
      await expect(bootstrapBlankDatabase(db, snapshot)).rejects.toThrow("production");
    });
  });
});

describe("baselineLedger — so `--migrate` never replays history", () => {
  test("writes one schema_migrations row per filename in the snapshot's list", async () => {
    await withBlankDatabase(async (db) => {
      await db.unsafe("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
      const written = await baselineLedger(db, ON_DISK);
      expect([...written].sort()).toEqual([...ON_DISK].sort());
      const rows = await db<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
      expect(rows.map((r) => r.name)).toEqual([...ON_DISK].sort());
    });
  });

  test("baselines BOTH 0059s — a high-water number would baseline neither correctly", async () => {
    await withBlankDatabase(async (db) => {
      await db.unsafe("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
      await baselineLedger(db, ON_DISK);
      const rows = await db<{ name: string }[]>`
        SELECT name FROM schema_migrations WHERE name LIKE '0059\\_%' ORDER BY name`;
      expect(rows.map((r) => r.name)).toEqual([
        "0059_analytics_output_and_report_snapshots.sql",
        "0059_swarm_framework_subject_snapshot_cleanup.sql",
      ]);
    });
  });

  test("a following migrate run finds nothing pending", async () => {
    // Replay here is not merely slow, it is destructive: the declaration
    // already created every object those migrations create, and 0053 re-runs
    // ownership sweeps and REVOKE ALL against a reconciled database.
    await withBlankDatabase(async (db) => {
      await db.unsafe("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
      await baselineLedger(db, ON_DISK);
      const applied = new Set((await db<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
      expect(ON_DISK.filter((f) => !applied.has(f))).toEqual([]);
    });
  });

  test("refuses when schema_migrations already holds rows — baselining history makes the ledger lie", async () => {
    await expect(baselineLedger(sql, ON_DISK)).rejects.toThrow(/already|history|rows/i);
  });

  test("refuses a name that is not a file in backend/migrations/", async () => {
    await withBlankDatabase(async (db) => {
      await db.unsafe("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
      await expect(baselineLedger(db, [...ON_DISK, "9999_imaginary.sql"])).rejects.toThrow("9999_imaginary.sql");
    });
  });
});
