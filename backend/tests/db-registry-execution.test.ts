// Execution under each role against a disposable database (spec §7.1) — the
// runtime half of the registered query interface.
//
// Spec §7.1: the registry "is not a runtime proof: execution under each role
// against a disposable database is a separate CI test." This is that test
// (issue #1026 criterion 78). tests/db-registry.test.ts pins the interface and
// the structural lint; preflight check 2 compares the declared privileges with
// `has_table_privilege`. Neither ever runs a statement, so neither can see a
// declaration that is simply wrong about what its statement needs. This file
// runs every registered site's probe (src/db/registry.ts `QueryProbe`) as the
// site's declared LOGIN role and fails on any refusal.
//
// HOW, step by step:
//
//   1. ENUMERATE IN A CHILD. The registry is process-global and backend
//      `bun test` runs every file in one process, so the in-process registry
//      holds whatever other files registered (fixtures included). A child
//      process imports the api's entry modules, the worker's entry modules and
//      every module on disk that calls `registerQuery`, and prints the
//      declarations it then holds — probes included. Nothing else is in it.
//   2. A DISPOSABLE DATABASE FROM THE REAL SNAPSHOT. A blank database copied
//      from `template0`, owned by rm_owner, bootstrapped by
//      `bootstrapBlankDatabase` from backend/schema/ — the same path a
//      `--local blank` boot takes (§8.1), so the grants under test are
//      grants.sql's, not whatever the migration-built suite template holds.
//   3. EACH ROLE LOGS IN AS ITSELF. The harness sets a password on each of the
//      four §3 roles once and connects as that role — never a superuser under
//      `SET ROLE`, which would carry the superuser's session state and prove
//      nothing about the role's own login.
//   4. EACH PROBE RUNS IN A TRANSACTION THAT IS ROLLED BACK. Any error fails
//      the site: 42501 (the grant is missing) is the one this test exists for,
//      and anything else means the probe no longer matches the schema.
//   5. EXACTNESS. A probe that needed nothing (`SELECT 1`) would pass for any
//      role, so each probe is also run as a scratch LOGIN role holding ONLY
//      the declared privileges on ONLY the declared object (must succeed), and
//      then once per declared privilege with that one privilege taken away
//      (must fail with 42501). That is what makes the probe a proof of the
//      declaration rather than a statement that happens to run.
//
// PROBE_PENDING below is the dated backlog of registered sites whose owner
// module had no probe when this test landed. It only shrinks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import postgres from "postgres";
import ts from "typescript";
import { config } from "../src/config.ts";
import { bootstrapBlankDatabase, loadSnapshot } from "../src/db/schema-snapshot.ts";
import type { QueryDeclaration, RmRole, TablePrivilege } from "../src/db/registry.ts";

const BACKEND = join(import.meta.dir, "..");
const SRC = join(BACKEND, "src");
const SCRIPTS = join(BACKEND, "scripts");
const REGISTRY_FILE = join(SRC, "db", "registry.ts");

const ROLES: readonly RmRole[] = ["rm_owner", "rm_app", "rm_worker", "rm_readonly"];

// ─────────────────────────────────────────────────────────────────────────────
// PROBE_PENDING — registered sites with no probe yet. Recorded 2026-09-25
// (#1026 W3) with 11 entries, every one of them src/db/seed's: seed.ts is
// owned by another package this wave, and w5-epoch-registry gives these sites
// their probes. An entry leaves when its site gains a probe (the stale check
// below fails until it does); NEVER ADD A LINE HERE — a new site ships with
// its probe.
// ─────────────────────────────────────────────────────────────────────────────
const PROBE_PENDING: readonly string[] = [
  "src/db/seed:backfillWalletHistory",
  "src/db/seed:seed.allocationFramework",
  "src/db/seed:seed.coldStart",
  "src/db/seed:seedJobSchedules.deadLetterAnalyticsRun",
  "src/db/seed:seedJobSchedules.deadLetterProducer",
  "src/db/seed:seedJobSchedules.deleteAnalyticsRun",
  "src/db/seed:seedJobSchedules.deleteHourlyRepair",
  "src/db/seed:seedJobSchedules.disableProducer",
  "src/db/seed:seedJobSchedules.insert",
  "src/db/seed:seedSmokeJobSchedules.disable",
  "src/db/seed:seedSmokeJobSchedules.insert",
];

/** The count PROBE_PENDING was recorded with; it may only go down. */
const PROBE_PENDING_CEILING = 11;

/**
 * The number of probed sites that ran when this test was last extended. The
 * equality below (every probed site ran) is the real proof; this floor is
 * what stops a mass removal of registrations from passing quietly. Raise it
 * as sites are added. Lower it only in the change that deletes a registering
 * module, saying which.
 */
const EXECUTED_FLOOR = 194;

// ─────────────────────────────────────────────────────────────────────────────
// Static enumeration: what the source says is registered.
// ─────────────────────────────────────────────────────────────────────────────

function tsFilesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[])
    .filter((rel) => rel.endsWith(".ts"))
    .map((rel) => join(dir, rel));
}

/** Absolute path → how many `registerQuery(...)` calls the module makes, for
 *  every module under src/ and scripts/ other than the registry itself. */
function declaringModules(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of [...tsFilesUnder(SRC), ...tsFilesUnder(SCRIPTS)]) {
    if (file === REGISTRY_FILE) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes("registerQuery(")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let calls = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "registerQuery") {
        calls += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (calls > 0) found.set(file, calls);
  }
  return found;
}

/** Every relative module an entry file imports, as absolute paths: the
 *  program's registrations without running the program (the api entry binds
 *  a port and runs its boot guards at import; the worker entry starts loops). */
function entryImports(entry: string): string[] {
  const text = readFileSync(entry, "utf8");
  return [...text.matchAll(/^import\s[^;]*?\sfrom\s+"(\.{1,2}\/[^"]+)";/gm)].map((m) => join(dirname(entry), m[1]!));
}

const API_ENTRY = join(SRC, "api", "index.ts");
const WORKER_ENTRY = join(SRC, "worker", "index.ts");

// ─────────────────────────────────────────────────────────────────────────────
// The disposable database and the role logins.
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "rm_registry_execution_password";
/** A LOGIN role that holds nothing but what the exactness check hands it. */
const SCRATCH = "rm_registry_probe_scratch";

const database = `rm_registry_exec_${crypto.randomUUID().slice(0, 8)}`;
let admin: postgres.Sql<{}>;
const logins = new Map<string, postgres.Sql<{}>>();
/** Each role's login attributes before this file touched them, restored after. */
const saved: { rolname: string; rolcanlogin: boolean; rolpassword: string | null }[] = [];

function urlFor(role: string, name = database): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
}

function login(role: string): postgres.Sql<{}> {
  let db = logins.get(role);
  if (!db) {
    db = postgres(urlFor(role), { max: 1, onnotice: () => {} });
    logins.set(role, db);
  }
  return db;
}

beforeAll(async () => {
  const superuser = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    // The cluster's roles are shared by every file; their login attributes are
    // put back in afterAll so nothing here leaks into a file that runs later.
    saved.push(
      ...(await superuser<{ rolname: string; rolcanlogin: boolean; rolpassword: string | null }[]>`
        SELECT rolname, rolcanlogin, rolpassword FROM pg_authid WHERE rolname = ANY(${ROLES as string[]})`),
    );
    expect(saved.map((r) => r.rolname).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) await superuser.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${PASSWORD}'`);
    await superuser.unsafe(`DROP ROLE IF EXISTS ${SCRATCH}`);
    await superuser.unsafe(`CREATE ROLE ${SCRATCH} LOGIN NOINHERIT PASSWORD '${PASSWORD}'`);
    // A blank database owned by rm_owner (since Postgres 15 only the database
    // owner may CREATE in `public`), copied from template0 so nothing the
    // suite's migration-built template holds comes with it.
    await superuser.unsafe(`CREATE DATABASE ${database} OWNER rm_owner TEMPLATE template0`);
  } finally {
    await superuser.end({ timeout: 5 });
  }

  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = `/${database}`;
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  // pgcrypto is provider-managed (the snapshot's header: "a managed cluster
  // installs it and rm_owner may not"), so the provider's half is done here.
  await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await admin.unsafe("SET ROLE rm_owner");
  await bootstrapBlankDatabase(admin, await loadSnapshot());
  await admin.unsafe("RESET ROLE");
  // The scratch role reaches `public` and the sequences a serial INSERT
  // draws on, and no relation at all until a case grants it one.
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${SCRATCH}`);
  await admin.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${SCRATCH}`);
});

afterAll(async () => {
  await Promise.all([...logins.values()].map((db) => db.end({ timeout: 5 })));
  if (admin) await admin.end({ timeout: 5 });
  const superuser = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await superuser.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await superuser.unsafe(`DROP ROLE IF EXISTS ${SCRATCH}`);
    for (const row of saved) {
      await superuser.unsafe(`ALTER ROLE ${row.rolname} WITH ${row.rolcanlogin ? "LOGIN" : "NOLOGIN"}`);
      if (row.rolpassword === null) await superuser.unsafe(`ALTER ROLE ${row.rolname} WITH PASSWORD NULL`);
      // A stored verifier is accepted back verbatim: Postgres recognises a
      // SCRAM or md5 string and stores it without hashing it again.
      else await superuser.unsafe(`ALTER ROLE ${row.rolname} WITH PASSWORD '${row.rolpassword.replace(/'/g, "''")}'`);
    }
  } finally {
    await superuser.end({ timeout: 5 });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Running one probe.
// ─────────────────────────────────────────────────────────────────────────────

type Outcome = { ok: true } | { ok: false; code: string; message: string };

class Rollback extends Error {}

/** Run `probe` on `db` inside a transaction that is always rolled back. */
async function runProbe(db: postgres.Sql<{}>, probe: NonNullable<QueryDeclaration["probe"]>): Promise<Outcome> {
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = '15s'");
      await tx.unsafe(probe.statement, [...(probe.params ?? [])] as postgres.ParameterOrJSON<never>[]);
      throw new Rollback();
    });
  } catch (error) {
    if (error instanceof Rollback) return { ok: true };
    const e = error as { code?: string; message?: string };
    return { ok: false, code: e.code ?? "unknown", message: e.message ?? String(error) };
  }
  return { ok: false, code: "no-rollback", message: "the probe transaction committed instead of rolling back" };
}

/** Grant exactly `privileges` on `object` to the scratch role, and nothing else. */
async function scratchHolds(object: string, privileges: readonly TablePrivilege[]): Promise<void> {
  await admin.unsafe(`REVOKE ALL ON public.${object} FROM ${SCRATCH}`);
  if (privileges.length > 0) await admin.unsafe(`GRANT ${privileges.join(", ")} ON public.${object} TO ${SCRATCH}`);
}

/**
 * Every way `declaration` fails, as sentences naming the site: the probe as the
 * declared role, then the exactness pair (see the file header). Empty means
 * the declaration is proved.
 */
async function executeSite(declaration: QueryDeclaration): Promise<string[]> {
  const probe = declaration.probe;
  if (!probe) return [`${declaration.site}: has no probe`];
  const failures: string[] = [];
  const as = await runProbe(login(declaration.role), probe);
  if (!as.ok) failures.push(`${declaration.site}: as ${declaration.role} → ${as.code} ${as.message}`);

  try {
    await scratchHolds(declaration.object, declaration.privileges);
    const exact = await runProbe(login(SCRATCH), probe);
    if (!exact.ok) {
      failures.push(
        `${declaration.site}: needs more than ${declaration.privileges.join(", ")} on ${declaration.object} ` +
          `→ ${exact.code} ${exact.message}`,
      );
    }
    for (const dropped of declaration.privileges) {
      await scratchHolds(declaration.object, declaration.privileges.filter((p) => p !== dropped));
      const without = await runProbe(login(SCRATCH), probe);
      if (without.ok || without.code !== "42501") {
        failures.push(
          `${declaration.site}: declares ${dropped} on ${declaration.object} but its probe ` +
            (without.ok ? "runs without it" : `fails with ${without.code}, not 42501, without it: ${without.message}`),
        );
      }
    }
  } finally {
    await admin.unsafe(`REVOKE ALL ON public.${declaration.object} FROM ${SCRATCH}`);
  }
  return failures;
}

// ─────────────────────────────────────────────────────────────────────────────
// The child enumeration.
// ─────────────────────────────────────────────────────────────────────────────

let enumerated: { sites: QueryDeclaration[]; declaring: Map<string, number> } | undefined;

/** The declarations a process holds after importing the api's entry modules,
 *  the worker's, and every declaring module on disk — and nothing else. */
async function childSites(): Promise<{ sites: QueryDeclaration[]; declaring: Map<string, number> }> {
  if (enumerated) return enumerated;
  const declaring = declaringModules();
  const modules = [...new Set([...entryImports(API_ENTRY), ...entryImports(WORKER_ENTRY), ...declaring.keys()])];
  const dir = mkdtempSync(join(tmpdir(), "rm-registry-exec-"));
  const script = join(dir, "enumerate.ts");
  writeFileSync(
    script,
    [
      ...modules.map((m) => `await import(${JSON.stringify(m)});`),
      `const { registeredSites } = await import(${JSON.stringify(REGISTRY_FILE)});`,
      `console.log("RM_REGISTRY_EXEC_SITES " + JSON.stringify(registeredSites()));`,
      // An imported module may start a timer; the answer is out, so leave.
      `process.exit(0);`,
    ].join("\n"),
  );
  try {
    // The child's pools point at the disposable database as rm_readonly, the
    // one role that can write nothing: enumeration must not issue a statement,
    // and if a module ever did at import, it could not change what is probed.
    const readonlyUrl = urlFor("rm_readonly");
    const child = Bun.spawn(["bun", "run", script], {
      env: { ...process.env, DATABASE_URL: readonlyUrl, WORKER_DATABASE_URL: readonlyUrl },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const line = out.split("\n").find((l) => l.startsWith("RM_REGISTRY_EXEC_SITES "));
    if (exitCode !== 0 || !line) throw new Error(`registry enumeration child failed (exit ${exitCode}):\n${out}\n${err}`);
    enumerated = { sites: JSON.parse(line.slice("RM_REGISTRY_EXEC_SITES ".length)) as QueryDeclaration[], declaring };
    return enumerated;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The tests.
// ─────────────────────────────────────────────────────────────────────────────

describe("every registered query runs as its declared role on a disposable database (spec §7.1)", () => {
  test("the child holds exactly the sites the source registers — the enumeration is complete", async () => {
    const { sites, declaring } = await childSites();
    const staticCount = [...declaring.values()].reduce((a, b) => a + b, 0);
    // Non-vacuous: the source registers sites, and the child saw every one.
    expect(staticCount).toBeGreaterThan(0);
    expect(sites.length).toBe(staticCount);
    // The api and worker entry graphs add nothing the on-disk scan missed: a
    // registration reachable only through them would be a site this count
    // cannot see.
    expect(new Set(sites.map((s) => s.site)).size).toBe(sites.length);
    for (const site of sites) expect(ROLES, site.site).toContain(site.role);
  });

  test("every site outside PROBE_PENDING carries a probe, and the backlog only shrinks", async () => {
    const { sites } = await childSites();
    const pending = new Set(PROBE_PENDING);
    expect(pending.size).toBe(PROBE_PENDING.length);
    expect(PROBE_PENDING.length).toBeLessThanOrEqual(PROBE_PENDING_CEILING);
    const missing = sites.filter((s) => !s.probe && !pending.has(s.site)).map((s) => s.site);
    expect(missing).toEqual([]);
    // Stale: an entry whose site now has a probe, or no longer exists, leaves.
    const unprobed = new Set(sites.filter((s) => !s.probe).map((s) => s.site));
    expect(PROBE_PENDING.filter((site) => !unprobed.has(site))).toEqual([]);
  });

  test("each probe succeeds as its declared LOGIN role, and needs exactly the declared privileges", async () => {
    const { sites } = await childSites();
    const probed = sites.filter((s) => s.probe);
    const failures: string[] = [];
    const ranBy = new Map<RmRole, number>();
    for (const declaration of probed) {
      failures.push(...(await executeSite(declaration)));
      ranBy.set(declaration.role, (ranBy.get(declaration.role) ?? 0) + 1);
    }
    // The message is the deliverable: each line names the site, the role and
    // the SQLSTATE, so a reader knows which declaration or grant is wrong.
    expect(failures).toEqual([]);
    // Non-vacuous: every probed site ran, and at least as many as last time.
    expect(probed.length).toBe(sites.length - PROBE_PENDING.length);
    expect(probed.length).toBeGreaterThanOrEqual(EXECUTED_FLOOR);
    expect([...ranBy.values()].reduce((a, b) => a + b, 0)).toBe(probed.length);
  }, 120_000);

  test("each login really is the declared role, not a superuser", async () => {
    for (const role of [...ROLES, SCRATCH]) {
      const [row] = await login(role)<{ who: string; su: string }[]>`
        SELECT current_user AS who, current_setting('is_superuser') AS su`;
      expect(row).toEqual({ who: role, su: "off" });
    }
  });
});

describe("RED CONTROL — a declaration the role's grants do not cover fails with 42501", () => {
  test("a real probe run as a role that lacks the grant is refused with 42501", async () => {
    const { sites } = await childSites();
    const insert = sites.find((s) => s.site === "src/api/routes/comments:createComment.insert");
    expect(insert?.probe).toBeDefined();
    // rm_readonly holds SELECT on comments and nothing else (grants.sql).
    const outcome = await runProbe(login("rm_readonly"), insert!.probe!);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.code).toBe("42501");
  });

  test("the executor names a declaration whose role lacks the grant", async () => {
    // grants.sql leaves rm_app SELECT only on schema_manifest (§8.3: only
    // rm_owner writes it), so this declaration is exactly the kind of wrong
    // the test exists to catch.
    const wrong: QueryDeclaration = {
      role: "rm_app",
      object: "schema_manifest",
      privileges: ["UPDATE", "SELECT"],
      site: "tests/db-registry-execution:red_control",
      purpose: "A deliberately wrong declaration: rm_app rewriting the schema manifest.",
      callers: ["src/api/index"],
      probe: { statement: "UPDATE schema_manifest SET format_version = format_version WHERE singleton" },
    };
    const failures = await executeSite(wrong);
    expect(failures.some((f) => f.startsWith(`${wrong.site}: as rm_app → 42501`))).toBe(true);
  });

  test("the exactness check names a probe that needs nothing, and one that needs more than declared", async () => {
    // A probe that does not use its declared privilege proves nothing.
    const vacuous = await executeSite({
      role: "rm_app",
      object: "comments",
      privileges: ["INSERT"],
      site: "tests/db-registry-execution:vacuous",
      purpose: "A probe that never exercises its declaration.",
      callers: ["src/api/routes/comments"],
      probe: { statement: "SELECT 1 WHERE false AND EXISTS (SELECT FROM pg_class WHERE relname = 'comments')" },
    });
    expect(vacuous).toContain("tests/db-registry-execution:vacuous: declares INSERT on comments but its probe runs without it");
    // An INSERT ... RETURNING reads the row, so declaring INSERT alone is short.
    const short = await executeSite({
      role: "rm_app",
      object: "comments",
      privileges: ["INSERT"],
      site: "tests/db-registry-execution:short",
      purpose: "A declaration missing the SELECT its RETURNING needs.",
      callers: ["src/api/routes/comments"],
      probe: {
        statement: "INSERT INTO comments (page, author, content) VALUES ($1, $2, $3) RETURNING id",
        params: ["/probe", "probe", "probe"],
      },
    });
    expect(short.some((f) => f.startsWith("tests/db-registry-execution:short: needs more than INSERT on comments → 42501"))).toBe(true);
  });
});
