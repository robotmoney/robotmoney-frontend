// The pure half of the stage target (scripts/release/stage-target-lib.ts, D61
// rule 2): the env files carry production's key names, and a captured globals
// file becomes DigitalOcean's role shape without its superusers.
import { describe, expect, test } from "bun:test";

import { parseEnvFile } from "../../lib/env-role.ts";
import {
  bindDatabase,
  composeStageHomeEnv,
  doadminPasswordSql,
  envKeyNames,
  fingerprintDiff,
  globalsToRoleSql,
  legacyMigrationScript,
  pgHbaConf,
  provisionTaxonomyScript,
  restoredDatabaseProblems,
  removalRefusal,
  stageTargetDirs,
  PROD_HOME_ENV_KEYS,
  STAGE_UP_ENV_KEYS,
  roleShapeProblems,
  rolePasswordSql,
  STAGE_TARGET,
  type StageHomeEnv,
} from "../../release/stage-target-lib.ts";
import { CAPTURE_CHECKOUT } from "../../release/target.ts";
import { RELEASE_REPO_URL } from "../../release/steps.ts";

const VALUES: StageHomeEnv = {
  rm_app: "app-pw",
  rm_worker: "worker-pw",
  rm_readonly: "ro-pw",
  rm_owner: "owner-pw",
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
  test("before the first boot it holds production's key names plus the model key, with RM_CREDENTIALS still to come, and never doadmin (D61)", () => {
    const keys = envKeyNames(composeStageHomeEnv(VALUES));
    expect(new Set(keys)).toEqual(new Set(STAGE_UP_ENV_KEYS));
    expect(keys.length).toBe(STAGE_UP_ENV_KEYS.length);
    expect(keys).not.toContain("doadmin");
    expect(keys).not.toContain("RM_ENV");
    // credentials-init appends RM_CREDENTIALS and env-rewrite moves OPENCODE_API_KEY aside: the file the run meets is production's.
    const afterCutoverTools = new Set([...keys.filter((k) => k !== "OPENCODE_API_KEY"), "RM_CREDENTIALS"]);
    expect(afterCutoverTools).toEqual(new Set(PROD_HOME_ENV_KEYS));
  });

  test("the repo's own parser reads every value back, the DigitalOcean panel spacing included", () => {
    expect(parseEnvFile(composeStageHomeEnv(VALUES))).toEqual(VALUES);
  });

  test("an empty or multi-line value refuses", () => {
    expect(() => composeStageHomeEnv({ ...VALUES, rm_readonly: "" })).toThrow(/rm_readonly/);
    expect(() => composeStageHomeEnv({ ...VALUES, rm_app: "a\nRM_ENV=prod" })).toThrow(/spans lines/);
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
    // up: no file carries doadmin at all. `stage-target doadmin` is the only place its password exists.
    const writeEnv = source.slice(source.indexOf("function writeEnvFiles"), source.indexOf("/** `expectedKind` null"));
    expect(writeEnv).not.toMatch(/passwords\.doadmin/);
    expect(writeEnv).toContain("rm_owner: passwords.rm_owner");
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

  test("rm_owner keeps the attribute line of the dump's globals (production's logs in since role-passwords)", () => {
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

  test("the passwords are set for the five roles and change no login attribute", () => {
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

  test("the restored database: ledger equal to the baseline, the identity row, rm_owner LOGIN, TLS on", () => {
    const baseline = ["0001_a.sql", "0081_deployment_identity.sql"];
    const ok = { ledger: "2", identity_table: "deployment_identity", identity_kind: "production", rm_owner_login: "true", doadmin_super: "false", doadmin_createrole: "true", ssl: "on" };
    // Straight from the dump: the row reads production and no kind is demanded yet.
    expect(restoredDatabaseProblems(ok, baseline, baseline, null)).toEqual([]);
    // After the enrollment the copy must read rehearsal, never production.
    expect(restoredDatabaseProblems({ ...ok, identity_kind: "rehearsal" }, baseline, baseline, STAGE_TARGET.identityKind)).toEqual([]);
    expect(restoredDatabaseProblems(ok, baseline, baseline, STAGE_TARGET.identityKind)).toEqual(["deployment_identity reads production; the stage target is enrolled rehearsal"]);
    expect(restoredDatabaseProblems({ ...ok, identity_table: "none" }, baseline, baseline, null)).toHaveLength(1);
    expect(restoredDatabaseProblems({ ...ok, rm_owner_login: "false" }, baseline, baseline, null)).toHaveLength(1);
    expect(restoredDatabaseProblems({ ...ok, ledger: "3" }, [...baseline, "0116_x.sql"], baseline, null)).toHaveLength(2);
  });

  test("the provisioning run re-applies 0053 with no ledger row, then rm_readonly's sequence grants", () => {
    const s = provisionTaxonomyScript("SELECT 53;");
    expect(s.startsWith("SELECT 53;")).toBe(true);
    expect(s).not.toContain("schema_migrations");
    expect(s).not.toContain("SET LOCAL ROLE");
    expect(s).toContain("GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_readonly;");
  });

});

describe("the capture checkout is the release runner's, never the stage target's", () => {
  const keep = [CAPTURE_CHECKOUT.checkout];

  test("the stage target's folders and the capture checkout are distinct, and none holds it", () => {
    const own = [...stageTargetDirs(), STAGE_TARGET.referenceClone, STAGE_TARGET.toolDir];
    for (const dir of own) {
      expect(dir).not.toBe(CAPTURE_CHECKOUT.checkout);
      expect(CAPTURE_CHECKOUT.checkout.startsWith(`${dir}/`)).toBe(false);
    }
    expect(STAGE_TARGET.host).toBe(CAPTURE_CHECKOUT.host);
    expect(STAGE_TARGET.repoUrl).toBe(RELEASE_REPO_URL);
  });

  test("down removes its own folders and refuses the capture checkout or a folder holding it", () => {
    for (const dir of stageTargetDirs(["/home/stage-server/rm-stage-legacy.v0.6.0-retired"])) {
      expect(removalRefusal(dir, ["/home/stage-server/rm-stage-legacy.v0.6.0-retired"], keep)).toBeUndefined();
    }
    expect(removalRefusal(CAPTURE_CHECKOUT.checkout, [], keep)).toBe("refusing to remove /home/stage-server/rm-capture: not a stage-target path");
    // Even if a future edit listed it (or its parent) as a stage-target folder, the keep list refuses it.
    expect(removalRefusal(CAPTURE_CHECKOUT.checkout, [CAPTURE_CHECKOUT.checkout], keep)).toBe(
      "refusing to remove /home/stage-server/rm-capture: it holds /home/stage-server/rm-capture, the release runner's capture checkout",
    );
    expect(removalRefusal("/home/stage-server", ["/home/stage-server"], keep)).toContain("it holds /home/stage-server/rm-capture");
  });
});
