// The migrate RUN (spec §8.3) and the gates in front of it (§8.5, §4.3).
//
// These tests are the specification for scripts/migrate-run.ts. Every function
// there throws `NOT IMPLEMENTED` today, so every test here fails — #1026 W2
// step 2's deliverable. Nothing here touches backend/scripts/migrate.ts, which
// is still what `bun run migrate` invokes and is untouched by this workstream.
//
// WHAT AN INTERRUPTED RUN IS TESTED AS. There is no hook to kill the process
// between two commits, so the failure modes are constructed as the DATABASE
// STATES those failures leave, which is what recovery actually reasons about:
//
//   * failure BETWEEN COMMITS  → ledger ahead of manifest with pending work
//     still on disk (§8.3's *in progress*).
//   * failure DURING GRANT RECONCILIATION → every migration committed, no
//     manifest published, because the manifest publishes inside that same
//     transaction and therefore never committed either.
//
// A rerun against each must reach a published manifest without re-applying a
// single committed migration. That is the §10 W2 gate "Migrate fails between
// commits and during grant reconciliation; rerun reaches a verified final
// state", stated as something executable.
import { afterEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { hashManifest, MANIFEST_FORMAT_VERSION, MANIFEST_TABLE, readManifest } from "../src/db/schema-manifest.ts";
import {
  checkMigrateGates,
  confirmRemoteTarget,
  promptOwnerPassword,
  runMigrate,
  type MigrateRunOptions,
} from "../scripts/migrate-run.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

// The §2 advisory-lock key is derived from the DATABASE identity — "not the
// compose project", so two instances pointed at one database collide and one
// database reached under two project names does not look like two. These tests
// pass a literal, because what is under test is the fencing, not the derivation.
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

// The enrollment column is `kind` — spec §4.2 and migration 0063, which is what
// the template database this file clones actually holds. The fixture replaces
// the table rather than reusing 0063's, because the missing-row case needs a
// shape that can hold zero rows and 0063 pins exactly one.
async function setIdentity(value: "production" | "rehearsal" | null): Promise<void> {
  await sql.unsafe("DROP TABLE IF EXISTS deployment_identity");
  await sql.unsafe(`
    CREATE TABLE deployment_identity (
      kind text NOT NULL,
      singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton))`);
  if (value) await sql`INSERT INTO deployment_identity (kind) VALUES (${value})`;
}

async function createManifestTable(): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${MANIFEST_TABLE} (
      format_version integer NOT NULL,
      declaration    text    NOT NULL,
      filenames      text[]  NOT NULL,
      content_hash   text    NOT NULL,
      singleton      boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton))`);
  await sql.unsafe(`ALTER TABLE ${MANIFEST_TABLE} OWNER TO rm_owner`);
}

const DECLARATION = { text: "-- the snapshot's declaration for these tests\n" };

async function publishManifestFor(filenames: readonly string[]): Promise<void> {
  await sql`
    INSERT INTO schema_manifest (format_version, declaration, filenames, content_hash)
    VALUES (${MANIFEST_FORMAT_VERSION}, ${DECLARATION.text}, ${filenames as string[]},
            ${hashManifest(DECLARATION, filenames)})`;
}

async function ledgerNames(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
  return rows.map((r) => r.name);
}

async function appliedAtFor(name: string): Promise<Date | null> {
  const [row] = await sql<{ applied_at: Date }[]>`
    SELECT applied_at FROM schema_migrations WHERE name = ${name}`;
  return row?.applied_at ?? null;
}

afterEach(async () => {
  await sql.unsafe(`DROP TABLE IF EXISTS ${MANIFEST_TABLE}`);
  await sql.unsafe("DROP TABLE IF EXISTS deployment_identity");
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
    // Failing fast beats a CI job hanging on an invisible prompt — the shape
    // backend/scripts/migrate.ts already refuses today ("stdin is not a
    // terminal").
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
    await promptOwnerPassword(options({ connection: "local", nonInteractive: true })).catch(() => undefined);
    for (const [key, value] of Object.entries(process.env)) {
      if (/rm_owner/i.test(key)) expect(value).toBeUndefined();
    }
  });

  test("a NOLOGIN rm_owner is reported as `spec §9.1 step 1 has not been applied`, not as a bad password", async () => {
    // 0053 line 10 creates rm_owner NOLOGIN and line 49 re-asserts it on every
    // apply, and the runner never re-applies 0053 to a database that recorded
    // it. "Password authentication failed" is the least useful sentence here.
    const [owner] = await sql<{ rolcanlogin: boolean }[]>`
      SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner'`;
    expect(owner?.rolcanlogin).toBe(false);
    await expect(
      promptOwnerPassword(options({ connection: "local", nonInteractive: true })),
    ).rejects.toThrow("ALTER ROLE rm_owner LOGIN PASSWORD");
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
// The run itself
// ───────────────────────────────────────────────────────────────────────────

describe("runMigrate — fence, per-migration transactions, always reconcile, publish in that transaction", () => {
  test("refuses when the effective role is not rm_owner", async () => {
    // THE FIXTURE IS THE SESSION, not the database state.
    //
    // This case and "failure DURING GRANT RECONCILIATION…" below used to build
    // byte-identical databases and demand opposite outcomes, which made one of
    // them unpassable whatever the implementation did. They are not testing the
    // same thing: that one is §8.3's recoverable in-progress state (every
    // migration committed, no manifest published, rerun finishes it), while
    // this one is §8.3's rule that "Only `rm_owner` may write it or the
    // ledger's `compat`/`metadata_version` columns". The distinguishing input
    // is WHO IS CONNECTED, and the suite's own handle is the container
    // superuser, which can act as rm_owner and must therefore be allowed
    // through. So this case connects as a role that genuinely cannot.
    await setIdentity("rehearsal");
    await createManifestTable();

    const role = `rm_not_owner_${Date.now().toString(36)}`;
    const password = "not-the-owner";
    await sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEROLE`);
    const url = new URL(config.databaseUrl);
    url.username = role;
    url.password = password;
    const stranger = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      await expect(runMigrate(stranger, options())).rejects.toThrow("rm_owner");
    } finally {
      await stranger.end({ timeout: 5 });
      await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  });

  test("refuses when the fence cannot be taken, naming the holder", async () => {
    // §2: "A tool that finds the lock held waits with a timeout, then refuses
    // naming the holder." The session lock alone is not enough — a dead
    // connection releases it while the statement it coordinated is still
    // executing — so the fence is a pg_advisory_xact_lock on the same key.
    await setIdentity("rehearsal");
    await createManifestTable();
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

  test("reconciles grants and publishes a manifest even with NOTHING pending", async () => {
    // "even with nothing pending" is the clause that catches production today:
    // a grant fixed by hand and then lost is invisible to a run that skips
    // reconciliation when the migration list is empty.
    await setIdentity("rehearsal");
    await createManifestTable();
    const names = await ledgerNames();
    await publishManifestFor(names);

    const result = await runMigrate(sql, options());
    expect(result.applied).toEqual([]);
    expect(result.resumedAndVerified).toEqual([]);
    expect(result.grantsReconciled).toBe(true);
    expect(result.manifest.filenames).toEqual(names);
  });

  test("the published manifest describes the FINAL state and equals what readManifest returns", async () => {
    await setIdentity("rehearsal");
    await createManifestTable();
    await publishManifestFor(await ledgerNames());
    const result = await runMigrate(sql, options());
    expect(await readManifest(sql)).toEqual(result.manifest);
  });

  test("manifest and grants commit together — a run that cannot reconcile publishes nothing", async () => {
    // A manifest that could commit separately would let a boot pass check 3a on
    // a database whose grants are still the previous version's, and check 2
    // would then fail on grants check 3a had just called correct.
    await setIdentity("rehearsal");
    await createManifestTable();
    // rm_owner cannot grant on a relation it does not own, so reconciliation
    // fails — and the manifest must not appear.
    await sql.unsafe("CREATE TABLE rm_migrate_foreign_probe (id integer)");
    await sql.unsafe("ALTER TABLE rm_migrate_foreign_probe OWNER TO rm_app");
    try {
      await expect(runMigrate(sql, options())).rejects.toThrow();
      expect(await readManifest(sql)).toBeNull();
    } finally {
      await sql.unsafe("DROP TABLE IF EXISTS rm_migrate_foreign_probe");
    }
  });

  test("revalidates deployment_identity after acquiring the fence and refuses a mismatch", async () => {
    // §2: "After acquiring, the tool re-reads `deployment_identity`, the ledger,
    // and the schema manifest and re-runs the plan against them. A mismatch
    // refuses." The row can change between the gate call and here.
    await setIdentity("rehearsal");
    await createManifestTable();
    await publishManifestFor(await ledgerNames());
    await sql.unsafe("UPDATE deployment_identity SET kind = 'production'");
    await expect(runMigrate(sql, options({ caller: "smoke_flag" }))).rejects.toThrow("production");
  });

  test("takes the session lock too when the caller does not already hold it", async () => {
    await setIdentity("rehearsal");
    await createManifestTable();
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
});

describe("runMigrate — recovery from an interrupted run", () => {
  test("failure BETWEEN COMMITS leaves a resumable state: a rerun verifies, applies the rest, and publishes", async () => {
    await setIdentity("rehearsal");
    await createManifestTable();
    const names = await ledgerNames();
    // The manifest embodies a strict prefix of the ledger — §8.3's *in
    // progress*, ledger ahead of manifest.
    const embodied = names.slice(0, -2);
    await publishManifestFor(embodied);

    const result = await runMigrate(sql, options());
    expect(result.resumedAndVerified).toEqual(names.slice(-2));
    expect(result.applied).toEqual([]);
    expect(result.grantsReconciled).toBe(true);
    expect(result.manifest.filenames).toEqual(names);
  });

  test("a resume REPLAYS NOTHING — every committed migration keeps its original applied_at", async () => {
    await setIdentity("rehearsal");
    await createManifestTable();
    const names = await ledgerNames();
    const witness = names[names.length - 1] ?? "";
    const before = await appliedAtFor(witness);
    await publishManifestFor(names.slice(0, -2));

    await runMigrate(sql, options());
    expect(await appliedAtFor(witness)).toEqual(before);
    expect((await ledgerNames()).length).toBe(names.length);
  });

  test("failure DURING GRANT RECONCILIATION leaves no manifest, and a rerun publishes one", async () => {
    // The manifest publishes inside the reconciliation transaction, so a
    // failure there means neither committed. Every migration is already
    // applied; the rerun's only job is to finish. The database state below is
    // the whole fixture: the session is the suite's own, which CAN act as
    // rm_owner — that is what separates this case from "refuses when the
    // effective role is not rm_owner" above.
    await setIdentity("rehearsal");
    await createManifestTable();
    const names = await ledgerNames();
    expect(await readManifest(sql)).toBeNull();

    const result = await runMigrate(sql, options());
    expect(result.applied).toEqual([]);
    expect(result.resumedAndVerified).toEqual(names);
    expect(await readManifest(sql)).toEqual(result.manifest);
  });

  test("a second rerun after a completed one is a no-op that still reconciles", async () => {
    await setIdentity("rehearsal");
    await createManifestTable();
    const first = await runMigrate(sql, options());
    const second = await runMigrate(sql, options());
    expect(second.applied).toEqual([]);
    expect(second.resumedAndVerified).toEqual([]);
    expect(second.grantsReconciled).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
  });

  test("refuses to resume an INCONSISTENT manifest rather than repairing it silently", async () => {
    await setIdentity("rehearsal");
    await createManifestTable();
    const names = await ledgerNames();
    await sql`
      INSERT INTO schema_manifest (format_version, declaration, filenames, content_hash)
      VALUES (${MANIFEST_FORMAT_VERSION}, ${DECLARATION.text}, ${names}, ${"f".repeat(64)})`;
    await expect(runMigrate(sql, options())).rejects.toThrow(/inconsistent|hash/i);
  });

  test("refuses when the ledger names a migration this checkout does not contain", async () => {
    await setIdentity("rehearsal");
    await createManifestTable();
    await sql`INSERT INTO schema_migrations (name) VALUES ('0099_from_a_newer_release.sql')`;
    await expect(runMigrate(sql, options())).rejects.toThrow("0099_from_a_newer_release.sql");
  });

  test("refuses committed work that fails its expected post-state check — a resume never accepts drift", async () => {
    await setIdentity("rehearsal");
    await createManifestTable();
    const names = await ledgerNames();
    await publishManifestFor(names.filter((n) => n < "0032_append_only_history.sql"));
    await sql.unsafe("DROP TRIGGER IF EXISTS swarm_members_append_only ON swarm_members");
    await expect(runMigrate(sql, options())).rejects.toThrow("swarm_members");
  });
});
