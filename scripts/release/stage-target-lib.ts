// The pure half of scripts/release/stage-target.ts (D61 rule 2).
//
// WHAT IT IS. Everything the stage-target builder decides that can be decided
// without a host: where each piece lives, which key names the env file
// carries, which role statements a captured `pg_dumpall --globals-only` becomes,
// the pg_hba rules, the SQL that copies ownership and grants from a reference
// database, and the commands that start the previous release's stack.
// stage-target.ts does the I/O; scripts/tests/unit/stage-target.test.ts drives
// these directly.
//
// WHY A STAGE TARGET. D61 rule 2: the production runbook is rehearsed
// unmodified on stage. Only the target file differs. So stage must hold what
// production holds before the release: since D63 (owner, 2026-10-09) that is
// production as it runs v0.6.0, a remote Postgres 18 over TLS with
// DigitalOcean's role shape, production's 116-name ledger and its
// deployment_identity row (enrolled `rehearsal` here, never `production`), a
// `~/.env` with production's key names, and the v0.6.0 stack that
// `bun smoke --static-port` started and Docker keeps running. Each constant
// below names the production fact it mirrors.

/** Where the target lives on stage-2. These are the release target file's fields. */
export const STAGE_TARGET = {
  /** The ssh alias of the stage host. */
  host: "rm-frontend-stage-2",
  /** The unprivileged deploying user on the stage host. */
  user: "stage-server",
  /** `$HOME` for every release tool on this target. Production's is `/root`. */
  home: "/home/stage-server/stage-target",
  /** The checkout the runner checks out at the release commit. */
  checkout: "/home/stage-server/rm-stage-target",
  /** The commit the release checkout starts at: v0.6.0. The runner moves it to the release commit (R1.1). */
  checkoutCommit: "e96d4598678346260282e37ffd5a10df286186ba",
  /** The legacy checkout, where the running v0.6.0 stack is started. Production's is `/root/rm-060`. */
  legacyCheckout: "/home/stage-server/rm-stage-legacy",
  /** Production's running commit (v0.6.0), read from the prod host 2026-10-09. */
  legacyCommit: "e96d4598678346260282e37ffd5a10df286186ba",
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
  /** The scratch database the reference ledger is replayed into, dropped afterwards. */
  referenceDatabase: "rm_stage_acl_ref",
  /** The fixed web port the `--static-port` boot pins (scripts/stack/ports.ts). */
  legacyWebPort: 48787,
  /** The label on everything stage-target.ts creates outside compose. */
  label: "robotmoney.stage-target=1",
  /** Where the control machine copies the bundled tool on the host. */
  toolDir: "/home/stage-server/.cache/stage-target",
  /** A local checkout on the host to borrow objects from when cloning. */
  referenceClone: "/home/stage-server/rm-060",
  /** The repository. */
  repoUrl: "git@github.com:robotmoney/robotmoney-frontend.git",
  /** The stage target's identity row: a restored copy of production is enrolled `rehearsal` (spec §5, D61). */
  identityKind: "rehearsal",
  /** The longest a dump may have been captured before `up` (runbook §7, fresh-dump rule). */
  maxDumpAgeHours: 24,
} as const;

/**
 * PURE. The folders the stage target owns: `up` creates them, `down` (and
 * `up --replace`) removes them. `retired` is the legacy checkouts a previous
 * run's S8.1 renamed. The release runner's capture checkout
 * (CAPTURE_CHECKOUT, ./target.ts) is never one of them.
 */
export function stageTargetDirs(retired: readonly string[] = []): string[] {
  return [STAGE_TARGET.home, STAGE_TARGET.checkout, STAGE_TARGET.legacyCheckout, ...retired];
}

/**
 * PURE. Why `down` may not remove `dir`, or undefined when it may. It removes
 * only its own folders, and never a folder in `keep` or one holding it (the
 * capture checkout the release runner owns).
 */
export function removalRefusal(dir: string, retired: readonly string[], keep: readonly string[]): string | undefined {
  if (!stageTargetDirs(retired).includes(dir)) return `refusing to remove ${dir}: not a stage-target path`;
  for (const k of keep) {
    if (k === dir || k.startsWith(`${dir}/`)) return `refusing to remove ${dir}: it holds ${k}, the release runner's capture checkout`;
  }
  return undefined;
}

/**
 * The key names of production's `~/.env` (`/root/.env`) after the v0.6.0
 * cutover, read from the prod host on 2026-10-09 with `cut -d= -f1`: the D61
 * allowlist's keys the host holds (no `RM_ENV`, no `doadmin`).
 */
export const PROD_HOME_ENV_KEYS = [
  "COINGECKO_API_KEY",
  "RM_CREDENTIALS",
  "database",
  "host",
  "port",
  "rm_app",
  "rm_owner",
  "rm_readonly",
  "rm_worker",
  "sslmode",
] as const;

/**
 * What `up` writes before it starts the v0.6.0 stack: production's keys, minus
 * `RM_CREDENTIALS` (credentials-init appends it), plus `OPENCODE_API_KEY`
 * (credentials-init reads the model key from it, and env-rewrite moves it out,
 * as the v0.6.0 cutover did). Never `doadmin` (D61, owner 2026-10-08).
 */
export const STAGE_UP_ENV_KEYS = [
  "rm_app",
  "rm_worker",
  "rm_readonly",
  "rm_owner",
  "host",
  "port",
  "database",
  "sslmode",
  "OPENCODE_API_KEY",
  "COINGECKO_API_KEY",
] as const;
export type StageHomeEnvKey = (typeof STAGE_UP_ENV_KEYS)[number];
export type StageHomeEnv = Record<StageHomeEnvKey, string>;

/** The login roles whose passwords the builder generates. `rm_owner` gets one too: production's logs in since `role-passwords` ran. */
export const GENERATED_PASSWORD_ROLES = ["doadmin", "rm_owner", "rm_app", "rm_worker", "rm_readonly"] as const;
export type GeneratedPasswordRole = (typeof GENERATED_PASSWORD_ROLES)[number];

function assertLineValue(key: string, value: string | undefined): string {
  if (value === undefined || value === "") throw new Error(`stage-target: no value for ${key}`);
  if (/[\r\n]/.test(value)) throw new Error(`stage-target: the value for ${key} spans lines`);
  return value;
}

/**
 * The stage target's `~/.env` as `up` writes it before the v0.6.0 stack's first
 * boot. Production's key names; no `doadmin` line (stored in no file, D61).
 * `OPENCODE_API_KEY` is temporary: credentials-init copies it into
 * `credential.json` and env-rewrite moves it to `~/.env.retired-<ts>`, so the
 * file the release run meets has production's keys exactly.
 */
export function composeStageHomeEnv(v: StageHomeEnv): string {
  const line = (key: StageHomeEnvKey, sep: " = " | "=") => `${key}${sep}${assertLineValue(key, v[key])}`;
  return [
    "# postgres",
    line("rm_app", " = "),
    line("rm_worker", " = "),
    line("rm_readonly", " = "),
    line("rm_owner", " = "),
    line("host", " = "),
    line("port", " = "),
    line("database", " = "),
    line("sslmode", " = "),
    "",
    "# inference (moved out by env-rewrite once credential.json holds it)",
    line("OPENCODE_API_KEY", "="),
    "",
    "# research",
    line("COINGECKO_API_KEY", "="),
    "",
  ].join("\n");
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
 * owners and grants are what its 76 ledger files left. The builder replays those
 * files, from the legacy checkout, in a scratch database the way the legacy
 * runner applied them (as doadmin, `SET LOCAL ROLE rm_owner` from 0054 on), and
 * copies the result onto the restored copy with the statements this query
 * prints. Run it in the scratch database. Each output row is one statement.
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
 * One ledger file as production applied it: in one transaction, as the
 * connecting login, with `SET LOCAL ROLE rm_owner` from 0054 on, and its ledger
 * row in the same transaction. psql runs it with `-1`. The v0.5 runner
 * (1cda4085 backend/src/db/migrate.ts) did exactly this for the first 76 files;
 * the owner-role runner of the v0.6.0 cutover leaves the same owners, so the
 * replay applies the other 40 the same way.
 */
export function legacyMigrationScript(file: string, ddl: string): string {
  const role = file >= "0054_rm_worker_allowlist.sql" ? "SET LOCAL ROLE rm_owner;\n" : "";
  return `${role}${ddl}\n;\nINSERT INTO schema_migrations (name) VALUES (${sqlLiteral(file)});\n`;
}

/**
 * The out-of-band run of `scripts/ops/provision-db-role-taxonomy.sh` (legacy
 * tree), modelled after the first 76 ledger files, which is where it ran in
 * production's history (before the v0.6.0 cutover applied the other 40): 0053's SQL as the bootstrap login,
 * with no ledger row, then the script's two rm_readonly sequence grants.
 *
 * Why it is modelled last. 0057 and 0058 grant rm_app only SELECT and INSERT on
 * the analytics ledger tables. Production's legacy boot passes its
 * `analytics-ledger-guard` step as rm_app (prod's v0.5.4 driver log,
 * 2026-10-01), and that probe needs UPDATE and DELETE privilege to reach the
 * immutability trigger. Only 0053's sweep, applied again after those tables
 * existed, grants it. The v0.5.0 runbook (§4.1.2) and 0062's notice name this
 * script as the way production's primary was provisioned.
 */
export function provisionTaxonomyScript(ddl0053: string): string {
  return `${ddl0053}\n;\nGRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_readonly;\nALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO rm_readonly;\n`;
}

export const PROVISION_TAXONOMY_FILE = "0053_database_role_taxonomy.sql";

/** The grant reconciliation the migrate runs after its last pending file (backend/scripts/migrate-run.ts, spec §8.3). */
export const GRANTS_RECONCILE_FILE = "backend/schema/grants.sql";

/**
 * The reconciliation `bun run migrate` ends every run with: `backend/schema/grants.sql`,
 * as the owner, outside any ledger row. It is what gives production's
 * `rm_owner` default privileges their runtime-role SELECT grants (so a table
 * created by a later migration, like 0115's token_market_samples, is readable
 * by rm_app and rm_worker), and what takes DELETE back (0107). The cutover's
 * migrate ran it once; the replay runs it after the cutover's files.
 */
export function grantsReconcileScript(grantsSql: string): string {
  return `SET LOCAL ROLE rm_owner;\n${grantsSql}\n`;
}

export const LEGACY_LEDGER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);\n`;

/** The restored database's facts, one `key=value` per line. */
export const RESTORED_STATE_QUERY = `
SELECT 'ledger=' || (SELECT count(*) FROM schema_migrations)
UNION ALL SELECT 'identity_table=' || COALESCE(to_regclass('public.deployment_identity')::text, 'none')
UNION ALL SELECT 'identity_kind=' || COALESCE((SELECT string_agg(kind::text, ',') FROM deployment_identity), 'none')
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
 * What `up` requires of the restored database before it writes any env file:
 * production's shape as it stands since the v0.6.0 cutover (D63). The ledger
 * equals the supported baseline, `deployment_identity` holds the one row, and
 * `rm_owner` logs in (production's does since `role-passwords` ran).
 * `identityKind` is what the copy is enrolled as: `production` straight from
 * the dump (`expectedKind` null), `rehearsal` once `up` has re-enrolled it.
 */
export function restoredDatabaseProblems(
  state: Record<string, string>,
  ledger: readonly string[],
  baseline: readonly string[],
  expectedKind: string | null,
): string[] {
  const problems: string[] = [];
  if (state.ledger !== String(baseline.length)) problems.push(`ledger has ${state.ledger} rows, production's baseline has ${baseline.length}`);
  const have = new Set(ledger);
  const want = new Set(baseline);
  for (const f of baseline) if (!have.has(f)) problems.push(`ledger lacks ${f}`);
  for (const f of ledger) if (!want.has(f)) problems.push(`ledger has ${f}, which the baseline does not`);
  if (state.identity_table === "none") problems.push("deployment_identity is missing; production has it since the v0.6.0 cutover");
  else if (expectedKind !== null && state.identity_kind !== expectedKind) {
    problems.push(`deployment_identity reads ${state.identity_kind}; the stage target is enrolled ${expectedKind}`);
  }
  if (state.rm_owner_login !== "true") problems.push(`rm_owner rolcanlogin=${state.rm_owner_login}; production's is true since role-passwords ran`);
  if (state.doadmin_super !== "false") problems.push(`doadmin rolsuper=${state.doadmin_super}; production's is false`);
  if (state.doadmin_createrole !== "true") problems.push(`doadmin rolcreaterole=${state.doadmin_createrole}; production's is true`);
  if (state.ssl !== "on") problems.push(`ssl=${state.ssl}; production requires TLS`);
  return problems;
}

/** The statement that enrolls the restored copy: a stage target is never `production` (spec §4.2, D61). */
export const ENROLL_REHEARSAL_SQL = `UPDATE deployment_identity SET kind = 'rehearsal', written_at = now(), written_by = current_user,
  note = 'stage-target up: a restored production dump, enrolled rehearsal (D61 rule 2, D63)' WHERE id;
SELECT 'identity_kind=' || string_agg(kind::text, ',') FROM deployment_identity;`;

// ---------------------------------------------------------------------------
// The previous release's stack
// ---------------------------------------------------------------------------

/** The fixed PATH `up` gives the v0.6.0 tools, the runner's own (scripts/release/steps.ts REMOTE_PATH). */
export const STACK_PATH = "/root/.bun/bin:/home/stage-server/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** The directory the build's own receipts go to, beside the release runs' (`<home>/.local/state/robotmoney-release/stage-target-up`). */
export function upReceiptDir(home: string): string {
  return `${home}/.local/state/robotmoney-release/stage-target-up`;
}

/**
 * The commands that bring the v0.6.0 stack up the way the v0.6.0 cutover did
 * (steps R6.2a, R6.2, R6.5, R6.7a, R6.7c and R6.7d of the v0.6.0 runner, whose
 * tools the legacy checkout still holds), each run in the legacy checkout under
 * `env -i`, as the release runner runs a step. The copy of production has
 * members whose keys belong to production's `credential.json`, which no stage
 * host holds, so the sequence writes a fresh `credential.json` and rebinds the
 * in-house members to it. That is stage-only setup on a disposable database.
 *
 * Returns the argv of each command, in order, with the env it runs under.
 */
export function legacyStackCommands(t: { home: string; instance: string; confirmTarget: string; runTs: string }): { name: string; argv: string[]; env: Record<string, string> }[] {
  const receipts = upReceiptDir(t.home);
  const base = { HOME: t.home, PATH: STACK_PATH, LANG: "C.UTF-8", RM_ENV: "stage" };
  const boot = { ...base, PROJECTS_SOURCE: "live" };
  const prodInit = (command: string) => ["bun", "scripts/prod-init.ts", command, "--instance", t.instance, "--confirm-target", t.confirmTarget];
  const smoke = ["bun", "run", "smoke", "--static-port", "--instance", t.instance];
  return [
    { name: "credentials-init", argv: ["bun", "scripts/release/credentials-init.ts", "--receipt-dir", receipts], env: base },
    { name: "env-rewrite", argv: ["bun", "scripts/release/env-rewrite.ts", "--run", t.runTs, "--receipt-dir", receipts], env: base },
    { name: "provision-tokens", argv: prodInit("provision-tokens"), env: base },
    { name: "boot 1", argv: smoke, env: boot },
    { name: "rebind-members", argv: prodInit("rebind-members"), env: base },
    { name: "boot 2", argv: smoke, env: boot },
  ];
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
