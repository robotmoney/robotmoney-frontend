// The pure half of the stage target (scripts/release/stage-target-lib.ts, D61
// rule 2): the env files carry production's key names, and a captured globals
// file becomes DigitalOcean's role shape without its superusers.
import { describe, expect, test } from "bun:test";

import { parseEnvFile } from "../../lib/env-role.ts";
import {
  bindDatabase,
  composeLegacyCheckoutEnv,
  composeStageHomeEnv,
  doadminPasswordSql,
  envKeyNames,
  fingerprintDiff,
  globalsToRoleSql,
  legacyLaunchScript,
  legacyMigrationScript,
  pgHbaConf,
  provisionTaxonomyScript,
  precutoverProblems,
  PROD_HOME_ENV_KEYS,
  PROD_LEGACY_CHECKOUT_ENV_KEYS,
  roleShapeProblems,
  rolePasswordSql,
  STAGE_TARGET,
  type StageHomeEnv,
} from "../../release/stage-target-lib.ts";

const VALUES: StageHomeEnv = {
  rm_app: "app-pw",
  rm_worker: "worker-pw",
  rm_readonly: "ro-pw",
  SWARM_SCHEDULES_ENABLED: "0",
  host: "172.17.0.1",
  port: "25060",
  database: "defaultdb",
  sslmode: "require",
  OPENCODE_API_KEY: "zen-key",
  COINGECKO_API_KEY: "cg-key",
};

/** Production's globals as `bun smoke:capture` wrote them on 2026-10-08 (role catalog only, no passwords). */
const GLOBALS = String.raw`--
\restrict abc
SET default_transaction_read_only = off;
CREATE ROLE _doadmin_managed;
ALTER ROLE _doadmin_managed WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
COMMENT ON ROLE _doadmin_managed IS 'Holds the privileges given to this service''s administrators. Reserved for platform management.';
CREATE ROLE _dodb;
ALTER ROLE _dodb WITH SUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN REPLICATION NOBYPASSRLS;
CREATE ROLE doadmin;
ALTER ROLE doadmin WITH NOSUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS;
COMMENT ON ROLE doadmin IS 'The primary administrative role for this service, for your own use.';
CREATE ROLE doadmin_group;
ALTER ROLE doadmin_group WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE postgres;
ALTER ROLE postgres WITH SUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS;
CREATE ROLE rm_app;
ALTER ROLE rm_app WITH NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE rm_owner;
ALTER ROLE rm_owner WITH NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE rm_readonly;
ALTER ROLE rm_readonly WITH NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE rm_worker;
ALTER ROLE rm_worker WITH NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS;
ALTER ROLE _dodb SET "pgaudit.log" TO 'none';
ALTER ROLE postgres SET default_transaction_isolation TO 'read committed';
GRANT _doadmin_managed TO doadmin_group WITH INHERIT TRUE GRANTED BY postgres;
GRANT doadmin_group TO doadmin WITH ADMIN OPTION, INHERIT TRUE GRANTED BY postgres;
GRANT pg_read_all_stats TO _doadmin_managed WITH ADMIN OPTION, INHERIT TRUE GRANTED BY postgres;
GRANT rm_app TO doadmin WITH ADMIN OPTION, INHERIT FALSE, SET FALSE GRANTED BY postgres;
GRANT rm_app TO doadmin WITH INHERIT TRUE GRANTED BY doadmin;
GRANT rm_owner TO doadmin WITH ADMIN OPTION, INHERIT FALSE, SET FALSE GRANTED BY postgres;
GRANT rm_owner TO doadmin WITH INHERIT TRUE GRANTED BY doadmin;
GRANT rm_readonly TO doadmin WITH ADMIN OPTION, INHERIT TRUE GRANTED BY postgres;
GRANT rm_worker TO doadmin WITH ADMIN OPTION, INHERIT FALSE, SET FALSE GRANTED BY postgres;
GRANT rm_worker TO doadmin WITH INHERIT TRUE GRANTED BY doadmin;
GRANT SET ON PARAMETER "anon.salt" TO doadmin_group WITH GRANT OPTION;
GRANT SET ON PARAMETER "pgaudit.log" TO _doadmin_auditing;
GRANT SET ON PARAMETER session_replication_role TO doadmin_group WITH GRANT OPTION;
\unrestrict abc
`;

describe("the stage target's ~/.env", () => {
  test("its key names are exactly production's: no rm_owner line (role-passwords writes it) and never doadmin (D61)", () => {
    const keys = envKeyNames(composeStageHomeEnv(VALUES));
    expect(new Set(keys)).toEqual(new Set(PROD_HOME_ENV_KEYS));
    expect(keys.length).toBe(PROD_HOME_ENV_KEYS.length);
    expect(keys).not.toContain("rm_owner");
    expect(keys).not.toContain("doadmin");
  });

  test("it carries the legacy extras the cutover's env rewrite must move aside", () => {
    const keys = envKeyNames(composeStageHomeEnv(VALUES));
    expect(keys).toContain("SWARM_SCHEDULES_ENABLED");
    expect(keys).toContain("OPENCODE_API_KEY");
    expect(keys).not.toContain("RM_ENV");
    expect(keys).not.toContain("RM_CREDENTIALS");
  });

  test("the repo's own parser reads every value back, the DigitalOcean panel spacing included", () => {
    expect(parseEnvFile(composeStageHomeEnv(VALUES))).toEqual(VALUES);
  });

  test("an empty or multi-line value refuses", () => {
    expect(() => composeStageHomeEnv({ ...VALUES, rm_readonly: "" })).toThrow(/rm_readonly/);
    expect(() => composeStageHomeEnv({ ...VALUES, rm_app: "a\nRM_ENV=prod" })).toThrow(/spans lines/);
  });
});

describe("the legacy checkout .env", () => {
  test("its key names are production's legacy checkout key names", () => {
    expect(envKeyNames(composeLegacyCheckoutEnv(VALUES, "doadmin-pw"))).toEqual([...PROD_LEGACY_CHECKOUT_ENV_KEYS]);
  });

  test("each URL names production's role and points at the stage database over TLS", () => {
    const env = parseEnvFile(composeLegacyCheckoutEnv(VALUES, "doadmin-pw"));
    expect(new URL(env.DATABASE_URL!).username).toBe("rm_app");
    expect(new URL(env.WORKER_DATABASE_URL!).username).toBe("rm_worker");
    expect(new URL(env.MIGRATE_DATABASE_URL!).username).toBe("doadmin");
    for (const k of ["DATABASE_URL", "WORKER_DATABASE_URL", "MIGRATE_DATABASE_URL"]) {
      const u = new URL(env[k]!);
      expect(u.host).toBe("172.17.0.1:25060");
      expect(u.pathname).toBe("/defaultdb");
      expect(u.searchParams.get("sslmode")).toBe("require");
    }
    expect(env.SWARM_SCHEDULES_ENABLED).toBe("0");
    // Production's legacy file holds a working doadmin URL; the v0.5.4 boot migrates through it.
    expect(decodeURIComponent(new URL(env.MIGRATE_DATABASE_URL!).password)).toBe("doadmin-pw");
  });
});

describe("stage doadmin is stored in no release file (D61, owner 2026-10-08)", () => {
  test("`stage-target doadmin` sets one statement through psql's stdin and prints only the password; up writes doadmin only into the legacy file", async () => {
    expect(doadminPasswordSql("p'w")).toBe("ALTER ROLE doadmin PASSWORD 'p''w';\n");
    expect(() => doadminPasswordSql("")).toThrow(/doadmin/);
    const source = await Bun.file(new URL("../../release/stage-target.ts", import.meta.url)).text();
    const doadmin = source.slice(source.indexOf("function remoteDoadmin"), source.indexOf("// The control machine"));
    expect(doadmin).toContain("psql(doadminPasswordSql(password), { secret: true })");
    expect(doadmin).not.toMatch(/writeFileSync|appendFileSync|console\.log|log\(/);
    // up: ~/.env gets no doadmin key; the legacy .env mirrors production's v0.5.4
    // file, whose MIGRATE_DATABASE_URL works (the v0.5.4 boot migrates through it).
    // `stage-target doadmin` rotates doadmin right after, so that copy goes stale.
    const writeEnv = source.slice(source.indexOf("function writeEnvFiles"), source.indexOf("function checkDatabase"));
    expect(writeEnv).not.toMatch(/passwords\.rm_owner/);
    expect(writeEnv.match(/passwords\.doadmin/g)).toHaveLength(1);
    expect(writeEnv).toContain("composeLegacyCheckoutEnv(values, passwords.doadmin)");
  });
});

describe("role DDL from the captured globals", () => {
  const result = globalsToRoleSql(GLOBALS);

  test("keeps every non-superuser role and leaves out the platform superusers", () => {
    expect(result.roles).toEqual(["_doadmin_managed", "doadmin", "doadmin_group", "rm_app", "rm_owner", "rm_readonly", "rm_worker"]);
    expect(result.skipped.map((s) => s.split(" ")[0])).toEqual(["_dodb", "postgres"]);
    expect(result.sql).not.toMatch(/\bpostgres\b/);
    expect(result.sql).not.toMatch(/_dodb/);
  });

  test("doadmin keeps DigitalOcean's attribute line: CREATEROLE CREATEDB, never SUPERUSER", () => {
    expect(result.sql).toContain("ALTER ROLE doadmin WITH NOSUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS;");
    expect(result.sql).not.toMatch(/ALTER ROLE \S+ WITH SUPERUSER/);
  });

  test("rm_owner stays NOLOGIN", () => {
    expect(result.sql).toContain("ALTER ROLE rm_owner WITH NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;");
  });

  test("doadmin holds ADMIN over each app role; a grant by postgres becomes the bootstrap superuser's", () => {
    for (const r of ["rm_app", "rm_owner", "rm_worker", "rm_readonly"]) {
      expect(result.sql).toMatch(new RegExp(`GRANT ${r} TO doadmin WITH ADMIN OPTION[^;]*;`));
    }
    expect(result.sql).not.toContain("GRANTED BY postgres");
    expect(result.sql).toContain("GRANT rm_owner TO doadmin WITH INHERIT TRUE GRANTED BY doadmin;");
    expect(result.sql).toContain("GRANT pg_read_all_stats TO _doadmin_managed WITH ADMIN OPTION, INHERIT TRUE;");
  });

  test("creation is idempotent and admin grants precede the grants made by doadmin", () => {
    expect(result.sql).toContain("CREATE ROLE rm_owner; EXCEPTION WHEN duplicate_object THEN NULL;");
    const admin = result.sql.indexOf("GRANT rm_app TO doadmin WITH ADMIN OPTION");
    const byDoadmin = result.sql.indexOf("GRANT rm_app TO doadmin WITH INHERIT TRUE GRANTED BY doadmin");
    expect(admin).toBeGreaterThan(-1);
    expect(byDoadmin).toBeGreaterThan(admin);
  });

  test("per-role settings, extension parameters and psql meta-commands are left out", () => {
    expect(result.sql).not.toContain("SET \"pgaudit.log\"");
    expect(result.sql).not.toContain("anon.salt");
    expect(result.sql).not.toContain("\\restrict");
    expect(result.sql).toContain("GRANT SET ON PARAMETER session_replication_role TO doadmin_group WITH GRANT OPTION;");
  });

  test("the passwords are set for the five roles, rm_owner without LOGIN", () => {
    const sql = rolePasswordSql({ doadmin: "a", rm_owner: "b'c", rm_app: "d", rm_worker: "e", rm_readonly: "f" });
    expect(sql).toContain("ALTER ROLE rm_owner PASSWORD 'b''c';");
    expect(sql).not.toMatch(/LOGIN/);
    expect(sql.trim().split("\n")).toHaveLength(5);
  });
});

describe("the checks", () => {
  test("role shape: production's pre-cutover rows pass; a superuser doadmin fails; rm_owner may be either", () => {
    const rows = ["doadmin|f|t|t|t|t", "rm_app|f|f|f|t|t", "rm_owner|f|f|f|f|t", "rm_readonly|f|f|f|t|t", "rm_worker|f|f|f|t|t"].join("\n");
    const admin = "rm_app\nrm_owner\nrm_readonly\nrm_worker\n";
    expect(roleShapeProblems(rows, admin)).toEqual([]);
    expect(roleShapeProblems(rows.replace("doadmin|f", "doadmin|t"), admin)).toEqual(["doadmin rolsuper=true, production has false"]);
    // role-passwords makes production's rm_owner LOGIN before its dump.
    expect(roleShapeProblems(rows.replace("rm_owner|f|f|f|f", "rm_owner|f|f|f|t"), admin)).toEqual([]);
    expect(roleShapeProblems(rows, "rm_app\n")).toHaveLength(3);
  });

  test("pre-cutover state: ledger equal to the baseline, no identity, TLS on", () => {
    const baseline = ["0001_a.sql", "0002_b.sql"];
    const ok = { ledger: "2", identity_table: "none", rm_owner_login: "false", doadmin_super: "false", doadmin_createrole: "true", ssl: "on" };
    expect(precutoverProblems(ok, baseline, baseline)).toEqual([]);
    expect(precutoverProblems({ ...ok, rm_owner_login: "true" }, baseline, baseline)).toEqual([]);
    expect(precutoverProblems({ ...ok, identity_table: "deployment_identity" }, baseline, baseline)).toHaveLength(1);
    expect(precutoverProblems({ ...ok, ledger: "3" }, [...baseline, "0081_deployment_identity.sql"], baseline)).toHaveLength(2);
  });

  test("pg_hba: TLS for every network login, never the superuser over the network", () => {
    const hba = pgHbaConf("rm_stage_super");
    expect(hba).toContain("hostnossl all all             all     reject");
    expect(hba).toContain("hostssl all   rm_stage_super   all     reject");
    expect(hba.indexOf("rm_stage_super")).toBeLessThan(hba.indexOf("scram-sha-256"));
  });

  test("fingerprints compare line by line", () => {
    expect(fingerprintDiff("a\nb\n", "b\na")).toEqual({ onlyReference: [], onlyRestored: [] });
    expect(fingerprintDiff("a\nb", "a\nc")).toEqual({ onlyReference: ["b"], onlyRestored: ["c"] });
  });

  test("the exported statements are bound to the target database", () => {
    expect(bindDatabase('ALTER DATABASE "@DATABASE@" OWNER TO doadmin;', "defaultdb")).toBe("ALTER DATABASE defaultdb OWNER TO doadmin;");
  });
});

describe("the legacy replay and driver", () => {
  test("a ledger file runs as the legacy runner ran it: SET LOCAL ROLE rm_owner from 0054 on", () => {
    expect(legacyMigrationScript("0053_database_role_taxonomy.sql", "SELECT 1;")).not.toContain("SET LOCAL ROLE");
    const s = legacyMigrationScript("0054_rm_worker_allowlist.sql", "SELECT 1;");
    expect(s.startsWith("SET LOCAL ROLE rm_owner;")).toBe(true);
    expect(s).toContain("INSERT INTO schema_migrations (name) VALUES ('0054_rm_worker_allowlist.sql');");
  });

  test("the provisioning run re-applies 0053 with no ledger row, then rm_readonly's sequence grants", () => {
    const s = provisionTaxonomyScript("SELECT 53;");
    expect(s.startsWith("SELECT 53;")).toBe(true);
    expect(s).not.toContain("schema_migrations");
    expect(s).not.toContain("SET LOCAL ROLE");
    expect(s).toContain("GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_readonly;");
  });

  test("the launch script starts smoke:archive in the legacy checkout with the stage HOME and project", () => {
    const script = legacyLaunchScript(STAGE_TARGET);
    expect(script).toContain(`export HOME=${STAGE_TARGET.home}`);
    expect(script).toContain(`cd ${STAGE_TARGET.legacyCheckout} || exit 1`);
    expect(script).toContain(`SMOKE_PROJECT=${STAGE_TARGET.legacyProject} bun run smoke:archive -- --no-tui`);
    expect(script).toContain(`tee "$HOME/${STAGE_TARGET.driverLog}"`);
    expect(script).not.toMatch(/doadmin-pw|PASSWORD=[^"$]/);
  });
});
