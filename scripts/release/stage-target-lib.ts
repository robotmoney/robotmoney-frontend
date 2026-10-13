// The pure half of scripts/release/stage-target.ts (D61 rule 2).
//
// WHAT IT IS. Everything the stage-target builder decides that can be decided
// without a host: where each piece lives, which key names the `~/.env` carries,
// which role statements a captured `pg_dumpall --globals-only` becomes, the
// pg_hba rules, the SQL that copies ownership and grants from a reference
// database, and the plan `up` builds from a dump. stage-target.ts does the
// I/O; scripts/tests/unit/stage-target.test.ts drives these directly.
//
// WHY A STAGE TARGET. D61 rule 2: the production runbook is rehearsed
// unmodified on stage. Only the target file differs. So stage must hold what
// production holds before the next patch: a remote Postgres 18 over TLS with
// DigitalOcean's role shape, the dump's own ledger and identity row (enrolled
// rehearsal), a `~/.env` with production's key names, and the stack production
// runs, booted the production way (`bun smoke --static-port`) from a checkout
// at the tag and commit production's /api/version reports. No constant below
// names a past upgrade: no previous commit, no fixed ledger, no driver script
// (issue 1272). Each constant names the production fact it mirrors.
import PROD_TARGET_FILE from "./targets/prod.json";
import { STAGE_WEB_PORT } from "../stack/ports.ts";
import { ledgerNotInRepo } from "./ledger.ts";

/** Where the target lives on stage-2. These are the release target file's fields. */
export const STAGE_TARGET = {
  /** The ssh alias of the stage host. */
  host: "rm-frontend-stage-2",
  /** The unprivileged deploying user on the stage host. */
  user: "stage-server",
  /** `$HOME` for every release tool on this target. Production's is `/root`. */
  home: "/home/stage-server/stage-target",
  /** The release checkout: R1.1 clones it at the go's ref. `up` never creates it; `down` removes it. */
  checkout: "/home/stage-server/rm-stage-target",
  /**
   * The checkout the running stack boots from, at the tag and commit
   * production reports (`up` reads them from production's /api/version).
   * Production's is the previous release's checkout (`/root/rm-0NN`).
   */
  runningCheckout: "/home/stage-server/rm-stage-running",
  /** The smoke instance. Production's is `rm_prod`. */
  instance: "stage_target",
  /** The long-lived Postgres container and its named data volume. */
  pgContainer: "rm-stage-target-pg",
  pgVolume: "rm-stage-target-pgdata",
  /**
   * Where the database listens. The Docker bridge gateway: reachable from this
   * host and from every compose network on it, never from outside. smoke treats
   * it as remote (scripts/lib/smoke-identity.ts), as it treats a managed host.
   */
  pgBindHost: "172.17.0.1",
  /** DigitalOcean's direct (non-pooler) port, the one production's `~/.env` names. */
  pgPort: 25060,
  /** DigitalOcean's database name. */
  database: "defaultdb",
  /** The container superuser. Only stage-target.ts uses it, over the container's local socket. */
  superuser: "rm_stage_super",
  /** The scratch database the dump's ledger is replayed into, dropped afterwards. */
  referenceDatabase: "rm_stage_acl_ref",
  /** The fixed web port a `--static-port` boot pins (scripts/stack/ports.ts). */
  webPort: STAGE_WEB_PORT,
  /** The label on everything stage-target.ts creates outside compose. */
  label: "robotmoney.stage-target=1",
  /** Where the control machine copies the bundled tool on the host. */
  toolDir: "/home/stage-server/.cache/stage-target",
  /** A local checkout on the host to borrow objects from when cloning. */
  referenceClone: "/home/stage-server/rm-060",
  /** The repository. */
  repoUrl: "git@github.com:robotmoney/robotmoney-frontend.git",
  /** Production's public origin: `up` reads the running tag and commit from its /api/version (the prod target file). */
  productionOrigin: PROD_TARGET_FILE.publicOrigin,
  /** The longest a dump may have been captured before `up` (runbook §7, fresh-dump rule). */
  maxDumpAgeHours: 24,
} as const;

/** What production reports about the stack it runs, read by `up` from `/api/version`. */
export interface RunningVersion {
  readonly commit: string;
  /** The release tag the boot carried (RM_BUILD_TAG), or null for an untagged boot. */
  readonly tag: string | null;
}

/** PURE. Every reason a `/api/version` body does not name a running commit. */
export function parseRunningVersion(text: string | null): RunningVersion | { error: string } {
  if (text === null) return { error: "/api/version did not answer 200" };
  let body: { commit?: unknown; tag?: unknown };
  try { body = JSON.parse(text) as { commit?: unknown; tag?: unknown }; } catch { return { error: "/api/version is not JSON" }; }
  if (typeof body.commit !== "string" || !/^[0-9a-f]{40}$/.test(body.commit)) return { error: `/api/version commit is ${String(body.commit)}, not a 40-hex sha` };
  if (/\+(dirty|unknown)/.test(text)) return { error: "/api/version carries +dirty or +unknown: production does not run a pushed commit" };
  const tag = typeof body.tag === "string" && /^v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(body.tag) ? body.tag : null;
  return { commit: body.commit, tag };
}

/** What `up` reads from the dump and from production, before it decides anything. */
export interface DumpManifest {
  /** The dump's own ledger, in the order it was applied (`schema_migrations` by applied_at, then name). */
  readonly ledger: readonly string[];
  /** Production's running commit and tag, from /api/version. */
  readonly running: RunningVersion;
}

/** The plan `up` follows: PURE, so a fixture manifest proves it replays the dump's own ledger and nothing else. */
export interface UpPlan {
  /** The ref the running checkout detaches at: the tag production reports, else its commit. */
  readonly ref: string;
  readonly commit: string;
  /** The ledger files the reference replay applies, in the dump's order. */
  readonly replay: readonly string[];
}

/**
 * PURE. The plan from a dump manifest. The replay is exactly the manifest's
 * ledger, in its order: never a constant list, never a split typed in from a
 * past upgrade. `repo` is the running checkout's backend/migrations; a ledger
 * name it lacks refuses, because the replay could not read that file. A gap
 * in the numbers is not judged (D66): the dump's ledger is replayed as it is.
 */
export function upPlan(manifest: DumpManifest, repo: readonly string[]): UpPlan | { errors: string[] } {
  const unknown = ledgerNotInRepo(manifest.ledger, repo);
  const errors = unknown.length === 0 ? [] : [`the running checkout at ${manifest.running.commit.slice(0, 8)} lacks ${unknown.length} ledger file(s) the replay would read: ${unknown.join(", ")}`];
  if (manifest.ledger.length === 0) errors.push("the dump's ledger is empty");
  if (errors.length > 0) return { errors };
  return { ref: manifest.running.tag ?? manifest.running.commit, commit: manifest.running.commit, replay: [...manifest.ledger] };
}

/**
 * PURE. The folders the stage target owns: `up` creates the home and the
 * running checkout, `down` (and `up --replace`) removes them and the release
 * checkout R1.1 made. The release runner's capture checkout (CAPTURE_CHECKOUT,
 * ./target.ts) is never one of them.
 */
export function stageTargetDirs(): string[] {
  return [STAGE_TARGET.home, STAGE_TARGET.checkout, STAGE_TARGET.runningCheckout];
}

/**
 * PURE. Why `down` may not remove `dir`, or undefined when it may. It removes
 * only its own folders, and never a folder in `keep` or one holding it (the
 * capture checkout the release runner owns).
 */
export function removalRefusal(dir: string, keep: readonly string[]): string | undefined {
  if (!stageTargetDirs().includes(dir)) return `refusing to remove ${dir}: not a stage-target path`;
  for (const k of keep) {
    if (k === dir || k.startsWith(`${dir}/`)) return `refusing to remove ${dir}: it holds ${k}, the release runner's capture checkout`;
  }
  return undefined;
}

/**
 * The key names of production's `~/.env` (`/root/.env`), in file order, read
 * from the prod host on 2026-10-08 with `cut -d= -f1`. The env rewrite (R6.2)
 * moves `SWARM_SCHEDULES_ENABLED` and `OPENCODE_API_KEY` aside, so the stage
 * file carries them too and the rehearsal exercises that move.
 */
export const PROD_HOME_ENV_KEYS = [
  "rm_app",
  "rm_worker",
  "rm_readonly",
  "SWARM_SCHEDULES_ENABLED",
  "host",
  "port",
  "database",
  "sslmode",
  "OPENCODE_API_KEY",
  "COINGECKO_API_KEY",
] as const;

/**
 * The stage `~/.env` holds production's key names and nothing more: no
 * `rm_owner` line (production's pre-state: `prod-init role-passwords` writes
 * it) and never `doadmin` (D61, owner 2026-10-08: doadmin is typed each run
 * and stored in no file).
 */
export type StageHomeEnvKey = (typeof PROD_HOME_ENV_KEYS)[number];
export type StageHomeEnv = Record<StageHomeEnvKey, string>;

/** The login roles whose passwords the builder generates. `rm_owner` gets one too, and stays NOLOGIN. */
export const GENERATED_PASSWORD_ROLES = ["doadmin", "rm_owner", "rm_app", "rm_worker", "rm_readonly"] as const;
export type GeneratedPasswordRole = (typeof GENERATED_PASSWORD_ROLES)[number];

function assertLineValue(key: string, value: string | undefined): string {
  if (value === undefined || value === "") throw new Error(`stage-target: no value for ${key}`);
  if (/[\r\n]/.test(value)) throw new Error(`stage-target: the value for ${key} spans lines`);
  return value;
}

/**
 * The stage target's `~/.env`. Production's layout, line for line: the same
 * comment headers, the same `key = value` spacing on the DigitalOcean panel
 * keys, the same order. No `rm_owner` line and no `doadmin` line: role-passwords
 * adds the first, and the second is never stored.
 */
export function composeStageHomeEnv(v: StageHomeEnv): string {
  const line = (key: StageHomeEnvKey, sep: " = " | "=") => `${key}${sep}${assertLineValue(key, v[key])}`;
  return [
    "# postgres",
    line("rm_app", " = "),
    line("rm_worker", " = "),
    line("rm_readonly", " = "),
    line("SWARM_SCHEDULES_ENABLED", "="),
    line("host", " = "),
    line("port", " = "),
    line("database", " = "),
    line("sslmode", " = "),
    "",
    "# inference",
    line("OPENCODE_API_KEY", "="),
    "",
    "# research",
    line("COINGECKO_API_KEY", "="),
    "",
  ].join("\n");
}

/** A postgres URL. Never logged: it carries a password. */
export function postgresUrl(role: string, password: string, host: string, port: number | string, database: string, sslmode: string): string {
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslmode}`;
}

/** The key names a `.env` text defines, in order. Values are never returned. */
export function envKeyNames(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    keys.push(line.slice(0, eq).replace(/^export\s+/, "").trim());
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const ROLE_NAME = String.raw`("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;

function unquoteRole(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

export interface RoleSqlResult {
  /** The statements, idempotent: run before and after the reference replay. */
  readonly sql: string;
  /** The roles it creates, in globals order. */
  readonly roles: readonly string[];
  /** The roles it leaves out, with the reason. */
  readonly skipped: readonly string[];
}

/**
 * What a captured `pg_dumpall --globals-only --no-role-passwords` becomes on
 * the stage cluster.
 *
 * Kept: every role that is not a superuser, with its exact attribute line
 * (doadmin is `NOSUPERUSER CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS` on
 * DigitalOcean), its comment, and every membership between kept roles and the
 * built-in `pg_*` roles. A membership production records as `GRANTED BY
 * postgres` is granted by this cluster's bootstrap superuser instead, which is
 * the same authority. `GRANTED BY doadmin` stays as it is.
 *
 * Left out: the superusers (`postgres`, `_dodb`), which belong to the platform
 * and which no release tool may hold; per-role settings (`ALTER ROLE … SET`),
 * which name DigitalOcean's extension parameters; parameter grants on
 * extension parameters (`anon.*`, `pgaudit.*`), which do not exist here.
 *
 * Idempotent: a role that exists is altered, not recreated, so the statements
 * also restore the attribute lines after the reference replay (whose migration
 * 0053 sets `rm_owner LOGIN` cluster-wide).
 */
export function globalsToRoleSql(globals: string): RoleSqlResult {
  const createRe = new RegExp(`^CREATE ROLE ${ROLE_NAME};$`);
  const alterWithRe = new RegExp(`^ALTER ROLE ${ROLE_NAME} WITH (.+);$`);
  const commentRe = new RegExp(`^COMMENT ON ROLE ${ROLE_NAME} IS .+;$`);
  const grantRoleRe = new RegExp(`^GRANT ${ROLE_NAME} TO ${ROLE_NAME}(.*?)(?: GRANTED BY ${ROLE_NAME})?;$`);
  const grantParamRe = /^GRANT SET ON PARAMETER ("?)([^" ]+)\1 TO .+;$/;

  const lines = globals.split("\n").map((l) => l.trimEnd());
  const roles: string[] = [];
  const attrs = new Map<string, string>();
  for (const line of lines) {
    const c = createRe.exec(line);
    if (c) roles.push(unquoteRole(c[1]!));
    const a = alterWithRe.exec(line);
    if (a) attrs.set(unquoteRole(a[1]!), a[2]!);
  }
  const superusers = new Set(
    roles.filter((r) => (attrs.get(r) ?? "").split(/\s+/).includes("SUPERUSER")),
  );
  const kept = roles.filter((r) => !superusers.has(r));
  const keptSet = new Set(kept);
  const known = (r: string) => keptSet.has(r) || r.startsWith("pg_");

  const out: string[] = [];
  for (const role of kept) {
    out.push(
      `DO $rm_role$ BEGIN CREATE ROLE ${quoteIdent(role)}; EXCEPTION WHEN duplicate_object THEN NULL; END $rm_role$;`,
    );
  }
  for (const role of kept) {
    const a = attrs.get(role);
    if (a) out.push(`ALTER ROLE ${quoteIdent(role)} WITH ${a};`);
  }
  for (const line of lines) {
    const c = commentRe.exec(line);
    if (c && keptSet.has(unquoteRole(c[1]!))) out.push(line);
  }
  for (const line of lines) {
    const g = grantRoleRe.exec(line);
    if (g) {
      const granted = unquoteRole(g[1]!);
      const member = unquoteRole(g[2]!);
      const options = g[3] ?? "";
      const grantor = g[4] ? unquoteRole(g[4]) : undefined;
      if (!known(granted) || !keptSet.has(member)) continue;
      const by = grantor && keptSet.has(grantor) ? ` GRANTED BY ${quoteIdent(grantor)}` : "";
      out.push(`GRANT ${quoteIdent(granted)} TO ${quoteIdent(member)}${options}${by};`);
      continue;
    }
    const p = grantParamRe.exec(line);
    if (p && !p[2]!.includes(".")) {
      const target = /TO ([^ ;]+)/.exec(line)?.[1];
      if (target && keptSet.has(unquoteRole(target))) out.push(line);
    }
  }
  return {
    sql: `${out.join("\n")}\n`,
    roles: kept,
    skipped: [...superusers].map((r) => `${r} (superuser: platform-owned on DigitalOcean)`),
  };
}

/**
 * The generated passwords. `rm_owner` keeps its NOLOGIN attribute: production's
 * `rm_owner` has a password nobody holds and cannot log in until
 * `prod-init role-passwords` (run before `release:run`) sets one. Never logged.
 */
export function rolePasswordSql(passwords: Record<GeneratedPasswordRole, string>): string {
  return `${GENERATED_PASSWORD_ROLES.map((r) => `ALTER ROLE ${r} PASSWORD ${sqlLiteral(assertLineValue(r, passwords[r]))};`).join("\n")}\n`;
}

/** `stage-target doadmin`: the stage doadmin's fresh password, as one statement. Never logged. */
export function doadminPasswordSql(password: string): string {
  return `ALTER ROLE doadmin PASSWORD ${sqlLiteral(assertLineValue("doadmin", password))};\n`;
}

/** The shape production holds before the cutover, checked after every build. */
export const EXPECTED_ROLE_SHAPE = {
  doadmin: { super: false, createrole: true, createdb: true, login: true },
  // Either: NOLOGIN since 0053, or LOGIN once `role-passwords` ran on production
  // before its dump (2026-10-08). The restored globals carry production's value.
  rm_owner: { super: false, createrole: false, createdb: false, login: null },
  rm_app: { super: false, createrole: false, createdb: false, login: true },
  rm_worker: { super: false, createrole: false, createdb: false, login: true },
  rm_readonly: { super: false, createrole: false, createdb: false, login: true },
} as const;

/** One row per role: `name|super|createrole|createdb|login|haspassword`. */
export const ROLE_SHAPE_QUERY = `
SELECT rolname || '|' || rolsuper || '|' || rolcreaterole || '|' || rolcreatedb || '|' || rolcanlogin || '|' || (rolpassword IS NOT NULL)
FROM pg_authid WHERE rolname IN ('doadmin','rm_owner','rm_app','rm_worker','rm_readonly') ORDER BY rolname;`;

/** The app roles doadmin must administer (DigitalOcean grants ADMIN on each). */
export const DOADMIN_ADMIN_OVER = ["rm_owner", "rm_app", "rm_worker", "rm_readonly"] as const;

export const DOADMIN_ADMIN_QUERY = `
SELECT DISTINCT r.rolname FROM pg_auth_members m
JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles mem ON mem.oid = m.member
WHERE mem.rolname = 'doadmin' AND m.admin_option ORDER BY 1;`;

/** Compare the role rows with {@link EXPECTED_ROLE_SHAPE}. Returns the problems. */
export function roleShapeProblems(rows: string, adminOver: string): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string[]>();
  for (const row of rows.split("\n").map((r) => r.trim()).filter(Boolean)) {
    const [name, ...rest] = row.split("|");
    seen.set(name!, rest);
  }
  for (const [role, want] of Object.entries(EXPECTED_ROLE_SHAPE)) {
    const got = seen.get(role);
    if (!got) {
      problems.push(`${role} is missing`);
      continue;
    }
    const [sup, createrole, createdb, login, hasPassword] = got.map((v) => v === "t" || v === "true");
    if (sup !== want.super) problems.push(`${role} rolsuper=${sup}, production has ${want.super}`);
    if (createrole !== want.createrole) problems.push(`${role} rolcreaterole=${createrole}, production has ${want.createrole}`);
    if (createdb !== want.createdb) problems.push(`${role} rolcreatedb=${createdb}, production has ${want.createdb}`);
    if (want.login !== null && login !== want.login) problems.push(`${role} rolcanlogin=${login}, production has ${want.login}`);
    if (!hasPassword) problems.push(`${role} has no password`);
  }
  const admin = new Set(adminOver.split("\n").map((r) => r.trim()).filter(Boolean));
  for (const role of DOADMIN_ADMIN_OVER) {
    if (!admin.has(role)) problems.push(`doadmin holds no ADMIN OPTION on ${role}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// TLS and authentication
// ---------------------------------------------------------------------------

/**
 * The cluster's pg_hba.conf. Like DigitalOcean: every network connection must
 * use TLS and a password. Unlike it: the container superuser may not connect
 * over the network at all, only through `docker exec` on the local socket.
 */
export function pgHbaConf(superuser: string): string {
  return [
    "# GENERATED by scripts/release/stage-target.ts. TLS for every network login.",
    "local   all   all                    trust",
    `hostssl all   ${superuser}   all     reject`,
    "hostnossl all all             all     reject",
    "hostssl all   all             all     scram-sha-256",
    "",
  ].join("\n");
}

/** Postgres TLS settings, applied with ALTER SYSTEM and a reload. */
export function tlsSettingsSql(certFile: string, keyFile: string): string {
  return [
    `ALTER SYSTEM SET ssl = on;`,
    `ALTER SYSTEM SET ssl_cert_file = ${sqlLiteral(certFile)};`,
    `ALTER SYSTEM SET ssl_key_file = ${sqlLiteral(keyFile)};`,
    `SELECT pg_reload_conf();`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Ownership and grants
// ---------------------------------------------------------------------------

/**
 * Why a reference database. `bun smoke:capture` dumps with `--no-owner
 * --no-privileges`, so the archive carries no owner and no grant. Production's
 * owners and grants are what its ledger files left, reconciled by
 * backend/schema/grants.sql at the end of every migrate. The builder replays
 * the dump's own ledger, from the running checkout, in a scratch database the
 * way the migrate applied them (as doadmin, `SET LOCAL ROLE rm_owner` from
 * 0054 on, then the grants reconcile), and copies the result onto the restored
 * copy with the statements this query prints. Run it in the scratch database.
 * Each output row is one statement.
 *
 * It covers the `public` schema, every relation, column grant, routine and
 * user-defined type in it, the database itself, and the default privileges.
 * Extension members are left to their extension.
 */
export const ACL_EXPORT_SQL = String.raw`
WITH
privs AS (
  SELECT * FROM (VALUES
    ('r','TABLE'),('p','TABLE'),('v','TABLE'),('m','TABLE'),('f','TABLE'),('S','SEQUENCE')) v(relkind, grant_kind)
),
alter_kind AS (
  SELECT * FROM (VALUES
    ('r','TABLE'),('p','TABLE'),('v','VIEW'),('m','MATERIALIZED VIEW'),('f','FOREIGN TABLE'),('S','SEQUENCE')) v(relkind, alter_kw)
),
rels AS (
  SELECT c.oid, c.relkind::text AS relkind, format('public.%I', c.relname) AS ident, c.relowner,
         COALESCE(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner)) AS acl,
         EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a','i')) AS linked
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m','f')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
),
routines AS (
  SELECT p.oid, p.oid::regprocedure::text AS ident, p.proowner,
         COALESCE(p.proacl, acldefault('f'::"char", p.proowner)) AS acl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
),
types AS (
  SELECT t.oid, format('public.%I', t.typname) AS ident, t.typowner, t.typtype
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public'
    AND (t.typtype IN ('e','d','r') OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
),
grantee AS (
  SELECT 0::oid AS oid, 'PUBLIC' AS name
  UNION ALL SELECT oid, quote_ident(rolname) FROM pg_roles
),
stmts AS (
  -- 1. the database
  SELECT 10 AS ord, '' AS k, format('ALTER DATABASE %I OWNER TO %I;', '@DATABASE@', pg_get_userbyid(d.datdba)) AS s
  FROM pg_database d WHERE d.datname = current_database()
  UNION ALL
  SELECT 11, '', format('REVOKE ALL ON DATABASE %I FROM PUBLIC, %I;', '@DATABASE@', pg_get_userbyid(d.datdba))
  FROM pg_database d WHERE d.datname = current_database()
  UNION ALL
  SELECT 12, a.privilege_type, format('GRANT %s ON DATABASE %I TO %s%s;', a.privilege_type, '@DATABASE@', g.name,
         CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
  FROM pg_database d, aclexplode(COALESCE(d.datacl, acldefault('d'::"char", d.datdba))) a JOIN grantee g ON g.oid = a.grantee
  WHERE d.datname = current_database()
  UNION ALL
  -- 2. the public schema
  SELECT 20, '', format('ALTER SCHEMA public OWNER TO %I;', pg_get_userbyid(n.nspowner)) FROM pg_namespace n WHERE n.nspname = 'public'
  UNION ALL
  SELECT 21, '', format('REVOKE ALL ON SCHEMA public FROM PUBLIC, pg_database_owner, %I;', pg_get_userbyid(n.nspowner))
  FROM pg_namespace n WHERE n.nspname = 'public'
  UNION ALL
  SELECT 22, a.privilege_type, format('GRANT %s ON SCHEMA public TO %s%s;', a.privilege_type, g.name,
         CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
  FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n'::"char", n.nspowner))) a JOIN grantee g ON g.oid = a.grantee
  WHERE n.nspname = 'public'
  UNION ALL
  -- 3. types, then relations, then their grants
  SELECT 30, t.ident, format('ALTER %s %s OWNER TO %I;', CASE WHEN t.typtype = 'd' THEN 'DOMAIN' ELSE 'TYPE' END, t.ident, pg_get_userbyid(t.typowner))
  FROM types t
  UNION ALL
  SELECT 40, r.ident, format('ALTER %s %s OWNER TO %I;', k.alter_kw, r.ident, pg_get_userbyid(r.relowner))
  FROM rels r JOIN alter_kind k USING (relkind) WHERE NOT r.linked
  UNION ALL
  SELECT 41, r.ident, format('REVOKE ALL ON %s %s FROM PUBLIC, %I;', p.grant_kind, r.ident, pg_get_userbyid(r.relowner))
  FROM rels r JOIN privs p USING (relkind)
  UNION ALL
  SELECT 42, r.ident || a.privilege_type, format('GRANT %s ON %s %s TO %s%s;', a.privilege_type, p.grant_kind, r.ident, g.name,
         CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
  FROM rels r JOIN privs p USING (relkind), aclexplode(r.acl) a JOIN grantee g ON g.oid = a.grantee
  UNION ALL
  SELECT 43, r.ident || at.attname || a.privilege_type, format('GRANT %s (%I) ON TABLE %s TO %s%s;', a.privilege_type, at.attname, r.ident, g.name,
         CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
  FROM rels r JOIN pg_attribute at ON at.attrelid = r.oid AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL,
       aclexplode(at.attacl) a JOIN grantee g ON g.oid = a.grantee
  UNION ALL
  -- 4. routines
  SELECT 50, f.ident, format('ALTER ROUTINE %s OWNER TO %I;', f.ident, pg_get_userbyid(f.proowner)) FROM routines f
  UNION ALL
  SELECT 51, f.ident, format('REVOKE ALL ON ROUTINE %s FROM PUBLIC, %I;', f.ident, pg_get_userbyid(f.proowner)) FROM routines f
  UNION ALL
  SELECT 52, f.ident || a.privilege_type, format('GRANT %s ON ROUTINE %s TO %s%s;', a.privilege_type, f.ident, g.name,
         CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
  FROM routines f, aclexplode(f.acl) a JOIN grantee g ON g.oid = a.grantee
  UNION ALL
  -- 5. default privileges (every grantee but the defining role itself)
  SELECT 60, pg_get_userbyid(da.defaclrole) || da.defaclobjtype::text || a.privilege_type || g.name,
         format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s GRANT %s ON %s TO %s%s;',
           pg_get_userbyid(da.defaclrole),
           CASE WHEN da.defaclnamespace = 0 THEN '' ELSE ' IN SCHEMA ' || quote_ident(da.defaclnamespace::regnamespace::text) END,
           a.privilege_type,
           CASE da.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END,
           g.name, CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
  FROM pg_default_acl da, aclexplode(da.defaclacl) a JOIN grantee g ON g.oid = a.grantee
  WHERE a.grantee <> da.defaclrole
)
SELECT s FROM stmts ORDER BY ord, k, s;`;

/**
 * One line per owner and per effective grant, grantor left out, so the
 * reference database and the restored copy can be compared line for line.
 * Run it in each; the two outputs must be equal.
 */
export const ACL_FINGERPRINT_SQL = String.raw`
WITH grantee AS (SELECT 0::oid AS oid, 'PUBLIC' AS name UNION ALL SELECT oid, rolname FROM pg_roles),
rels AS (
  SELECT c.oid, c.relkind, c.relname, c.relowner,
         COALESCE(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner)) AS acl
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m','f')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
),
routines AS (
  SELECT p.oid::regprocedure::text AS ident, p.proowner, COALESCE(p.proacl, acldefault('f'::"char", p.proowner)) AS acl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
),
lines AS (
  SELECT 'database owner ' || pg_get_userbyid(datdba) AS l FROM pg_database WHERE datname = current_database()
  UNION ALL
  SELECT 'database grant ' || g.name || ' ' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END
  FROM pg_database d, aclexplode(COALESCE(d.datacl, acldefault('d'::"char", d.datdba))) a JOIN grantee g ON g.oid = a.grantee
  WHERE d.datname = current_database()
  UNION ALL
  SELECT 'schema public owner ' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'
  UNION ALL
  SELECT 'schema public grant ' || g.name || ' ' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END
  FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n'::"char", n.nspowner))) a JOIN grantee g ON g.oid = a.grantee
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'rel ' || r.relname || ' owner ' || pg_get_userbyid(r.relowner) FROM rels r
  UNION ALL
  SELECT 'rel ' || r.relname || ' grant ' || g.name || ' ' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END
  FROM rels r, aclexplode(r.acl) a JOIN grantee g ON g.oid = a.grantee
  UNION ALL
  SELECT 'col ' || r.relname || '.' || at.attname || ' grant ' || g.name || ' ' || a.privilege_type
  FROM rels r JOIN pg_attribute at ON at.attrelid = r.oid AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL,
       aclexplode(at.attacl) a JOIN grantee g ON g.oid = a.grantee
  UNION ALL
  SELECT 'routine ' || f.ident || ' owner ' || pg_get_userbyid(f.proowner) FROM routines f
  UNION ALL
  SELECT 'routine ' || f.ident || ' grant ' || g.name || ' ' || a.privilege_type FROM routines f, aclexplode(f.acl) a JOIN grantee g ON g.oid = a.grantee
  UNION ALL
  SELECT 'default ' || pg_get_userbyid(da.defaclrole) || ' ' || COALESCE(da.defaclnamespace::regnamespace::text, '-') || ' ' || da.defaclobjtype::text
         || ' grant ' || g.name || ' ' || a.privilege_type
  FROM pg_default_acl da, aclexplode(da.defaclacl) a JOIN grantee g ON g.oid = a.grantee
  WHERE a.grantee <> da.defaclrole
)
SELECT l FROM lines ORDER BY l COLLATE "C";`;

/** Put the target database's name into the exported statements. */
export function bindDatabase(statements: string, database: string): string {
  const quoted = quoteIdent(database);
  return statements.replaceAll('"@DATABASE@"', quoted).replaceAll("@DATABASE@", quoted);
}

/** Lines in one fingerprint and not the other. Empty both ways means a match. */
export function fingerprintDiff(reference: string, restored: string): { onlyReference: string[]; onlyRestored: string[] } {
  const a = new Set(reference.split("\n").filter(Boolean));
  const b = new Set(restored.split("\n").filter(Boolean));
  return {
    onlyReference: [...a].filter((l) => !b.has(l)),
    onlyRestored: [...b].filter((l) => !a.has(l)),
  };
}

/**
 * One ledger file as the migrate applied it: in one transaction, as the
 * connecting login, with `SET LOCAL ROLE rm_owner` from 0054 on (0053 created
 * the role), and its ledger row in the same transaction. psql runs it with
 * `-1`. The rule comes from the files' own content, not from a release.
 */
export function replayMigrationScript(file: string, ddl: string): string {
  const role = file >= "0054_rm_worker_allowlist.sql" ? "SET LOCAL ROLE rm_owner;\n" : "";
  return `${role}${ddl}\n;\nINSERT INTO schema_migrations (name) VALUES (${sqlLiteral(file)});\n`;
}

/** The reconciliation `bun run migrate` ends every run with, as the owner, outside any ledger row. */
export const GRANTS_RECONCILE_FILE = "backend/schema/grants.sql";

export function grantsReconcileScript(grantsSql: string): string {
  return `SET LOCAL ROLE rm_owner;\n${grantsSql}\n`;
}

/** A production dump carries its identity row (0081 is in its ledger). A stage target is never `production` (spec §4.2, D61). */
export const ENROLL_REHEARSAL_SQL = `UPDATE deployment_identity SET kind = 'rehearsal', written_at = now(), written_by = current_user,
  note = 'stage-target up: a restored production dump, enrolled rehearsal (D61 rule 2)' WHERE id;
SELECT 'identity_kind=' || string_agg(kind::text, ',') FROM deployment_identity;`;

export const LEDGER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);\n`;

/** The restored database's facts, one `key=value` per line. */
export const RESTORED_STATE_QUERY = `
SELECT 'ledger=' || (SELECT count(*) FROM schema_migrations)
UNION ALL SELECT 'identity_table=' || COALESCE(to_regclass('public.deployment_identity')::text, 'none')
UNION ALL SELECT 'rm_owner_login=' || (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner')
UNION ALL SELECT 'doadmin_super=' || (SELECT rolsuper FROM pg_roles WHERE rolname = 'doadmin')
UNION ALL SELECT 'doadmin_createrole=' || (SELECT rolcreaterole FROM pg_roles WHERE rolname = 'doadmin')
UNION ALL SELECT 'ssl=' || current_setting('ssl')
UNION ALL SELECT 'server_version=' || current_setting('server_version');`;

/** Parse `key=value` lines. */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * What `up` requires of the restored database before it writes any env file.
 * `ledger` is what the restored database records; `replayed` is what the
 * reference replay applied (the plan's list): the two must be the same set.
 * The identity table must exist: a production dump carries it, and `up`
 * enrolls it rehearsal.
 */
export function restoredProblems(state: Record<string, string>, ledger: readonly string[], replayed: readonly string[]): string[] {
  const problems: string[] = [];
  if (state.ledger !== String(ledger.length)) problems.push(`ledger has ${state.ledger} rows, ${ledger.length} names were read`);
  const have = new Set(ledger);
  const want = new Set(replayed);
  for (const f of replayed) if (!have.has(f)) problems.push(`ledger lacks ${f}, which the replay applied`);
  for (const f of ledger) if (!want.has(f)) problems.push(`ledger has ${f}, which the replay did not apply`);
  if (state.identity_table === "none" || state.identity_table === undefined) problems.push("deployment_identity is absent; a production dump carries it");
  if (state.rm_owner_login !== "false" && state.rm_owner_login !== "true") problems.push(`rm_owner rolcanlogin=${state.rm_owner_login}; production's is false, or true once role-passwords ran`);
  if (state.doadmin_super !== "false") problems.push(`doadmin rolsuper=${state.doadmin_super}; production's is false`);
  if (state.doadmin_createrole !== "true") problems.push(`doadmin rolcreaterole=${state.doadmin_createrole}; production's is true`);
  if (state.ssl !== "on") problems.push(`ssl=${state.ssl}; production requires TLS`);
  return problems;
}

/** Single-quote a word for a POSIX shell. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Ages a dump manifest's `capturedAt` in hours, or null if it has none. */
export function dumpAgeHours(manifest: { capturedAt?: string }, now: Date): number | null {
  if (!manifest.capturedAt) return null;
  const t = Date.parse(manifest.capturedAt);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}
