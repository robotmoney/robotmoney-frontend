// The pure half of the stage target (scripts/release/stage-target-lib.ts, D61
// rule 2): the env file carries production's key names, a captured globals
// file becomes DigitalOcean's role shape without its superusers, and the `up`
// plan replays the dump's own ledger at the tag and commit production reports,
// with no past-upgrade constant in the tool (issue 1272).
import { describe, expect, test } from "bun:test";

import { parseEnvFile } from "../../lib/env-role.ts";
import {
  bindDatabase,
  composeStageHomeEnv,
  connectionLimitArgs,
  parseConnectionLimitsFlag,
  parseProductionLimits,
  doadminPasswordSql,
  envKeyNames,
  fingerprintDiff,
  globalsToRoleSql,
  parseRunningVersion,
  pgHbaConf,
  replayMigrationScript,
  restoredProblems,
  removalRefusal,
  stageTargetDirs,
  PROD_HOME_ENV_KEYS,
  roleShapeProblems,
  rolePasswordSql,
  STAGE_TARGET,
  upPlan,
  type StageHomeEnv,
} from "../../release/stage-target-lib.ts";
import { CAPTURE_CHECKOUT } from "../../release/target.ts";
import { RELEASE_REPO_URL } from "../../release/steps.ts";

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

  test("it carries the extras the env rewrite (C07-env-rewrite) must move aside", () => {
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

describe("stage doadmin is stored in no release file (D61, owner 2026-10-08)", () => {
  test("`stage-target doadmin` sets one statement through psql's stdin and prints only the password; up writes doadmin into no file", async () => {
    expect(doadminPasswordSql("p'w")).toBe("ALTER ROLE doadmin PASSWORD 'p''w';\n");
    expect(() => doadminPasswordSql("")).toThrow(/doadmin/);
    const source = await Bun.file(new URL("../../release/stage-target.ts", import.meta.url)).text();
    const doadmin = source.slice(source.indexOf("function remoteDoadmin"), source.indexOf("// The control machine"));
    expect(doadmin).toContain("psql(doadminPasswordSql(password), { secret: true })");
    expect(doadmin).not.toMatch(/writeFileSync|appendFileSync|console\.log|log\(/);
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

  test("restored state: the ledger equals what the replay applied, the identity table exists, TLS on", () => {
    const replayed = ["0001_a.sql", "0002_b.sql"];
    const ok = { ledger: "2", identity_table: "public.deployment_identity", rm_owner_login: "false", doadmin_super: "false", doadmin_createrole: "true", ssl: "on" };
    expect(restoredProblems(ok, replayed, replayed)).toEqual([]);
    expect(restoredProblems({ ...ok, rm_owner_login: "true" }, replayed, replayed)).toEqual([]);
    // red controls: a count that disagrees with the names read, a replayed file the ledger lacks, a missing identity table.
    expect(restoredProblems({ ...ok, ledger: "3" }, replayed, replayed)).toHaveLength(1);
    expect(restoredProblems(ok, replayed, [...replayed, "0003_c.sql"]).join()).toContain("ledger lacks 0003_c.sql");
    expect(restoredProblems({ ...ok, identity_table: "none" }, replayed, replayed).join()).toContain("deployment_identity is absent");
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

describe("the replay and the up plan (issue 1272)", () => {
  test("a ledger file runs as the migrate applied it: SET LOCAL ROLE rm_owner from 0054 on", () => {
    expect(replayMigrationScript("0053_database_role_taxonomy.sql", "SELECT 1;")).not.toContain("SET LOCAL ROLE");
    const s = replayMigrationScript("0054_rm_worker_allowlist.sql", "SELECT 1;");
    expect(s.startsWith("SET LOCAL ROLE rm_owner;")).toBe(true);
    expect(s).toContain("INSERT INTO schema_migrations (name) VALUES ('0054_rm_worker_allowlist.sql');");
  });

  const SHA = "a502de30068e0c1cc2e232a76098364e0b709033";
  /** A fixture dump manifest: the dump's ledger in applied order (0081 first at the cutover), and what production reports. */
  const manifest = {
    ledger: ["0001_a.sql", "0002_b.sql", "0081_deployment_identity.sql", "0082_c.sql", "0083_d.sql"],
    running: { commit: SHA, tag: "v0.6.0" },
  };
  const repo = ["0001_a.sql", "0002_b.sql", "0081_deployment_identity.sql", "0082_c.sql", "0083_d.sql", "0084_pending.sql"];

  test("the up plan replays exactly the manifest's filenames, in its order, and detaches at the reported tag", () => {
    const plan = upPlan(manifest, repo);
    expect("errors" in plan).toBe(false);
    if ("errors" in plan) return;
    expect(plan.replay).toEqual(manifest.ledger);
    expect(plan.ref).toBe("v0.6.0");
    expect(plan.commit).toBe(SHA);
    // An untagged boot detaches at the commit.
    const untagged = upPlan({ ...manifest, running: { commit: SHA, tag: null } }, repo);
    expect("errors" in untagged ? undefined : untagged.ref).toBe(SHA);
    // Red controls: a ledger name the running checkout lacks, an empty ledger.
    expect(upPlan({ ...manifest, ledger: [...manifest.ledger, "0999_x.sql"] }, repo)).toHaveProperty("errors");
    expect(upPlan({ ...manifest, ledger: [] }, repo)).toHaveProperty("errors");
    // A skipped number is not judged (D67): the dump's ledger is replayed as it is.
    const skipped = upPlan({ ...manifest, ledger: ["0001_a.sql", "0083_d.sql"] }, repo);
    expect("errors" in skipped ? skipped.errors : skipped.replay).toEqual(["0001_a.sql", "0083_d.sql"]);
  });

  test("/api/version is read for the running commit and tag; a dirty or short commit refuses", () => {
    expect(parseRunningVersion(JSON.stringify({ api: "1.0.0", commit: SHA, tag: "v0.6.0" }))).toEqual({ commit: SHA, tag: "v0.6.0" });
    expect(parseRunningVersion(JSON.stringify({ commit: SHA, tag: null }))).toEqual({ commit: SHA, tag: null });
    expect(parseRunningVersion(JSON.stringify({ commit: `${SHA}+dirty` }))).toHaveProperty("error");
    expect(parseRunningVersion(JSON.stringify({ commit: "abc" }))).toHaveProperty("error");
    expect(parseRunningVersion(null)).toHaveProperty("error");
    expect(parseRunningVersion("<html>")).toHaveProperty("error");
  });

  test("STAGE_TARGET holds no past-upgrade constant: no legacy commit or checkout, no driver log, no fixed migration list", () => {
    const keys = Object.keys(STAGE_TARGET);
    for (const gone of ["legacyCommit", "legacyCheckout", "legacyProject", "driverSession", "driverLog", "checkoutCommit", "baselineFile", "legacyWebPort"]) {
      expect(keys).not.toContain(gone);
    }
    for (const [k, v] of Object.entries(STAGE_TARGET)) {
      expect(Array.isArray(v), k).toBe(false);
      if (typeof v === "string") {
        expect(v, k).not.toMatch(/^[0-9a-f]{40}$/);
        expect(v, k).not.toMatch(/v0\.5\.4|smoke-archive|tmux/);
      }
    }
    expect(STAGE_TARGET.runningCheckout).not.toBe(STAGE_TARGET.checkout);
    expect(STAGE_TARGET.productionOrigin).toBe("https://robotmoney.network");
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

  test("down removes its own folders and refuses the capture checkout", () => {
    expect(stageTargetDirs()).toEqual([STAGE_TARGET.home, STAGE_TARGET.checkout, STAGE_TARGET.runningCheckout]);
    for (const dir of stageTargetDirs()) expect(removalRefusal(dir, keep)).toBeUndefined();
    expect(removalRefusal(CAPTURE_CHECKOUT.checkout, keep)).toBe("refusing to remove /home/stage-server/rm-capture: not a stage-target path");
    expect(removalRefusal("/home/stage-server", keep)).toBe("refusing to remove /home/stage-server: not a stage-target path");
    // The keep rule itself: a stage-target folder that held the capture checkout would refuse.
    expect(removalRefusal(STAGE_TARGET.home, [`${STAGE_TARGET.home}/rm-capture`])).toContain("it holds");
  });
});

// ── issue 1514: the stage Postgres carries production's connection limits, so the stage api derives production's budget ──
describe("the stage Postgres's connection limits", () => {
  const health = (budget: unknown) => JSON.stringify({ ok: true, db_pool: { request: {}, batch: {}, budget } });

  test("are read from production's /health db_pool.budget", () => {
    expect(parseProductionLimits(health({ maxConnections: 25, superuserReserved: 3, reserved: 0, headroom: 10, available: 12, guard: 1, request: 6, batch: 5 })))
      .toEqual({ maxConnections: 25, superuserReserved: 3, reserved: 0 });
    // red: no answer, no budget, a budget that cannot be a server's.
    expect(parseProductionLimits(null)).toEqual({ error: "no /health answer" });
    expect(parseProductionLimits("<html>")).toEqual({ error: "/health is not JSON" });
    expect(parseProductionLimits(JSON.stringify({ ok: true, db_pool: null }))).toEqual({ error: "/health carries no db_pool.budget" });
    expect(parseProductionLimits(health({ maxConnections: 3, superuserReserved: 3, reserved: 0 }))).toHaveProperty("error");
    expect(parseProductionLimits(health({ maxConnections: "x", superuserReserved: 3, reserved: 0 }))).toHaveProperty("error");
  });

  test("or set by hand, as <max>/<superuser_reserved>/<reserved>", () => {
    expect(parseConnectionLimitsFlag("25/3/0")).toEqual({ maxConnections: 25, superuserReserved: 3, reserved: 0 });
    expect(parseConnectionLimitsFlag("25")).toHaveProperty("error");
    expect(parseConnectionLimitsFlag("3/3/0")).toHaveProperty("error");
  });

  test("become the Postgres server's settings", () => {
    expect(connectionLimitArgs({ maxConnections: 25, superuserReserved: 3, reserved: 2 }))
      .toEqual(["-c", "max_connections=25", "-c", "superuser_reserved_connections=3", "-c", "reserved_connections=2"]);
  });
});
