// The `--seed` gate — criterion 52 (smoke-production-spec.md §5, §4.3).
//
//   §5:   "`--seed` creates demo data on a blank database. It is explicit,
//          refuses a populated database, requires `rehearsal`, and is never
//          implied by any mode."
//   §4.3: "Rehearsal-only preparation: `--migrate`, `--seed`, `--spoof-keys`
//          require `rehearsal` in addition to their own guards."
//
// Driven through the functions `bun smoke --seed` runs (backend/scripts/
// smoke-prepare.ts → seed.ts `seedDemo`): `assertSeedable` and the seed itself,
// in ONE mutation fence (backend/src/db/target-lock.ts withMutationFence),
// logged in AS rm_owner — the credential the smoke runs the seed on — against
// databases of this file's own. That no `--local` mode IMPLIES `--seed` is the
// argv half, pinned in scripts/tests/unit/smoke-db-mode.test.ts.
//
// "POPULATED" IS ROWS, NOT TABLES. A snapshot bootstrap has every table and is
// blank; the bootstrap data's own rows (the job schedules, the singletons) do
// not make it populated. Any row beyond those does, counted exactly.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { assertSeedable, seedDemo } from "../src/db/seed.ts";
import { bootstrapBlankDatabase, bootstrapRowCounts, loadSnapshot, populatedTables } from "../src/db/schema-snapshot.ts";
import { withMutationFence } from "../src/db/target-lock.ts";
import { adminConnection, adminExec, harnessConnection, harnessUrl, ROLE_PASSWORD } from "./support/cluster.ts";

const OWNER_PASSWORD = randomBytes(18).toString("base64url");
const OWNER = { name: "rm_owner", password: OWNER_PASSWORD };
let ownerCanLogin = true;

function urlFor(database: string, role?: { name: string; password: string }): string {
  const url = new URL(harnessUrl(database));
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
  // cluster admin: ALTER ROLE is superuser-only (rm_owner holds no CREATEROLE)
  await adminExec(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
});

afterAll(async () => {
  await adminExec(`ALTER ROLE rm_owner ${ownerCanLogin ? "LOGIN" : "NOLOGIN"} PASSWORD '${ROLE_PASSWORD()}'`);
});

/** A database of its own: bootstrapped from the snapshot (blank), or a clone of the migrated, seeded template (populated). */
async function withDatabase(
  shape: "snapshot" | "template",
  body: (dbs: { db: postgres.Sql<{}>; name: string }) => Promise<void>,
): Promise<void> {
  const name = `rm_seed_gate_${shape}_${randomBytes(4).toString("hex")}`;
  const maintenance = adminConnection(); // cluster admin: CREATE/DROP DATABASE
  if (shape === "snapshot") await maintenance.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
  else await maintenance.unsafe(`CREATE DATABASE ${name} OWNER rm_owner TEMPLATE "${process.env.RM_TEST_MIGRATED_TEMPLATE_DB}"`);
  const db = harnessConnection(name);
  try {
    if (shape === "snapshot") {
      await db.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      const owner = connect(name, OWNER);
      try {
        await bootstrapBlankDatabase(owner, await loadSnapshot());
      } finally {
        await owner.end({ timeout: 5 });
      }
    } else {
      await db.unsafe("INSERT INTO deployment_identity (kind) VALUES ('rehearsal')");
    }
    await body({ db, name });
  } finally {
    await db.end({ timeout: 5 });
    await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await maintenance.end({ timeout: 5 });
  }
}

/** `bun smoke --seed`'s preparation: the gate and the seed, as rm_owner, in one fence. */
function fencedSeed(name: string, rmEnv: string | undefined = "stage"): Promise<void> {
  return withMutationFence({ databaseUrl: urlFor(name, OWNER), label: "seed" }, (tx) => seedDemo(tx, { rmEnv }));
}

function fencedGate(name: string, request: { rmEnv: string | undefined; explicitlyRequested: boolean }): Promise<void> {
  return withMutationFence({ databaseUrl: urlFor(name, OWNER), label: "seed-gate" }, (tx) => assertSeedable(tx, request));
}

async function count(db: postgres.Sql<{}>, table: string): Promise<number> {
  const [row] = (await db.unsafe(`SELECT count(*)::int AS n FROM ${table}`)) as unknown as { n: number }[];
  return row?.n ?? 0;
}

describe("--seed refuses a populated database — rows, not tables (§5)", () => {
  test("a snapshot-bootstrapped database is blank: every table exists, and its bootstrap rows do not count", async () => {
    await withDatabase("snapshot", async ({ db, name }) => {
      const snapshot = await loadSnapshot();
      // Non-vacuous: the bootstrap data put rows in, so a count-anything test
      // would call this database populated.
      expect(await count(db, "job_schedules")).toBe(bootstrapRowCounts(snapshot.bootstrapDataSql).get("job_schedules") ?? -1);
      expect(await count(db, "job_schedules")).toBeGreaterThan(0);
      expect(await populatedTables(db, snapshot)).toEqual([]);

      await fencedSeed(name);
      // The seed wrote its demo data, as rm_owner, including the job_schedules
      // DELETEs rm_app is not granted.
      expect(await count(db, "jobs")).toBeGreaterThan(0);
      expect(await count(db, "allocation_framework")).toBe(1);
    });
  });

  test("the SAME database after one seed is populated, and a second --seed refuses naming the tables, writing nothing", async () => {
    await withDatabase("snapshot", async ({ db, name }) => {
      await fencedSeed(name);
      const jobsBefore = await count(db, "jobs");
      const refusal = fencedSeed(name);
      await expect(refusal).rejects.toThrow("Refusing --seed: the database is populated");
      await expect(fencedSeed(name)).rejects.toThrow(/jobs \(\d+ row\(s\)\)/);
      expect(await count(db, "jobs")).toBe(jobsBefore);
    });
  });

  test("ONE row in a table the bootstrap never touches makes it populated — counted exactly, not estimated", async () => {
    await withDatabase("snapshot", async ({ db, name }) => {
      // Inserted and read back at once: pg_stat_user_tables would still say 0
      // (no autovacuum has run), which is why the gate counts rather than asks
      // the statistics.
      await db.unsafe("INSERT INTO comments (page, author, content) VALUES ('/x', 'someone', 'one row')");
      const populated = await populatedTables(db, await loadSnapshot());
      expect(populated.length).toBe(1);
      expect(populated[0]?.rows).toBe(1);
      expect(populated[0]?.bootstrapRows).toBe(0);
      await expect(fencedGate(name, { rmEnv: "stage", explicitlyRequested: true })).rejects.toThrow(
        `${populated[0]!.table} (1 row(s))`,
      );
    });
  });

  test("a bootstrap table holding MORE rows than the bootstrap data inserts is populated", async () => {
    await withDatabase("snapshot", async ({ db, name }) => {
      await db.unsafe(
        "INSERT INTO job_schedules (kind, cron, payload, timezone, enabled) VALUES ('ops.repair_gaps', '1 * * * *', '{}', 'UTC', false)",
      );
      await expect(fencedGate(name, { rmEnv: "stage", explicitlyRequested: true })).rejects.toThrow(/job_schedules \(\d+ row\(s\), \d+ from bootstrap data\)/);
    });
  });

  test("a migrated, seeded database (the test template, rehearsal-enrolled) is populated and refuses", async () => {
    await withDatabase("template", async ({ name }) => {
      await expect(fencedSeed(name)).rejects.toThrow("Refusing --seed: the database is populated");
    });
  });
});

describe("--seed requires rehearsal and an explicit request (§4.3, §5)", () => {
  test("a production enrollment refuses before any row is counted or written", async () => {
    await withDatabase("snapshot", async ({ db, name }) => {
      await db.unsafe("UPDATE deployment_identity SET kind = 'production'");
      await expect(fencedSeed(name)).rejects.toThrow("enrolled as production");
      expect(await count(db, "jobs")).toBe(0);
    });
  });

  test("no enrollment row refuses — an un-enrolled database is not a rehearsal database", async () => {
    await withDatabase("snapshot", async ({ db, name }) => {
      await db.unsafe("DELETE FROM deployment_identity");
      await expect(fencedSeed(name)).rejects.toThrow("not enrolled at all");
      expect(await count(db, "jobs")).toBe(0);
    });
  });

  test("RM_ENV=prod refuses whatever the database says", async () => {
    await withDatabase("snapshot", async ({ db, name }) => {
      await expect(fencedSeed(name, "prod")).rejects.toThrow("refused under RM_ENV=prod");
      expect(await count(db, "jobs")).toBe(0);
    });
  });

  test("a seed nobody asked for refuses — no mode may imply a preparation", async () => {
    await withDatabase("snapshot", async ({ name }) => {
      await expect(fencedGate(name, { rmEnv: "stage", explicitlyRequested: false })).rejects.toThrow("not explicitly requested");
    });
  });

  test("red control: the same blank rehearsal database with an explicit request passes the gate", async () => {
    await withDatabase("snapshot", async ({ name }) => {
      await expect(fencedGate(name, { rmEnv: "stage", explicitlyRequested: true })).resolves.toBeUndefined();
      await expect(fencedGate(name, { rmEnv: undefined, explicitlyRequested: true })).resolves.toBeUndefined();
    });
  });
});
