// The DATABASE half of `bun smoke`, as the boot's wiring calls it — spec §7's
// "database create/restore (local) → target lock (§2) → identity matrix (§4.3)
// → authorized preparation → preflight", and §5's local Postgres.
//
// scripts/lib/smoke-main.ts sequences and journals these steps; this module
// holds what each step IS, so smoke-main keeps only the wiring (its line budget,
// scripts/tests/unit/smoke-main-split.test.ts, is the reason the split exists).
//
// THE CREDENTIALS, per §3 and §5:
//   - a local mode (`blank`, `dump`, `volume`): smoke generates the four role
//     passwords once, saves them in the instance's state directory, and reuses
//     them (scripts/lib/smoke-state.ts). The local container's superuser does
//     only what `doadmin` does in production — it creates the four roles and
//     the database, once — and nothing uses it again (§7.3). `rm_owner` then
//     provisions the schema; the api gets `rm_app`, the pipeline worker
//     `rm_worker`, preflight reads through `rm_readonly`.
//   - the remote database: `~/.env`'s connection values and its `rm_app`,
//     `rm_worker` and `rm_readonly` passwords. `rm_owner` is typed at the
//     terminal by the one preparation that needs it and never stored.
//
// THE HOST DOES THE DATABASE WORK. Every read and write below runs from the host
// over a direct connection — the target lock, the identity read, the bootstrap,
// the migrate run, the seed, preflight — never from inside an application
// container. That is what lets the remote path reach a database on the host's
// own loopback (wave-2 open problem 6: a `docker run psql` could not), and what
// keeps a migration credential out of every container.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readTargetStateAt, type TargetState } from "../../backend/src/db/target-lock.ts";
import type { LockHolder } from "../../backend/src/db/target-lock.ts";
import { generateRolePasswords, readRolePasswords, type GeneratedRolePasswords, type InstancePaths } from "./smoke-state.ts";

/** The four roles of spec §3. */
export const TAXONOMY_ROLES = ["rm_owner", "rm_app", "rm_worker", "rm_readonly"] as const;
export type TaxonomyRole = (typeof TAXONOMY_ROLES)[number];

/** How the HOST reaches the target database. */
export interface HostTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly sslmode: string;
}

/** A `postgres://` URL for `role` on `target`. Never logged: it carries the password. */
export function roleUrl(target: HostTarget, role: string, password: string): string {
  const url = new URL(`postgres://${target.host}`);
  url.port = String(target.port);
  url.username = encodeURIComponent(role);
  url.password = encodeURIComponent(password);
  url.pathname = `/${target.database}`;
  url.searchParams.set("sslmode", target.sslmode);
  return url.toString();
}

/**
 * The instance's role passwords: the saved set when there is one, else a fresh
 * set, saved (§5: "In `blank` and `dump` modes smoke generates the four role
 * passwords and saves them in the instance's state directory beside the
 * volume; `volume` mode reuses them."). `volume` never generates: a reattached
 * volume's roles already hold the saved passwords, and a new set would orphan
 * them (readRolePasswords refuses, naming the file).
 */
export function instanceRolePasswords(paths: InstancePaths, mode: "blank" | "dump" | "volume"): GeneratedRolePasswords {
  if (mode === "volume" || existsSync(paths.rolePasswordsFile)) return readRolePasswords(paths);
  return generateRolePasswords(paths);
}

/** A SQL string literal. The passwords are base64url, but quoting is never skipped for that. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * What the LOCAL superuser runs, once, on a Postgres smoke owns — exactly what
 * `doadmin` does on a fresh production cluster (§3, §7.3): create the four
 * roles with their generated passwords, hand the database to `rm_owner`, and
 * install the extensions the snapshot lists as provider-managed (pgcrypto; a
 * managed cluster installs it, `rm_owner` may not). Nothing else: the schema is
 * `rm_owner`'s to create (bootstrapBlankDatabase), and the superuser is not used
 * again.
 *
 * Idempotent, so a rerun of an interrupted `database` step converges: a role
 * that exists has its password (re)set to the saved one.
 *
 * `rm_owner` is LOGIN and holds no CREATEROLE (§3: "`rm_owner` never holds
 * `CREATEROLE`"); no role here is a superuser or can create roles.
 */
export function localSuperuserSql(passwords: GeneratedRolePasswords, database: string): string {
  const roles = TAXONOMY_ROLES.map(
    (role) => `
DO $rm$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD ${literal(passwords[role])};
  ELSE
    ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD ${literal(passwords[role])};
  END IF;
END $rm$;`,
  ).join("\n");
  return `${roles}
ALTER DATABASE "${database}" OWNER TO rm_owner;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
`;
}

/**
 * What the dump's restore superuser runs after `pg_restore --no-owner
 * --no-privileges`: the four roles, as for a blank database, then every
 * application object the restore left owned by the superuser handed to
 * `rm_owner` — the owner a production database has after §9.1 — so the
 * enrollment write, `--migrate` and every later grant run as `rm_owner` and not
 * as a superuser. Extension members stay with their extension (re-owning one
 * fails for a non-superuser and is not the application's to own).
 *
 * THE TARGET-STATE READ GRANTS. A backup carries no privileges: `bun
 * smoke:capture` dumps with `--no-privileges` and the restore passes it again,
 * so the restored copy grants the runtime roles nothing. The target lock (§2)
 * then reads identity, ledger and manifest AS `rm_readonly` and cannot: a
 * column it holds no privilege on is invisible in information_schema, and the
 * boot refused at its lock with "deployment_identity carries neither a `kind`
 * nor an `identity` column" (the first real `--local dump` boot, scripts/tests/
 * integration/smoke-dump-lifecycle.test.ts). So the runtime roles get back
 * exactly the read the schema itself declares on those three tables — SELECT,
 * as 0063 grants it on `deployment_identity` and backend/schema/grants.sql's
 * `select_for_runtime` on all three — on whichever of them the restored
 * version has, and nothing else. Every other grant is the roles-and-grants
 * reconciliation's, run by `--migrate` as `rm_owner` (§8.1, §8.3); no write,
 * DELETE or TRUNCATE is granted here (D55 (6)).
 */
export function dumpOwnershipSql(passwords: GeneratedRolePasswords, database: string): string {
  return `${localSuperuserSql(passwords, database)}
ALTER SCHEMA public OWNER TO rm_owner;
DO $rm_own$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relkind, c.oid::regclass AS object_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m','f')
      AND (c.relkind <> 'S' OR NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a','i')))
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO rm_owner',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
                     WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE'
                     ELSE 'TABLE' END, r.object_name);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS object_name
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO rm_owner', r.object_name);
  END LOOP;
END $rm_own$;
GRANT USAGE ON SCHEMA public TO rm_app, rm_worker, rm_readonly;
DO $rm_read$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[${TARGET_STATE_TABLES.map((t) => `'${t}'`).join(", ")}] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO rm_app, rm_worker, rm_readonly', t);
    END IF;
  END LOOP;
END $rm_read$;
`;
}

/**
 * The tables the target lock reads (backend/src/db/target-lock.ts
 * readTargetState): the enrollment, the ledger, the manifest. A restored dump
 * grants the runtime roles SELECT on these and on nothing else (dumpOwnershipSql).
 */
export const TARGET_STATE_TABLES = ["deployment_identity", "schema_migrations", "schema_manifest"] as const;

/**
 * Read the target's identity, ledger and manifest from the host over a
 * short-lived direct connection. The plan is built from this (§1.2 hashes the
 * identity kind), and the target lock revalidates against it (§2).
 */
export async function hostReadTargetState(url: string): Promise<TargetState> {
  return readTargetStateAt(url);
}

/** One preparation step, as backend/scripts/smoke-prepare.ts takes it. No secret travels in it. */
export interface PrepareStep {
  readonly action: "bootstrap" | "enroll" | "migrate" | "seed" | "preflight";
  readonly rmEnv: "prod" | "stage" | null;
  readonly connection: "remote" | "local";
  readonly target: HostTarget;
  readonly credentials:
    | { readonly source: "instance"; readonly stateRoot: string; readonly instance: string }
    | { readonly source: "home-env"; readonly file: string };
  readonly lock: { readonly backendPid: number; readonly holder: LockHolder };
  readonly stateDir: string;
  readonly nonInteractive: boolean;
  readonly note?: string;
}

export type PrepareOutcome =
  | { readonly ok: true; readonly detail: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

/**
 * Run one preparation step in its own HOST process and return its result.
 *
 * The child's stdio is the boot's own, so a remote rm_owner prompt and the
 * `y/n` reach the operator's terminal; it stays in the boot's process group
 * for the same reason (a background process group cannot read the terminal).
 * It ignores the terminal's SIGINT itself (smoke-prepare.ts): a stop lands on
 * the boot, which honours it at the next phase boundary, never in the middle
 * of a fenced write. The result comes back through a file in the instance's
 * directory, never through the environment.
 */
export async function runPrepareStep(repoRoot: string, step: PrepareStep, env: Record<string, string>): Promise<PrepareOutcome> {
  const resultFile = join(step.stateDir, `prepare-${step.action}-${process.pid}.json`);
  rmSync(resultFile, { force: true });
  const child = spawn("bun", ["--no-env-file", join(repoRoot, "backend", "scripts", "smoke-prepare.ts")], {
    cwd: join(repoRoot, "backend"),
    env: { ...env, RM_PREPARE_REQUEST: JSON.stringify({ ...step, resultFile }) },
    stdio: "inherit",
  });
  const code = await new Promise<number>((resolve) => child.on("exit", (c, signal) => resolve(c ?? (signal ? 128 : 1))));
  let parsed: { ok: boolean; detail?: Record<string, unknown>; error?: string } | null = null;
  try {
    parsed = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch {
    parsed = null;
  } finally {
    rmSync(resultFile, { force: true });
  }
  if (parsed?.ok === true && code === 0) return { ok: true, detail: parsed.detail ?? {} };
  return { ok: false, error: parsed?.error ?? `the ${step.action} step exited ${code} without a result` };
}

/**
 * Run SQL as a Postgres container's own superuser, over `docker exec` — the
 * local stand-in for `doadmin` (§7.3), used for exactly the provisioning
 * `localSuperuserSql` / `dumpOwnershipSql` write and nothing else. The SQL (it
 * carries the generated passwords) travels on stdin, never in an argv `ps`
 * would show. Output: null on success, else psql's own error text.
 */
export function superuserSql(container: string, user: string, database: string, sql: string): string | null {
  const run = Bun.spawnSync(
    ["docker", "exec", "-i", container, "psql", "-X", "-q", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-f", "-"],
    {
      stdin: Buffer.from(sql),
      stdout: "pipe",
      stderr: "pipe",
      // Its own process group: a terminal's Ctrl-C is the boot's to honour at
      // a phase boundary, never this statement's to die of halfway.
      detached: true,
    } as Parameters<typeof Bun.spawnSync>[1],
  );
  return run.exitCode === 0 ? null : (run.stderr?.toString() ?? "").trim() || `psql exited ${run.exitCode}`;
}

/** What a Postgres that is still initializing answers — not a failure of the SQL. */
const NOT_UP_YET = /the database system is (starting up|shutting down)|could not connect|No such file or directory|Connection refused/;

/**
 * {@link superuserSql}, waiting out a server that is still initializing. The
 * postgres image's entrypoint runs a TEMPORARY server for initdb that answers
 * `pg_isready` and then shuts down; a statement sent in that window meets "the
 * database system is shutting down". The provisioning SQL is idempotent, so it
 * is retried until the real server answers or `timeoutMs` passes. A refusal
 * from a server that IS up (a bad statement, a permission) returns at once.
 */
export async function superuserSqlSettled(
  container: string,
  user: string,
  database: string,
  sql: string,
  timeoutMs = 60_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const error = superuserSql(container, user, database, sql);
    if (error === null || !NOT_UP_YET.test(error) || Date.now() >= deadline) return error;
    await Bun.sleep(500);
  }
}

/**
 * Whether an operator is at a terminal to answer a remote preparation's
 * rm_owner prompt and its `y/n` (§8.5). Not a TUI decision — `bun smoke` draws
 * none (§1) — only whether a prompt may be asked at all: without a terminal a
 * remote `--migrate` or `--seed` refuses rather than wait on nobody.
 */
export function operatorTerminal(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * The environment a preparation child runs with: what `bun` and the backend
 * modules need to start, and nothing else. Never the boot's own environment,
 * which may carry an operator's DATABASE_URL or tokens; the child builds every
 * credential it uses from the files its request names.
 */
export function prepareChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TERM", "USER", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR", "RM_SMOKE_STATE_ROOT"]) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
