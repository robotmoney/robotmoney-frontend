// Preflight, checks 1-6 (spec §7) — the read-only checks that decide whether a
// database may be served.
//
// These tests are the specification for src/db/preflight.ts and exercise every
// check it implements (issue #1026, W2). Nothing calls `runPreflight` at
// runtime yet; wiring it into smoke, `api` and the worker lanes is a later
// wave, so a green run here proves the checks, not that a boot runs them.
//
// THEY RUN AGAINST THE REAL EPHEMERAL POSTGRES (tests/preload.ts), in a
// database cloned for this file alone, because §7.3's whole point is that "CI
// end-to-end runs use the production roles and the production preflight" — a
// mocked catalog would prove nothing about `has_table_privilege`, `pg_has_role`
// or `pg_class.relowner`, which is where checks 1, 2 and 5 actually live.
//
// SEVERAL TESTS MUTATE CLUSTER-WIDE ROLE ATTRIBUTES (`rolsuper`,
// `rolcreaterole`, `rm_owner` membership). Roles are a property of the CLUSTER,
// not of this file's cloned database, so each one restores what it changed in a
// `finally` — a leaked `rm_app SUPERUSER` would make every later file in the
// run meaningless rather than red.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { CONNECTION_TOKENS, ROLES, homeEnvFilePath } from "../../scripts/lib/env-role.ts";
import { config } from "../src/config.ts";
import { APPEND_ONLY_TABLES, LEDGER_IMMUTABLE_FAMILIES } from "../src/db/append-only-guard.ts";
import { sql } from "../src/db/client.ts";
import {
  ENV_FILE_ALLOWED_KEYS,
  RUNTIME_DELETE_REVOKED_TABLES,
  checkEnvCredentials,
  checkEnvIdentity,
  checkPrivileges,
  checkSubjectEpochDurations,
  checkRoleTokens,
  checkSchemaCompatibility,
  checkSchemaIntegrity,
  findDenylistViolations,
  homeEnvPath,
  missingPrivileges,
  preflightReportLines,
  protectedFromDeletion,
  runPreflight,
  type PreflightContext,
  type PreflightDb,
  type PreflightFinding,
  type PreflightReport,
} from "../src/db/preflight.ts";
import { registerQuery, registeredSites, requiredPrivileges, type RmRole } from "../src/db/registry.ts";
import { parseMigrationHeader, recordMigrationCompat } from "../src/db/schema-compat.ts";
import { MANIFEST_FORMAT_VERSION, detectManifestState, hashManifest, writeManifest } from "../src/db/schema-manifest.ts";
import { loadSnapshot } from "../src/db/schema-snapshot.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// PER TEST, not per file. Several cases here are deliberately destructive to
// DATABASE state rather than to cluster state: check 6 drops the
// `epoch_duration_seconds` column and its constraint, check 3a drops an
// append-only trigger, and the check-2 cases grant and revoke privileges and
// create objects owned by runtime roles. None of that is reversible by a
// fixture — this repo's rule is a clean database per test via a template copy,
// never delete-to-reset (tests/support/clean-db.ts) — so a later test asserting
// the healthy shape could never pass behind them. A template copy is a
// file-level copy, measured in tens of milliseconds, so the isolation is cheap
// enough to be the default here. The `beforeAll` below only touches CLUSTER
// state (role passwords), which a clone does not reset and therefore still
// holds for every test.
useCleanDatabasePerTest(import.meta.file);

const PASSWORDS: Record<"rm_app" | "rm_worker" | "rm_readonly", string> = {
  rm_app: "rm_app_preflight_password",
  rm_worker: "rm_worker_preflight_password",
  rm_readonly: "rm_readonly_preflight_password",
};

const RUNTIME_ROLES: readonly RmRole[] = ["rm_app", "rm_worker", "rm_readonly"];

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

let tmpDir = "";

beforeAll(async () => {
  for (const [role, password] of Object.entries(PASSWORDS)) {
    await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}'`);
  }
  tmpDir = mkdtempSync(join(tmpdir(), "rm-preflight-env-"));
});

afterAll(async () => {
  // Leave the cluster exactly as the template built it.
  await sql.unsafe("ALTER ROLE rm_app NOSUPERUSER NOCREATEROLE");
  await sql.unsafe("ALTER ROLE rm_worker NOSUPERUSER NOCREATEROLE");
  await sql.unsafe("ALTER ROLE rm_readonly NOSUPERUSER NOCREATEROLE");
});

function context(over: Partial<PreflightContext> = {}): PreflightContext {
  return {
    env: "stage",
    connection: "local",
    roles: RUNTIME_ROLES,
    codeFilenames: [],
    envFilePath: join(tmpDir, "default.env"),
    ...over,
  };
}

function tokens(over: Partial<Record<RmRole, string>> = {}): ReadonlyMap<RmRole, string> {
  const map = new Map<RmRole, string>([
    ["rm_app", PASSWORDS.rm_app],
    ["rm_worker", PASSWORDS.rm_worker],
    ["rm_readonly", PASSWORDS.rm_readonly],
  ]);
  for (const [role, value] of Object.entries(over)) map.set(role as RmRole, value as string);
  return map;
}

function refusals(findings: readonly PreflightFinding[]): readonly PreflightFinding[] {
  return findings.filter((f) => f.severity === "refuse");
}

/** The site-id prefix of every declaration THIS file registers. */
const OWN_SITE_PREFIX = "tests/db-preflight-checks:";

/**
 * Check 2's findings without the required-half findings owed to declarations
 * that OTHER TEST FILES registered.
 *
 * The registry is process-global and backend CI runs every file in one `bun
 * test` process. db-registry.test.ts registers rm_worker UPDATE and rm_app
 * DELETE on relations that do not exist, and those stay registered for every
 * file that runs after it. Without this scope, whether a zero-finding
 * assertion here holds would depend on which files happen to sort before this
 * one — a verdict about file order, not about the check.
 *
 * What is dropped is narrow: a finding of check `privileges` that names a
 * `tests/…` site id from another file and no site id of this file's. A
 * required-half finding always names its declarants (`declarantsFor`); a
 * denylist finding never names a site id, so every denylist finding is kept.
 * So is every finding for a REAL call site, whose id is `<module>:<function>`
 * and never starts with `tests/`: a production declaration this database
 * cannot satisfy still fails these tests.
 */
function scoped(findings: readonly PreflightFinding[]): readonly PreflightFinding[] {
  const sites = registeredSites().map((declaration) => declaration.site);
  const foreign = sites.filter((site) => site.startsWith("tests/") && !site.startsWith(OWN_SITE_PREFIX));
  const own = sites.filter((site) => site.startsWith(OWN_SITE_PREFIX));
  return findings.filter(
    (finding) =>
      finding.check !== "privileges" ||
      !foreign.some((site) => finding.message.includes(site)) ||
      own.some((site) => finding.message.includes(site)),
  );
}

/** A report with `scoped` applied to every check and `passed` recomputed the
 *  way `runPreflight` computes it. */
function scopedReport(report: PreflightReport): PreflightReport {
  const results = report.results.map((result) => ({ ...result, findings: [...scoped(result.findings)] }));
  const passed = !results.some((result) => result.findings.some((finding) => finding.severity === "refuse"));
  return { results, passed };
}

function writeEnvFile(name: string, lines: readonly string[]): string {
  const path = join(tmpDir, name);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

/** The ledger's recorded filenames, in apply order. */
async function ledgerNames(db: PreflightDb = sql): Promise<string[]> {
  return ((await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[]).map(
    (row) => row.name,
  );
}

/** Publish the manifest for the current ledger the way a finished migrate run
 *  does (backend/scripts/migrate-run.ts step 6): as rm_owner, through
 *  `writeManifest`, with the snapshot's declaration and a hash from
 *  `hashManifest`. Nothing here is a hand-written row. */
async function publishManifest(): Promise<void> {
  const snapshot = await loadSnapshot();
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    const filenames = await ledgerNames(tx);
    await writeManifest(tx, {
      formatVersion: MANIFEST_FORMAT_VERSION,
      declaration: snapshot.manifest.declaration,
      filenames,
      contentHash: hashManifest(snapshot.manifest.declaration, filenames),
    });
  });
}

/** Enroll this clone as `rehearsal`, as rm_owner — the only role 0063 lets
 *  write it. */
async function enrollRehearsal(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx`INSERT INTO deployment_identity (kind, note) VALUES ('rehearsal', 'db-preflight-checks fixture')`;
  });
}

/** Rows each `public` table has had inserted, updated or deleted, from the
 *  cumulative statistics. Read in one transaction after clearing this
 *  session's snapshot, so the numbers are the current shared-memory ones. */
async function tupleWrites(): Promise<Record<string, number>> {
  return await sql.begin(async (tx) => {
    await tx`SELECT pg_stat_clear_snapshot()`;
    const rows = (await tx`
      SELECT relname AS name, (n_tup_ins + n_tup_upd + n_tup_del)::bigint AS writes
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY relname`) as unknown as { name: string; writes: string }[];
    return Object.fromEntries(rows.map((row) => [row.name, Number(row.writes)]));
  });
}

/** A one-connection pool on this file's clone, as the harness's superuser. */
function pinnedConnection(readOnly: boolean): postgres.Sql<{}> {
  return postgres(config.databaseUrl, {
    max: 1,
    onnotice: () => {},
    ...(readOnly ? { connection: { default_transaction_read_only: true } } : {}),
  });
}

/** Push a connection's pending table statistics to shared memory. Postgres
 *  flushes them lazily (at most once a second while a backend is busy), and
 *  a comparison that reads before the flush would call every write
 *  invisible. `pg_stat_force_next_flush()` makes the flush happen as that
 *  statement's backend goes idle, which is before the statement returns. */
async function flushStats(db: postgres.Sql<{}>): Promise<void> {
  await db`SELECT pg_stat_force_next_flush()`;
  await db`SELECT 1`;
}

/**
 * A (role, relation, privilege) declaration for the REQUIRED half of check 2,
 * registered the way a real call site registers one. The live registry is
 * still empty (no call site uses `registerQuery` yet), so without this every
 * required-half assertion below would loop over nothing.
 *
 * rm_readonly SELECT on `jobs` is a declaration every migrated database
 * satisfies. The registry is process-global and has no unregister, so this
 * declaration stays registered for every file that runs after this one; it is
 * chosen so that it can never be the reason another file's check 2 refuses.
 * The site id starts with OWN_SITE_PREFIX, which `scoped` relies on.
 */
const REQUIRED_FIXTURE = registerQuery({
  role: "rm_readonly",
  object: "jobs",
  privileges: ["SELECT"],
  site: "tests/db-preflight-checks:requiredHalfFixture",
  purpose: "Fixture declaration giving check 2's required half something real to test.",
  // `callers` is mandatory since the registry started pinning who may reach a
  // statement (w1-judge-server). Check 2 never reads it; this names the same
  // fictitious entry module db-registry.test.ts's fixtures use.
  callers: ["src/api/routes/fixture"],
}).declaration;

// ───────────────────────────────────────────────────────────────────────────
// Check 1 — every role token authenticates
// ───────────────────────────────────────────────────────────────────────────

describe("check 1 — every role token smoke will hand to a container authenticates", () => {
  test("passes with no findings when every role in the context has a working token", async () => {
    const result = await checkRoleTokens(sql, context(), tokens());
    expect(result.check).toBe("roles_authenticate");
    expect(result.findings).toEqual([]);
  });

  test("refuses, naming the role, when a token does not authenticate", async () => {
    const result = await checkRoleTokens(sql, context(), tokens({ rm_worker: "not-the-password" }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.check).toBe("roles_authenticate");
    expect(result.findings[0]?.message).toContain("rm_worker");
  });

  test("refuses a role with NO token supplied — an absent token is how a container falls back to another credential", async () => {
    const partial = new Map<RmRole, string>([["rm_app", PASSWORDS.rm_app]]);
    const result = await checkRoleTokens(sql, context({ roles: ["rm_app", "rm_worker"] }), partial);
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("rm_worker");
  });

  test("reports every failing role, not the first, so one boot fixes them all", async () => {
    const result = await checkRoleTokens(sql, context(), tokens({ rm_app: "wrong", rm_readonly: "wrong" }));
    const named = result.findings.map((f) => f.message).join(" ");
    expect(refusals(result.findings)).toHaveLength(2);
    expect(named).toContain("rm_app");
    expect(named).toContain("rm_readonly");
  });

  test("a container scope asks only about its own credential", async () => {
    const own = new Map<RmRole, string>([["rm_app", PASSWORDS.rm_app]]);
    const result = await checkRoleTokens(sql, context({ roles: ["rm_app"] }), own);
    expect(result.findings).toEqual([]);
  });

  test("never logs a token value — a finding names the role and nothing else", async () => {
    const secret = "a-secret-that-must-not-be-printed";
    const result = await checkRoleTokens(sql, context({ roles: ["rm_app"] }), new Map([["rm_app", secret]]));
    for (const finding of result.findings) {
      expect(finding.message).not.toContain(secret);
    }
  });

  test("probes the server the HANDLE points at — config.databaseUrl naming a dead server changes nothing", async () => {
    // The host-side smoke preflight holds a handle to the remote it will serve
    // while its own environment can name any other database. The probe must
    // follow the handle: with the process's configured URL pointed at a port
    // nothing listens on, the three real passwords still authenticate.
    const configured = config.databaseUrl;
    config.databaseUrl = "postgres://nobody:nothing@127.0.0.1:1/nowhere";
    try {
      const result = await checkRoleTokens(sql, context(), tokens());
      expect(result.findings).toEqual([]);
    } finally {
      config.databaseUrl = configured;
    }
  });

  test("probes the handle's DATABASE — roles that may not connect to it refuse, naming it", async () => {
    // Same server, different database: one the runtime roles have no CONNECT
    // on. A probe aimed at config.databaseUrl (this file's clone, which they
    // may connect to) would pass all three; a probe that follows the handle
    // refuses each one and says where it tried.
    const database = `rmt_pf_probe_${crypto.randomUUID().slice(0, 8)}`;
    await sql.unsafe(`CREATE DATABASE ${database}`);
    await sql.unsafe(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`);
    const url = new URL(config.databaseUrl);
    url.pathname = `/${database}`;
    const elsewhere = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      const result = await checkRoleTokens(elsewhere, context(), tokens());
      expect(refusals(result.findings)).toHaveLength(RUNTIME_ROLES.length);
      for (const role of RUNTIME_ROLES) {
        const finding = result.findings.find((f) => f.message.startsWith(`${role} `));
        expect(finding?.message).toContain(`/${database}`);
      }
      // The control: the clone the process is configured for accepts them.
      expect((await checkRoleTokens(sql, context(), tokens())).findings).toEqual([]);
    } finally {
      await elsewhere.end({ timeout: 5 });
      await sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
  });

  test("a handle that cannot say which server it points at refuses rather than guessing", async () => {
    // A `sql.begin` transaction handle carries no connection options. Falling
    // back to any other target would test a password against a database the
    // containers may never meet.
    const result = await sql.begin((tx) => checkRoleTokens(tx, context(), tokens()));
    expect(refusals(result.findings)).toHaveLength(RUNTIME_ROLES.length);
    for (const finding of result.findings) expect(finding.message).toContain("only a top-level postgres() pool");
  });

  test("a reserved connection cannot say either — only the top-level pool carries the server", async () => {
    // postgres.js attaches `options` to the pool object alone; `sql.reserve()`
    // returns a bare query function. A caller that wires check 1 to a reserved
    // handle refuses every role, so wiring must pass the pool itself.
    const reserved = await sql.reserve();
    try {
      expect((reserved as unknown as { options?: unknown }).options).toBeUndefined();
      const result = await checkRoleTokens(reserved, context(), tokens());
      expect(refusals(result.findings)).toHaveLength(RUNTIME_ROLES.length);
      for (const finding of result.findings) expect(finding.message).toContain("only a top-level postgres() pool");
    } finally {
      reserved.release();
    }
    // The control: the pool the reserved connection came from works.
    expect((await checkRoleTokens(sql, context(), tokens())).findings).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Check 2 — required privileges, and the denylist
// ───────────────────────────────────────────────────────────────────────────

describe("check 2, required half — the registry says what each role's programs need", () => {
  test("missingPrivileges reports nothing for a privilege the role actually holds", async () => {
    // 0053 line 129 grants rm_app SELECT/INSERT/UPDATE/DELETE on all tables.
    expect(await missingPrivileges(sql, "rm_app", "jobs", ["SELECT", "INSERT"])).toEqual([]);
  });

  test("missingPrivileges reports exactly the privileges the role lacks", async () => {
    // 0053 lines 136-137 give rm_readonly SELECT only.
    expect(await missingPrivileges(sql, "rm_readonly", "jobs", ["SELECT", "INSERT", "UPDATE"])).toEqual([
      "INSERT",
      "UPDATE",
    ]);
  });

  test("missingPrivileges refuses a relation that does not resolve in public — a registry bug, not a missing grant", async () => {
    await expect(missingPrivileges(sql, "rm_app", "no_such_relation_anywhere", ["SELECT"])).rejects.toThrow(
      "no_such_relation_anywhere",
    );
  });

  test("missingPrivileges never issues the statement the privilege would permit", async () => {
    const [before] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM jobs`;
    await missingPrivileges(sql, "rm_app", "jobs", ["DELETE", "TRUNCATE"]);
    const [after] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM jobs`;
    expect(after?.count).toBe(before?.count);
  });

  test("the registry declares something for rm_readonly, so the required half has a case to decide", () => {
    // Guards the two tests below against passing vacuously: an empty registry
    // makes "every declared privilege is held" true of any database.
    const declared = requiredPrivileges().get("rm_readonly")?.get(REQUIRED_FIXTURE.object);
    expect([...(declared ?? [])]).toContain("SELECT");
  });

  test("a declared privilege that is held produces no finding", async () => {
    const result = await checkPrivileges(sql, context({ roles: ["rm_readonly"] }));
    expect(result.check).toBe("privileges");
    expect(scoped(result.findings)).toEqual([]);
  });

  test("a missing required privilege refuses, naming the call site that declared it", async () => {
    // Revoke exactly the privilege the fixture declares. Grants live in this
    // test's cloned database, so the next test starts from the template again.
    await sql.unsafe(`REVOKE SELECT ON ${REQUIRED_FIXTURE.object} FROM rm_readonly`);
    const result = await checkPrivileges(sql, context({ roles: ["rm_readonly"] }));
    const refused = refusals(scoped(result.findings));
    expect(refused).toHaveLength(1);
    // Actionable means "which declaration asked for this", not "something is
    // missing somewhere": the site id is `<module>:<function>`.
    expect(refused[0]?.message).toContain(REQUIRED_FIXTURE.site);
    expect(refused[0]?.message).toContain("rm_readonly is missing SELECT on jobs");
  });
});

describe("check 2, denylist half — the fixed list of things no runtime role may hold", () => {
  test("a runtime role marked SUPERUSER is a denylist violation", async () => {
    await sql.unsafe("ALTER ROLE rm_app SUPERUSER");
    try {
      const violations = await findDenylistViolations(sql, ["rm_app"]);
      expect(violations).toContainEqual({ rule: "superuser", role: "rm_app", object: null });
    } finally {
      await sql.unsafe("ALTER ROLE rm_app NOSUPERUSER");
    }
  });

  test("a runtime role holding CREATEROLE is a denylist violation — 0053 lines 49-52 pin NOCREATEROLE", async () => {
    await sql.unsafe("ALTER ROLE rm_worker CREATEROLE");
    try {
      const violations = await findDenylistViolations(sql, ["rm_worker"]);
      expect(violations).toContainEqual({ rule: "createrole", role: "rm_worker", object: null });
    } finally {
      await sql.unsafe("ALTER ROLE rm_worker NOCREATEROLE");
    }
  });

  test("a runtime role granted membership in rm_owner is a denylist violation", async () => {
    // 0053 line 56 grants rm_owner to `current_user` and says in its own
    // comment: "This is intentionally the current role, never either runtime
    // role." A runtime role that acquired it makes every other guard decorative.
    await sql.unsafe("GRANT rm_owner TO rm_app");
    try {
      const violations = await findDenylistViolations(sql, ["rm_app"]);
      expect(violations).toContainEqual({ rule: "rm_owner_membership", role: "rm_app", object: "rm_owner" });
    } finally {
      await sql.unsafe("REVOKE rm_owner FROM rm_app");
    }
  });

  test("a runtime role owning an application object is a denylist violation, naming the relation", async () => {
    await sql.unsafe("CREATE TABLE rm_preflight_owned_probe (id integer)");
    await sql.unsafe("ALTER TABLE rm_preflight_owned_probe OWNER TO rm_worker");
    try {
      const violations = await findDenylistViolations(sql, ["rm_worker"]);
      expect(violations).toContainEqual({
        rule: "object_ownership",
        role: "rm_worker",
        object: "rm_preflight_owned_probe",
      });
    } finally {
      await sql.unsafe("DROP TABLE IF EXISTS rm_preflight_owned_probe");
    }
  });

  test("a runtime role holding CREATE on public is a DDL denylist violation — 0053 line 117 revokes it", async () => {
    await sql.unsafe("GRANT CREATE ON SCHEMA public TO rm_app");
    try {
      const violations = await findDenylistViolations(sql, ["rm_app"]);
      expect(violations).toContainEqual({ rule: "ddl", role: "rm_app", object: "public" });
    } finally {
      await sql.unsafe("REVOKE CREATE ON SCHEMA public FROM rm_app");
    }
  });

  test("DELETE on an append-only table is a denylist violation, one per table", async () => {
    // THE VIOLATION IS CONSTRUCTED, not borrowed from the ambient schema.
    //
    // This case used to read the state 0053 line 129 left behind
    // (`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO
    // rm_app`, append-only tables included) and assert the denylist reported
    // every one of them. Migration 0065 is §9.1 step 2 — it revokes exactly
    // that grant — so an assertion resting on the grant's presence would be
    // ERASED by the fix rather than kept honest by it, and two later migrations
    // (0056 on `analytics_overwrite_events`, 0065 on the rest) already made the
    // ambient set a moving target no literal could track.
    //
    // The property under test is "the denylist detects a DELETE grant on an
    // append-only table", one finding per table. That property has to survive
    // 0065, so the grant is made here and revoked in `finally`, which is what
    // every other case in this describe already does.
    const tables = [...APPEND_ONLY_TABLES].sort();
    const relations = tables.map((t) => `"${t}"`).join(", ");
    await sql.unsafe(`GRANT DELETE ON ${relations} TO rm_app`);
    try {
      const violations = await findDenylistViolations(sql, ["rm_app"]);
      const appendOnly = violations.filter((v) => v.rule === "append_only_write");
      expect(appendOnly.map((v) => v.object).sort()).toEqual(tables);
    } finally {
      await sql.unsafe(`REVOKE DELETE ON ${relations} FROM rm_app`);
    }
  });

  test("TRUNCATE on an append-only table is the same violation as DELETE", async () => {
    await sql.unsafe("GRANT TRUNCATE ON swarm_members TO rm_worker");
    try {
      const violations = await findDenylistViolations(sql, ["rm_worker"]);
      expect(violations).toContainEqual({
        rule: "append_only_write",
        role: "rm_worker",
        object: "swarm_members",
      });
    } finally {
      await sql.unsafe("REVOKE TRUNCATE ON swarm_members FROM rm_worker");
    }
  });

  test("DELETE or TRUNCATE on an immutable ledger table is the same violation, one per table (D53 (6))", async () => {
    // LEDGER_IMMUTABLE_FAMILIES count as append-only for this rule: losing a
    // ledger row is the same harm as losing a history row. 0057-0060 grant the
    // runtime roles SELECT and INSERT only, so the grant is constructed here.
    const tables = [...new Set(LEDGER_IMMUTABLE_FAMILIES.flatMap((family) => family.tables))].sort();
    const relations = tables.map((t) => `"${t}"`).join(", ");
    await sql.unsafe(`GRANT DELETE ON ${relations} TO rm_app`);
    await sql.unsafe(`GRANT TRUNCATE ON ${relations} TO rm_worker`);
    const violations = await findDenylistViolations(sql, ["rm_app", "rm_worker"]);
    for (const role of ["rm_app", "rm_worker"] as const) {
      const hits = violations.filter((v) => v.rule === "append_only_write" && v.role === role).map((v) => v.object);
      expect(hits.sort()).toEqual(tables);
    }
  });

  test("a clean runtime role produces no violations at all", async () => {
    // rm_readonly holds SELECT only (0053) and owns nothing.
    expect(await findDenylistViolations(sql, ["rm_readonly"])).toEqual([]);
  });

  test("the fully migrated database is clean for every runtime role — no rule fires on a correct grant state", async () => {
    // The widened rules (every schema, the database, TRIGGER, functions,
    // types, schemas, the ledgers) must not turn a correct database into a
    // refused one: a check that always fails gets turned off.
    expect(await findDenylistViolations(sql, RUNTIME_ROLES)).toEqual([]);
  });

  test("reports every violation it finds, not the first", async () => {
    await sql.unsafe("ALTER ROLE rm_readonly SUPERUSER CREATEROLE");
    try {
      const rules = (await findDenylistViolations(sql, ["rm_readonly"])).map((v) => v.rule);
      expect(rules).toContain("superuser");
      expect(rules).toContain("createrole");
    } finally {
      await sql.unsafe("ALTER ROLE rm_readonly NOSUPERUSER NOCREATEROLE");
    }
  });
});

describe("check 2, every denylist class refuses through checkPrivileges itself", () => {
  // Each case builds exactly one violation for rm_worker, then asks CHECK 2 —
  // not the helper — and expects a refusal that names the thing. The helper's
  // report only matters if checkPrivileges turns it into a refusal, so that is
  // the path proved here. Grants and objects live in this test's cloned
  // database; the two role attributes are cluster-wide and are undone.
  const cases: readonly { name: string; setup: string[]; teardown?: string[]; expects: string }[] = [
    { name: "SUPERUSER", setup: ["ALTER ROLE rm_worker SUPERUSER"], teardown: ["ALTER ROLE rm_worker NOSUPERUSER"], expects: "rm_worker is a SUPERUSER" },
    { name: "CREATEROLE", setup: ["ALTER ROLE rm_worker CREATEROLE"], teardown: ["ALTER ROLE rm_worker NOCREATEROLE"], expects: "rm_worker holds CREATEROLE" },
    { name: "membership in rm_owner", setup: ["GRANT rm_owner TO rm_worker"], teardown: ["REVOKE rm_owner FROM rm_worker"], expects: "rm_worker holds membership in rm_owner" },
    {
      name: "ownership of a relation",
      setup: ["CREATE TABLE rm_pf_owned_rel (id integer)", "ALTER TABLE rm_pf_owned_rel OWNER TO rm_worker"],
      expects: "rm_worker owns the application object rm_pf_owned_rel",
    },
    {
      name: "ownership of a function",
      setup: [
        "CREATE FUNCTION rm_pf_owned_fn(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1'",
        "ALTER FUNCTION rm_pf_owned_fn(integer) OWNER TO rm_worker",
      ],
      expects: "rm_worker owns the application object function rm_pf_owned_fn(integer)",
    },
    {
      name: "ownership of a type",
      setup: ["CREATE TYPE rm_pf_owned_type AS ENUM ('a', 'b')", "ALTER TYPE rm_pf_owned_type OWNER TO rm_worker"],
      expects: "rm_worker owns the application object type rm_pf_owned_type",
    },
    {
      name: "ownership of a schema",
      setup: ["CREATE SCHEMA rm_pf_owned_schema AUTHORIZATION rm_worker"],
      expects: "rm_worker owns the application object schema rm_pf_owned_schema",
    },
    { name: "CREATE on public", setup: ["GRANT CREATE ON SCHEMA public TO rm_worker"], expects: "rm_worker holds CREATE on schema public" },
    {
      name: "CREATE on a non-system schema other than public",
      setup: ["CREATE SCHEMA rm_pf_other_schema", "GRANT CREATE ON SCHEMA rm_pf_other_schema TO rm_worker"],
      expects: "rm_worker holds CREATE on schema rm_pf_other_schema",
    },
    {
      name: "CREATE on the database",
      setup: ["DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO rm_worker', current_database()); END $$"],
      teardown: ["DO $$ BEGIN EXECUTE format('REVOKE CREATE ON DATABASE %I FROM rm_worker', current_database()); END $$"],
      expects: "rm_worker holds CREATE on database",
    },
    { name: "the TRIGGER privilege", setup: ["GRANT TRIGGER ON jobs TO rm_worker"], expects: "rm_worker holds TRIGGER on jobs" },
    { name: "DELETE on an append-only table", setup: ["GRANT DELETE ON audit_log TO rm_worker"], expects: "append-only table audit_log" },
    { name: "TRUNCATE on an append-only table", setup: ["GRANT TRUNCATE ON audit_log TO rm_worker"], expects: "append-only table audit_log" },
    { name: "DELETE on an immutable ledger table", setup: ["GRANT DELETE ON source_acquisitions TO rm_worker"], expects: "append-only table source_acquisitions" },
    { name: "TRUNCATE on an immutable ledger table", setup: ["GRANT TRUNCATE ON analytics_ledger_runs TO rm_worker"], expects: "append-only table analytics_ledger_runs" },
  ];

  for (const entry of cases) {
    test(`${entry.name} refuses the boot`, async () => {
      // The control: the clean clone does not already say it.
      const before = await checkPrivileges(sql, context({ roles: ["rm_worker"] }));
      expect(refusals(before.findings).map((f) => f.message).join("\n")).not.toContain(entry.expects);

      for (const statement of entry.setup) await sql.unsafe(statement);
      try {
        const result = await checkPrivileges(sql, context({ roles: ["rm_worker"] }));
        const text = refusals(result.findings).map((f) => f.message).join("\n");
        expect(text).toContain(entry.expects);
      } finally {
        for (const statement of entry.teardown ?? []) await sql.unsafe(statement);
      }
    });
  }
});

describe("check 2, the asymmetry — the registry is not an allowlist", () => {
  test("a grant absent from the registry is NOT forbidden by that fact alone", async () => {
    // Spec §7 check 2, verbatim: "A grant absent from the registry is not
    // forbidden by that fact alone." The registry declares rm_readonly SELECT
    // on `jobs` (REQUIRED_FIXTURE) and nothing on `job_schedules`; rm_readonly
    // is then given a privilege on `job_schedules` that 0053 never gave it and
    // no call site declares. Check 2 must report NOTHING — not "undeclared",
    // not in any other wording — because only the denylist says what may not
    // be held.
    expect(requiredPrivileges().get("rm_readonly")?.has("job_schedules") ?? false).toBe(false);
    await sql.unsafe("GRANT INSERT ON job_schedules TO rm_readonly");
    const [held] = await sql<{ held: boolean }[]>`
      SELECT has_table_privilege('rm_readonly', 'job_schedules', 'INSERT') AS held`;
    expect(held?.held).toBe(true);

    const result = await checkPrivileges(sql, context({ roles: ["rm_readonly"] }));
    expect(scoped(result.findings)).toEqual([]);
  });

  test("rm_app holding DELETE on an append-only table FAILS check 2 — the grant §9.1 step 2 exists to remove", async () => {
    // Spec §9.1 step 2: "Check 2 fails until it lands." Migration 0065 IS that
    // step, so the grant 0053 left behind is gone from this database and this
    // case constructs it instead of reading it. The thing being proved is
    // unchanged and is the reason the step exists: while a runtime role holds
    // DELETE on an append-only table, check 2 refuses the boot and names both.
    await sql.unsafe("GRANT DELETE ON swarm_members TO rm_app");
    try {
      const result = await checkPrivileges(sql, context({ roles: ["rm_app"] }));
      const refused = refusals(result.findings);
      expect(refused.length).toBeGreaterThan(0);
      const text = refused.map((f) => f.message).join("\n");
      expect(text).toContain("rm_app");
      expect(text).toContain("swarm_members");
      expect(text).toMatch(/DELETE/);
    } finally {
      await sql.unsafe("REVOKE DELETE ON swarm_members FROM rm_app");
    }
  });

  test("check 2 refuses at `refuse` severity on stage too — a denylist first armed in production is untested", async () => {
    await sql.unsafe("GRANT rm_owner TO rm_worker");
    try {
      for (const env of ["stage", "prod"] as const) {
        const result = await checkPrivileges(sql, context({ env, roles: ["rm_worker"] }));
        const owner = refusals(result.findings).filter((f) => f.message.includes("rm_owner"));
        expect(owner.length).toBeGreaterThan(0);
      }
    } finally {
      await sql.unsafe("REVOKE rm_owner FROM rm_worker");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Check 2 × spec §9.1 step 2 — the append-only grant transition, replayed
// ───────────────────────────────────────────────────────────────────────────

describe("check 2 fails before the append-only grant transition and passes after it (0065 + 0072 PART 2)", () => {
  const TRANSITION_0065 = readFileSync(join(MIGRATIONS_DIR, "0065_append_only_grant_transition.sql"), "utf8");
  const MIGRATION_0072 = readFileSync(join(MIGRATIONS_DIR, "0072_drop_swarm_schedules.sql"), "utf8");

  /** 0072's PART 2 DO block, verbatim: the first `DO $$ … $$;` after the
   *  PART 2 banner. PART 1 deletes the retired schedule rows and is not part
   *  of the grant transition. */
  function part2Of0072(): string {
    const banner = MIGRATION_0072.indexOf("PART 2");
    expect(banner).toBeGreaterThan(-1);
    const start = MIGRATION_0072.indexOf("DO $$", banner);
    const end = MIGRATION_0072.indexOf("\n$$;", start);
    expect(start).toBeGreaterThan(banner);
    expect(end).toBeGreaterThan(start);
    return MIGRATION_0072.slice(start, end + "\n$$;".length);
  }

  /** The quoted names in a migration's `<name> text[] := ARRAY[...]`. */
  function declaredArray(text: string, name: string): string[] {
    const match = new RegExp(`${name}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([^\\]]*)\\]`).exec(text);
    expect(match).not.toBeNull();
    return [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
  }

  /** Apply the transition exactly as the migrate run applies a migration:
   *  inside a transaction, as rm_owner. */
  async function applyTransition(): Promise<void> {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(TRANSITION_0065);
      await tx.unsafe(part2Of0072());
    });
  }

  /** Every runtime-role privilege on every append-only table, for comparing
   *  one apply with the next. */
  async function grantMatrix(): Promise<readonly object[]> {
    return await sql`
      SELECT r.rolname AS role, t.name AS object, p.privilege,
             has_table_privilege(r.rolname, to_regclass('public.' || t.name), p.privilege) AS held
      FROM unnest(${["rm_app", "rm_worker", "rm_readonly"]}::text[]) AS r(rolname)
      CROSS JOIN unnest(${[...APPEND_ONLY_TABLES]}::text[]) AS t(name)
      CROSS JOIN unnest(${["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]}::text[]) AS p(privilege)
      ORDER BY 1, 2, 3`;
  }

  const WRITERS: readonly RmRole[] = ["rm_app", "rm_worker"];

  test("the post-0053 grant state refuses once per (role, table); the transition clears it; re-applying it is a no-op", async () => {
    // RECREATE what 0053 left behind: `GRANT SELECT, INSERT, UPDATE, DELETE ON
    // ALL TABLES` reached every append-only table, and TRUNCATE is the
    // privilege the row triggers cannot stop.
    const relations = [...APPEND_ONLY_TABLES].map((t) => `"${t}"`).join(", ");
    await sql.unsafe(`GRANT DELETE, TRUNCATE ON ${relations} TO rm_app, rm_worker`);

    // BEFORE: check 2 refuses, exactly once per role per table.
    const before = await checkPrivileges(sql, context({ roles: WRITERS }));
    const appendOnly = refusals(scoped(before.findings)).filter((f) => f.message.includes("append-only table"));
    const named = appendOnly.map((f) => {
      const match = /^(rm_\w+) holds DELETE\/TRUNCATE on the append-only table (\w+):/.exec(f.message);
      return match ? `${match[1]}/${match[2]}` : f.message;
    });
    const expected = WRITERS.flatMap((role) => [...APPEND_ONLY_TABLES].map((table) => `${role}/${table}`));
    expect(named.sort()).toEqual(expected.sort());

    // AFTER: the migration text itself, not a hand-written REVOKE.
    await applyTransition();
    expect(scoped((await checkPrivileges(sql, context({ roles: WRITERS }))).findings)).toEqual([]);
    expect(await findDenylistViolations(sql, WRITERS)).toEqual([]);
    const once = await grantMatrix();

    // AGAIN: idempotent — no error, the same grants, the same verdict.
    await applyTransition();
    expect(await grantMatrix()).toEqual(once);
    expect(scoped((await checkPrivileges(sql, context({ roles: WRITERS }))).findings)).toEqual([]);
  });

  test("the transition's arrays cover every APPEND_ONLY_TABLES entry — no append-only table can skip it", () => {
    // 0065 revokes on the 0032-era set and 0072 on the two scheduler logs. A
    // table added to APPEND_ONLY_TABLES without a revoking migration would
    // pass every test above that builds its own grants, and still hold 0053's
    // DELETE in production. A new append-only table needs its own revoking
    // migration, added to this union.
    const union = new Set([
      ...declaredArray(TRANSITION_0065, "append_only"),
      ...declaredArray(MIGRATION_0072, "newly_protected"),
    ]);
    expect([...APPEND_ONLY_TABLES].filter((table) => !union.has(table))).toEqual([]);

    // The other direction: nothing the transition protects is unknown to
    // check 2. D53 (2) moves `swarm_stream_events` to grant-only protection
    // (its triggers go so rm_owner can prune past the oldest servable cursor;
    // DELETE/TRUNCATE stay revoked from the runtime roles, which is what 0072's
    // REVOKE does). So the comparison is against check 2's own protected set,
    // not APPEND_ONLY_TABLES: a table the transition revokes on must stay one
    // check 2 refuses a DELETE grant on.
    const protectedSet = new Set(protectedFromDeletion());
    expect([...union].filter((table) => !protectedSet.has(table))).toEqual([]);
  });

  test("check 2 refuses a runtime-role DELETE grant on swarm_stream_events whether or not it is append-only (D53 (2))", async () => {
    // Listed on its own, independently of APPEND_ONLY_TABLES: when wave 3
    // takes the table out of the append-only set, check 2 must keep refusing.
    expect(RUNTIME_DELETE_REVOKED_TABLES).toContain("swarm_stream_events");
    expect(protectedFromDeletion()).toContain("swarm_stream_events");

    // The control: the clean clone does not already say it.
    expect(
      (await findDenylistViolations(sql, WRITERS)).filter((v) => v.object === "swarm_stream_events"),
    ).toEqual([]);

    await sql.unsafe("GRANT DELETE ON swarm_stream_events TO rm_app");
    await sql.unsafe("GRANT TRUNCATE ON swarm_stream_events TO rm_worker");
    const result = await checkPrivileges(sql, context({ roles: WRITERS }));
    const named = refusals(result.findings)
      .filter((f) => f.message.includes("swarm_stream_events"))
      .map((f) => /^(rm_\w+) holds DELETE\/TRUNCATE on /.exec(f.message)?.[1]);
    expect(named.sort()).toEqual(["rm_app", "rm_worker"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Check 3 — integrity (a) and compatibility (b)
// ───────────────────────────────────────────────────────────────────────────

describe("check 3a — integrity against the manifest stored in the database", () => {
  test("refuses a database with no manifest — nothing to compare is not a reason to serve", async () => {
    const result = await checkSchemaIntegrity(sql, context());
    expect(result.check).toBe("schema_integrity");
    expect(refusals(result.findings).length).toBeGreaterThan(0);
    expect(result.findings.map((f) => f.message).join("\n")).toContain("schema_manifest");
  });

  test("a manifest published by the real writer passes 3a — the control for the interrupted case below", async () => {
    await publishManifest();
    expect((await detectManifestState(sql)).kind).toBe("published");
    expect((await checkSchemaIntegrity(sql, context())).findings).toEqual([]);
  });

  test("refuses a really-interrupted database, and for that reason alone — ledger ahead of a VALID manifest", async () => {
    // Built from the writes an interrupted migrate run leaves, in the order it
    // leaves them (backend/scripts/migrate-run.ts):
    //   1. a finished run published the manifest for the whole ledger (step 6:
    //      rm_owner, writeManifest, hashManifest);
    //   2. the next run committed one migration in its own transaction
    //      (step 5: rm_owner, the DDL, the ledger row, recordMigrationCompat);
    //   3. it died before its reconciliation transaction published anything.
    // Every row is written by the function production writes it with, and the
    // manifest's hash verifies — so "in progress" is the ONLY thing wrong. The
    // old fixture's hash was the literal 'unverified', which also made the
    // manifest inconsistent and hid whether in-progress alone refuses.
    await publishManifest();

    const file = "9999_rm_preflight_interrupted_probe.sql";
    const ddl = [
      "-- compat: additive",
      "-- metadata_version: 1",
      "CREATE TABLE rm_preflight_interrupted_probe (id integer PRIMARY KEY);",
      "",
    ].join("\n");
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      await recordMigrationCompat(tx, parseMigrationHeader(file, ddl));
    });

    const state = await detectManifestState(sql);
    expect(state.kind).toBe("in_progress");
    expect(state.kind === "in_progress" ? state.ahead : []).toEqual([file]);

    const result = await checkSchemaIntegrity(sql, context());
    const refused = refusals(result.findings);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.message).toContain("in progress");
    expect(refused[0]?.message).toContain(file);
  });

  test("compares against the DATABASE's manifest, not the booting image's snapshot", async () => {
    // "Genuine drift fails here whatever code is booting" (§7 check 3a). An old
    // image meeting a newer database compares against that database's own
    // declaration, so an ordinary version difference produces no findings — and
    // that is independent of `codeFilenames`, which 3a must never read.
    const empty = await checkSchemaIntegrity(sql, context({ codeFilenames: [] }));
    const ahead = await checkSchemaIntegrity(sql, context({ codeFilenames: ["9999_from_the_future.sql"] }));
    expect(ahead.findings).toEqual(empty.findings);
  });

  test("a dropped trigger on an append-only table is genuine drift and fails", async () => {
    await sql.unsafe("DROP TRIGGER IF EXISTS swarm_members_append_only ON swarm_members");
    const result = await checkSchemaIntegrity(sql, context());
    const text = refusals(result.findings).map((f) => f.message).join("\n");
    expect(text).toContain("swarm_members");
  });
});

describe("check 3b — does the booting code support the installed version", () => {
  test("no surplus means no findings: the code ships exactly what the ledger records", async () => {
    const ledger = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    const result = await checkSchemaCompatibility(sql, context({ codeFilenames: ledger.map((r) => r.name) }));
    expect(result.check).toBe("schema_compatibility");
    expect(result.findings).toEqual([]);
  });

  test("refuses a surplus ledger row with a NULL compat — unknown is not 'probably fine'", async () => {
    const ledger = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    const surplus = ledger[ledger.length - 1]?.name ?? "";
    const result = await checkSchemaCompatibility(sql, context({ codeFilenames: ledger.slice(0, -1).map((r) => r.name) }));
    const text = refusals(result.findings).map((f) => f.message).join("\n");
    expect(refusals(result.findings).length).toBeGreaterThan(0);
    expect(text).toContain(surplus);
  });

  test("refuses when the code is AHEAD of the database — that is a pending migration, not a compatibility question", async () => {
    const ledger = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    const codeFilenames = [...ledger.map((r) => r.name), "0063_not_applied_here.sql"];
    const result = await checkSchemaCompatibility(sql, context({ codeFilenames }));
    const text = refusals(result.findings).map((f) => f.message).join("\n");
    expect(text).toContain("0063_not_applied_here.sql");
  });

  test("the 0059 migrations are distinguished by filename, never by number", async () => {
    // `backend/migrations/` holds SEVERAL files numbered 0059, so "at 0059"
    // names several different schemas (§8.1). The set is read from disk rather
    // than written down here: this test's own subject is that the FILENAME LIST
    // is the identity and the number is not, so a hardcoded count would
    // contradict it the next time a fourth 0059 lands — which is exactly what
    // happened when 0059_swarm_judgement_completion_usage.sql arrived from main.
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.startsWith("0059_") && n.endsWith(".sql"))
      .sort();
    const ledger = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    const names = ledger.map((r) => r.name);
    expect(names.filter((n) => n.startsWith("0059_")).sort()).toEqual(onDisk);
    expect(onDisk.length).toBeGreaterThan(1);

    // Code shipping only SOME of them is not "at 0059 and therefore current":
    // each of the others is surplus and must be evaluated on its own name.
    const [omitted, ...shipped] = onDisk;
    const codeFilenames = names.filter((n) => n !== omitted);
    const result = await checkSchemaCompatibility(sql, context({ codeFilenames }));
    const text = refusals(result.findings).map((f) => f.message).join("\n");
    expect(text).toContain(omitted);
    for (const sibling of shipped) expect(text).not.toContain(sibling);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Check 4 — ~/.env holds no dangerous credential
// ───────────────────────────────────────────────────────────────────────────

describe("check 4 — ~/.env holds only the keys §3 lists", () => {
  // The connection keys as scripts/lib/env-role.ts reads them (the
  // DigitalOcean panel's spelling), plus the three runtime role passwords.
  const SAFE = [
    "host = db.example.invalid",
    "port = 25060",
    "database = defaultdb",
    "sslmode = require",
    "rm_app = token-a",
    "rm_worker = token-b",
    "rm_readonly = token-c",
  ];

  test("the allowlist is exactly §3's keys, spelled the way env-role.ts reads the connection and the roles", () => {
    // §3: "the remote connection (host, port, dbname); the runtime role
    // passwords rm_app, rm_worker and rm_readonly; RM_ENV; and RM_CREDENTIALS."
    // env-role.ts is the one resolver the host-side tools use, so its
    // CONNECTION_TOKENS and ROLES are pinned here; `dbname` is §3's own
    // spelling of `database` and is accepted beside it.
    const expected = [...CONNECTION_TOKENS, "dbname", ...ROLES, "RM_ENV", "RM_CREDENTIALS"];
    expect([...ENV_FILE_ALLOWED_KEYS].sort()).toEqual([...new Set(expected)].sort());
  });

  test("the file preflight reads by default is env-role.ts's $HOME/.env", () => {
    expect(homeEnvPath("/home/deployer")).toBe(homeEnvFilePath("/home/deployer"));
    expect(homeEnvPath()).toBe(homeEnvFilePath());
  });

  test("a file holding exactly the allowlist passes on prod — both database spellings, RM_ENV, RM_CREDENTIALS", async () => {
    const envFilePath = writeEnvFile("exact-allowlist.env", [
      "# the deploying user's home-directory file",
      ...SAFE,
      "dbname = defaultdb",
      "RM_ENV=prod",
      "export RM_CREDENTIALS=/home/deployer/.robotmoney/credential.json",
    ]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(result.check).toBe("env_credentials");
    expect(result.findings).toEqual([]);
  });

  test("a file holding only the connection and the three runtime tokens passes", async () => {
    const envFilePath = writeEnvFile("safe.env", SAFE);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(result.findings).toEqual([]);
  });

  test("an unlisted key — a model key — refuses on prod and warns on stage, naming the key and never the value", async () => {
    const secret = "sk-zen-a-model-key-that-must-not-be-printed";
    const envFilePath = writeEnvFile("model-key.env", [...SAFE, `OPENCODE_API_KEY=${secret}`]);

    const prod = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(refusals(prod.findings)).toHaveLength(1);
    expect(prod.findings[0]?.message).toContain("OPENCODE_API_KEY");
    expect(prod.findings[0]?.message).not.toContain(secret);

    const stage = await checkEnvCredentials(context({ env: "stage", envFilePath }));
    expect(stage.findings).toHaveLength(1);
    expect(stage.findings[0]?.severity).toBe("warn");
    expect(stage.findings[0]?.message).toContain("OPENCODE_API_KEY");
  });

  test("an unlisted key — the retired ADMIN_TOKEN, now a service token (§3) — refuses on prod", async () => {
    const envFilePath = writeEnvFile("admin-token.env", [...SAFE, "ADMIN_TOKEN=an-operator-bearer"]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("ADMIN_TOKEN");
  });

  test("the spelling is exact — `HOST` is a key env-role.ts never reads, so it is not the allowed `host`", async () => {
    const envFilePath = writeEnvFile("upper-host.env", ["HOST=db.example.invalid", "rm_app=token-a"]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("HOST");
  });

  test("an `export` prefix does not hide a key", async () => {
    const envFilePath = writeEnvFile("export-owner.env", [...SAFE, "export rm_owner=typed-once-never-stored"]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("rm_owner");
    expect(result.findings[0]?.message).toContain("the migration credential");
  });

  test("a line that is not KEY = VALUE is reported by line number, never by content", async () => {
    const pasted = "a-bare-pasted-secret-with-no-key";
    const envFilePath = writeEnvFile("bare-line.env", [...SAFE, pasted]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain(`line ${SAFE.length + 1}`);
    expect(result.findings[0]?.message).not.toContain(pasted);
  });

  test("the key is everything before the first `=`, as env-role.ts reads it — an allowed prefix cannot hide a key", async () => {
    // `host:OPENCODE_API_KEY=…` and `rm_worker: rm_owner=…` start with an
    // allowed key, but parseEnvFile stores them under the keys
    // `host:OPENCODE_API_KEY` and `rm_worker: rm_owner`, neither of which §3
    // allows. Each is its own refusal on prod, by line number, and neither
    // the value nor the key text is printed.
    const modelKey = "sk-live-secret-behind-an-allowed-prefix";
    const ownerPassword = "owner-password-behind-an-allowed-prefix";
    const envFilePath = writeEnvFile("colon-prefix.env", [
      ...SAFE,
      `host:OPENCODE_API_KEY=${modelKey}`,
      `rm_worker: rm_owner=${ownerPassword}`,
    ]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    const refused = refusals(result.findings);
    expect(refused).toHaveLength(2);
    expect(refused[0]?.message).toContain(`line ${SAFE.length + 1}`);
    expect(refused[1]?.message).toContain(`line ${SAFE.length + 2}`);
    expect(refused[1]?.message).toContain("the migration credential");
    const text = result.findings.map((f) => f.message).join("\n");
    expect(text).not.toContain(modelKey);
    expect(text).not.toContain(ownerPassword);
    expect(text).not.toContain("host:OPENCODE_API_KEY");
  });

  test("a `key: value` line with no `=` is still a stored credential — refused by line number", async () => {
    const envFilePath = writeEnvFile("colon-only.env", [...SAFE, "rm_owner: typed-once-never-stored"]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain(`line ${SAFE.length + 1}`);
    expect(result.findings[0]?.message).not.toContain("typed-once-never-stored");
  });

  test("refuses an rm_owner token on prod", async () => {
    const envFilePath = writeEnvFile("owner.env", [...SAFE, "rm_owner=super-secret-owner-token"]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("rm_owner");
  });

  test("refuses a doadmin token on prod", async () => {
    const envFilePath = writeEnvFile("doadmin.env", [...SAFE, "doadmin=cluster-admin-token"]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("doadmin");
  });

  test("warns and proceeds on stage (§7 check 4), still naming an owner credential", async () => {
    const envFilePath = writeEnvFile("owner-stage.env", [...SAFE, "rm_owner=super-secret-owner-token"]);
    const result = await checkEnvCredentials(context({ env: "stage", envFilePath }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe("warn");
    expect(result.findings[0]?.message).toContain("rm_owner");
    expect(refusals(result.findings)).toEqual([]);
  });

  test("unset RM_ENV refuses against a remote and warns under --local, per §4.3's unset row", async () => {
    const envFilePath = writeEnvFile("owner-unset.env", [...SAFE, "rm_owner=super-secret-owner-token"]);
    const remote = await checkEnvCredentials(context({ env: null, connection: "remote", envFilePath }));
    expect(remote.findings[0]?.severity).toBe("refuse");
    const local = await checkEnvCredentials(context({ env: null, connection: "local", envFilePath }));
    expect(local.findings[0]?.severity).toBe("warn");
  });

  test("names the offending KEY and never the value — it does not log, hash or compare a secret", async () => {
    const secret = "an-owner-password-that-must-never-be-printed";
    const envFilePath = writeEnvFile("redaction.env", [...SAFE, `rm_owner=${secret}`]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    const text = result.findings.map((f) => f.message).join("\n");
    expect(text).toContain("rm_owner");
    expect(text).not.toContain(secret);
  });

  test("reports every dangerous key present, not the first", async () => {
    const envFilePath = writeEnvFile("all-three.env", [
      ...SAFE,
      "rm_owner=x",
      "doadmin=y",
      "POSTGRES_SUPERUSER_URL=postgres://postgres@host/db",
    ]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    const text = result.findings.map((f) => f.message).join("\n");
    expect(text).toContain("rm_owner");
    expect(text).toContain("doadmin");
    expect(refusals(result.findings).length).toBeGreaterThanOrEqual(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Check 5 — RM_ENV x deployment_identity
// ───────────────────────────────────────────────────────────────────────────

describe("check 5 — RM_ENV x deployment_identity resolve per the §4.3 matrix", () => {
  // The enrollment column is `kind` — spec §4.2 ("`deployment_identity.kind ∈
  // {production, rehearsal}`") and migration 0063, which is what the template
  // database this test runs against actually holds. The fixture replaces the
  // table rather than reusing 0063's so that the zero-row and two-row cases
  // below are expressible at all: 0063 pins one row with a boolean primary key.
  async function withIdentity(value: "production" | "rehearsal" | null, body: () => Promise<void>): Promise<void> {
    await sql.unsafe("DROP TABLE IF EXISTS deployment_identity");
    await sql.unsafe(`
      CREATE TABLE deployment_identity (
        kind text NOT NULL,
        singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton)
      )`);
    if (value) await sql`INSERT INTO deployment_identity (kind) VALUES (${value})`;
    try {
      await body();
    } finally {
      await sql.unsafe("DROP TABLE IF EXISTS deployment_identity");
    }
  }

  test("prod + remote + production identity passes", async () => {
    await withIdentity("production", async () => {
      const result = await checkEnvIdentity(sql, context({ env: "prod", connection: "remote" }));
      expect(result.check).toBe("env_identity");
      expect(result.findings).toEqual([]);
    });
  });

  test("prod + remote + rehearsal identity refuses", async () => {
    await withIdentity("rehearsal", async () => {
      const result = await checkEnvIdentity(sql, context({ env: "prod", connection: "remote" }));
      expect(refusals(result.findings)).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("rehearsal");
    });
  });

  test("prod + any --local mode refuses", async () => {
    await withIdentity("rehearsal", async () => {
      const result = await checkEnvIdentity(sql, context({ env: "prod", connection: "local" }));
      expect(refusals(result.findings)).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("prod");
    });
  });

  test("stage + remote + production identity refuses — stage policy never touches production data", async () => {
    await withIdentity("production", async () => {
      const result = await checkEnvIdentity(sql, context({ env: "stage", connection: "remote" }));
      expect(refusals(result.findings)).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("production");
    });
  });

  test("stage + local + production identity refuses — a reattached volume gets no weaker policy than a remote", async () => {
    await withIdentity("production", async () => {
      const result = await checkEnvIdentity(sql, context({ env: "stage", connection: "local" }));
      expect(refusals(result.findings)).toHaveLength(1);
    });
  });

  test("unset RM_ENV against a remote refuses", async () => {
    await withIdentity("rehearsal", async () => {
      const result = await checkEnvIdentity(sql, context({ env: null, connection: "remote" }));
      expect(refusals(result.findings)).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("RM_ENV");
    });
  });

  test("unset RM_ENV under --local warns `RM_ENV not set, running as stage` and proceeds", async () => {
    await withIdentity("rehearsal", async () => {
      const result = await checkEnvIdentity(sql, context({ env: null, connection: "local" }));
      expect(refusals(result.findings)).toEqual([]);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.severity).toBe("warn");
      expect(result.findings[0]?.message).toContain("RM_ENV not set, running as stage");
    });
  });

  test("no deployment_identity row refuses — absence of evidence is not evidence of rehearsal", async () => {
    await withIdentity(null, async () => {
      const result = await checkEnvIdentity(sql, context({ env: "stage", connection: "remote" }));
      expect(refusals(result.findings)).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("deployment_identity");
    });
  });

  test("more than one deployment_identity row refuses", async () => {
    await sql.unsafe("DROP TABLE IF EXISTS deployment_identity");
    await sql.unsafe("CREATE TABLE deployment_identity (kind text NOT NULL)");
    await sql.unsafe("INSERT INTO deployment_identity (kind) VALUES ('rehearsal'), ('production')");
    try {
      const result = await checkEnvIdentity(sql, context({ env: "stage", connection: "remote" }));
      expect(refusals(result.findings).length).toBeGreaterThan(0);
    } finally {
      await sql.unsafe("DROP TABLE IF EXISTS deployment_identity");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Check 6 — every active subject has an epoch duration
// ───────────────────────────────────────────────────────────────────────────
//
// REWRITTEN (issue #1026 W4). This block used to assert the five `swarm.*`
// schedule rows were enabled and their crons parsed. The scheduler spec's §12
// amendment table replaces that clause with "preflight: every active subject
// has an epoch duration", and the same change retires the rows — so the old
// assertions could only have been kept by keeping a check that refuses every
// production boot for the absence of rows the design forbids.

describe("check 6 — every active subject has an epoch duration", () => {
  test("passes when every active subject has one", async () => {
    const result = await checkSubjectEpochDurations(sql, context({ env: "prod" }));
    expect(result.check).toBe("subject_epoch_durations");
    expect(result.findings).toEqual([]);
  });

  test("has NO environment qualifier — stage is checked exactly like prod", async () => {
    // The old check returned empty off `prod`, because the rows were
    // legitimately disabled on stage. Nothing about a duration is
    // environment-specific (spec §8), so both environments answer alike.
    const subjectId = `pf_dur_${crypto.randomUUID().slice(0, 8)}`;
    await sql`INSERT INTO swarm_subjects (id, status, name) VALUES (${subjectId}, 'active', 'pf')`;
    await sql.unsafe(
      `ALTER TABLE swarm_subjects DROP CONSTRAINT swarm_subjects_epoch_duration_seconds_check`,
    );
    await sql.unsafe(`ALTER TABLE swarm_subjects ALTER COLUMN epoch_duration_seconds DROP NOT NULL`);
    try {
      await sql`UPDATE swarm_subjects SET epoch_duration_seconds = NULL WHERE id = ${subjectId}`;
      for (const env of ["prod", "stage"] as const) {
        const result = await checkSubjectEpochDurations(sql, context({ env }));
        const text = refusals(result.findings).map((f) => f.message).join("\n");
        expect(text).toContain(subjectId);
      }
    } finally {
      await sql`UPDATE swarm_subjects SET epoch_duration_seconds = 3600 WHERE epoch_duration_seconds IS NULL`;
      await sql.unsafe(`ALTER TABLE swarm_subjects ALTER COLUMN epoch_duration_seconds SET NOT NULL`);
      await sql.unsafe(
        `ALTER TABLE swarm_subjects ADD CONSTRAINT swarm_subjects_epoch_duration_seconds_check CHECK (epoch_duration_seconds > 0)`,
      );
    }
  });

  test("an INACTIVE subject without one is not a refusal — it runs no epochs", async () => {
    const subjectId = `pf_dur_off_${crypto.randomUUID().slice(0, 8)}`;
    await sql`INSERT INTO swarm_subjects (id, status, name) VALUES (${subjectId}, 'inactive', 'pf')`;
    await sql.unsafe(
      `ALTER TABLE swarm_subjects DROP CONSTRAINT swarm_subjects_epoch_duration_seconds_check`,
    );
    await sql.unsafe(`ALTER TABLE swarm_subjects ALTER COLUMN epoch_duration_seconds DROP NOT NULL`);
    try {
      await sql`UPDATE swarm_subjects SET epoch_duration_seconds = NULL WHERE id = ${subjectId}`;
      const result = await checkSubjectEpochDurations(sql, context({ env: "prod" }));
      const text = refusals(result.findings).map((f) => f.message).join("\n");
      expect(text).not.toContain(subjectId);
    } finally {
      await sql`UPDATE swarm_subjects SET epoch_duration_seconds = 3600 WHERE epoch_duration_seconds IS NULL`;
      await sql.unsafe(`ALTER TABLE swarm_subjects ALTER COLUMN epoch_duration_seconds SET NOT NULL`);
      await sql.unsafe(
        `ALTER TABLE swarm_subjects ADD CONSTRAINT swarm_subjects_epoch_duration_seconds_check CHECK (epoch_duration_seconds > 0)`,
      );
    }
  });

  test("refuses when the column itself is absent — the migration has not reached this database", async () => {
    await sql.unsafe(`ALTER TABLE swarm_subjects DROP COLUMN epoch_duration_seconds`);
    try {
      const result = await checkSubjectEpochDurations(sql, context({ env: "prod" }));
      expect(refusals(result.findings)).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("epoch_duration_seconds");
    } finally {
      await sql.unsafe(
        `ALTER TABLE swarm_subjects ADD COLUMN epoch_duration_seconds integer NOT NULL DEFAULT 3600`,
      );
      await sql.unsafe(
        `ALTER TABLE swarm_subjects ADD CONSTRAINT swarm_subjects_epoch_duration_seconds_check CHECK (epoch_duration_seconds > 0)`,
      );
    }
  });

  test("changes nothing — a preflight measures and never repairs", async () => {
    const before = await sql<{ id: string; epoch_duration_seconds: number }[]>`
      SELECT id, epoch_duration_seconds FROM swarm_subjects ORDER BY id`;
    await checkSubjectEpochDurations(sql, context({ env: "prod" }));
    const after = await sql<{ id: string; epoch_duration_seconds: number }[]>`
      SELECT id, epoch_duration_seconds FROM swarm_subjects ORDER BY id`;
    expect(after).toEqual(before);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Orchestrator
// ───────────────────────────────────────────────────────────────────────────

describe("runPreflight — one library, three callers (§7.2)", () => {
  test("`full` scope runs all seven check ids; `container` runs only checks 1-3", async () => {
    const all = await runPreflight(sql, context({ env: "prod" }), "full", tokens());
    expect(all.results.map((r) => r.check)).toEqual([
      "roles_authenticate",
      "privileges",
      "schema_integrity",
      "schema_compatibility",
      "env_credentials",
      "env_identity",
      "subject_epoch_durations",
    ]);

    const own = new Map<RmRole, string>([["rm_app", PASSWORDS.rm_app]]);
    const container = await runPreflight(sql, context({ roles: ["rm_app"] }), "container", own);
    expect(container.results.map((r) => r.check)).toEqual([
      "roles_authenticate",
      "privileges",
      "schema_integrity",
      "schema_compatibility",
    ]);
  });

  test("runs every check before deciding — a database failing 2, 3 and 5 says so in one boot", async () => {
    // Check 2's failure is CONSTRUCTED. It used to come for free from 0053's
    // ambient `DELETE ON ALL TABLES` grant, but migration 0065 is §9.1 step 2
    // and removes it — so borrowing it here would quietly reduce this case to
    // "3 and 5" the day the transition landed, which is the opposite of what it
    // is for. What is under test is that one boot reports EVERY failing check
    // rather than stopping at the first.
    await sql.unsafe("GRANT DELETE ON swarm_members TO rm_app");
    try {
      const report = await runPreflight(sql, context({ env: "prod", connection: "remote" }), "full", tokens());
      const failed = report.results.filter((r) => r.findings.some((f) => f.severity === "refuse")).map((r) => r.check);
      expect(failed).toContain("privileges");
      expect(failed).toContain("schema_integrity");
      expect(failed).toContain("env_identity");
      expect(report.passed).toBe(false);
    } finally {
      await sql.unsafe("REVOKE DELETE ON swarm_members FROM rm_app");
    }
  });

  test("warnings neither clear nor set `passed`", async () => {
    const envFilePath = writeEnvFile("warn-only.env", ["rm_app=a", "rm_owner=b"]);
    const report = await runPreflight(sql, context({ env: "stage", envFilePath }), "full", tokens());
    const warnings = report.results.flatMap((r) => r.findings).filter((f) => f.severity === "warn");
    expect(warnings.length).toBeGreaterThan(0);
    expect(report.passed).toBe(report.results.every((r) => !r.findings.some((f) => f.severity === "refuse")));
  });

  describe("is read-only against EVERY table, in a passing outcome and in a failing one", () => {
    // Two independent proofs, both over the whole database rather than a
    // couple of tables:
    //   (a) the run happens on a connection pinned
    //       `default_transaction_read_only = on`, where any INSERT, UPDATE,
    //       DELETE, TRUNCATE, DDL or sequence advance raises 25006 — and a
    //       check that caught that error would turn it into a finding, so no
    //       finding may mention it either;
    //   (b) the cumulative n_tup_ins / n_tup_upd / n_tup_del of every public
    //       table is the same after the run as before it.

    async function readOnlyRun(ctx: PreflightContext): Promise<PreflightReport> {
      const pinned = pinnedConnection(true);
      try {
        // The pin is real, or (a) proves nothing.
        const [setting] = await pinned<{ value: string }[]>`SELECT current_setting('default_transaction_read_only') AS value`;
        expect(setting?.value).toBe("on");
        // Awaited inside a try, not handed to `expect(...).rejects`: a
        // postgres.js query is lazy and only runs when its own `then` is
        // called, which bun's matcher does not do.
        let refusedCode: string | undefined;
        try {
          await pinned`CREATE TABLE rm_preflight_read_only_probe (id integer)`;
        } catch (error) {
          refusedCode = (error as { code?: string }).code;
        }
        expect(refusedCode).toBe("25006");

        const report = await runPreflight(pinned, ctx, "full", tokens());
        await flushStats(pinned);
        const text = report.results.flatMap((r) => r.findings.map((f) => f.message)).join("\n");
        expect(text).not.toContain("25006");
        expect(text).not.toMatch(/read-only transaction/i);
        return report;
      } finally {
        await pinned.end({ timeout: 5 });
      }
    }

    test("the tuple counters see a write from another connection — the comparison below is not blind", async () => {
      const before = await tupleWrites();
      const writer = pinnedConnection(false);
      try {
        await writer`UPDATE job_schedules SET enabled = enabled WHERE id = (SELECT min(id) FROM job_schedules)`;
        await flushStats(writer);
      } finally {
        await writer.end({ timeout: 5 });
      }
      const after = await tupleWrites();
      expect(after.job_schedules).toBeGreaterThan(before.job_schedules ?? 0);
    });

    test("passing outcome: a published, enrolled, clean database — report passes and nothing is written", async () => {
      await publishManifest();
      await enrollRehearsal();
      const envFilePath = writeEnvFile("read-only-pass.env", ["host=db.example.invalid", "rm_app=token-a"]);
      const ctx = context({ env: "stage", connection: "local", codeFilenames: await ledgerNames(), envFilePath });

      const before = await tupleWrites();
      const report = scopedReport(await readOnlyRun(ctx));
      expect(preflightReportLines(report)).toEqual([]);
      expect(report.passed).toBe(true);
      expect(await tupleWrites()).toEqual(before);
    });

    test("failing outcome: checks 2, 3 and 5 refuse — and still nothing is written", async () => {
      await sql.unsafe("GRANT DELETE ON swarm_members TO rm_app");
      const ctx = context({ env: "prod", connection: "remote" });

      const before = await tupleWrites();
      const report = await readOnlyRun(ctx);
      expect(report.passed).toBe(false);
      const failed = report.results.filter((r) => refusals(r.findings).length > 0).map((r) => r.check);
      expect(failed).toContain("privileges");
      expect(failed).toContain("schema_integrity");
      expect(failed).toContain("env_identity");
      expect(await tupleWrites()).toEqual(before);
    });
  });

  test("throws rather than reporting a failed check when the database cannot be queried at all", async () => {
    const dead = postgres("postgres://rm_app:wrong@127.0.0.1:1/nope", { max: 1, onnotice: () => {}, connect_timeout: 1 });
    try {
      await expect(runPreflight(dead, context(), "container", tokens())).rejects.toThrow();
    } finally {
      await dead.end({ timeout: 5 });
    }
  });
});

describe("preflightReportLines — the only thing an operator has when a boot stops", () => {
  test("renders one `[preflight]` line per finding, in check order", async () => {
    const report = await runPreflight(sql, context({ env: "prod", connection: "remote" }), "full", tokens());
    const lines = preflightReportLines(report);
    const findings = report.results.flatMap((r) => r.findings);
    expect(lines).toHaveLength(findings.length);
    expect(lines.every((line) => line.startsWith("[preflight]"))).toBe(true);
    for (const [index, finding] of findings.entries()) {
      expect(lines[index]).toContain(finding.message);
    }
  });

  test("is pure and synchronous — the same report renders identically twice", async () => {
    const report = await runPreflight(sql, context({ env: "prod" }), "full", tokens());
    expect(preflightReportLines(report)).toEqual(preflightReportLines(report));
  });

  test("renders nothing for a clean report", () => {
    expect(preflightReportLines({ results: [], passed: true })).toEqual([]);
  });
});
