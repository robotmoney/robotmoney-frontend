// The migrate RUN (spec §8.3), the gates in front of it (§8.5, §4.3), and the
// `bun run migrate` command that drives it (backend/scripts/migrate.ts).
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
// single committed migration, proved by `applied_at` identity. That is the §10
// W2 gate "Migrate fails between commits and during grant reconciliation;
// rerun reaches a verified final state", stated as something executable.
//
// WHO IS CONNECTED. The suite's own handle is the container superuser, which
// may act as rm_owner, so the runner's `SET LOCAL ROLE rm_owner` works under it.
// The cases that make a claim about rm_owner (criterion 70: "migrate runs as
// `rm_owner`") log in AS rm_owner instead, with a password this file sets on
// the role for its own run and clears afterwards. Tests that plant migration
// files or ledger rows run in a private clone of the migrated template,
// because `schema_migrations` is append-only and a planted row would outlive
// the test.
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
import {
  checkMigrateGates,
  confirmRemoteTarget,
  migrateReceiptPath,
  promptOwnerPassword,
  runMigrate,
  writeMigrateReceipt,
  type MigrateRunOptions,
} from "../scripts/migrate-run.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const BACKEND = join(import.meta.dir, "..");

// The §2 advisory-lock key is derived from the DATABASE identity. These tests
// pass a literal, because what is under test is the fencing, not the
// derivation.
function options(over: Partial<MigrateRunOptions> = {}): MigrateRunOptions {
  return {
    caller: "smoke_flag",
    env: "stage",
    connection: "local",
    lockKey: 7726322199513601n,
    sessionLockHeld: false,
    nonInteractive: true,
    ...over,
  };
}

// The REAL enrollment table, migration 0063's: one row at most (its key is a
// boolean pinned true), zero rows allowed, which is exactly the missing-row
// case. It is owned by rm_owner, so a run logged in AS rm_owner can read it.
async function setIdentity(value: "production" | "rehearsal" | null, db: postgres.Sql<{}> = sql): Promise<void> {
  await db.unsafe("DELETE FROM deployment_identity");
  if (value) await db`INSERT INTO deployment_identity (kind) VALUES (${value})`;
}

const DECLARATION = { text: "-- the snapshot's declaration for these tests\n" };

async function publishManifestFor(filenames: readonly string[]): Promise<void> {
  await sql`
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

// ───────────────────────────────────────────────────────────────────────────
// Logging in AS rm_owner, and private databases
// ───────────────────────────────────────────────────────────────────────────

// Set on the cluster's rm_owner for this file only, and cleared in afterAll.
// Held in a module constant, never in process.env: the property under test is
// that the owner password lives in no environment variable and no file.
const OWNER_PASSWORD = randomBytes(18).toString("base64url");

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

const OWNER = { name: "rm_owner", password: OWNER_PASSWORD };

/** A private clone of the migrated, seeded template, with a superuser handle
 *  for fixtures and an rm_owner login for the run. Dropped afterwards. */
async function withClone(
  body: (dbs: { admin: postgres.Sql<{}>; owner: postgres.Sql<{}>; name: string }) => Promise<void>,
): Promise<void> {
  const name = `rm_migrate_run_${randomBytes(4).toString("hex")}`;
  const maintenance = connect("postgres");
  await maintenance.unsafe(`CREATE DATABASE ${name} TEMPLATE "${process.env.RM_TEST_TEMPLATE_DB}"`);
  const admin = connect(name);
  const owner = connect(name, OWNER);
  try {
    await body({ admin, owner, name });
  } finally {
    await owner.end({ timeout: 5 });
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

beforeAll(async () => {
  await sql.unsafe(`ALTER ROLE rm_owner PASSWORD '${OWNER_PASSWORD}'`);
});

afterAll(async () => {
  await sql.unsafe("ALTER ROLE rm_owner LOGIN PASSWORD NULL");
  for (const dir of plantedDirs) rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  await sql.unsafe("DELETE FROM schema_manifest");
  await sql.unsafe("DELETE FROM deployment_identity");
});

// ───────────────────────────────────────────────────────────────────────────
// The gates, applied before anything connects as rm_owner
// ───────────────────────────────────────────────────────────────────────────

describe("checkMigrateGates — §8.5 and §4.3, before the owner password is ever requested", () => {
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

  test("RM_ENV=stage with a typed owner password against a production identity refuses", async () => {
    // The §10 W2 gate, verbatim. The remote confirmation is the last thing in
    // front of this refusal, never a substitute for it.
    await setIdentity("production");
    const refusals = await checkMigrateGates(
      sql,
      options({ caller: "operator", env: "stage", connection: "remote", nonInteractive: false }),
    );
    expect(refusals.map((r) => r.reason)).toContain("identity_not_rehearsal");
  });

  test("the operator caller MAY run on prod against a production identity", async () => {
    // §8.5: "In production an upgrade is an operator intervention:
    // `bun run migrate`, prompting for `rm_owner`, planned per release,
    // receipted." Two callers, two rule sets, one run.
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
      promptOwnerPassword(options({ connection: "remote", nonInteractive: true })),
    ).rejects.toThrow(/non-?interactive|terminal/i);
  });

  test("uses the password smoke generated in local modes, with no prompt at all", async () => {
    // §5: smoke "generates the four role passwords and saves them in the
    // instance's state directory beside the volume" and "No terminal prompt
    // exists in local modes" — so nonInteractive is irrelevant here.
    const password = await promptOwnerPassword(options({ connection: "local", nonInteractive: true }));
    expect(typeof password).toBe("string");
    expect(password.length).toBeGreaterThan(0);
  });

  test("never leaves the owner password in the process environment", async () => {
    const password = await promptOwnerPassword(options({ connection: "local", nonInteractive: true, lockKey: 1n }));
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

describe("rm_owner — LOGIN, the migration login, never CREATEROLE", () => {
  test("a cluster migrated from scratch has rm_owner LOGIN and without CREATEROLE, as 0053 now creates it", async () => {
    // This cluster was built by applying every migration to an empty Postgres
    // (tests/preload.ts), so its rm_owner is exactly what 0053 created. No
    // ALTER ROLE in this file changes rolcanlogin before this case runs.
    expect(await ownerAttributes()).toEqual({ rolcanlogin: true, rolcreaterole: false, rolsuper: false });
  });

  test("migrate runs AS rm_owner on a migrated database, and rm_owner holds no CREATEROLE afterwards", async () => {
    await setIdentity("rehearsal");
    const owner = connect(await currentDatabase(), OWNER);
    try {
      const [who] = await owner<{ user: string }[]>`SELECT current_user AS user`;
      expect(who?.user).toBe("rm_owner");
      const result = await runMigrate(owner, options());
      expect(result.applied).toEqual([]);
      expect(await readManifest(sql)).toEqual(result.manifest);
    } finally {
      await owner.end({ timeout: 5 });
    }
    expect((await ownerAttributes()).rolcreaterole).toBe(false);
  });

  test("an existing database's NOLOGIN rm_owner refuses as `§9.1 step 1 has not been applied`, then migrates once it has", async () => {
    // Every database that recorded 0053 before it said LOGIN still has a
    // NOLOGIN owner, and the runner never re-applies a recorded file. The
    // refusal must name the doadmin step, not report a bad password.
    await setIdentity("rehearsal");
    await sql.unsafe("ALTER ROLE rm_owner NOLOGIN PASSWORD NULL");
    try {
      const existing = options({ connection: "local", nonInteractive: true, lockKey: 99n });
      await promptOwnerPassword(existing); // the local generation this identity will reuse
      await expect(promptOwnerPassword(existing)).rejects.toThrow("ALTER ROLE rm_owner LOGIN PASSWORD");

      // Spec §9.1 step 1, through the provisioning login: LOGIN plus a
      // password, then a verification login — which here is the run itself.
      await sql.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
      const owner = connect(await currentDatabase(), OWNER);
      try {
        const result = await runMigrate(owner, options());
        expect(result.manifest.filenames).toEqual(await ledgerNames());
      } finally {
        await owner.end({ timeout: 5 });
      }
    } finally {
      await sql.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
    }
    expect((await ownerAttributes()).rolcreaterole).toBe(false);
  });

  test("the run writes a receipt, and neither it nor the environment holds the owner password", async () => {
    await setIdentity("rehearsal");
    const stateDir = mkdtempSync(join(tmpdir(), "rm-migrate-receipt-"));
    plantedDirs.push(stateDir);
    const owner = connect(await currentDatabase(), OWNER);
    try {
      const startedAt = new Date();
      const result = await runMigrate(owner, options({ caller: "operator" }));
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
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// `bun run migrate` — the real command, as a process
// ───────────────────────────────────────────────────────────────────────────

describe("`bun run migrate` (backend/scripts/migrate.ts)", () => {
  const READONLY_PASSWORD = randomBytes(12).toString("hex");

  async function runCommand(
    envFile: string,
    extra: { rmEnv?: string; args?: readonly string[] } = {},
  ): Promise<{ code: number; out: string; home: string }> {
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
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, out: stdout + stderr, home };
  }

  async function envFileFor(extraLines = ""): Promise<string> {
    const url = new URL(config.databaseUrl);
    return [
      `host = ${url.hostname}`,
      `port = ${url.port || "5432"}`,
      `database = ${await currentDatabase()}`,
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
    expect(out).toContain("deployment_identity is `production`");
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
    // No receipt, because nothing ran.
    expect(() => statSync(join(home, ".local", "state", "robotmoney-smoke", "rm_prod"))).toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The run itself
// ───────────────────────────────────────────────────────────────────────────

describe("runMigrate — fence, per-migration transactions, always reconcile, publish in that transaction", () => {
  test("refuses when the effective role is not rm_owner", async () => {
    // THE FIXTURE IS THE SESSION, not the database state: §8.3's rule that
    // "Only `rm_owner` may write it or the ledger's `compat`/`metadata_version`
    // columns". The suite's own handle is the container superuser, which can
    // act as rm_owner and must therefore be allowed through, so this case
    // connects as a role that genuinely cannot.
    await setIdentity("rehearsal");

    const role = `rm_not_owner_${Date.now().toString(36)}`;
    const password = "not-the-owner";
    await sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEROLE`);
    const stranger = connect(await currentDatabase(), { name: role, password });
    try {
      await expect(runMigrate(stranger, options())).rejects.toThrow("rm_owner");
    } finally {
      await stranger.end({ timeout: 5 });
      await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  });

  test("refuses when the fence cannot be taken, naming the holder", async () => {
    // §2: "A tool that finds the lock held waits with a timeout, then refuses
    // naming the holder."
    await setIdentity("rehearsal");
    const key = 7726322199513601n;
    const competitor = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await competitor.unsafe(`SELECT pg_advisory_lock(${key.toString()}::bigint)`);
      const [holder] = await competitor<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await expect(runMigrate(sql, options({ lockKey: key }))).rejects.toThrow(String(holder?.pid ?? ""));
    } finally {
      await competitor.end({ timeout: 5 });
    }
  });

  test("a run with NOTHING pending still repairs drifted grants and republishes a deleted manifest", async () => {
    // "even with nothing pending" is the clause that catches production today:
    // a grant fixed by hand and then lost is invisible to a run that skips
    // reconciliation when the migration list is empty.
    await setIdentity("rehearsal");
    await runMigrate(sql, options());

    await sql.unsafe("REVOKE SELECT ON jobs FROM rm_readonly");
    await sql.unsafe("GRANT DELETE ON audit_log TO rm_app");
    await sql.unsafe("DELETE FROM schema_manifest");
    expect(await tablePrivilege("rm_readonly", "jobs", "SELECT")).toBe(false);
    expect(await tablePrivilege("rm_app", "audit_log", "DELETE")).toBe(true);

    const result = await runMigrate(sql, options());
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

    // …and the repair list is a measurement, not a constant: a run that found
    // nothing to repair says so.
    expect((await runMigrate(sql, options())).grantsRepaired).toEqual([]);
  });

  test("the published manifest describes the FINAL state and equals what readManifest returns", async () => {
    await setIdentity("rehearsal");
    await publishManifestFor(await ledgerNames());
    const result = await runMigrate(sql, options());
    expect(await readManifest(sql)).toEqual(result.manifest);
  });

  test("grants reconciliation creates no role, even on a run where it changes grants", async () => {
    // D52 / spec §8.1: "Role creation is not part of it." Snapshot the whole
    // role catalog, make reconciliation do real work, and compare.
    await setIdentity("rehearsal");
    await sql.unsafe("REVOKE SELECT ON jobs FROM rm_readonly");
    const before = await roleSnapshot();
    const result = await runMigrate(sql, options());
    expect(result.grantsRepaired).toContain("jobs");
    expect(await roleSnapshot()).toEqual(before);
  });

  test("revalidates deployment_identity after acquiring the fence and refuses a mismatch", async () => {
    // §2: "After acquiring, the tool re-reads `deployment_identity`, the ledger,
    // and the schema manifest and re-runs the plan against them. A mismatch
    // refuses." The row can change between the gate call and here.
    await setIdentity("rehearsal");
    await publishManifestFor(await ledgerNames());
    await sql.unsafe("UPDATE deployment_identity SET kind = 'production'");
    await expect(runMigrate(sql, options({ caller: "smoke_flag" }))).rejects.toThrow("production");
  });

  test("takes the session lock too when the caller does not already hold it", async () => {
    await setIdentity("rehearsal");
    await publishManifestFor(await ledgerNames());
    const key = 7726322199513602n;
    await runMigrate(sql, options({ lockKey: key, sessionLockHeld: false }));
    // …and releases it explicitly on exit, so the next tool is not blocked by a
    // lock nobody is using.
    const [after] = (await sql.unsafe(`
      SELECT COUNT(*)::int AS count FROM pg_locks
      WHERE locktype = 'advisory' AND ((classid::bigint << 32) | objid::bigint) = ${key.toString()}::bigint`)) as unknown as {
      count: number;
    }[];
    expect(after?.count).toBe(0);
  });

  test("refuses a blank database and names the snapshot bootstrap instead of replaying history", async () => {
    const name = `rm_migrate_blank_${randomBytes(4).toString("hex")}`;
    const maintenance = connect("postgres");
    await maintenance.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
    const owner = connect(name, OWNER);
    try {
      // The gates need an enrollment to read; a blank database has none, so
      // the refusal a caller sees first is the identity one. Give it a
      // rehearsal row the way `--local blank` would, and nothing else.
      await owner.unsafe("CREATE TABLE deployment_identity (kind text NOT NULL)");
      await owner.unsafe("INSERT INTO deployment_identity (kind) VALUES ('rehearsal')");
      await expect(runMigrate(owner, options())).rejects.toThrow(/blank.*snapshot/s);
    } finally {
      await owner.end({ timeout: 5 });
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
    await withClone(async ({ admin, owner }) => {
      await setIdentity("rehearsal", admin);
      await runMigrate(owner, options());
      const manifestBefore = await readManifest(admin);
      const ledgerBefore = await ledgerNames(admin);

      const dir = migrationsWith({
        "0098_headed_probe.sql": `${ADDITIVE}CREATE TABLE rm_headed_probe (id integer);\n`,
        "0099_headerless_probe.sql": "-- a probe with prose and no declaration\nCREATE TABLE rm_headerless_probe (id integer);\n",
      });
      const refusal = runMigrate(owner, options(), { migrationsDir: dir });
      await expect(refusal).rejects.toThrow("0099_headerless_probe.sql");
      await expect(runMigrate(owner, options(), { migrationsDir: dir })).rejects.toThrow(/compat/);

      // Refused BEFORE the first commit: not even the well-formed file ahead
      // of it was applied.
      expect(await ledgerNames(admin)).toEqual(ledgerBefore);
      expect(await readManifest(admin)).toEqual(manifestBefore);
      const [tables] = await admin<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM pg_class WHERE relname IN ('rm_headed_probe', 'rm_headerless_probe')`;
      expect(tables?.n).toBe(0);
    });
  });

  test("a header-less file at or below the 0063 baseline is applied as pre-compat and records NULL compat", async () => {
    // D53 decision 3: files 0001-0063 predate the header and are not
    // backfilled. One that is still pending applies, and its ledger row says
    // nothing about compatibility rather than inventing a claim.
    await withClone(async ({ admin, owner }) => {
      await setIdentity("rehearsal", admin);
      const dir = migrationsWith({
        "0063_zz_precompat_probe.sql": "-- no declaration: pre-compat\nCREATE TABLE rm_precompat_probe (id integer);\n",
        "0099_declared_probe.sql": `${ADDITIVE}CREATE TABLE rm_declared_probe (id integer);\n`,
      });
      const result = await runMigrate(owner, options(), { migrationsDir: dir });
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
    await withClone(async ({ admin, owner }) => {
      await setIdentity("rehearsal", admin);
      await runMigrate(owner, options());
      const dir = migrationsWith({
        "0098_interrupt_probe_a.sql": `${ADDITIVE}CREATE TABLE rm_interrupt_probe_a (id integer);\n`,
        "0099_interrupt_probe_b.sql": `${ADDITIVE}CREATE TABLE rm_interrupt_probe_b (id integer);\n`,
      });

      const killed = new Error("injected: the process died after 0098 committed");
      await expect(
        runMigrate(owner, options(), {
          migrationsDir: dir,
          afterCommit: (file) => {
            if (file === "0098_interrupt_probe_a.sql") throw killed;
          },
        }),
      ).rejects.toThrow(killed.message);

      // What the interruption actually left, read through the one classifier
      // both boot and the migrate tool use. The manifest is the one a real run
      // published, so its hash verifies and `in_progress` is the only finding.
      const state = await detectManifestState(admin);
      expect(state.kind).toBe("in_progress");
      if (state.kind === "in_progress") expect(state.ahead).toEqual(["0098_interrupt_probe_a.sql"]);
      const ledger = await ledgerNames(admin);
      expect(ledger).toContain("0098_interrupt_probe_a.sql");
      expect(ledger).not.toContain("0099_interrupt_probe_b.sql");
      const committed = await appliedAtByName(admin);

      const rerun = await runMigrate(owner, options(), { migrationsDir: dir });
      expect(rerun.resumedAndVerified).toEqual(["0098_interrupt_probe_a.sql"]);
      expect(rerun.applied).toEqual(["0099_interrupt_probe_b.sql"]);
      expect((await detectManifestState(admin)).kind).toBe("published");

      // Nothing replayed: every row that existed after the interruption keeps
      // its applied_at.
      const after = await appliedAtByName(admin);
      for (const [name, at] of committed) expect({ name, at: after.get(name) }).toEqual({ name, at });
    });
  });

  test("a failure DURING GRANT RECONCILIATION publishes nothing, and a rerun finishes with every applied_at unchanged", async () => {
    await withClone(async ({ admin, owner }) => {
      await setIdentity("rehearsal", admin);
      const dir = migrationsWith({
        "0099_reconcile_probe.sql": `${ADDITIVE}CREATE TABLE rm_reconcile_probe (id integer);\n`,
      });
      // grants.sql refuses a relation a runtime role owns (check 2's
      // `object_ownership`), inside the reconciliation transaction.
      await admin.unsafe("CREATE TABLE rm_migrate_foreign_probe (id integer)");
      await admin.unsafe("ALTER TABLE rm_migrate_foreign_probe OWNER TO rm_app");
      expect(await readManifest(admin)).toBeNull();

      await expect(runMigrate(owner, options(), { migrationsDir: dir })).rejects.toThrow(
        "owned by a runtime role",
      );
      // The migration committed in its own transaction; the manifest did not,
      // because it publishes in the reconciliation's.
      expect(await ledgerNames(admin)).toContain("0099_reconcile_probe.sql");
      expect(await readManifest(admin)).toBeNull();
      const committed = await appliedAtByName(admin);

      await admin.unsafe("DROP TABLE rm_migrate_foreign_probe");
      const rerun = await runMigrate(owner, options(), { migrationsDir: dir });
      expect(rerun.applied).toEqual([]);
      expect(rerun.resumedAndVerified).toContain("0099_reconcile_probe.sql");
      expect(await readManifest(admin)).toEqual(rerun.manifest);

      const after = await appliedAtByName(admin);
      expect(after.size).toBe(committed.size);
      for (const [name, at] of committed) expect({ name, at: after.get(name) }).toEqual({ name, at });
    });
  });

  test("a resume from a hand-published prefix manifest verifies the rest and replays nothing", async () => {
    await setIdentity("rehearsal");
    const names = await ledgerNames();
    const witness = names[names.length - 1] ?? "";
    const before = await appliedAtFor(witness);
    await publishManifestFor(names.slice(0, -2));

    const result = await runMigrate(sql, options());
    expect(result.resumedAndVerified).toEqual(names.slice(-2));
    expect(result.applied).toEqual([]);
    expect(await appliedAtFor(witness)).toEqual(before);
    expect((await ledgerNames()).length).toBe(names.length);
  });

  test("a second rerun after a completed one is a no-op that still reconciles", async () => {
    await setIdentity("rehearsal");
    const first = await runMigrate(sql, options());
    const second = await runMigrate(sql, options());
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
    await expect(runMigrate(sql, options())).rejects.toThrow(/inconsistent|hash/i);
  });

  test("refuses when the ledger names a migration this checkout does not contain", async () => {
    await withClone(async ({ admin, owner }) => {
      await setIdentity("rehearsal", admin);
      await admin`INSERT INTO schema_migrations (name) VALUES ('0099_from_a_newer_release.sql')`;
      await expect(runMigrate(owner, options())).rejects.toThrow("0099_from_a_newer_release.sql");
    });
  });

  test("refuses committed work that fails its expected post-state check — a resume never accepts drift", async () => {
    await setIdentity("rehearsal");
    const names = await ledgerNames();
    await publishManifestFor(names.filter((n) => n < "0032_append_only_history.sql"));
    await sql.unsafe("DROP TRIGGER IF EXISTS swarm_members_append_only ON swarm_members");
    await expect(runMigrate(sql, options())).rejects.toThrow("swarm_members");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A snapshot-bootstrapped database (§8.1), then a real run
// ───────────────────────────────────────────────────────────────────────────

describe("snapshot bootstrap, then runMigrate", () => {
  test("a snapshot-bootstrapped database, then runMigrate as rm_owner, applies nothing and verifies", async () => {
    // Spec §10 W2 "Snapshot bootstrap then `--migrate`". The database is blank
    // and owned by rm_owner, the way `--local blank` hands it over; pgcrypto is
    // provider-managed (PROVIDER_MANAGED_EXCLUSIONS), so the fixture installs
    // it the way a managed cluster does.
    const name = `rm_migrate_snapshot_${randomBytes(4).toString("hex")}`;
    const maintenance = connect("postgres");
    await maintenance.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
    const admin = connect(name);
    await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    const snapshot = await loadSnapshot();
    try {
      // The declaration sets a session search_path, so the bootstrap gets its
      // own connection and the run a fresh one.
      const bootstrapper = connect(name, OWNER);
      try {
        await bootstrapBlankDatabase(bootstrapper, snapshot);
      } finally {
        await bootstrapper.end({ timeout: 5 });
      }
      expect((await ownerAttributes()).rolcreaterole).toBe(false);

      const owner = connect(name, OWNER);
      try {
        const result = await runMigrate(owner, options());
        expect(result.applied).toEqual([]);
        expect(result.resumedAndVerified).toEqual([]);
        expect(result.manifest.contentHash).toBe(snapshot.manifest.contentHash);
        expect(result.manifest.filenames).toEqual(snapshot.filenames);
      } finally {
        await owner.end({ timeout: 5 });
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
