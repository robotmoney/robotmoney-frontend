// The migrate RUN (spec §8.3), the gates in front of it (§8.5, §4.3), the
// target lock it runs under (§2), and the `bun run migrate` command that drives
// it (backend/scripts/migrate.ts).
//
// WHAT AN INTERRUPTED RUN IS TESTED AS. The run itself is interrupted, never a
// database state written by hand:
//
//   * failure BETWEEN COMMITS  → `runMigrate`'s `afterCommit` seam throws after
//     one planted migration commits and before the next begins. The run stops
//     where a killed process would, with the ledger ahead of the manifest
//     (§8.3's *in progress*).
//   * failure DURING GRANT RECONCILIATION → a relation owned by a runtime role
//     makes the snapshot's grants part raise, inside the transaction the
//     manifest publishes in, so neither commits.
//
// A rerun after each must reach a published manifest without re-applying a
// single committed migration, proved by `applied_at` identity.
//
// WHO IS CONNECTED. `runMigrate` requires `current_user = rm_owner`: every run
// here logs in AS rm_owner, with a password this file sets on the role for its
// own run and clears afterwards. The suite's superuser handle writes fixtures
// only. Every run holds the §2 target lock, taken through `acquireTargetLock`
// exactly as a tool takes it (tests/support/target-lock.ts). Tests that plant
// migration files or ledger rows run in a private clone of the migrated
// template, because `schema_migrations` is append-only and a planted row would
// outlive the test.
//
// THE FIRST MANIFEST. A database with no manifest gets its first one only after
// the §9.1 step 2 baseline (backend/tests/prod-baseline.test.ts covers that
// comparison itself). This harness builds its template by replaying every
// migration as its own superuser login, and 0016 leaves default privileges FOR
// THAT LOGIN that no snapshot declares — in production the bootstrap login is
// `doadmin`, a listed provider role, so they are excluded there. Every database
// this file migrates is first made production-shaped in that one respect
// (`revokeLoginDefaults`), so it passes the baseline for the reason production
// would, and nothing else about it is adjusted.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import {
  detectManifestState,
  hashManifest,
  MANIFEST_FORMAT_VERSION,
  readManifest,
} from "../src/db/schema-manifest.ts";
import { bootstrapBlankDatabase, loadSnapshot } from "../src/db/schema-snapshot.ts";
import { acquireTargetLock, readTargetState, TARGET_LOCK_KEY } from "../src/db/target-lock.ts";
import {
  checkMigrateGates,
  confirmRemoteTarget,
  MigrateRefused,
  migrateCommand,
  migrateReceiptPath,
  promptOwnerPassword,
  runMigrate,
  writeMigrateReceipt,
  type MigrateGateOptions,
  type MigrateRunSeams,
} from "../scripts/migrate-run.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { holdTargetLock, withTargetLock } from "./support/target-lock.ts";

useCleanDatabase(import.meta.file);

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const BACKEND = join(import.meta.dir, "..");
const LOGIN = new URL(config.databaseUrl).username;

/** The gate half of the options: the `--migrate` caller on a local stage target by default. */
function options(over: Partial<MigrateGateOptions & { nonInteractive: boolean }> = {}): MigrateGateOptions & {
  nonInteractive: boolean;
} {
  return { caller: "smoke_flag", env: "stage", connection: "local", nonInteractive: true, ...over };
}

// The REAL enrollment table, migration 0063's: one row at most (its key is a
// boolean pinned true), zero rows allowed, which is exactly the missing-row
// case.
async function setIdentity(value: "production" | "rehearsal" | null, db: postgres.Sql<{}> = sql): Promise<void> {
  await db.unsafe("DELETE FROM deployment_identity");
  if (value) await db`INSERT INTO deployment_identity (kind) VALUES (${value})`;
}

const DECLARATION = { text: "-- the snapshot's declaration for these tests\n" };

async function publishManifestFor(filenames: readonly string[], db: postgres.Sql<{}> = sql): Promise<void> {
  await db`
    INSERT INTO schema_manifest (format_version, declaration, filenames, content_hash)
    VALUES (${MANIFEST_FORMAT_VERSION}, ${DECLARATION.text}, ${filenames as string[]},
            ${hashManifest(DECLARATION, filenames)})`;
}

async function ledgerNames(db: postgres.Sql<{}> = sql): Promise<string[]> {
  const rows = await db<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
  return rows.map((r) => r.name);
}

async function appliedAtFor(name: string): Promise<Date | null> {
  const [row] = await sql<{ applied_at: Date }[]>`
    SELECT applied_at FROM schema_migrations WHERE name = ${name}`;
  return row?.applied_at ?? null;
}

async function appliedAtByName(db: postgres.Sql<{}>): Promise<Map<string, string>> {
  const rows = await db<{ name: string; applied_at: Date }[]>`SELECT name, applied_at FROM schema_migrations`;
  return new Map(rows.map((row) => [row.name, row.applied_at.toISOString()]));
}

async function roleSnapshot(db: postgres.Sql<{}> = sql): Promise<string[]> {
  const rows = await db<{ line: string }[]>`
    SELECT concat_ws(' ', rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolinherit) AS line
    FROM pg_roles ORDER BY rolname`;
  return rows.map((row) => row.line);
}

async function ownerAttributes(): Promise<{ rolcanlogin: boolean; rolcreaterole: boolean; rolsuper: boolean }> {
  const [row] = await sql<{ rolcanlogin: boolean; rolcreaterole: boolean; rolsuper: boolean }[]>`
    SELECT rolcanlogin, rolcreaterole, rolsuper FROM pg_roles WHERE rolname = 'rm_owner'`;
  if (!row) throw new Error("rm_owner does not exist on the test cluster");
  return row;
}

async function tablePrivilege(role: string, table: string, privilege: string, db = sql): Promise<boolean> {
  const [row] = (await db.unsafe(
    `SELECT has_table_privilege('${role}', 'public.${table}', '${privilege}') AS ok`,
  )) as unknown as { ok: boolean }[];
  return row?.ok === true;
}

/** Production shape for the one thing this harness's template carries that production's does not (see header). */
async function revokeLoginDefaults(db: postgres.Sql<{}>): Promise<void> {
  await db.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE "${LOGIN}" IN SCHEMA public REVOKE ALL ON TABLES FROM rm_worker`);
  await db.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE "${LOGIN}" IN SCHEMA public REVOKE ALL ON SEQUENCES FROM rm_worker`);
}

// ───────────────────────────────────────────────────────────────────────────
// Logging in AS rm_owner, and private databases
// ───────────────────────────────────────────────────────────────────────────

// Set on the cluster's rm_owner for this file only, and cleared in afterAll.
// Held in a module constant, never in process.env: the property under test is
// that the owner password lives in no environment variable and no file.
const OWNER_PASSWORD = randomBytes(18).toString("base64url");
const OWNER = { name: "rm_owner", password: OWNER_PASSWORD };

function urlFor(database: string, role?: { name: string; password: string }): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = encodeURIComponent(role.password);
  }
  return url.toString();
}

function currentDatabase(): Promise<string> {
  return sql<{ db: string }[]>`SELECT current_database() AS db`.then((rows) => rows[0]?.db ?? "");
}

function connect(database: string, role?: { name: string; password: string }): postgres.Sql<{}> {
  return postgres(urlFor(database, role), { max: 1, onnotice: () => {} });
}

/** This file's own database, and an rm_owner login to it. */
let fileDb = "";
let owner: postgres.Sql<{}>;

/**
 * The run as a tool performs it: the target lock on `database` held for the
 * whole run, then `runMigrate` on the rm_owner pool `db`.
 */
async function migrate(
  db: postgres.Sql<{}>,
  database: string,
  over: Partial<MigrateGateOptions & { nonInteractive: boolean }> = {},
  seams: MigrateRunSeams = {},
): Promise<Awaited<ReturnType<typeof runMigrate>>> {
  return withTargetLock(urlFor(database), (lock) => runMigrate(db, { ...options(over), lock }, seams));
}

/** A private clone of the migrated, seeded template, with a superuser handle
 *  for fixtures and an rm_owner login for the run. Dropped afterwards. */
async function withClone(
  body: (dbs: { admin: postgres.Sql<{}>; owner: postgres.Sql<{}>; name: string }) => Promise<void>,
): Promise<void> {
  const name = `rm_migrate_run_${randomBytes(4).toString("hex")}`;
  const maintenance = connect("postgres");
  await maintenance.unsafe(`CREATE DATABASE ${name} TEMPLATE "${process.env.RM_TEST_TEMPLATE_DB}"`);
  const admin = connect(name);
  await revokeLoginDefaults(admin);
  const cloneOwner = connect(name, OWNER);
  try {
    await body({ admin, owner: cloneOwner, name });
  } finally {
    await cloneOwner.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
    await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await maintenance.end({ timeout: 5 });
  }
}

/** A migrations directory holding every real file plus the planted ones, so
 *  the REAL apply loop meets them. */
function migrationsWith(planted: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-migrate-run-"));
  for (const file of readdirSync(MIGRATIONS)) {
    if (file.endsWith(".sql")) symlinkSync(join(MIGRATIONS, file), join(dir, file));
  }
  for (const [file, text] of Object.entries(planted)) writeFileSync(join(dir, file), text, "utf8");
  plantedDirs.push(dir);
  return dir;
}
const plantedDirs: string[] = [];

const ADDITIVE = "-- compat: additive\n-- metadata_version: 1\n--\n";

// rm_owner is a CLUSTER-wide role, and the next test file in sorted order
// (migration-0053-creates-every-role-it-alters.test.ts) reads its LOGIN
// attribute as evidence of what 0053 did. So this file records the attribute
// before touching the role and puts back exactly that value, never a forced
// LOGIN. Only the password this file set is cleared.
let ownerCanLogin: boolean | null = null;
const ownerLoginClause = (): string => (ownerCanLogin === false ? "NOLOGIN" : "LOGIN");

beforeAll(async () => {
  ownerCanLogin = (await ownerAttributes()).rolcanlogin;
  await sql.unsafe(`ALTER ROLE rm_owner PASSWORD '${OWNER_PASSWORD}'`);
  fileDb = await currentDatabase();
  await revokeLoginDefaults(sql);
  owner = connect(fileDb, OWNER);
});

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await sql.unsafe(`ALTER ROLE rm_owner ${ownerLoginClause()} PASSWORD NULL`);
  for (const dir of plantedDirs) rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  await sql.unsafe("DELETE FROM schema_manifest");
  await sql.unsafe("DELETE FROM deployment_identity");
});

// ───────────────────────────────────────────────────────────────────────────
// The gates, applied before anything connects as rm_owner
// ───────────────────────────────────────────────────────────────────────────

describe("checkMigrateGates — §8.5 and the ONE §4.3 matrix, before the owner password is ever requested", () => {
  test("`--migrate` refuses on RM_ENV=prod", async () => {
    await setIdentity("rehearsal");
    const refusals = await checkMigrateGates(sql, options({ caller: "smoke_flag", env: "prod" }));
    expect(refusals.map((r) => r.reason)).toContain("prod_env");
    expect(refusals.find((r) => r.reason === "prod_env")?.message).toContain("--migrate");
  });

  test("`--migrate` refuses on deployment_identity = production", async () => {
    await setIdentity("production");
    const refusals = await checkMigrateGates(sql, options({ caller: "smoke_flag", env: "stage" }));
    expect(refusals.map((r) => r.reason)).toContain("identity_not_rehearsal");
    expect(refusals.find((r) => r.reason === "identity_not_rehearsal")?.message).toContain("production");
  });

  test("`--migrate` refuses a MISSING identity row — absence of evidence is not evidence of rehearsal", async () => {
    await setIdentity(null);
    const refusals = await checkMigrateGates(sql, options({ caller: "smoke_flag" }));
    expect(refusals.map((r) => r.reason)).toContain("identity_missing");
  });

  test("`--migrate` proceeds on stage against a rehearsal identity", async () => {
    await setIdentity("rehearsal");
    expect(await checkMigrateGates(sql, options({ caller: "smoke_flag", env: "stage" }))).toEqual([]);
  });

  test("RM_ENV=stage with a typed owner password against a production identity refuses, with the matrix's own reason", async () => {
    // The §10 W2 gate, verbatim. The remote confirmation is the last thing in
    // front of this refusal, never a substitute for it.
    await setIdentity("production");
    const refusals = await checkMigrateGates(
      sql,
      options({ caller: "operator", env: "stage", connection: "remote", nonInteractive: false }),
    );
    expect(refusals.map((r) => r.reason)).toContain("identity_not_rehearsal");
    // The words are resolveDeploymentPolicy's (backend/src/deploy-policy.ts):
    // one matrix, so the operator reads the same sentence from every tool.
    expect(refusals[0]?.message).toContain("stage policy (incl. --allow-insecure) never touches production data");
  });

  test("the operator caller MAY run on prod against a production identity", async () => {
    await setIdentity("production");
    expect(
      await checkMigrateGates(sql, options({ caller: "operator", env: "prod", connection: "remote" })),
    ).toEqual([]);
  });

  test("prod combined with a --local mode refuses for either caller", async () => {
    await setIdentity("production");
    for (const caller of ["operator", "smoke_flag"] as const) {
      const refusals = await checkMigrateGates(sql, options({ caller, env: "prod", connection: "local" }));
      expect(refusals.length).toBeGreaterThan(0);
    }
  });

  test("unset RM_ENV against a remote refuses", async () => {
    await setIdentity("rehearsal");
    const refusals = await checkMigrateGates(
      sql,
      options({ caller: "operator", env: null, connection: "remote" }),
    );
    expect(refusals.map((r) => r.reason)).toContain("env_unset_remote");
  });

  test("unset RM_ENV under --local does not refuse", async () => {
    await setIdentity("rehearsal");
    expect(await checkMigrateGates(sql, options({ caller: "operator", env: null, connection: "local" }))).toEqual([]);
  });

  test("returns every refusal found, so one run learns all of them", async () => {
    await setIdentity("production");
    const refusals = await checkMigrateGates(sql, options({ caller: "smoke_flag", env: "prod" }));
    expect(refusals.map((r) => r.reason).sort()).toEqual(["identity_not_rehearsal", "prod_env"]);
  });

  test("every refusal carries an operator-readable sentence, not just a reason code", async () => {
    await setIdentity("production");
    for (const refusal of await checkMigrateGates(sql, options({ env: "prod" }))) {
      expect(refusal.message.length).toBeGreaterThan(20);
      expect(refusal.message).not.toBe(refusal.reason);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The credential and the remote confirmation
// ───────────────────────────────────────────────────────────────────────────

describe("promptOwnerPassword — typed for one run, never stored", () => {
  test("refuses in nonInteractive mode when a prompt would be needed", async () => {
    // Failing fast beats a CI job hanging on an invisible prompt.
    await expect(
      promptOwnerPassword(options({ connection: "remote", nonInteractive: true }), urlFor(fileDb)),
    ).rejects.toThrow(/non-?interactive|terminal/i);
  });

  test("uses the password smoke generated in local modes, verified by a real login, with no prompt at all", async () => {
    // §5: smoke "generates the four role passwords and saves them in the
    // instance's state directory beside the volume" and "No terminal prompt
    // exists in local modes" — the smoke hands the saved one in.
    const password = await promptOwnerPassword(
      { ...options({ connection: "local", nonInteractive: true }), localOwnerPassword: OWNER_PASSWORD },
      urlFor(fileDb),
    );
    expect(password).toBe(OWNER_PASSWORD);
  });

  test("a local run with no generated password refuses: this module never invents one", async () => {
    await expect(promptOwnerPassword(options({ connection: "local" }), urlFor(fileDb))).rejects.toThrow(
      /generated for the instance/,
    );
  });

  test("a wrong local password refuses by name rather than being used", async () => {
    await expect(
      promptOwnerPassword({ ...options({ connection: "local" }), localOwnerPassword: "not-the-owner" }, urlFor(fileDb)),
    ).rejects.toThrow(/rm_owner credential was not accepted/);
  });

  test("never leaves the owner password in the process environment", async () => {
    const password = await promptOwnerPassword(
      { ...options({ connection: "local" }), localOwnerPassword: OWNER_PASSWORD },
      urlFor(fileDb),
    );
    for (const [key, value] of Object.entries(process.env)) {
      if (/rm_owner/i.test(key)) expect(value).toBeUndefined();
      expect(value?.includes(password) ?? false).toBe(false);
    }
  });
});

describe("confirmRemoteTarget — the y/n in front of a remote run", () => {
  test("skips entirely on a local connection", async () => {
    await expect(confirmRemoteTarget(options({ connection: "local" }), "localhost:5432/robotmoney")).resolves
      .toBeUndefined();
  });

  test("refuses nonInteractive on a remote connection — an unattended run may not confirm for the operator", async () => {
    await expect(
      confirmRemoteTarget(options({ connection: "remote", nonInteractive: true }), "db.example.invalid:25060/rm"),
    ).rejects.toThrow(/non-?interactive|confirm/i);
  });

  test("prints the redacted target and never a password", async () => {
    const redacted = "db.example.invalid:25060/robotmoney";
    await expect(
      confirmRemoteTarget(options({ connection: "remote", nonInteractive: true }), redacted),
    ).rejects.toThrow(redacted);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// rm_owner is the migration login (spec §3, §9.1 step 1)
// ───────────────────────────────────────────────────────────────────────────

describe("rm_owner — LOGIN, the migration login, the only session the run accepts, never CREATEROLE", () => {
  test("a cluster migrated from scratch has rm_owner LOGIN and without CREATEROLE, as 0053 now creates it", async () => {
    expect(await ownerAttributes()).toEqual({ rolcanlogin: true, rolcreaterole: false, rolsuper: false });
  });

  test("migrate runs AS rm_owner on a migrated database, and rm_owner holds no CREATEROLE afterwards", async () => {
    await setIdentity("rehearsal");
    const [who] = await owner<{ user: string }[]>`SELECT current_user AS user`;
    expect(who?.user).toBe("rm_owner");
    const result = await migrate(owner, fileDb);
    expect(result.applied).toEqual([]);
    expect(await readManifest(sql)).toEqual(result.manifest);
    expect((await ownerAttributes()).rolcreaterole).toBe(false);
  });

  test("a SUPERUSER session is refused, although it could become rm_owner — current_user must be rm_owner", async () => {
    await setIdentity("rehearsal");
    const superuser = connect(fileDb);
    try {
      await expect(migrate(superuser, fileDb)).rejects.toThrow(`the session is ${LOGIN}, not rm_owner`);
    } finally {
      await superuser.end({ timeout: 5 });
    }
    // Nothing was published by the refused session.
    expect(await readManifest(sql)).toBeNull();
  });

  test("a MEMBER of rm_owner that did not become it is refused too", async () => {
    await setIdentity("rehearsal");
    const role = `rm_owner_member_${Date.now().toString(36)}`;
    await sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'member-pw' NOSUPERUSER NOCREATEROLE IN ROLE rm_owner`);
    const member = connect(fileDb, { name: role, password: "member-pw" });
    try {
      await expect(migrate(member, fileDb)).rejects.toThrow(`the session is ${role}, not rm_owner`);
    } finally {
      await member.end({ timeout: 5 });
      await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  });

  test("an existing database's NOLOGIN rm_owner refuses as `§9.1 step 1 has not been applied`, then migrates once it has", async () => {
    await setIdentity("rehearsal");
    await sql.unsafe("ALTER ROLE rm_owner NOLOGIN PASSWORD NULL");
    try {
      await expect(
        promptOwnerPassword({ ...options({ connection: "local" }), localOwnerPassword: OWNER_PASSWORD }, urlFor(fileDb)),
      ).rejects.toThrow("ALTER ROLE rm_owner LOGIN PASSWORD");

      // Spec §9.1 step 1, through the provisioning login: LOGIN plus a
      // password, then a verification login — which here is the run itself.
      await sql.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
      const fresh = connect(fileDb, OWNER);
      try {
        const result = await migrate(fresh, fileDb);
        expect(result.manifest.filenames).toEqual(await ledgerNames());
      } finally {
        await fresh.end({ timeout: 5 });
      }
    } finally {
      await sql.unsafe(`ALTER ROLE rm_owner ${ownerLoginClause()} PASSWORD '${OWNER_PASSWORD}'`);
    }
    expect((await ownerAttributes()).rolcreaterole).toBe(false);
  });

  test("the run writes a receipt, and neither it nor the environment holds the owner password", async () => {
    await setIdentity("rehearsal");
    const stateDir = mkdtempSync(join(tmpdir(), "rm-migrate-receipt-"));
    plantedDirs.push(stateDir);
    const startedAt = new Date();
    const result = await migrate(owner, fileDb, { caller: "operator" });
    const path = await writeMigrateReceipt(migrateReceiptPath(stateDir, startedAt), result, {
      caller: "operator",
      env: "stage",
      target: "localhost:5432/robotmoney",
      startedAt,
    });

    const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(receipt.kind).toBe("migrate-receipt");
    expect(receipt.applied).toEqual(result.applied);
    expect(receipt.grantsRepaired).toEqual(result.grantsRepaired);
    expect(receipt.manifest).toEqual({
      formatVersion: result.manifest.formatVersion,
      contentHash: result.manifest.contentHash,
      filenames: result.manifest.filenames,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // A receipt is a record: a second write to the same path refuses.
    await expect(
      writeMigrateReceipt(path, result, { caller: "operator", env: "stage", target: "x", startedAt }),
    ).rejects.toThrow();

    for (const file of readdirSync(stateDir)) {
      expect(readFileSync(join(stateDir, file), "utf8")).not.toContain(OWNER_PASSWORD);
    }
    for (const value of Object.values(process.env)) {
      expect(value?.includes(OWNER_PASSWORD) ?? false).toBe(false);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The target lock the run proceeds under (§2)
// ───────────────────────────────────────────────────────────────────────────

describe("runMigrate under the §2 target lock — no private lock, proof at every boundary", () => {
  test("a lock that is no longer held refuses before anything is read for a decision", async () => {
    await setIdentity("rehearsal");
    const lock = await holdTargetLock(urlFor(fileDb));
    await lock.release();
    await expect(runMigrate(owner, { ...options(), lock })).rejects.toThrow('the phase "migrate: start" does not start');
    expect(await readManifest(sql)).toBeNull();
  });

  test("the run takes no session lock of its own: mid-run, the only session lock on the key is the caller's", async () => {
    // The run used to take `pg_try_advisory_lock(bigint)` — the FENCE's lock
    // object (objsubid 1) — as a session lock of its own. It never contended
    // with smoke's session lock (objsubid 2) and blocked every other tool's
    // fence for the whole run. Observed from the catalog, mid-run.
    await withClone(async ({ admin, owner: cloneOwner, name }) => {
      await setIdentity("rehearsal", admin);
      await migrate(cloneOwner, name);
      const dir = migrationsWith({ "0099_lock_probe.sql": `${ADDITIVE}CREATE TABLE rm_lock_probe (id integer);\n` });
      const seen: { objsubid: number; pid: number }[] = [];
      await withTargetLock(urlFor(name), async (lock) => {
        await runMigrate(cloneOwner, { ...options(), lock }, {
          migrationsDir: dir,
          afterCommit: async () => {
            const rows = await admin<{ objsubid: number; pid: number }[]>`
              SELECT objsubid::int AS objsubid, pid FROM pg_locks
               WHERE locktype = 'advisory' AND granted
                 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                 AND ((classid::bigint << 32) | objid::bigint) = ${TARGET_LOCK_KEY.toString()}::bigint`;
            seen.push(...rows.map((r) => ({ ...r })));
          },
        });
        expect(seen).toEqual([{ objsubid: 2, pid: lock.backendPid }]);
      });
    });
  });

  test("the fence is the mutating connection's: a competitor inside a fenced mutation holds the run until it commits", async () => {
    // §2: "A competitor that wins the session lock after the coordinator's
    // connection died still blocks on the xact lock until the in-flight
    // mutation commits or aborts." Here the competitor is mid-mutation; the run
    // (under its own session lock) must wait for it, and must not run first.
    await setIdentity("rehearsal");
    await withTargetLock(urlFor(fileDb), async (lock) => {
      const competitor = connect(fileDb);
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const mutation = competitor.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${TARGET_LOCK_KEY.toString()}::bigint)`;
        order.push("competitor fenced");
        await held;
        order.push("competitor commits");
      });
      await Bun.sleep(200);
      const run = runMigrate(owner, { ...options(), lock }).then(() => order.push("run finished"));
      await Bun.sleep(500);
      expect(order).toEqual(["competitor fenced"]);
      release();
      await mutation;
      await run;
      expect(order).toEqual(["competitor fenced", "competitor commits", "run finished"]);
      await competitor.end({ timeout: 5 });
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// migrateCommand — the one command sequence
// ───────────────────────────────────────────────────────────────────────────

describe("migrateCommand — plan, lock, gates, owner, run, receipt, release", () => {
  const log = (): void => {};

  test("a held target lock: it waits its timeout, then refuses naming the holder and its plan id", async () => {
    await setIdentity("rehearsal");
    const planId = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
    const reader = connect(fileDb);
    const holder = await acquireTargetLock({
      databaseUrl: urlFor(fileDb),
      holder: { tool: "smoke", planId, instance: "rm_it_holder", host: "other-host", pid: 4242 },
      timeoutMs: 5_000,
      expected: await readTargetState(reader),
    });
    await reader.end({ timeout: 5 });
    if (!holder.acquired) throw new Error(holder.reason);
    try {
      const started = Date.now();
      const refusal = migrateCommand({
        caller: "smoke_flag",
        env: "stage",
        connection: "local",
        readerUrl: urlFor(fileDb),
        nonInteractive: true,
        localOwnerPassword: OWNER_PASSWORD,
        lock: { acquire: { holder: { tool: "migrate", planId: null, instance: null, host: "h", pid: process.pid }, timeoutMs: 700 } },
        receiptPath: join(mkdtempSync(join(tmpdir(), "rm-migrate-cmd-")), "r.json"),
        log,
      });
      await expect(refusal).rejects.toBeInstanceOf(MigrateRefused);
      await expect(refusal).rejects.toThrow(`held by smoke (instance rm_it_holder) under plan ${planId.slice(0, 12)}`);
      expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    } finally {
      await holder.lock.release();
    }
    expect(await readManifest(sql)).toBeNull();
  });

  test("after acquiring, a plan the target no longer matches refuses — and the lock is released again", async () => {
    await setIdentity("rehearsal");
    const reader = connect(fileDb);
    const holder = await acquireTargetLock({
      databaseUrl: urlFor(fileDb),
      holder: { tool: "smoke", planId: "feedfacefeedfacefeedface", instance: null, host: "h", pid: 1 },
      timeoutMs: 5_000,
      expected: await readTargetState(reader),
    });
    await reader.end({ timeout: 5 });
    if (!holder.acquired) throw new Error(holder.reason);
    const command = migrateCommand({
      caller: "smoke_flag",
      env: "stage",
      connection: "local",
      readerUrl: urlFor(fileDb),
      nonInteractive: true,
      localOwnerPassword: OWNER_PASSWORD,
      lock: { acquire: { holder: { tool: "migrate", planId: null, instance: null, host: "h", pid: process.pid }, timeoutMs: 20_000 } },
      receiptPath: join(mkdtempSync(join(tmpdir(), "rm-migrate-cmd-")), "r.json"),
      log,
    });
    // The command read its plan and is now waiting. The holder re-enrolls the
    // target, then releases.
    await Bun.sleep(500);
    await sql.unsafe("UPDATE deployment_identity SET kind = 'production'");
    await holder.lock.release();
    await expect(command).rejects.toThrow("deployment_identity is production, but the plan was built against rehearsal");
    // …and it did not keep the lock it acquired for the refusal.
    const [held] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted
         AND ((classid::bigint << 32) | objid::bigint) = ${TARGET_LOCK_KEY.toString()}::bigint`;
    expect(held?.n).toBe(0);
  });

  test("a full local run writes a receipt naming the lock it ran under, and releases the lock", async () => {
    await setIdentity("rehearsal");
    const dir = mkdtempSync(join(tmpdir(), "rm-migrate-cmd-"));
    plantedDirs.push(dir);
    const { result, receipt } = await migrateCommand({
      caller: "smoke_flag",
      env: "stage",
      connection: "local",
      readerUrl: urlFor(fileDb),
      nonInteractive: true,
      localOwnerPassword: OWNER_PASSWORD,
      lock: { acquire: { holder: { tool: "migrate", planId: null, instance: null, host: "h", pid: process.pid }, timeoutMs: 5_000 } },
      receiptPath: join(dir, "receipt.json"),
      log,
    });
    expect(result.baselined).toBe(true);
    const text = readFileSync(receipt, "utf8");
    expect(JSON.parse(text).targetLock).toContain("migrate");
    expect(text).not.toContain(OWNER_PASSWORD);
    const [held] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted
         AND ((classid::bigint << 32) | objid::bigint) = ${TARGET_LOCK_KEY.toString()}::bigint`;
    expect(held?.n).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// `bun run migrate` — the real command, as a process
// ───────────────────────────────────────────────────────────────────────────

describe("`bun run migrate` (backend/scripts/migrate.ts)", () => {
  const READONLY_PASSWORD = randomBytes(12).toString("hex");

  function spawnCommand(
    envFile: string,
    extra: { rmEnv?: string; args?: readonly string[] } = {},
  ): { child: Bun.Subprocess<"ignore", "pipe", "pipe">; home: string; done: Promise<{ code: number; out: string }> } {
    const home = mkdtempSync(join(tmpdir(), "rm-migrate-home-"));
    plantedDirs.push(home);
    writeFileSync(join(home, ".env"), envFile, "utf8");
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home };
    if (extra.rmEnv) env.RM_ENV = extra.rmEnv;
    const child = Bun.spawn(["bun", "scripts/migrate.ts", ...(extra.args ?? [])], {
      cwd: BACKEND,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const done = (async () => {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, out: stdout + stderr };
    })();
    return { child, home, done };
  }

  async function runCommand(
    envFile: string,
    extra: { rmEnv?: string; args?: readonly string[] } = {},
  ): Promise<{ code: number; out: string; home: string }> {
    const { home, done } = spawnCommand(envFile, extra);
    return { ...(await done), home };
  }

  async function envFileFor(extraLines = "", host?: string): Promise<string> {
    const url = new URL(config.databaseUrl);
    return [
      `host = ${host ?? url.hostname}`,
      `port = ${url.port || "5432"}`,
      `database = ${fileDb}`,
      "sslmode = disable",
      `rm_readonly = ${READONLY_PASSWORD}`,
      extraLines,
    ].join("\n");
  }

  beforeAll(async () => {
    await sql.unsafe(`ALTER ROLE rm_readonly WITH LOGIN PASSWORD '${READONLY_PASSWORD}'`);
  });

  test("refuses a ~/.env that holds an rm_owner line, before connecting to anything", async () => {
    const { code, out } = await runCommand(await envFileFor("rm_owner = stored-owner-password"), { rmEnv: "prod" });
    expect(code).not.toBe(0);
    expect(out).toContain("rm_owner");
    expect(out).toContain("§3");
    expect(out).not.toContain("stored-owner-password");
  });

  test("refuses a ~/.env that holds a doadmin line — it never logs in as doadmin", async () => {
    const { code, out } = await runCommand(await envFileFor("doadmin = provisioning-password"), { rmEnv: "prod" });
    expect(code).not.toBe(0);
    expect(out).toContain("doadmin");
  });

  test("runs the gates first: RM_ENV=stage against a production identity refuses without asking for a password", async () => {
    await setIdentity("production");
    const receiptDir = mkdtempSync(join(tmpdir(), "rm-migrate-r-"));
    plantedDirs.push(receiptDir);
    const receipt = join(receiptDir, "receipt.json");
    const { code, out } = await runCommand(await envFileFor(), { rmEnv: "stage", args: ["--receipt", receipt] });
    expect(code).not.toBe(0);
    expect(out).toContain("deployment_identity is production");
    expect(out).not.toContain("password (not echoed");
    expect(() => statSync(receipt)).toThrow();
  });

  test("with the gates passed and no terminal, it refuses rather than read an owner password from anywhere", async () => {
    await setIdentity("production");
    const before = await ledgerNames();
    const { code, out, home } = await runCommand(await envFileFor(), { rmEnv: "prod" });
    expect(code).not.toBe(0);
    expect(out).toMatch(/non-interactive|stdin is not a terminal/);
    expect(await readManifest(sql)).toBeNull();
    expect(await ledgerNames()).toEqual(before);
    expect(() => statSync(join(home, ".local", "state", "robotmoney-smoke", "rm_prod"))).toThrow();
  });

  test("criteria 36 + 39: behind a holder reached under ANOTHER hostname it waits --lock-timeout, then exits non-zero naming the holder and its plan id", async () => {
    // The holder connects through 127.0.0.1, the command through `localhost`
    // (the ~/.env host): two hostnames for one database still contend,
    // because the key is one constant and the server scopes it to the database.
    await setIdentity("rehearsal");
    const planId = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const viaIp = new URL(urlFor(fileDb));
    viaIp.hostname = "127.0.0.1";
    const reader = postgres(viaIp.toString(), { max: 1, onnotice: () => {} });
    const held = await acquireTargetLock({
      databaseUrl: viaIp.toString(),
      holder: { tool: "smoke", planId, instance: "rm_it_standing", host: "stage-host", pid: 777 },
      timeoutMs: 5_000,
      expected: await readTargetState(reader),
    });
    await reader.end({ timeout: 5 });
    if (!held.acquired) throw new Error(held.reason);
    try {
      const started = Date.now();
      const { code, out } = await runCommand(await envFileFor("", "localhost"), {
        rmEnv: "stage",
        args: ["--instance", "rm_it_cli", "--lock-timeout", "2"],
      });
      expect(code).not.toBe(0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
      expect(out).toContain(`held by smoke (instance rm_it_standing) under plan ${planId.slice(0, 12)}, on stage-host pid 777`);
      expect(out).toMatch(/waited \d+ms and gave up/);
      expect(out).not.toContain("password (not echoed");
    } finally {
      await held.lock.release();
    }
  }, 30_000);

  test("criterion 21: a target re-enrolled while the command waited refuses after it acquires, naming both values", async () => {
    await setIdentity("rehearsal");
    const reader = connect(fileDb);
    const held = await acquireTargetLock({
      databaseUrl: urlFor(fileDb),
      holder: { tool: "smoke", planId: "cafebabecafebabecafebabe", instance: null, host: "h", pid: 1 },
      timeoutMs: 5_000,
      expected: await readTargetState(reader),
    });
    await reader.end({ timeout: 5 });
    if (!held.acquired) throw new Error(held.reason);
    const { done } = spawnCommand(await envFileFor(), { rmEnv: "stage", args: ["--instance", "rm_it_cli", "--lock-timeout", "30"] });
    // Wait until the command is queued behind the holder: its dedicated lock
    // connection publishes itself through application_name.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const [row] = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE 'rm-tl:migrate|%'`;
      if ((row?.n ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error("the command never queued behind the holder");
      await Bun.sleep(50);
    }
    await sql.unsafe("UPDATE deployment_identity SET kind = 'production'");
    await held.lock.release();
    const { code, out } = await done;
    expect(code).not.toBe(0);
    expect(out).toContain("deployment_identity is production, but the plan was built against rehearsal");
    expect(out).not.toContain("password (not echoed");
    await setIdentity("rehearsal");
  }, 40_000);

  test("under a real terminal the whole sequence runs: gates, masked rm_owner prompt, y, run, receipt", async () => {
    // Criterion 70 as a PROCESS, not a module call. `script` gives the command
    // a pseudo-terminal, so `process.stdin.isTTY` is true and the real
    // hiddenPrompt and confirmation run.
    await setIdentity("rehearsal");
    await migrate(owner, fileDb);
    const manifestBefore = await readManifest(sql);

    const home = mkdtempSync(join(tmpdir(), "rm-migrate-pty-"));
    plantedDirs.push(home);
    writeFileSync(join(home, ".env"), await envFileFor(), "utf8");
    const receipt = join(home, "receipts", "migrate.json");

    const child = Bun.spawn(["script", "-qefc", `bun scripts/migrate.ts --receipt ${receipt}`, "/dev/null"], {
      cwd: BACKEND,
      env: { PATH: process.env.PATH ?? "", HOME: home, RM_ENV: "stage", TERM: "dumb" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let screen = "";
    const decoder = new TextDecoder();
    const pump = (async () => {
      for await (const chunk of child.stdout) screen += decoder.decode(chunk);
    })();
    const waitFor = async (text: string): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (!screen.includes(text)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${text}"; terminal so far:\n${screen}`);
        await Bun.sleep(25);
      }
    };

    try {
      await waitFor("rm_owner password (not echoed");
      child.stdin.write(`${OWNER_PASSWORD}\r`);
      await child.stdin.flush();
      await waitFor("type y to continue");
      expect(screen).toContain("WARNING: this will apply pending migrations to the REMOTE target");
      child.stdin.write("y\r");
      await child.stdin.flush();
      await waitFor("[migrate] receipt ");
      const code = await child.exited;
      await pump;
      expect({ code, screen }).toEqual({ code: 0, screen: expect.any(String) });
    } finally {
      if (child.exitCode === null) child.kill();
      try {
        child.stdin.end();
      } catch {
        // already closed with the process
      }
    }

    const text = readFileSync(receipt, "utf8");
    const written = JSON.parse(text) as { kind: string; manifest: { contentHash: string; filenames: string[] } };
    expect(written.kind).toBe("migrate-receipt");
    expect(text).not.toContain(OWNER_PASSWORD);
    expect(screen).not.toContain(OWNER_PASSWORD);
    for (const file of readdirSync(home, { recursive: true }) as string[]) {
      const path = join(home, file);
      if (statSync(path).isFile()) expect(readFileSync(path, "utf8")).not.toContain(OWNER_PASSWORD);
    }

    const published = await readManifest(sql);
    expect(published?.contentHash).toBe(written.manifest.contentHash);
    expect(published?.filenames).toEqual(await ledgerNames());
    expect(published?.contentHash).toBe(manifestBefore?.contentHash);
    expect((await detectManifestState(sql)).kind).toBe("published");
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// `bun run migrate` has one meaning
// ───────────────────────────────────────────────────────────────────────────

describe("`bun run migrate` resolves to backend/scripts/migrate.ts from BOTH package.json files", () => {
  function resolveMigrateScript(manifest: string): string {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { scripts: Record<string, string> };
    const argv = (pkg.scripts.migrate ?? "").split(/\s+/);
    const cwdAt = argv.indexOf("--cwd");
    const base = join(manifest, "..", cwdAt >= 0 ? argv[cwdAt + 1] ?? "" : "");
    const entry = argv.find((token) => token.endsWith(".ts"));
    if (!entry) throw new Error(`${manifest}: the migrate script names no .ts entry point`);
    return join(base, entry);
  }

  test("root and backend `migrate` both run the gated command", () => {
    const expected = join(BACKEND, "scripts", "migrate.ts");
    expect(resolveMigrateScript(join(BACKEND, "..", "package.json"))).toBe(expected);
    expect(resolveMigrateScript(join(BACKEND, "package.json"))).toBe(expected);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The run itself
// ───────────────────────────────────────────────────────────────────────────

describe("runMigrate — per-migration fenced transactions, always reconcile, publish in that transaction", () => {
  test("refuses a role that cannot act as rm_owner at all", async () => {
    await setIdentity("rehearsal");
    const role = `rm_not_owner_${Date.now().toString(36)}`;
    const password = "not-the-owner";
    await sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEROLE`);
    const stranger = connect(fileDb, { name: role, password });
    try {
      await expect(migrate(stranger, fileDb)).rejects.toThrow("rm_owner");
    } finally {
      await stranger.end({ timeout: 5 });
      await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  });

  test("a run with NOTHING pending still repairs drifted grants and republishes a deleted manifest", async () => {
    await setIdentity("rehearsal");
    await migrate(owner, fileDb);

    await sql.unsafe("REVOKE SELECT ON jobs FROM rm_readonly");
    await sql.unsafe("GRANT DELETE ON audit_log TO rm_app");
    await sql.unsafe("DELETE FROM schema_manifest");
    expect(await tablePrivilege("rm_readonly", "jobs", "SELECT")).toBe(false);
    expect(await tablePrivilege("rm_app", "audit_log", "DELETE")).toBe(true);

    const result = await migrate(owner, fileDb);
    expect(result.applied).toEqual([]);
    expect(await tablePrivilege("rm_readonly", "jobs", "SELECT")).toBe(true);
    expect(await tablePrivilege("rm_app", "audit_log", "DELETE")).toBe(false);
    expect(result.grantsRepaired).toContain("jobs");
    expect(result.grantsRepaired).toContain("audit_log");

    const snapshot = await loadSnapshot();
    const published = await readManifest(sql);
    expect(published).toEqual(result.manifest);
    expect(published?.declaration).toEqual(snapshot.manifest.declaration);
    expect(published?.filenames).toEqual(await ledgerNames());

    expect((await migrate(owner, fileDb)).grantsRepaired).toEqual([]);
  });

  test("the published manifest describes the FINAL state and equals what readManifest returns", async () => {
    await setIdentity("rehearsal");
    await publishManifestFor(await ledgerNames());
    const result = await migrate(owner, fileDb);
    expect(await readManifest(sql)).toEqual(result.manifest);
    expect(result.baselined).toBe(false);
  });

  test("grants reconciliation creates no role, even on a run where it changes grants", async () => {
    await setIdentity("rehearsal");
    await sql.unsafe("REVOKE SELECT ON jobs FROM rm_readonly");
    const before = await roleSnapshot();
    const result = await migrate(owner, fileDb);
    expect(result.grantsRepaired).toContain("jobs");
    expect(await roleSnapshot()).toEqual(before);
  });

  test("re-runs the gates on the owner connection and refuses a row that changed since the caller's gate call", async () => {
    await setIdentity("rehearsal");
    await publishManifestFor(await ledgerNames());
    await sql.unsafe("UPDATE deployment_identity SET kind = 'production'");
    await expect(migrate(owner, fileDb, { caller: "smoke_flag" })).rejects.toThrow("production");
  });

  test("refuses a blank database and names the snapshot bootstrap instead of replaying history", async () => {
    const name = `rm_migrate_blank_${randomBytes(4).toString("hex")}`;
    const maintenance = connect("postgres");
    await maintenance.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
    const blankOwner = connect(name, OWNER);
    try {
      await blankOwner.unsafe("CREATE TABLE deployment_identity (kind text NOT NULL)");
      await blankOwner.unsafe("INSERT INTO deployment_identity (kind) VALUES ('rehearsal')");
      await expect(migrate(blankOwner, name)).rejects.toThrow(/blank.*snapshot/s);
    } finally {
      await blankOwner.end({ timeout: 5 });
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await maintenance.end({ timeout: 5 });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §8.2's header, enforced by the real apply loop
// ───────────────────────────────────────────────────────────────────────────

describe("runMigrate — every pending migration declares additive or breaking", () => {
  test("a pending header-less migration refuses, names itself, and leaves no ledger row and no new manifest", async () => {
    await withClone(async ({ admin, owner: cloneOwner, name }) => {
      await setIdentity("rehearsal", admin);
      await migrate(cloneOwner, name);
      const manifestBefore = await readManifest(admin);
      const ledgerBefore = await ledgerNames(admin);

      const dir = migrationsWith({
        "0098_headed_probe.sql": `${ADDITIVE}CREATE TABLE rm_headed_probe (id integer);\n`,
        "0099_headerless_probe.sql": "-- a probe with prose and no declaration\nCREATE TABLE rm_headerless_probe (id integer);\n",
      });
      await expect(migrate(cloneOwner, name, {}, { migrationsDir: dir })).rejects.toThrow("0099_headerless_probe.sql");
      await expect(migrate(cloneOwner, name, {}, { migrationsDir: dir })).rejects.toThrow(/compat/);

      expect(await ledgerNames(admin)).toEqual(ledgerBefore);
      expect(await readManifest(admin)).toEqual(manifestBefore);
      const [tables] = await admin<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM pg_class WHERE relname IN ('rm_headed_probe', 'rm_headerless_probe')`;
      expect(tables?.n).toBe(0);
    });
  });

  test("a header-less file at or below the 0063 baseline is applied as pre-compat and records NULL compat", async () => {
    await withClone(async ({ admin, owner: cloneOwner, name }) => {
      await setIdentity("rehearsal", admin);
      // The first manifest is baselined against the real snapshot first; the
      // planted files then land on a published database, as any later release's
      // migrations do.
      await migrate(cloneOwner, name);
      const dir = migrationsWith({
        "0063_zz_precompat_probe.sql": "-- no declaration: pre-compat\nCREATE TABLE rm_precompat_probe (id integer);\n",
        "0099_declared_probe.sql": `${ADDITIVE}CREATE TABLE rm_declared_probe (id integer);\n`,
      });
      const result = await migrate(cloneOwner, name, {}, { migrationsDir: dir });
      expect(result.applied).toEqual(["0063_zz_precompat_probe.sql", "0099_declared_probe.sql"]);
      const rows = await admin<{ name: string; compat: string | null; metadata_version: number | null }[]>`
        SELECT name, compat, metadata_version FROM schema_migrations
        WHERE name IN ('0063_zz_precompat_probe.sql', '0099_declared_probe.sql') ORDER BY name`;
      expect(rows.map((r) => ({ ...r }))).toEqual([
        { name: "0063_zz_precompat_probe.sql", compat: null, metadata_version: null },
        { name: "0099_declared_probe.sql", compat: "additive", metadata_version: 1 },
      ]);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Recovery from an interrupted run
// ───────────────────────────────────────────────────────────────────────────

describe("runMigrate — recovery from an interrupted run", () => {
  test("a REAL interruption between two commits leaves an in-progress database, and a rerun resumes without replaying", async () => {
    await withClone(async ({ admin, owner: cloneOwner, name }) => {
      await setIdentity("rehearsal", admin);
      await migrate(cloneOwner, name);
      const dir = migrationsWith({
        "0098_interrupt_probe_a.sql": `${ADDITIVE}CREATE TABLE rm_interrupt_probe_a (id integer);\n`,
        "0099_interrupt_probe_b.sql": `${ADDITIVE}CREATE TABLE rm_interrupt_probe_b (id integer);\n`,
      });

      const killed = new Error("injected: the process died after 0098 committed");
      await expect(
        migrate(cloneOwner, name, {}, {
          migrationsDir: dir,
          afterCommit: (file) => {
            if (file === "0098_interrupt_probe_a.sql") throw killed;
          },
        }),
      ).rejects.toThrow(killed.message);

      const state = await detectManifestState(admin);
      expect(state.kind).toBe("in_progress");
      if (state.kind === "in_progress") expect(state.ahead).toEqual(["0098_interrupt_probe_a.sql"]);
      const ledger = await ledgerNames(admin);
      expect(ledger).toContain("0098_interrupt_probe_a.sql");
      expect(ledger).not.toContain("0099_interrupt_probe_b.sql");
      const committed = await appliedAtByName(admin);

      const rerun = await migrate(cloneOwner, name, {}, { migrationsDir: dir });
      expect(rerun.resumedAndVerified).toEqual(["0098_interrupt_probe_a.sql"]);
      expect(rerun.applied).toEqual(["0099_interrupt_probe_b.sql"]);
      expect((await detectManifestState(admin)).kind).toBe("published");

      const after = await appliedAtByName(admin);
      for (const [n, at] of committed) expect({ n, at: after.get(n) }).toEqual({ n, at });
    });
  });

  test("a failure DURING GRANT RECONCILIATION publishes nothing, and a rerun finishes with every applied_at unchanged", async () => {
    await withClone(async ({ admin, owner: cloneOwner, name }) => {
      await setIdentity("rehearsal", admin);
      await migrate(cloneOwner, name);
      const manifestBefore = await readManifest(admin);
      const dir = migrationsWith({
        "0099_reconcile_probe.sql": `${ADDITIVE}CREATE TABLE rm_reconcile_probe (id integer);\n`,
      });
      await admin.unsafe("CREATE TABLE rm_migrate_foreign_probe (id integer)");
      await admin.unsafe("ALTER TABLE rm_migrate_foreign_probe OWNER TO rm_app");

      await expect(migrate(cloneOwner, name, {}, { migrationsDir: dir })).rejects.toThrow("owned by a runtime role");
      // The migration committed in its own transaction; the manifest did not,
      // because it publishes in the reconciliation's.
      expect(await ledgerNames(admin)).toContain("0099_reconcile_probe.sql");
      expect(await readManifest(admin)).toEqual(manifestBefore);
      const committed = await appliedAtByName(admin);

      await admin.unsafe("DROP TABLE rm_migrate_foreign_probe");
      const rerun = await migrate(cloneOwner, name, {}, { migrationsDir: dir });
      expect(rerun.applied).toEqual([]);
      expect(rerun.resumedAndVerified).toContain("0099_reconcile_probe.sql");
      expect(await readManifest(admin)).toEqual(rerun.manifest);

      const after = await appliedAtByName(admin);
      expect(after.size).toBe(committed.size);
      for (const [n, at] of committed) expect({ n, at: after.get(n) }).toEqual({ n, at });
    });
  });

  test("a resume from a hand-published prefix manifest verifies the rest and replays nothing", async () => {
    await setIdentity("rehearsal");
    const names = await ledgerNames();
    const witness = names[names.length - 1] ?? "";
    const before = await appliedAtFor(witness);
    await publishManifestFor(names.slice(0, -2));

    const result = await migrate(owner, fileDb);
    expect(result.resumedAndVerified).toEqual(names.slice(-2));
    expect(result.applied).toEqual([]);
    expect(await appliedAtFor(witness)).toEqual(before);
    expect((await ledgerNames()).length).toBe(names.length);
    expect(result.manifest.filenames).toEqual(names);
    expect(await readManifest(sql)).toEqual(result.manifest);
  });

  test("a second rerun after a completed one is a no-op that still reconciles", async () => {
    await setIdentity("rehearsal");
    const first = await migrate(owner, fileDb);
    const second = await migrate(owner, fileDb);
    expect(second.applied).toEqual([]);
    expect(second.resumedAndVerified).toEqual([]);
    expect(second.grantsRepaired).toEqual([]);
    expect(second.manifest).toEqual(first.manifest);
  });

  test("refuses to resume an INCONSISTENT manifest rather than repairing it silently", async () => {
    await setIdentity("rehearsal");
    const names = await ledgerNames();
    await sql`
      INSERT INTO schema_manifest (format_version, declaration, filenames, content_hash)
      VALUES (${MANIFEST_FORMAT_VERSION}, ${DECLARATION.text}, ${names}, ${"f".repeat(64)})`;
    await expect(migrate(owner, fileDb)).rejects.toThrow(/inconsistent|hash/i);
  });

  test("refuses when the ledger names a migration this checkout does not contain", async () => {
    await withClone(async ({ admin, owner: cloneOwner, name }) => {
      await setIdentity("rehearsal", admin);
      await admin`INSERT INTO schema_migrations (name) VALUES ('0099_from_a_newer_release.sql')`;
      await expect(migrate(cloneOwner, name)).rejects.toThrow("0099_from_a_newer_release.sql");
    });
  });

  test("refuses committed work that fails its expected post-state check — a resume never accepts drift", async () => {
    await setIdentity("rehearsal");
    const names = await ledgerNames();
    await publishManifestFor(names.filter((n) => n < "0032_append_only_history.sql"));
    await sql.unsafe("DROP TRIGGER IF EXISTS swarm_members_append_only ON swarm_members");
    await expect(migrate(owner, fileDb)).rejects.toThrow("swarm_members");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A snapshot-bootstrapped database (§8.1), then a real run
// ───────────────────────────────────────────────────────────────────────────

describe("snapshot bootstrap, then runMigrate", () => {
  test("a snapshot-bootstrapped database, then runMigrate as rm_owner, applies nothing and verifies; rm_owner never holds CREATEROLE", async () => {
    // Spec §10 W2 "Snapshot bootstrap then `--migrate`". The database is blank
    // and owned by rm_owner, the way `--local blank` hands it over; pgcrypto is
    // on the snapshot's provider exclusion list, so the fixture installs it the
    // way a managed cluster does.
    const name = `rm_migrate_snapshot_${randomBytes(4).toString("hex")}`;
    const maintenance = connect("postgres");
    await maintenance.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
    const admin = connect(name);
    await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    const snapshot = await loadSnapshot();
    try {
      const bootstrapper = connect(name, OWNER);
      try {
        await bootstrapBlankDatabase(bootstrapper, snapshot);
      } finally {
        await bootstrapper.end({ timeout: 5 });
      }
      expect((await ownerAttributes()).rolcreaterole).toBe(false);

      const snapshotOwner = connect(name, OWNER);
      try {
        const result = await migrate(snapshotOwner, name);
        expect(result.applied).toEqual([]);
        expect(result.resumedAndVerified).toEqual([]);
        expect(result.baselined).toBe(false);
        expect(result.manifest.contentHash).toBe(snapshot.manifest.contentHash);
        expect(result.manifest.filenames).toEqual(snapshot.filenames);
      } finally {
        await snapshotOwner.end({ timeout: 5 });
      }
      expect((await detectManifestState(admin)).kind).toBe("published");
      expect((await ownerAttributes()).rolcreaterole).toBe(false);
    } finally {
      await admin.end({ timeout: 5 });
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await maintenance.end({ timeout: 5 });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Criterion 54's seam pair: a synthesized migration M, with a snapshot that
// embodies it, published through the REAL runner
// ───────────────────────────────────────────────────────────────────────────

describe("MigrateRunSeams — migrationsDir with snapshotDir publishes M's manifest through the real run", () => {
  test("a fixture snapshot embodying a synthesized additive migration is the one the run loads and publishes", async () => {
    const { cpSync } = await import("node:fs");
    const { serializeDeclaration } = await import("../src/db/schema-manifest.ts");
    await withClone(async ({ admin, owner: cloneOwner, name }) => {
      await setIdentity("rehearsal", admin);
      await migrate(cloneOwner, name);

      const synthesized = "0099_synthesized_additive.sql";
      const migrationsDir = migrationsWith({ [synthesized]: `${ADDITIVE}CREATE TABLE rm_synthesized (id integer);\n` });
      // The snapshot fixture: backend/schema/ with M appended to its filename
      // list and the hash recomputed over the same declaration — the smallest
      // honest "snapshot N+1" for this test's M.
      const snapshotDir = mkdtempSync(join(tmpdir(), "rm-migrate-snapshot-"));
      plantedDirs.push(snapshotDir);
      cpSync(join(BACKEND, "schema"), join(snapshotDir, "schema"), { recursive: true });
      const metadataPath = join(snapshotDir, "schema", "snapshot.json");
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
        filenames: string[];
        exclusions: { roles: string[]; extensions: string[] };
        fingerprint: Record<string, Record<string, string>>;
        contentHash: string;
      };
      metadata.filenames = [...metadata.filenames, synthesized];
      const declarationSql = readFileSync(join(snapshotDir, "schema", "snapshot.sql"), "utf8").replace(/\s+$/, "");
      const declaration = serializeDeclaration({ sql: declarationSql, exclusions: metadata.exclusions, fingerprint: metadata.fingerprint });
      metadata.contentHash = hashManifest(declaration, metadata.filenames);
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      // Red control: the fixture snapshot does NOT load against the real
      // migrations directory — the pair is checked as a pair.
      await expect(loadSnapshot(snapshotDir)).rejects.toThrow(synthesized);

      const result = await migrate(cloneOwner, name, {}, { migrationsDir, snapshotDir });
      expect(result.applied).toEqual([synthesized]);
      expect(result.manifest.filenames.at(-1)).toBe(synthesized);
      expect(result.manifest.contentHash).toBe(metadata.contentHash);
      expect(await readManifest(admin)).toEqual(result.manifest);
      expect((await detectManifestState(admin)).kind).toBe("published");
    });
  });
});
