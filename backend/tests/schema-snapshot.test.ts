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
import { runPreflight, type PreflightContext, type PreflightReport } from "../src/db/preflight.ts";
import type { RmRole } from "../src/db/registry.ts";
import { SCHEDULES } from "../src/db/seed.ts";
import { LEDGER_FAMILIES } from "../src/db/analytics-ledger-guard.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
const ON_DISK = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

const DECLARATION_SQL = [
  "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());",
  "CREATE TABLE job_schedules (kind text PRIMARY KEY, cron text NOT NULL, enabled boolean NOT NULL DEFAULT false);",
  // `kind`, per spec §4.2 and migration 0063 — the fixture declares the same
  // column the real declaration does.
  "CREATE TABLE deployment_identity (kind text NOT NULL, singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton));",
  // 0032's append-only guard, on the one table this fixture declares that is in
  // APPEND_ONLY_TABLES. The fixture's filename list claims to embody every
  // migration on disk, 0032 included, so a declaration WITHOUT these triggers
  // is a snapshot that lies about its own version — and preflight check 3a is
  // right to call that drift. Declaring them is the honest fix; deleting the
  // check's subject from the fixture would not be.
  "CREATE FUNCTION rm_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$\n" +
    "BEGIN\n" +
    "  RAISE EXCEPTION 'table \"%\" is append-only: row deletion is not permitted (%).', TG_TABLE_NAME, TG_OP\n" +
    "    USING ERRCODE = '0A000';\n" +
    "END;\n" +
    "$guard$;",
  "CREATE TRIGGER schema_migrations_append_only BEFORE DELETE OR TRUNCATE ON schema_migrations" +
    " FOR EACH STATEMENT EXECUTE FUNCTION rm_append_only_guard();",
  "ALTER TABLE schema_migrations ENABLE ALWAYS TRIGGER schema_migrations_append_only;",
  "CREATE TRIGGER schema_migrations_append_only_row BEFORE DELETE ON schema_migrations" +
    " FOR EACH ROW EXECUTE FUNCTION rm_append_only_guard();",
  "ALTER TABLE schema_migrations ENABLE ALWAYS TRIGGER schema_migrations_append_only_row;",
].join("\n");
const BOOTSTRAP_DATA_SQL = "INSERT INTO job_schedules (kind, cron, enabled) VALUES ('vault.sample_share_price', '0 * * * *', true);";
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

/**
 * A genuinely empty database on the suite's Postgres instance.
 *
 * OWNED BY `rm_owner`, which is not a detail. Since Postgres 15 the `public`
 * schema is owned by `pg_database_owner` and carries CREATE for that role
 * alone, so a database created under the suite's superuser leaves `rm_owner`
 * with no CREATE on `public` at all: every `SET ROLE rm_owner` bootstrap below
 * would fail on its first `CREATE TABLE`, and the failure would read as a
 * defect in the snapshot rather than in the fixture. `OWNER rm_owner` makes
 * the fixture match what §5's `--local blank` actually hands the bootstrap —
 * a database the schema owner owns.
 */
async function withBlankDatabase(body: (db: postgres.Sql<{}>, name: string) => Promise<void>): Promise<void> {
  const base = new URL(config.databaseUrl);
  const name = `rm_snapshot_blank_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
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

/** The password the preflight case below hands `checkRoleTokens`. Preflight
 *  check 1 is "Every role token smoke will hand to a container authenticates"
 *  (§7), which it answers by actually logging in — so the fixture has to make
 *  the credential real rather than assert about a password nobody set. Role
 *  attributes are a property of the CLUSTER, not of any one database, so this
 *  holds for the blank databases created below. */
const RM_APP_PASSWORD = "rm_app_snapshot_password";

beforeAll(async () => {
  fixtures = mkdtempSync(join(tmpdir(), "rm-snapshot-fixtures-"));
  await sql.unsafe(`ALTER ROLE rm_app WITH LOGIN PASSWORD '${RM_APP_PASSWORD}'`);
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

  test("the list names EVERY 0059 migration — a number alone is not an identity", async () => {
    // Derived from disk, never written down: the subject of this case is that
    // the filename list is the identity and the number is not, so a literal
    // pair here would be the very mistake it is testing against. Three files
    // are numbered 0059 today; a fourth must not need this test edited.
    const snapshot = await loadSnapshot(writeSnapshot("many-0059s"));
    const expected = ON_DISK.filter((f) => f.startsWith("0059_")).sort();
    expect(expected.length).toBeGreaterThan(1);
    expect(snapshot.filenames.filter((f) => f.startsWith("0059_")).sort()).toEqual(expected);
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
      expect(schedule?.kind).toBe("vault.sample_share_price");
    });
  });

  test("writes deployment_identity = rehearsal, never production", async () => {
    const snapshot = await loadSnapshot(writeSnapshot("bootstrap-identity"));
    await withBlankDatabase(async (db) => {
      await db.unsafe("SET ROLE rm_owner");
      await bootstrapBlankDatabase(db, snapshot);
      const rows = await db<{ kind: string }[]>`SELECT kind FROM deployment_identity`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("rehearsal");
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
      writeFileSync(context.envFilePath, `rm_app=${RM_APP_PASSWORD}\n`, "utf8");
      const report = await runPreflight(db, context, "container", new Map([["rm_app", RM_APP_PASSWORD]]));
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
        CREATE TABLE deployment_identity (kind text NOT NULL,
          singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton))`);
      await db.unsafe("INSERT INTO deployment_identity (kind) VALUES ('production')");
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

  test("baselines EVERY 0059 — a high-water number would baseline none of them correctly", async () => {
    // The expectation comes from disk for the same reason the assertion exists:
    // "0059" is not a version, the filenames are. A literal list here would go
    // stale the next time a migration reuses the number, which is exactly the
    // event this case is supposed to survive.
    const expected = ON_DISK.filter((f) => f.startsWith("0059_")).sort();
    expect(expected.length).toBeGreaterThan(1);
    await withBlankDatabase(async (db) => {
      await db.unsafe("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
      await baselineLedger(db, ON_DISK);
      const rows = await db<{ name: string }[]>`
        SELECT name FROM schema_migrations WHERE name LIKE '0059\\_%' ORDER BY name`;
      expect(rows.map((r) => r.name)).toEqual(expected);
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

// ───────────────────────────────────────────────────────────────────────────
// THE REAL SNAPSHOT — backend/schema/, not a fixture
// ───────────────────────────────────────────────────────────────────────────
//
// Everything above runs on a three-table fixture, which proves the MECHANISM.
// It cannot prove the thing §10 W2 actually asks for: that the snapshot this
// repository ships bootstraps a blank database which then passes a real
// preflight without `--seed`. These cases load `loadSnapshot()` with no
// directory — the four files under backend/schema/ — and apply them.
//
// PREFLIGHT RUNS AS rm_app, in the `full` scope. The container scope skips
// checks 4-6, and a superuser handle answers every catalog question as the one
// role that can see everything. rm_app is the role the api boots under.
//
// WHAT CHECK 2 CAN AND CANNOT SEE HERE. Its denylist half (superuser,
// CREATEROLE, rm_owner membership, ownership, DDL, append-only DELETE/TRUNCATE)
// is exercised against the real grants. Its "required" half reads the query
// registry, and this process registers no queries, so that half has nothing to
// check. Stated rather than hidden.

/**
 * Bootstrap the REAL snapshot into a blank database owned by rm_owner, then
 * hand `body` both the owner-side handle and an rm_app login to it.
 *
 * pgcrypto is installed first, as the superuser, because the snapshot's header
 * says it is provider-managed: "a managed cluster installs it and rm_owner may
 * not". Installing it is the provider's half of a blank database, not a
 * shortcut past the snapshot.
 */
async function withRealBootstrap(
  body: (ctx: { owner: postgres.Sql<{}>; app: postgres.Sql<{}>; snapshot: Awaited<ReturnType<typeof loadSnapshot>> }) => Promise<void>,
): Promise<void> {
  const snapshot = await loadSnapshot();
  await withBlankDatabase(async (owner, name) => {
    await owner.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await owner.unsafe("SET ROLE rm_owner");
    await bootstrapBlankDatabase(owner, snapshot);
    await owner.unsafe("RESET ROLE");

    const url = new URL(config.databaseUrl);
    url.pathname = `/${name}`;
    url.username = "rm_app";
    url.password = RM_APP_PASSWORD;
    const app = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      await body({ owner, app, snapshot });
    } finally {
      await app.end({ timeout: 5 });
    }
  });
}

async function fullPreflightAsApp(
  app: postgres.Sql<{}>,
  snapshot: Awaited<ReturnType<typeof loadSnapshot>>,
  envName: string,
): Promise<PreflightReport> {
  const context: PreflightContext = {
    env: "stage",
    connection: "local",
    roles: ["rm_app"] as readonly RmRole[],
    codeFilenames: snapshot.filenames,
    envFilePath: join(fixtures, `${envName}.env`),
  };
  writeFileSync(context.envFilePath, `rm_app=${RM_APP_PASSWORD}\n`, "utf8");
  return runPreflight(app, context, "full", new Map([["rm_app", RM_APP_PASSWORD]]));
}

/** Every finding, flattened, so a failure prints what refused rather than `false`. */
function findings(report: PreflightReport): string[] {
  return report.results.flatMap((r) => r.findings.map((f) => `${f.severity} ${f.check}: ${f.message}`));
}

describe("the real snapshot (backend/schema/) — bootstrap, preflight, bootstrap data, grid columns", () => {
  test("the real snapshot bootstraps and passes full preflight without --seed", async () => {
    await withRealBootstrap(async ({ owner, app, snapshot }) => {
      const [who] = (await app`SELECT current_user AS role`) as unknown as { role: string }[];
      expect(who?.role).toBe("rm_app");

      // No --seed: the ledger is the snapshot's list and the identity is the
      // one a blank bootstrap writes (§4.2).
      const ledger = await owner<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
      expect(ledger.map((r) => r.name)).toEqual([...snapshot.filenames].sort());
      const identity = await owner<{ kind: string }[]>`SELECT kind FROM deployment_identity`;
      expect(identity.map((r) => r.kind)).toEqual(["rehearsal"]);

      const report = await fullPreflightAsApp(app, snapshot, "real-preflight");
      expect(findings(report).filter((f) => f.startsWith("refuse"))).toEqual([]);
      expect(report.passed).toBe(true);

      // All six checks ran — the full scope, not the container's three.
      expect(report.results.map((r) => r.check)).toEqual([
        "roles_authenticate",
        "privileges",
        "schema_integrity",
        "schema_compatibility",
        "env_credentials",
        "env_identity",
        "subject_epoch_durations",
      ]);

      // RECORDED, NOT HIDDEN: check 6 had no subject to check. The bootstrap
      // data seeds no subject, so on a blank database check 6 passes because
      // there is nothing to refuse. The next case gives it a subject.
      const [subjects] = (await app`SELECT count(*)::int AS n FROM swarm_subjects`) as unknown as { n: number }[];
      expect(subjects?.n).toBe(0);
    });
  });

  test("check 6 passes again with a subject to check — every column from the declaration, none from a seed", async () => {
    await withRealBootstrap(async ({ app, snapshot }) => {
      // The minimal insert the admin route makes: it names no scheduling
      // column, so all three come from the schema declaration (§2.3, criterion
      // 81's "from the schema declaration").
      await app`INSERT INTO swarm_subjects (id, name) VALUES ('grid-subject', 'Grid Subject')`;
      const [subject] = (await app`
        SELECT status, epoch_duration_seconds, epoch_anchor, judging_duration_seconds
          FROM swarm_subjects WHERE id = 'grid-subject'`) as unknown as {
        status: string;
        epoch_duration_seconds: number;
        epoch_anchor: Date;
        judging_duration_seconds: number;
      }[];
      expect(subject?.status).toBe("active");
      expect(subject?.epoch_duration_seconds).toBe(3600);
      expect(subject?.epoch_anchor.toISOString()).toBe("1970-01-01T00:00:00.000Z");
      expect(subject?.judging_duration_seconds).toBe(900);

      const report = await fullPreflightAsApp(app, snapshot, "real-preflight-subject");
      expect(findings(report).filter((f) => f.startsWith("refuse"))).toEqual([]);
      expect(report.passed).toBe(true);
    });
  });

  test("every subject carries all three scheduling columns, and NULL or non-positive is refused, not treated as disabled", async () => {
    await withRealBootstrap(async ({ owner }) => {
      const columns = await owner<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
        SELECT column_name, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'swarm_subjects'
           AND column_name IN ('epoch_duration_seconds', 'epoch_anchor', 'judging_duration_seconds')
         ORDER BY column_name`;
      expect(columns.map((c) => ({ column: c.column_name, nullable: c.is_nullable, defaulted: c.column_default !== null })))
        .toEqual([
          { column: "epoch_anchor", nullable: "NO", defaulted: true },
          { column: "epoch_duration_seconds", nullable: "NO", defaulted: true },
          { column: "judging_duration_seconds", nullable: "NO", defaulted: true },
        ]);
      // No enable column: §2.4 "There is no on/off state for scheduling."
      const enable = await owner<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'swarm_subjects'
           AND column_name ~ '(enabled|schedul|paused|disabled)'`;
      expect(enable.map((c) => c.column_name)).toEqual([]);

      const refused = async (statement: string): Promise<string | null> => {
        try {
          await owner.unsafe(statement);
          return null;
        } catch (error) {
          return (error as { code?: string }).code ?? "no-sqlstate";
        }
      };
      // 23502 not_null_violation, 23514 check_violation.
      expect({
        nullDuration: await refused("INSERT INTO swarm_subjects (id, name, epoch_duration_seconds) VALUES ('a', 'a', NULL)"),
        zeroDuration: await refused("INSERT INTO swarm_subjects (id, name, epoch_duration_seconds) VALUES ('b', 'b', 0)"),
        nullAnchor: await refused("INSERT INTO swarm_subjects (id, name, epoch_anchor) VALUES ('c', 'c', NULL)"),
        nullJudging: await refused("INSERT INTO swarm_subjects (id, name, judging_duration_seconds) VALUES ('d', 'd', NULL)"),
        zeroJudging: await refused("INSERT INTO swarm_subjects (id, name, judging_duration_seconds) VALUES ('e', 'e', 0)"),
        negativeJudging: await refused("INSERT INTO swarm_subjects (id, name, judging_duration_seconds) VALUES ('f', 'f', -1)"),
      }).toEqual({
        nullDuration: "23502",
        zeroDuration: "23514",
        nullAnchor: "23502",
        nullJudging: "23502",
        zeroJudging: "23514",
        negativeJudging: "23514",
      });
    });
  });

  test("a reconciliation run on a populated database changes no subject's scheduling columns", async () => {
    await withRealBootstrap(async ({ owner, app, snapshot }) => {
      await app`
        INSERT INTO swarm_subjects (id, name, epoch_duration_seconds, epoch_anchor, judging_duration_seconds)
        VALUES ('populated', 'Populated', 86400, '2026-09-01T22:45:00Z', 1800)`;
      // What every migrate run applies, "always, even with nothing pending" (§8.3).
      await owner.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx.unsafe(snapshot.grantsSql);
      });
      const [row] = (await app`
        SELECT epoch_duration_seconds, epoch_anchor, judging_duration_seconds
          FROM swarm_subjects WHERE id = 'populated'`) as unknown as {
        epoch_duration_seconds: number;
        epoch_anchor: Date;
        judging_duration_seconds: number;
      }[];
      expect({
        duration: row?.epoch_duration_seconds,
        anchor: row?.epoch_anchor.toISOString(),
        judging: row?.judging_duration_seconds,
      }).toEqual({ duration: 86400, anchor: "2026-09-01T22:45:00.000Z", judging: 1800 });
    });
  });

  test("reconciliation never widens an immutable analytics ledger past SELECT, INSERT — every family, every run", async () => {
    await withRealBootstrap(async ({ owner, app, snapshot }) => {
      // Derived from the guard's own inventory, never written down here: a
      // family added later must be covered by grants.sql's insert-only list or
      // this case goes red.
      const ledgers = LEDGER_FAMILIES.flatMap((family) => [...family.tables]).sort();
      expect(ledgers.length).toBeGreaterThan(10);

      const privileges = async () =>
        (await owner`
          SELECT t AS ledger,
                 has_table_privilege('rm_app', 'public.' || t, 'SELECT')    AS app_select,
                 has_table_privilege('rm_app', 'public.' || t, 'INSERT')    AS app_insert,
                 has_table_privilege('rm_app', 'public.' || t, 'UPDATE')    AS app_update,
                 has_table_privilege('rm_app', 'public.' || t, 'DELETE')    AS app_delete,
                 has_table_privilege('rm_app', 'public.' || t, 'TRUNCATE')  AS app_truncate,
                 has_table_privilege('rm_worker', 'public.' || t, 'UPDATE')   AS worker_update,
                 has_table_privilege('rm_worker', 'public.' || t, 'DELETE')   AS worker_delete,
                 has_table_privilege('rm_worker', 'public.' || t, 'TRUNCATE') AS worker_truncate
            FROM unnest(${ledgers}::text[]) AS t
           ORDER BY t`) as unknown as Record<string, unknown>[];
      const expected = ledgers.map((ledger) => ({
        ledger,
        app_select: true,
        app_insert: true,
        app_update: false,
        app_delete: false,
        app_truncate: false,
        worker_update: false,
        worker_delete: false,
        worker_truncate: false,
      }));

      // After the bootstrap's own reconciliation, and after a second run — the
      // "always, even with nothing pending" run every migrate performs (§8.3).
      expect(await privileges()).toEqual(expected);
      await owner.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx.unsafe(snapshot.grantsSql);
      });
      expect(await privileges()).toEqual(expected);

      // And the refusal is the GRANT's, not the trigger's: 42501 from the
      // executor, before the immutability trigger (P0001) could run.
      const refused = await app
        .unsafe("UPDATE source_acquisitions SET cache_identity = cache_identity")
        .then(() => null, (error: { code?: string }) => error.code ?? "no-sqlstate");
      expect(refused).toBe("42501");
    });
  });

  test("D51: one final take per (session, member) under a race, and rm_app may UPDATE only `final`", async () => {
    await withRealBootstrap(async ({ owner, app }) => {
      // The minimum a take needs: a subject, a member and a session.
      await owner`INSERT INTO swarm_subjects (id, name) VALUES ('final-subject', 'Final Subject')`;
      await owner`INSERT INTO swarm_members (id, name, handle) VALUES ('final-member', 'Final Member', 'final-member')`;
      const [session] = (await owner`
        INSERT INTO swarm_sessions (subject_id, state) VALUES ('final-subject', 'collecting')
        RETURNING id`) as unknown as { id: string }[];
      const take = (revision: number, final: boolean) => `
        INSERT INTO swarm_recommendations
          (session_id, member_id, subject_id, date, nonce, stance, payload, signature, revision, final)
        VALUES ('${session!.id}', 'final-member', 'final-subject', CURRENT_DATE, 'nonce-${revision}', 'hold',
                '{}'::jsonb, 'sig-${revision}', ${revision}, ${final})`;
      await app.unsafe(take(1, true));

      const code = async (run: () => Promise<unknown>): Promise<string | null> => {
        try {
          await run();
          return null;
        } catch (error) {
          return (error as { code?: string }).code ?? "no-sqlstate";
        }
      };

      // Content is never rewritten: every column but `final` is refused by
      // grant, as rm_app, over a real login.
      expect({
        stance: await code(() => app.unsafe("UPDATE swarm_recommendations SET stance = 'sell'")),
        payload: await code(() => app.unsafe(`UPDATE swarm_recommendations SET payload = '{"x":1}'::jsonb`)),
        signature: await code(() => app.unsafe("UPDATE swarm_recommendations SET signature = 'forged'")),
        revision: await code(() => app.unsafe("UPDATE swarm_recommendations SET revision = 9")),
        final: await code(() => app.unsafe("UPDATE swarm_recommendations SET final = true WHERE revision = 1")),
      }).toEqual({ stance: "42501", payload: "42501", signature: "42501", revision: "42501", final: null });

      // Two racing amendments. Each unsets the member's current final take and
      // inserts its own as final, in its own transaction, on its own
      // connection. The partial unique index serializes them: whichever commits
      // second meets the first's final row and is refused.
      const url = new URL(config.databaseUrl);
      url.pathname = `/${(await owner`SELECT current_database() AS db`)[0]!.db}`;
      url.username = "rm_app";
      url.password = RM_APP_PASSWORD;
      const racer = postgres(url.toString(), { max: 1, onnotice: () => {} });
      try {
        let releaseFirst!: () => void;
        const firstHolds = new Promise<void>((resolve) => (releaseFirst = resolve));
        let firstInserted!: () => void;
        const inserted = new Promise<void>((resolve) => (firstInserted = resolve));

        const first = app.begin(async (tx) => {
          await tx.unsafe("UPDATE swarm_recommendations SET final = false WHERE final AND member_id = 'final-member'");
          await tx.unsafe(take(2, true));
          firstInserted();
          await firstHolds;
        });
        await inserted;
        const second = code(() =>
          racer.begin(async (tx) => {
            // Blocks on the first transaction's row lock, then sees its final
            // row once it commits.
            await tx.unsafe("UPDATE swarm_recommendations SET final = false WHERE final AND member_id = 'final-member'");
            await tx.unsafe(take(3, true));
          }),
        );
        // Release the first only once the second is provably WAITING on it —
        // otherwise the two run one after the other, which is an ordinary
        // amendment and not the race this case is about.
        for (let attempt = 0; ; attempt++) {
          const [waiting] = (await owner`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND usename = 'rm_app' AND wait_event_type = 'Lock'`) as unknown as {
            n: number;
          }[];
          if ((waiting?.n ?? 0) > 0) break;
          if (attempt > 200) throw new Error("the second amendment never blocked on the first");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        releaseFirst();
        await first;
        const secondOutcome = await second;
        // Under READ COMMITTED the loser's UPDATE re-checks the row it waited
        // on, finds it no longer final, unsets nothing, and its INSERT then
        // meets the winner's final row: 23505 on the partial index. The loser
        // wrote nothing.
        expect(secondOutcome).toBe("23505");
      } finally {
        await racer.end({ timeout: 5 });
      }

      const rows = (await owner`
        SELECT revision, final FROM swarm_recommendations
         WHERE session_id = ${session!.id} AND member_id = 'final-member' ORDER BY revision`) as unknown as {
        revision: number;
        final: boolean;
      }[];
      expect(rows).toEqual([
        { revision: 1, final: false },
        { revision: 2, final: true },
      ]);
    });
  });

  test("bootstrap data is exactly seed.ts's SCHEDULES: vault, wallet, buyback and project rows, and no swarm or session row", async () => {
    await withRealBootstrap(async ({ owner }) => {
      const rows = await owner<
        { kind: string; cron: string; enabled: boolean; timezone: string; payload: unknown; catchup_policy: string }[]
      >`SELECT kind, cron, enabled, timezone, payload, catchup_policy FROM job_schedules ORDER BY kind, cron`;
      const actual = rows.map((r) => ({ ...r, payload: JSON.parse(JSON.stringify(r.payload)) }));
      const expected = SCHEDULES.map((s) => ({
        kind: s.kind,
        cron: s.cron,
        enabled: s.enabled,
        timezone: s.timezone,
        payload: s.payload,
        catchup_policy: s.catchupPolicy ?? "all",
      })).sort((a, b) => (a.kind === b.kind ? a.cron.localeCompare(b.cron) : a.kind < b.kind ? -1 : 1));
      // Set equality in both directions, every column the seed writes: the
      // bootstrap data and the seed are two writers of the same rows, and
      // nothing else pins one to the other.
      expect(actual).toEqual(expected);

      // §8.1's named families, each present and enabled.
      const kinds = new Set(rows.filter((r) => r.enabled).map((r) => r.kind));
      for (const family of ["vault.", "wallet.", "buybacks.", "projects."]) {
        expect({ family, present: [...kinds].some((k) => k.startsWith(family)) }).toEqual({ family, present: true });
      }

      // "There are no session schedule rows" (§8.1), and no session at all.
      expect(rows.filter((r) => r.kind.startsWith("swarm."))).toEqual([]);
      const [sessions] = (await owner`SELECT count(*)::int AS n FROM swarm_sessions`) as unknown as { n: number }[];
      expect(sessions?.n).toBe(0);
      const [recommendations] = (await owner`
        SELECT count(*)::int AS n FROM swarm_recommendations`) as unknown as { n: number }[];
      expect(recommendations?.n).toBe(0);
    });
  });
});
