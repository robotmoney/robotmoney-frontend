// Blank + all migrations = the snapshot — the first of spec §8.4's CI proofs
// (smoke-production-spec.md §8.4, issue #1026 criterion 50).
//
// WHY THIS FILE MATTERS MORE THAN ITS SIZE. Spec §8.1 calls the snapshot
// "hand-maintained", and the repository has no generator for it. Every other
// snapshot test (schema-snapshot.test.ts) proves the snapshot BOOTSTRAPS; none
// proves it describes the same database the migrations build. Without this
// comparison a migration can land with a snapshot edit that is merely
// plausible, and the two histories — every production database, which was
// built by migrations, and every blank rehearsal, which is built from the
// snapshot — drift apart with nothing to say so.
//
// THE TWO SIDES, each built by the path real databases take:
//
//   migrated  — a copy of the suite's template, which tests/preload.ts builds
//               by applying every file in backend/migrations/ to an empty
//               database. The login that replayed the migrations then runs
//               the provisioning step §9.1 step 3 gives the cluster's
//               provisioning login (scripts/lib/smoke-database.ts
//               PROVISIONING_DEFAULT_PRIVILEGES_SQL): 0016 ran as that login
//               and left it a default DELETE for rm_worker, which only that
//               login can take back. The copy is then enrolled `rehearsal` by
//               rm_owner (§4.2) and given the REAL migrate run (`runMigrate`,
//               §8.3): nothing is pending, so what the run adds is the §9.1
//               step 2 baseline (the live schema must match the snapshot
//               before a first manifest is published), the roles-and-grants
//               reconciliation and the manifest — "always, even with nothing
//               pending". No database is ever migrated without that step, so
//               comparing one that skipped it would compare a state nothing
//               ships.
//   snapshot  — an empty database owned by rm_owner, bootstrapped from
//               backend/schema/ by `bootstrapBlankDatabase`, the `--local
//               blank` path (§5). pgcrypto is installed first by the superuser
//               because it is provider-managed (the snapshot header says so).
//
// THE COMPARISON is tests/support/catalog-normalize.ts: every declared object
// by name, OID-free, sorted, every class read on both sides — COMMENT ON,
// privileges and default privileges included.
//
// NO TOLERATED DIFFERENCE. This file used to carry a list of recorded causes,
// each an exact record of a known difference: privileges (0053's rm_app
// DELETE, cause B), the replaying login's default privileges (cause E),
// comments (cause F) and others before them. Wave 5 of #1026 closed the last
// two with D55 (6) — migration 0089 revokes DELETE and TRUNCATE from every
// runtime role on every table, and the provisioning step takes the login's
// defaults back — and the list was deleted with them. The two sides must now
// be equal, object for object; any difference fails, naming the object.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { PROVISIONING_DEFAULT_PRIVILEGES_SQL } from "../../scripts/lib/smoke-database.ts";
import { config } from "../src/config.ts";
import { checkSchemaIntegrity, type PreflightContext } from "../src/db/preflight.ts";
import { bootstrapBlankDatabase, loadSnapshot } from "../src/db/schema-snapshot.ts";
import { runMigrate, type MigrateGateOptions } from "../scripts/migrate-run.ts";
import { withTargetLock } from "./support/target-lock.ts";
import {
  describeCatalogDiff,
  diffCatalogs,
  normalizedCatalog,
  type CatalogDiff,
  type CatalogEntry,
} from "./support/catalog-normalize.ts";
import { adminUrl } from "./support/cluster.ts";

function urlFor(database: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

function connect(database: string): postgres.Sql<{}> {
  return postgres(urlFor(database), { max: 1, onnotice: () => {} });
}

/** The smoke `--migrate` caller against a rehearsal database this file owns.
 *  It runs under the §2 target lock a tool would hold (tests/support/target-lock.ts). */
const MIGRATE_OPTIONS: MigrateGateOptions & { nonInteractive: boolean } = {
  caller: "smoke_flag",
  env: "stage",
  connection: "local",
  nonInteractive: true,
};

const suffix = crypto.randomUUID().slice(0, 8);
const MIGRATED_DB = `rm_equiv_migrated_${suffix}`;
const SNAPSHOT_DB = `rm_equiv_snapshot_${suffix}`;
const RESTORED_DB = `rm_equiv_restored_${suffix}`;

let migrated: postgres.Sql<{}>;
let snapshotDb: postgres.Sql<{}>;
let migratedCatalog: CatalogEntry[] = [];
let snapshotCatalog: CatalogEntry[] = [];
let baselined = false;

beforeAll(async () => {
  const admin = connect("postgres");
  try {
    await admin.unsafe(`CREATE DATABASE ${MIGRATED_DB} OWNER rm_owner TEMPLATE "${process.env.RM_TEST_MIGRATED_TEMPLATE_DB}"`);
    // OWNER rm_owner: §5's `--local blank` hands the bootstrap a database the
    // schema owner owns (see schema-snapshot.test.ts's withBlankDatabase).
    await admin.unsafe(`CREATE DATABASE ${SNAPSHOT_DB} OWNER rm_owner`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  migrated = connect(MIGRATED_DB);
  // §9.1 step 3, as the login that ran the migrations: the provisioning
  // login's own defaults, which no migration can reach.
  await migrated.unsafe(PROVISIONING_DEFAULT_PRIVILEGES_SQL);
  // §4.2: a restored or copied database is enrolled `rehearsal` through
  // rm_owner before any stage tool touches it.
  await migrated.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx.unsafe("INSERT INTO deployment_identity (kind) VALUES ('rehearsal')");
  });
  // The run requires `current_user = rm_owner` for its whole session. The
  // template has no manifest, so this run is the §9.1 step 2 baseline: it
  // publishes the first manifest only when the live schema matches the
  // snapshot, and refuses naming the difference otherwise.
  await migrated.unsafe("SET ROLE rm_owner");
  const run = await withTargetLock(urlFor(MIGRATED_DB), (lock) => runMigrate(migrated, { ...MIGRATE_OPTIONS, lock }));
  await migrated.unsafe("RESET ROLE");
  // The template already holds every migration: this run only baselines,
  // reconciles and publishes. If it applied something, the template is not
  // "all migrations".
  expect(run.applied).toEqual([]);
  baselined = run.baselined;

  snapshotDb = connect(SNAPSHOT_DB);
  await snapshotDb.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await snapshotDb.unsafe("SET ROLE rm_owner");
  await bootstrapBlankDatabase(snapshotDb, await loadSnapshot());
  await snapshotDb.unsafe("RESET ROLE");

  migratedCatalog = await normalizedCatalog(migrated);
  snapshotCatalog = await normalizedCatalog(snapshotDb);
}, 120_000);

afterAll(async () => {
  await migrated?.end({ timeout: 5 });
  await snapshotDb?.end({ timeout: 5 });
  const admin = connect("postgres");
  try {
    for (const name of [MIGRATED_DB, SNAPSHOT_DB, RESTORED_DB]) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

/** Every difference, one object per entry, with both of its definitions. */
function differences(diff: CatalogDiff): string[] {
  return describeCatalogDiff(diff, "migrations", "snapshot");
}

/** The keys of every differing object, sorted. */
function differingKeys(diff: CatalogDiff): string[] {
  return [...diff.onlyLeft.map((e) => e.key), ...diff.onlyRight.map((e) => e.key), ...diff.differing.map((d) => d.key)].sort();
}

const DATABASE_LOGIN = new URL(adminUrl()).username;
const RUNTIME = ["rm_app", "rm_worker", "rm_readonly"] as const;

// ───────────────────────────────────────────────────────────────────────────
// The proof
// ───────────────────────────────────────────────────────────────────────────

describe("blank + all migrations = the snapshot (spec §8.4)", () => {
  test("both sides were really read — a comparison of two empty lists proves nothing", () => {
    // Floors, not counts: the point is that neither side came back empty or
    // half-read, not to pin the schema's size.
    for (const catalog of [migratedCatalog, snapshotCatalog]) {
      expect(catalog.filter((e) => e.key.startsWith("table public.")).length).toBeGreaterThan(50);
      expect(catalog.filter((e) => e.key.startsWith("trigger public.")).length).toBeGreaterThan(20);
      expect(catalog.filter((e) => e.key.startsWith("function public.")).length).toBeGreaterThan(5);
      expect(catalog.filter((e) => e.key.startsWith("index public.")).length).toBeGreaterThan(50);
      expect(catalog.filter((e) => e.key.startsWith("acl relation public.")).length).toBeGreaterThan(50);
      expect(catalog.filter((e) => e.key.startsWith("default privileges for rm_owner ")).length).toBe(2);
    }
  });

  test("every object the migrations declare, the snapshot declares identically — with no tolerated difference", () => {
    const diff = diffCatalogs(migratedCatalog, snapshotCatalog);
    // The message names every differing object and both of its definitions,
    // so a red run says which object to fix and on which side.
    const lines = differences(diff);
    if (lines.length > 0) {
      throw new Error(
        `backend/schema/ and backend/migrations/ declare ${lines.length} object(s) differently ` +
          `(fix the snapshot, or the migration it forgot):\n${lines.join("\n")}`,
      );
    }
    expect(differingKeys(diff)).toEqual([]);
  });

  test("the real migrate run baselined the migrated side: its live schema matched the snapshot (§9.1 step 2)", () => {
    // The baseline refuses to publish a first manifest over a live schema that
    // differs from the snapshot, so a `true` here is the migrate tool's own
    // verdict on the same question, reached by its own comparison.
    expect(baselined).toBe(true);
  });

  test("no runtime role holds DELETE or TRUNCATE on any relation, on either side (D55 (6))", () => {
    for (const catalog of [migratedCatalog, snapshotCatalog]) {
      const held = catalog
        .filter((e) => e.key.startsWith("acl relation public."))
        .flatMap((e) =>
          e.definition
            .split(", ")
            .filter((item) => RUNTIME.some((role) => item.startsWith(`${role}:`)) && /:(DELETE|TRUNCATE) /.test(item))
            .map((item) => `${e.key} ${item}`),
        );
      expect(held).toEqual([]);
    }
    // And no default privilege hands either one to a runtime role later.
    for (const catalog of [migratedCatalog, snapshotCatalog]) {
      const defaults = catalog.filter((e) => e.key.startsWith("default privileges for "));
      expect(defaults.filter((e) => /rm_(app|worker|readonly):(DELETE|TRUNCATE)/.test(e.definition))).toEqual([]);
    }
  });

  test("comments were really read on both sides, and both sides declare the same ones — the comparison is not passing on a skipped class", () => {
    const comments = (catalog: readonly CatalogEntry[]) => catalog.filter((e) => e.key.startsWith("comment on "));
    expect(comments(migratedCatalog).length).toBeGreaterThan(50);
    expect(comments(snapshotCatalog)).toEqual(comments(migratedCatalog));
  });

  test("RED CONTROL: a planted difference fails, and the failure names each planted object", async () => {
    // Planted inside a transaction on the migrated side and rolled back, so the
    // shared comparison above is untouched. One plant per class:
    //   * a column default    — a declaration class;
    //   * a trigger's firing mode — only tgenabled differs;
    //   * rm_app DELETE on an APPEND-ONLY table and on an ORDINARY one — the
    //     shape the retired cause B recorded, now a difference like any other;
    //   * rm_worker UPDATE on swarm_recommendations, where both sides hold
    //     SELECT only;
    //   * rm_worker ALL on a relation both sides narrow to SELECT;
    //   * a comment on an object neither side comments;
    //   * a new index;
    //   * a DELETE default for rm_worker from the replaying login — the shape
    //     the retired cause E recorded, 0016's default before §9.1 step 3.
    let planted: CatalogDiff | null = null;
    await migrated
      .begin(async (tx) => {
        await tx.unsafe("ALTER TABLE jobs ALTER COLUMN priority SET DEFAULT 7");
        await tx.unsafe("ALTER TABLE schema_migrations DISABLE TRIGGER schema_migrations_append_only_row");
        await tx.unsafe("GRANT DELETE ON swarm_members TO rm_app");
        await tx.unsafe("GRANT DELETE ON analytics_read_mode TO rm_app");
        await tx.unsafe("GRANT UPDATE ON swarm_recommendations TO rm_worker");
        await tx.unsafe("GRANT ALL ON deployment_identity TO rm_worker");
        await tx.unsafe("COMMENT ON COLUMN jobs.dedupe_key IS 'planted'");
        await tx.unsafe("CREATE INDEX rm_equiv_planted_idx ON jobs (updated_at)");
        await tx.unsafe("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT DELETE ON TABLES TO rm_worker");
        planted = diffCatalogs(await normalizedCatalog(tx), snapshotCatalog);
        throw new RollbackPlant();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackPlant)) throw error;
      });

    const diff = planted as unknown as CatalogDiff;
    const message = differences(diff).join("\n");
    expect(differingKeys(diff)).toEqual([
      "acl relation public.analytics_read_mode",
      "acl relation public.deployment_identity",
      "acl relation public.swarm_members",
      "acl relation public.swarm_recommendations",
      "column public.jobs.priority",
      "comment on pg_class public.jobs.dedupe_key",
      `default privileges for ${DATABASE_LOGIN} in public on tables`,
      "index public.rm_equiv_planted_idx",
      "trigger public.schema_migrations.schema_migrations_append_only_row",
    ]);
    expect(message).toContain("differs: column public.jobs.priority");
    expect(message).toContain("default 7");
    expect(message).toContain("only in migrations: index public.rm_equiv_planted_idx");
    expect(message).toContain("enabled=D");
    expect(message).toContain("rm_app:DELETE");
    expect(message).toContain("rm_worker:UPDATE by rm_owner");
    expect(message).toContain(`rm_worker:DELETE by ${DATABASE_LOGIN}`);
    expect(message).toContain("only in migrations: comment on pg_class public.jobs.dedupe_key — planted");
  });

  test("RED CONTROL: an operator, a cast, a publication and an event trigger are read — none is an unread class", async () => {
    // The four database-level classes tests/support/catalog-normalize.ts reads
    // since wave 4 of #1026. The snapshot declares none of them, so each plant
    // must surface as a named object only the migrated side has. The event
    // trigger needs a function returning event_trigger, which is itself a
    // planted function (and its ACL).
    let planted: CatalogDiff | null = null;
    await migrated
      .begin(async (tx) => {
        await tx.unsafe("CREATE OPERATOR public.=== (LEFTARG = integer, RIGHTARG = integer, FUNCTION = int4eq)");
        await tx.unsafe("CREATE CAST (public.jobs AS text) WITH INOUT");
        await tx.unsafe("CREATE PUBLICATION rm_equiv_planted_pub FOR TABLE public.jobs");
        await tx.unsafe(
          "CREATE FUNCTION public.rm_equiv_planted_evt() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$",
        );
        await tx.unsafe(
          "CREATE EVENT TRIGGER rm_equiv_planted_evt ON ddl_command_end EXECUTE FUNCTION public.rm_equiv_planted_evt()",
        );
        planted = diffCatalogs(await normalizedCatalog(tx), snapshotCatalog);
        throw new RollbackPlant();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackPlant)) throw error;
      });

    const diff = planted as unknown as CatalogDiff;
    const message = differences(diff).join("\n");
    expect(differingKeys(diff)).toEqual([
      "acl function public.rm_equiv_planted_evt()",
      "cast (jobs AS text)",
      "event trigger rm_equiv_planted_evt",
      "function public.rm_equiv_planted_evt()",
      "operator public.===(integer, integer)",
      "publication rm_equiv_planted_pub",
    ]);
    expect(message).toContain("tables=public.jobs");
    expect(message).toContain("on ddl_command_end");
    expect(message).toContain("method=i");
  });
});

describe("a restored backup gets rm_owner's default privileges back from the reconciliation", () => {
  // `bun smoke:capture` dumps with `--no-privileges`, and a restore therefore
  // carries no default privileges at all, while the manifest the restored copy
  // is checked against (§8.3) declares rm_owner's four. The migrate run's
  // roles-and-grants reconciliation (backend/schema/grants.sql) is the step
  // every restored copy passes through before preflight, so it must put them
  // back. The restore is modelled on a blank bootstrap with rm_owner's
  // defaults stripped by the superuser, which is the whole of what
  // `--no-privileges` loses there: the grants on each relation are
  // reconciliation's in either case.
  const context: PreflightContext = {
    env: "stage",
    connection: "local",
    roles: [...RUNTIME],
    codeFilenames: [],
    envFilePath: "/nonexistent",
  };

  test("check 3a refuses the stripped copy by name, and passes after the real migrate run reconciles it", async () => {
    const admin = connect("postgres");
    try {
      await admin.unsafe(`CREATE DATABASE ${RESTORED_DB} OWNER rm_owner`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const restored = connect(RESTORED_DB);
    try {
      await restored.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await restored.unsafe("SET ROLE rm_owner");
      await bootstrapBlankDatabase(restored, await loadSnapshot());
      await restored.unsafe("RESET ROLE");
      await restored.unsafe(
        "ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public REVOKE ALL ON TABLES FROM rm_app, rm_worker, rm_readonly",
      );
      await restored.unsafe(
        "ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM rm_app, rm_worker, rm_readonly",
      );

      // Red control: the stripped copy is refused, naming both classes.
      const before = (await checkSchemaIntegrity(restored, context)).findings.map((f) => f.message);
      expect(before.some((m) => m.includes("default privileges for rm_owner in schema public on tables"))).toBe(true);
      expect(before.some((m) => m.includes("default privileges for rm_owner in schema public on sequences"))).toBe(true);

      const [identity] = (await restored`SELECT count(*)::int AS n FROM deployment_identity`) as unknown as { n: number }[];
      if (identity!.n === 0) {
        await restored.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE rm_owner");
          await tx.unsafe("INSERT INTO deployment_identity (kind) VALUES ('rehearsal')");
        });
      }
      await restored.unsafe("SET ROLE rm_owner");
      const run = await withTargetLock(urlFor(RESTORED_DB), (lock) => runMigrate(restored, { ...MIGRATE_OPTIONS, lock }));
      await restored.unsafe("RESET ROLE");
      expect(run.applied).toEqual([]);

      expect((await checkSchemaIntegrity(restored, context)).findings).toEqual([]);
    } finally {
      await restored.end({ timeout: 5 });
    }
  }, 120_000);
});

/** Thrown to roll back the red control's plant; never escapes the test. */
class RollbackPlant extends Error {}
