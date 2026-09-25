// §9.1 step 2, the production baseline — criterion 75 (D52).
//
//   "Baseline — compare production's live schema with the snapshot for its
//    installed filename list. Any difference is repaired by a migration first;
//    the first `bun run migrate` publishes a manifest only when the live schema
//    matches."
//
// Spec §10 W2: "Production baseline: a live schema that differs from the
// snapshot blocks the first manifest publication."
//
// Driven through the REAL migrate run (`runMigrate`, backend/scripts/
// migrate-run.ts) as the operator's `bun run migrate` drives it — caller
// `operator`, `RM_ENV=prod`, a remote connection, a database enrolled as
// production, logged in AS rm_owner, under the §2 target lock — against
// databases with NO manifest, which is exactly production before §9.1 step 2.
// Each database is its own (one per case, from a blank or from the template),
// never a shared one reset between cases.
//
// The cases:
//   - a database that IS the snapshot (bootstrapped from it, its manifest
//     removed) publishes its first manifest, and says it baselined;
//   - the same database with one column dropped refuses, naming the column,
//     and publishes nothing — red control for the case above;
//   - a database built by REPLAYING the migrations as this harness's superuser
//     refuses, naming the one thing it carries that the snapshot does not (that
//     login's default privileges) — the migration-built shape production has;
//   - a ledger that never recorded 0053 (production's actual ledger: 0053 and
//     0062 were applied through psql) refuses BEFORE anything is applied,
//     naming 0053, and publishes nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { readManifest } from "../src/db/schema-manifest.ts";
import { bootstrapBlankDatabase, loadSnapshot } from "../src/db/schema-snapshot.ts";
import { runMigrate } from "../scripts/migrate-run.ts";
import { withTargetLock } from "./support/target-lock.ts";

const OWNER_PASSWORD = randomBytes(18).toString("base64url");
const OWNER = { name: "rm_owner", password: OWNER_PASSWORD };
const LOGIN = new URL(config.databaseUrl).username;
let ownerCanLogin = true;

function urlFor(database: string, role?: { name: string; password: string }): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = encodeURIComponent(role.password);
  }
  return url.toString();
}

function connect(database: string, role?: { name: string; password: string }): postgres.Sql<{}> {
  return postgres(urlFor(database, role), { max: 1, onnotice: () => {} });
}

beforeAll(async () => {
  const [row] = await sql<{ rolcanlogin: boolean }[]>`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner'`;
  ownerCanLogin = row?.rolcanlogin ?? true;
  await sql.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
});

afterAll(async () => {
  // rm_owner is cluster-wide: put back the attribute this file found.
  await sql.unsafe(`ALTER ROLE rm_owner ${ownerCanLogin ? "LOGIN" : "NOLOGIN"} PASSWORD NULL`);
});

/** A database of its own: blank-and-bootstrapped from the snapshot, or a clone of the migration-built template. */
async function withDatabase(
  shape: "snapshot" | "migrations",
  body: (dbs: { admin: postgres.Sql<{}>; owner: postgres.Sql<{}>; name: string }) => Promise<void>,
): Promise<void> {
  const name = `rm_baseline_${shape}_${randomBytes(4).toString("hex")}`;
  const maintenance = connect("postgres");
  if (shape === "snapshot") {
    await maintenance.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
  } else {
    await maintenance.unsafe(`CREATE DATABASE ${name} TEMPLATE "${process.env.RM_TEST_TEMPLATE_DB}"`);
  }
  const admin = connect(name);
  const owner = connect(name, OWNER);
  try {
    if (shape === "snapshot") {
      // pgcrypto is on the snapshot's provider exclusion list: a managed
      // cluster installs it, rm_owner may not.
      await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      const bootstrapper = connect(name, OWNER);
      try {
        await bootstrapBlankDatabase(bootstrapper, await loadSnapshot());
      } finally {
        await bootstrapper.end({ timeout: 5 });
      }
      // Production before §9.1 step 2: no manifest at all.
      await admin.unsafe("DELETE FROM schema_manifest");
    }
    // Enrolled as production (§9.1 step 4 has run; step 2 has not).
    await admin.unsafe("DELETE FROM deployment_identity");
    await admin.unsafe("INSERT INTO deployment_identity (kind) VALUES ('production')");
    await body({ admin, owner, name });
  } finally {
    await owner.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
    await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await maintenance.end({ timeout: 5 });
  }
}

/** The operator's run, as `bun run migrate` performs it against production. */
function operatorRun(owner: postgres.Sql<{}>, name: string): ReturnType<typeof runMigrate> {
  return withTargetLock(urlFor(name), (lock) =>
    runMigrate(owner, { caller: "operator", env: "prod", connection: "remote", nonInteractive: true, lock }),
  );
}

async function ledger(db: postgres.Sql<{}>): Promise<string[]> {
  return (await db<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`).map((r) => r.name);
}

describe("§9.1 step 2 — the first manifest is published only over a live schema that matches the snapshot", () => {
  test("a database that IS the snapshot publishes its first manifest, and the result says it baselined", async () => {
    await withDatabase("snapshot", async ({ admin, owner, name }) => {
      expect(await readManifest(admin)).toBeNull();
      const snapshot = await loadSnapshot();
      const result = await operatorRun(owner, name);
      expect(result.baselined).toBe(true);
      expect(result.applied).toEqual([]);
      expect(result.manifest.contentHash).toBe(snapshot.manifest.contentHash);
      expect(await readManifest(admin)).toEqual(result.manifest);

      // A later run republishes over its own manifest and does not baseline again.
      const again = await operatorRun(owner, name);
      expect(again.baselined).toBe(false);
    });
  });

  test("RED CONTROL: the same database with one column dropped refuses, naming the column, and publishes nothing", async () => {
    await withDatabase("snapshot", async ({ admin, owner, name }) => {
      await admin.unsafe("ALTER TABLE job_schedules DROP COLUMN last_enqueued_at");
      const refusal = operatorRun(owner, name);
      await expect(refusal).rejects.toThrow("Refusing to publish this database's first schema manifest");
      await expect(operatorRun(owner, name)).rejects.toThrow("column public.job_schedules.last_enqueued_at");
      expect(await readManifest(admin)).toBeNull();
    });
  });

  test("a MIGRATION-built database refuses by name: the replaying login's default privileges are not the snapshot's", async () => {
    // Every relation and function the migrations create is the snapshot's
    // (schema-equivalence.test.ts); what differs is what 0016 left FOR THE
    // LOGIN THAT RAN IT. In production that login is doadmin, which the
    // snapshot's exclusion list covers; in this harness it is not, and the
    // baseline says so rather than publishing over it.
    await withDatabase("migrations", async ({ admin, owner, name }) => {
      const before = await ledger(admin);
      await expect(operatorRun(owner, name)).rejects.toThrow(
        `default privileges for ${LOGIN} in schema public on tables is in the live catalog but not declared`,
      );
      expect(await readManifest(admin)).toBeNull();
      expect(await ledger(admin)).toEqual(before);

      // With the login's leftovers gone — production's shape — it baselines.
      await admin.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE "${LOGIN}" IN SCHEMA public REVOKE ALL ON TABLES FROM rm_worker`);
      await admin.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE "${LOGIN}" IN SCHEMA public REVOKE ALL ON SEQUENCES FROM rm_worker`);
      const result = await operatorRun(owner, name);
      expect(result.baselined).toBe(true);
      expect(await readManifest(admin)).toEqual(result.manifest);
    });
  });

  test("a ledger that never recorded 0053 refuses BEFORE anything is applied, naming 0053, and publishes nothing", async () => {
    // Production's ledger: scripts/ops/provision-db-role-taxonomy.sh applied
    // 0053 and 0062 through psql without recording them. The runner would
    // otherwise "apply" 0053 again as a pending file, onto a schema that has it.
    await withDatabase("snapshot", async ({ admin, owner, name }) => {
      // schema_migrations is append-only (an ENABLE ALWAYS statement trigger);
      // only the superuser fixture handle, disabling it for one transaction, can
      // remove the row — a hand-run psql is exactly how production got this way.
      await admin.begin(async (tx) => {
        await tx.unsafe("ALTER TABLE schema_migrations DISABLE TRIGGER USER");
        await tx.unsafe("DELETE FROM schema_migrations WHERE name = '0053_database_role_taxonomy.sql'");
        await tx.unsafe("ALTER TABLE schema_migrations ENABLE ALWAYS TRIGGER schema_migrations_append_only");
        await tx.unsafe("ALTER TABLE schema_migrations ENABLE ALWAYS TRIGGER schema_migrations_append_only_row");
      });
      const before = await ledger(admin);
      expect(before).not.toContain("0053_database_role_taxonomy.sql");

      await expect(operatorRun(owner, name)).rejects.toThrow(
        "the snapshot embodies 0053_database_role_taxonomy.sql, which the ledger does not record although later files are recorded",
      );
      expect(await ledger(admin)).toEqual(before);
      expect(await readManifest(admin)).toBeNull();
    });
  });
});
