#!/usr/bin/env bun
// The stage target: a production-shaped target on stage-2 for unmodified
// rehearsals (D61 rule 2, docs/runbooks/stage-target.md).
//
//   bun scripts/release/stage-target.ts up --dump <dir on stage-2> [--replace]
//   bun scripts/release/stage-target.ts status
//   bun scripts/release/stage-target.ts down
//   bun scripts/release/stage-target.ts doadmin   (stage only: a fresh doadmin password on stdout, for a pipe)
//
// Run from the CONTROL machine. It bundles itself, copies the bundle to the
// stage host and runs it there over ssh with stdin closed (`remote <command>`).
// Every secret is generated and written on the host: no password crosses ssh,
// appears in a process argument or reaches this terminal.
//
// Since D63 (owner, 2026-10-09) the target is production as it runs v0.6.0.
// What `up` builds, in order:
//   1. the two checkouts, both at v0.6.0 (e96d4598): the legacy checkout, where
//      the running stack is started, and the release checkout, which the runner
//      moves to the release commit (R1.1);
//   2. `$HOME` for the target, with a self-signed TLS certificate;
//   3. a long-lived Postgres 18 container over TLS on a fixed port, its data in
//      a named volume;
//   4. DigitalOcean's role shape from the dump's own globals, with generated
//      passwords (rm_owner with LOGIN, as production's since `role-passwords`,
//      doadmin CREATEROLE with a password held in memory for the checks, then
//      dropped);
//   5. production's owners and grants, from a replay of the 116 ledger files in
//      a scratch database in production's order (the capture carries none);
//   6. the restored dump with those owners and grants, its deployment_identity
//      row re-enrolled `rehearsal` (a stage target is never `production`), and
//      checked against the baseline (ledger 116, identity present);
//   7. `~/.env` with production's key names;
//   8. the v0.6.0 stack, brought up the way the v0.6.0 cutover did: a fresh
//      credential.json and the rebind of the in-house members to it (setup of a
//      disposable database), the service tokens, and `bun smoke --static-port`
//      from the legacy checkout. Docker keeps the stack running, as on production.
//
// doadmin is stored in no file (D61, owner 2026-10-08). After `up`, the stage
// sequence is production's: `up`, then
//
//   bun scripts/release/stage-target.ts doadmin | bun run role-passwords --target stage --doadmin-stdin
//
// then `release:run`. `doadmin` gives the stage doadmin a fresh password
// through the container's local superuser socket and prints it to stdout, for
// that pipe and nothing else. It exists because this is a disposable stage
// database; production has no such command (its doadmin is typed by the admin).
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { parseEnvFile } from "../lib/env-role.ts";
import { POSTGRES_IMAGE } from "../lib/postgres-image.ts";
import { resolveBackupFiles, restorePipelineArgv, SHM_FLAGS } from "../lib/restore-container.ts";
import { instanceStackProject } from "../lib/smoke-state.ts";
import { PRE_IDENTITY_RELEASES, SUPPORTED_RELEASES } from "../../backend/src/db/supported-releases.ts";
import { IDENTITY_MIGRATION } from "./precondition.ts";
import { CAPTURE_CHECKOUT } from "./target.ts";
import {
  ACL_EXPORT_SQL,
  ACL_FINGERPRINT_SQL,
  bindDatabase,
  composeStageHomeEnv,
  DOADMIN_ADMIN_QUERY,
  doadminPasswordSql,
  dumpAgeHours,
  ENROLL_REHEARSAL_SQL,
  envKeyNames,
  fingerprintDiff,
  GENERATED_PASSWORD_ROLES,
  globalsToRoleSql,
  GRANTS_RECONCILE_FILE,
  grantsReconcileScript,
  LEGACY_LEDGER_TABLE_SQL,
  legacyMigrationScript,
  legacyStackCommands,
  parseKeyValues,
  pgHbaConf,
  PROD_HOME_ENV_KEYS,
  PROVISION_TAXONOMY_FILE,
  provisionTaxonomyScript,
  removalRefusal,
  RESTORED_STATE_QUERY,
  restoredDatabaseProblems,
  ROLE_SHAPE_QUERY,
  roleShapeProblems,
  rolePasswordSql,
  shellQuote,
  STAGE_TARGET as T,
  stageTargetDirs,
  tlsSettingsSql,
  upReceiptDir,
  type GeneratedPasswordRole,
  type StageHomeEnv,
} from "./stage-target-lib.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function log(message: string): void {
  console.log(`[stage-target] ${message}`);
}

class Refusal extends Error {}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command. `stdin` is data, never an argument. */
function run(argv: string[], opts: { stdin?: string; env?: Record<string, string>; cwd?: string } = {}): RunResult {
  const r = Bun.spawnSync(argv, {
    stdin: opts.stdin === undefined ? "ignore" : encoder.encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  return { code: r.exitCode ?? 1, stdout: decoder.decode(r.stdout), stderr: decoder.decode(r.stderr) };
}

function must(argv: string[], what: string, opts: Parameters<typeof run>[1] = {}): string {
  const r = run(argv, opts);
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

/** Run a command with its output streamed to this terminal. */
async function stream(argv: string[], what: string, opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit", cwd: opts.cwd, env: opts.env ? { ...process.env, ...opts.env } : process.env });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${what} failed (exit ${code})`);
}

// ---------------------------------------------------------------------------
// The database, through the container's local socket
// ---------------------------------------------------------------------------

interface PsqlOpts {
  db?: string;
  user?: string;
  tuples?: boolean;
  single?: boolean;
  /** Hide the error text: the statements carry a password. */
  secret?: boolean;
}

function psql(sql: string, o: PsqlOpts = {}): string {
  const argv = [
    "docker", "exec", "-i", T.pgContainer, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=terse",
    "-U", o.user ?? T.superuser, "-d", o.db ?? T.database,
    ...(o.tuples ? ["-At"] : []), ...(o.single ? ["-1"] : []), "-f", "-",
  ];
  const r = run(argv, { stdin: sql });
  if (r.code !== 0) {
    throw new Error(o.secret ? `a statement carrying a password failed (exit ${r.code}); its text is withheld` : `psql failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

/** Connect from the host over TCP and TLS as `role`, like every release tool does. */
function hostPsql(role: string, password: string, sql: string): RunResult {
  return run(
    ["psql", "-X", "-At", `host=${T.pgBindHost} port=${T.pgPort} dbname=${T.database} user=${role} sslmode=require connect_timeout=5`, "-c", sql],
    { env: { PGPASSWORD: password } },
  );
}

function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Buffer.from(bytes).toString("base64url");
}

// ---------------------------------------------------------------------------
// What exists
// ---------------------------------------------------------------------------

function dockerNames(kind: "container" | "volume", filter: string): string[] {
  const argv = kind === "container"
    ? ["docker", "ps", "-a", "--format", "{{.Names}}", "--filter", filter]
    : ["docker", "volume", "ls", "-q", "--filter", filter];
  return run(argv).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** The compose projects this target's stacks may run under: the instance's. */
function targetProjects(): string[] {
  return [instanceStackProject(T.instance, {})];
}

function projectContainers(): string[] {
  const names = new Set<string>();
  for (const p of targetProjects()) {
    for (const n of dockerNames("container", `label=com.docker.compose.project=${p}`)) names.add(n);
    for (const n of dockerNames("container", `label=robotmoney.smoke.project=${p}`)) names.add(n);
  }
  return [...names];
}

/** Retired legacy checkouts a previous run's S8.1 left beside the legacy checkout (`<legacy>.<version>-retired`). */
function retiredLegacyCheckouts(): string[] {
  const parent = dirname(T.legacyCheckout);
  const prefix = `${basename(T.legacyCheckout)}.`;
  let names: string[] = [];
  try { names = readdirSync(parent); } catch { return []; }
  return names.filter((n) => n.startsWith(prefix) && /^v\d+\.\d+\.\d+-retired$/.test(n.slice(prefix.length))).map((n) => join(parent, n));
}

function existingPieces(): string[] {
  const pieces: string[] = [];
  if (dockerNames("container", `name=^${T.pgContainer}$`).length) pieces.push(`container ${T.pgContainer}`);
  if (dockerNames("volume", `name=^${T.pgVolume}$`).length) pieces.push(`volume ${T.pgVolume}`);
  for (const dir of stageTargetDirs(retiredLegacyCheckouts())) if (existsSync(dir)) pieces.push(`directory ${dir}`);
  for (const c of projectContainers()) pieces.push(`container ${c}`);
  return pieces;
}

function portHolder(port: number): string | null {
  const r = run(["ss", "-ltnH", `sport = :${port}`]);
  return r.stdout.trim() ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

function cloneAt(dir: string, commit: string): void {
  log(`cloning ${commit.slice(0, 8)} into ${dir}`);
  const cloned = run(["git", "clone", "--quiet", "--reference-if-able", T.referenceClone, "--dissociate", T.repoUrl, dir]);
  if (cloned.code !== 0) {
    log(`clone from ${T.repoUrl} failed (${cloned.stderr.trim().split("\n").pop()}); cloning from ${T.referenceClone} instead`);
    rmSync(dir, { recursive: true, force: true });
    must(["git", "clone", "--quiet", "--no-hardlinks", T.referenceClone, dir], "git clone");
    must(["git", "-C", dir, "remote", "set-url", "origin", T.repoUrl], "git remote set-url");
  }
  const has = run(["git", "-C", dir, "cat-file", "-e", `${commit}^{commit}`]);
  if (has.code !== 0) must(["git", "-C", dir, "fetch", "--quiet", "origin"], "git fetch");
  must(["git", "-C", dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", commit], `git checkout ${commit}`);
}

async function bunInstall(dir: string, cwds: string[]): Promise<void> {
  for (const cwd of cwds) {
    log(`bun install in ${join(dir, cwd)}`);
    await stream(["bun", "install", "--frozen-lockfile"], `bun install (${cwd})`, { cwd: join(dir, cwd) });
  }
}

function readDumpPreflight(dumpDir: string) {
  const backup = resolveBackupFiles(dumpDir);
  if ("error" in backup) throw new Refusal(`the dump at ${dumpDir} is not usable: ${backup.error}`);
  const manifestPath = join(dumpDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Refusal(`${manifestPath} is missing; capture with bun smoke:capture`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { capturedAt?: string; role?: string; pgIsInRecovery?: boolean; target?: string };
  const age = dumpAgeHours(manifest, new Date());
  if (age === null) throw new Refusal(`${manifestPath} has no capturedAt`);
  if (age > T.maxDumpAgeHours) {
    throw new Refusal(`the dump was captured ${age.toFixed(1)} h ago; the fresh-dump rule allows ${T.maxDumpAgeHours} h. Capture a new one first`);
  }
  log(`dump ${backup.stamp}: captured ${manifest.capturedAt} (${age.toFixed(1)} h ago) as ${manifest.role} from a replica=${manifest.pgIsInRecovery}`);
  return backup;
}

function startPostgres(): void {
  log(`creating volume ${T.pgVolume} and container ${T.pgContainer} (${POSTGRES_IMAGE}) on ${T.pgBindHost}:${T.pgPort}`);
  must(["docker", "volume", "create", "--label", T.label, T.pgVolume], "docker volume create");
  // The superuser password only satisfies the image's entrypoint. pg_hba
  // refuses that role over the network, so the value is never needed again.
  const envFile = join(T.home, ".pg-init.env");
  writeFileSync(envFile, `POSTGRES_USER=${T.superuser}\nPOSTGRES_PASSWORD=${generatePassword()}\nPOSTGRES_DB=${T.database}\n`, { mode: 0o600 });
  try {
    must([
      "docker", "run", "-d", "--name", T.pgContainer, "--restart", "unless-stopped",
      "--env-file", envFile, "--label", T.label,
      "-p", `${T.pgBindHost}:${T.pgPort}:5432`, ...SHM_FLAGS,
      "-v", `${T.pgVolume}:/var/lib/postgresql`, POSTGRES_IMAGE,
    ], "docker run");
  } finally {
    rmSync(envFile, { force: true });
  }
}

async function waitForPostgres(): Promise<void> {
  // The entrypoint's initdb server listens on the socket only; a TCP answer
  // inside the container is the real server.
  for (let i = 0; i < 120; i++) {
    if (run(["docker", "exec", T.pgContainer, "pg_isready", "-q", "-h", "127.0.0.1", "-p", "5432"]).code === 0) {
      log(`postgres ready after ${i + 1} s`);
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error("postgres never became ready");
}

function enableTls(): void {
  const tlsDir = join(T.home, "pg-tls");
  mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  log("generating a self-signed TLS certificate");
  must([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825",
    "-subj", `/CN=${T.pgContainer}`, "-keyout", join(tlsDir, "server.key"), "-out", join(tlsDir, "server.crt"),
  ], "openssl req");
  chmodSync(join(tlsDir, "server.key"), 0o600);
  must(["docker", "cp", tlsDir, `${T.pgContainer}:/var/lib/postgresql/tls`], "docker cp tls");
  must(["docker", "exec", "-u", "root", T.pgContainer, "sh", "-c",
    "chown -R postgres:postgres /var/lib/postgresql/tls && chmod 700 /var/lib/postgresql/tls && chmod 600 /var/lib/postgresql/tls/server.key"], "chown tls");
  must(["docker", "exec", "-i", "-u", "postgres", T.pgContainer, "sh", "-c", 'cat > "$PGDATA/pg_hba.conf"'], "write pg_hba.conf", { stdin: pgHbaConf(T.superuser) });
  psql(tlsSettingsSql("/var/lib/postgresql/tls/server.crt", "/var/lib/postgresql/tls/server.key"));
  const ssl = psql("SHOW ssl;", { tuples: true }).trim();
  if (ssl !== "on") throw new Error(`ssl is ${ssl} after the reload`);
  log("TLS on; pg_hba requires TLS for every network login and refuses the superuser");
}

function decryptGlobals(backup: { passphraseFile: string; globalsEnc: string }): string {
  return must(["gpg", "--batch", "--quiet", "--passphrase-file", backup.passphraseFile, "--decrypt", backup.globalsEnc], "gpg --decrypt globals");
}

function applyRoles(globals: string, passwords: Record<GeneratedPasswordRole, string>): void {
  const roles = globalsToRoleSql(globals);
  psql(roles.sql, { single: true });
  psql(rolePasswordSql(passwords), { single: true, secret: true });
  log(`roles from the dump's globals: ${roles.roles.join(", ")}; left out ${roles.skipped.join(", ") || "none"}`);
}

/**
 * Replay production's ledger in a scratch database, in the order production
 * applied it, and return the statements that give the restored copy the same
 * owners and grants, with the reference fingerprint.
 *
 * Production's history, which the replay follows: the first 76 files (the
 * v0.5 ledger, PRE_IDENTITY_RELEASES) as the legacy runner applied them, then
 * the out-of-band taxonomy provisioning, then the v0.6.0 cutover: 0081 first,
 * then every other file in filename order, then the grant reconciliation the
 * cutover's migrate closed with.
 */
function referenceGrants(baseline: readonly string[]): { statements: string; fingerprint: string } {
  const dir = join(T.legacyCheckout, "backend", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const missing = baseline.filter((f) => !files.includes(f));
  const extra = files.filter((f) => !baseline.includes(f));
  if (missing.length || extra.length) {
    throw new Error(`the legacy checkout's migrations are not production's ledger: missing ${missing.join(",") || "none"}, extra ${extra.join(",") || "none"}`);
  }
  const first = new Set(PRE_IDENTITY_RELEASES[0]!.migrations);
  const v05 = files.filter((f) => first.has(f));
  const cutover = [IDENTITY_MIGRATION, ...files.filter((f) => !first.has(f) && f !== IDENTITY_MIGRATION)];
  log(`replaying production's ${files.length} ledger files as doadmin in ${T.referenceDatabase} (${v05.length} before the v0.6.0 cutover, ${cutover.length} at it)`);
  psql(`DROP DATABASE IF EXISTS ${T.referenceDatabase};`);
  psql(`CREATE DATABASE ${T.referenceDatabase} OWNER doadmin;`);
  psql(LEGACY_LEDGER_TABLE_SQL, { user: "doadmin", db: T.referenceDatabase });
  const apply = (f: string) =>
    psql(legacyMigrationScript(f, readFileSync(join(dir, f), "utf8")), { user: "doadmin", db: T.referenceDatabase, single: true });
  for (const f of v05) apply(f);
  log("applying the out-of-band taxonomy provisioning (0053 alone, as provision-db-role-taxonomy.sh did)");
  psql(provisionTaxonomyScript(readFileSync(join(dir, PROVISION_TAXONOMY_FILE), "utf8")), { user: "doadmin", db: T.referenceDatabase, single: true });
  for (const f of cutover) apply(f);
  log(`applying the cutover migrate's closing grant reconciliation (${GRANTS_RECONCILE_FILE})`);
  psql(grantsReconcileScript(readFileSync(join(T.legacyCheckout, GRANTS_RECONCILE_FILE), "utf8")), { user: "doadmin", db: T.referenceDatabase, single: true });
  const statements = psql(ACL_EXPORT_SQL, { db: T.referenceDatabase, tuples: true });
  const fingerprint = psql(ACL_FINGERPRINT_SQL, { db: T.referenceDatabase, tuples: true });
  psql(`DROP DATABASE ${T.referenceDatabase};`);
  log(`reference: ${statements.split("\n").filter(Boolean).length} ownership and grant statements`);
  return { statements, fingerprint };
}

/** The supported baseline (D63): the ledger the restored dump must equal. */
function readBaseline(): string[] {
  return [...SUPPORTED_RELEASES[0]!.migrations];
}

function writeEnvFiles(passwords: Record<GeneratedPasswordRole, string>): StageHomeEnv {
  const stageDefault = parseEnvFile(readFileSync("/home/stage-server/.env", "utf8"));
  for (const k of ["OPENCODE_API_KEY", "COINGECKO_API_KEY"] as const) {
    if (!stageDefault[k]) throw new Error(`/home/stage-server/.env has no ${k}`);
  }
  const values: StageHomeEnv = {
    rm_app: passwords.rm_app,
    rm_worker: passwords.rm_worker,
    rm_readonly: passwords.rm_readonly,
    rm_owner: passwords.rm_owner,
    host: T.pgBindHost,
    port: String(T.pgPort),
    database: T.database,
    sslmode: "require",
    OPENCODE_API_KEY: stageDefault.OPENCODE_API_KEY!,
    COINGECKO_API_KEY: stageDefault.COINGECKO_API_KEY!,
  };
  const homeEnv = join(T.home, ".env");
  writeFileSync(homeEnv, composeStageHomeEnv(values), { mode: 0o600 });
  chmodSync(homeEnv, 0o600);
  log(`wrote ${homeEnv} (0600): ${envKeyNames(readFileSync(homeEnv, "utf8")).join(", ")}`);
  return values;
}

/** `expectedKind` null: straight from the dump, before the re-enrollment. */
function checkDatabase(passwords: Record<GeneratedPasswordRole, string>, baseline: readonly string[], expectedKind: string | null): string[] {
  const state = parseKeyValues(psql(RESTORED_STATE_QUERY, { tuples: true }));
  const ledger = psql("SELECT name FROM schema_migrations ORDER BY name COLLATE \"C\";", { tuples: true }).split("\n").filter(Boolean);
  const problems = restoredDatabaseProblems(state, ledger, baseline, expectedKind);
  problems.push(...roleShapeProblems(psql(ROLE_SHAPE_QUERY, { tuples: true }), psql(DOADMIN_ADMIN_QUERY, { tuples: true })));
  for (const role of ["doadmin", "rm_owner", "rm_app", "rm_worker", "rm_readonly"] as const) {
    const r = hostPsql(role, passwords[role], "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid();");
    if (r.code !== 0 || r.stdout.trim() !== "t") problems.push(`${role} cannot log in over TLS from the host (${r.stderr.trim().split("\n")[0] ?? ""})`);
  }
  const su = run(["psql", "-X", "-At", `host=${T.pgBindHost} port=${T.pgPort} dbname=${T.database} user=${T.superuser} sslmode=require connect_timeout=5`, "-c", "SELECT 1"], { env: { PGPASSWORD: "x" } });
  if (su.code === 0) problems.push("the container superuser logged in over the network");
  const plain = run(["psql", "-X", "-At", `host=${T.pgBindHost} port=${T.pgPort} dbname=${T.database} user=rm_app sslmode=disable connect_timeout=5`, "-c", "SELECT 1"], { env: { PGPASSWORD: passwords.rm_app } });
  if (plain.code === 0) problems.push("rm_app logged in without TLS");
  log(`database: ledger=${state.ledger} identity=${state.identity_table}/${state.identity_kind} rm_owner_login=${state.rm_owner_login} doadmin_super=${state.doadmin_super} doadmin_createrole=${state.doadmin_createrole} ssl=${state.ssl} server=${state.server_version}`);
  return problems;
}

async function buildDatabase(backup: ReturnType<typeof readDumpPreflight>, baseline: readonly string[]): Promise<Record<GeneratedPasswordRole, string>> {
  startPostgres();
  await waitForPostgres();
  enableTls();
  const passwords = Object.fromEntries(GENERATED_PASSWORD_ROLES.map((r) => [r, generatePassword()])) as Record<GeneratedPasswordRole, string>;
  const globals = decryptGlobals(backup);
  applyRoles(globals, passwords);
  psql(`ALTER DATABASE ${T.database} OWNER TO doadmin;`);
  const reference = referenceGrants(baseline);
  // The replay ran 0053, whose ALTER ROLE lines are cluster-wide: put production's attribute lines back.
  applyRoles(globals, passwords);
  log(`restoring ${backup.dumpEnc} into ${T.database} (the long step)`);
  const started = Date.now();
  const pipeline = Bun.spawn(restorePipelineArgv(backup.passphraseFile, backup.dumpEnc, T.pgContainer, T.superuser, T.database), {
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const restoreExit = await pipeline.exited;
  if (restoreExit !== 0) throw new Error(`pg_restore failed (exit ${restoreExit})`);
  log(`restore done in ${Math.round((Date.now() - started) / 1000)} s`);
  psql(bindDatabase(reference.statements, T.database), { single: true });
  const restored = psql(ACL_FINGERPRINT_SQL, { tuples: true });
  const diff = fingerprintDiff(reference.fingerprint, restored);
  if (diff.onlyReference.length || diff.onlyRestored.length) {
    for (const l of diff.onlyReference.slice(0, 20)) log(`  only in the replayed ledger: ${l}`);
    for (const l of diff.onlyRestored.slice(0, 20)) log(`  only in the restored dump:   ${l}`);
    throw new Error(`owners and grants differ from the replayed ledger: ${diff.onlyReference.length} and ${diff.onlyRestored.length} lines`);
  }
  log(`owners and grants equal the replayed ledger (${restored.split("\n").filter(Boolean).length} lines)`);
  // The dump carries production's identity row. A stage target is never `production` (spec §4.2, D61).
  const fromDump = parseKeyValues(psql("SELECT 'identity_kind=' || COALESCE(string_agg(kind::text, ','), 'none') FROM deployment_identity;", { tuples: true }));
  log(`the dump's deployment_identity reads ${fromDump.identity_kind}; enrolling the copy ${T.identityKind}`);
  const enrolled = parseKeyValues(psql(ENROLL_REHEARSAL_SQL, { tuples: true }));
  if (enrolled.identity_kind !== T.identityKind) throw new Error(`the identity row reads ${enrolled.identity_kind} after the enrollment`);
  psql("ANALYZE;");
  return passwords;
}

/** One command of the v0.6.0 bring-up, run in the legacy checkout under `env -i` as the release runner runs a step. */
async function runInLegacyCheckout(name: string, argv: string[], env: Record<string, string>): Promise<void> {
  log(`v0.6.0 stack: ${name} (cd ${T.legacyCheckout} && ${argv.join(" ")})`);
  const p = Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv], {
    cwd: T.legacyCheckout, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const code = await p.exited;
  if (code !== 0) throw new Error(`v0.6.0 stack: ${name} failed (exit ${code})`);
}

/**
 * Bring the v0.6.0 stack up as the v0.6.0 cutover did, from the legacy checkout
 * (scripts/release/stage-target-lib.ts legacyStackCommands). `bun smoke` exits
 * once the stack is ready and Docker keeps it running, as on production.
 */
async function startLegacyStack(): Promise<void> {
  const runTs = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  mkdirSync(upReceiptDir(T.home), { recursive: true, mode: 0o700 });
  for (const c of legacyStackCommands({ home: T.home, instance: T.instance, confirmTarget: `${T.pgBindHost}:${T.pgPort}/${T.database}`, runTs })) {
    await runInLegacyCheckout(c.name, c.argv, c.env);
  }
}

async function waitForLegacySite(): Promise<boolean> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const r = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", `http://127.0.0.1:${T.legacyWebPort}/`]);
    if (r.stdout.trim() === "200") {
      log(`the v0.6.0 site answers 200 on :${T.legacyWebPort}`);
      return true;
    }
    await Bun.sleep(5_000);
  }
  return false;
}

async function remoteUp(args: string[]): Promise<number> {
  const dumpIdx = args.indexOf("--dump");
  const dumpDir = dumpIdx >= 0 ? args[dumpIdx + 1] : undefined;
  if (!dumpDir) throw new Refusal("up needs --dump <dir on the stage host>");
  const replace = args.includes("--replace");
  const backup = readDumpPreflight(dumpDir);

  const existing = existingPieces();
  if (existing.length) {
    if (!replace) throw new Refusal(`a stage target already exists (${existing.join("; ")}). Pass --replace to rebuild it`);
    log(`--replace: taking the existing target down first`);
    await remoteDown();
  }
  for (const port of [T.pgPort, T.legacyWebPort]) {
    const holder = portHolder(port);
    if (holder) throw new Refusal(`port ${port} is held: ${holder}`);
  }

  mkdirSync(T.home, { recursive: true, mode: 0o700 });
  chmodSync(T.home, 0o700);
  cloneAt(T.legacyCheckout, T.legacyCommit);
  cloneAt(T.checkout, T.checkoutCommit);
  const baseline = readBaseline();
  log(`production baseline: ${baseline.length} ledger files`);
  await bunInstall(T.legacyCheckout, [".", "backend"]);
  await bunInstall(T.checkout, [".", "backend"]);

  const passwords = await buildDatabase(backup, baseline);
  const problems = checkDatabase(passwords, baseline, T.identityKind);
  if (problems.length) {
    for (const p of problems) log(`  PROBLEM: ${p}`);
    throw new Error(`the stage database does not match production's shape since the v0.6.0 cutover (${problems.length} problems)`);
  }
  log("the stage database matches production's shape since the v0.6.0 cutover");
  writeEnvFiles(passwords);
  writeFileSync(join(T.home, "stage-target.json"), `${JSON.stringify({
    builtAt: new Date().toISOString(),
    dump: dumpDir,
    stamp: backup.stamp,
    legacyCommit: T.legacyCommit,
    checkoutCommit: T.checkoutCommit,
    pg: `${T.pgContainer} ${POSTGRES_IMAGE} ${T.pgBindHost}:${T.pgPort}/${T.database}`,
  }, null, 2)}\n`, { mode: 0o600 });

  await startLegacyStack();
  const up = await waitForLegacySite();
  const after = checkDatabase(passwords, baseline, T.identityKind);
  for (const p of after) log(`  PROBLEM after the v0.6.0 boot: ${p}`);
  await remoteStatus();
  if (!up) {
    log(`the v0.6.0 site did not answer on :${T.legacyWebPort}; read the stack: bun run smoke:status --instance ${T.instance} in ${T.legacyCheckout}`);
    return 1;
  }
  return after.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------

/** `down` removes only its own folders, never the release runner's capture checkout. */
function assertOwnPath(dir: string): void {
  const refusal = removalRefusal(dir, retiredLegacyCheckouts(), [CAPTURE_CHECKOUT.checkout]);
  if (refusal !== undefined) throw new Error(refusal);
}

async function remoteDown(): Promise<number> {
  // The v0.6.0 stack, by its own tool and state: the legacy checkout started it, a rehearsal's boot may have replaced it.
  const stackState = join(T.home, ".local", "state", "robotmoney-smoke", T.instance);
  for (const dir of [T.checkout, T.legacyCheckout, ...retiredLegacyCheckouts()]) {
    if (existsSync(stackState) && existsSync(join(dir, "package.json"))) {
      log(`bun smoke:down --instance ${T.instance} (from ${dir})`);
      run(["bun", "smoke:down", "--instance", T.instance], { cwd: dir, env: { HOME: T.home, RM_ENV: "stage" } });
    }
  }
  const containers = projectContainers();
  if (containers.length) {
    log(`removing ${containers.length} stack container(s)`);
    run(["docker", "rm", "-f", "-v", ...containers]);
  }
  for (const p of targetProjects()) {
    const nets = run(["docker", "network", "ls", "-q", "--filter", `label=com.docker.compose.project=${p}`]).stdout.split("\n").filter(Boolean);
    if (nets.length) run(["docker", "network", "rm", ...nets]);
    const vols = [
      ...dockerNames("volume", `label=com.docker.compose.project=${p}`),
      ...dockerNames("volume", `label=robotmoney.smoke.project=${p}`),
    ];
    if (vols.length) run(["docker", "volume", "rm", "-f", ...new Set(vols)]);
    const images = run(["docker", "images", "-q", "--filter", `reference=${p}-*`]).stdout.split("\n").filter(Boolean);
    if (images.length) run(["docker", "image", "rm", "-f", ...new Set(images)]);
  }
  if (dockerNames("container", `name=^${T.pgContainer}$`).length) {
    log(`removing ${T.pgContainer}`);
    run(["docker", "rm", "-f", "-v", T.pgContainer]);
  }
  if (dockerNames("volume", `name=^${T.pgVolume}$`).length) {
    log(`removing volume ${T.pgVolume}`);
    run(["docker", "volume", "rm", T.pgVolume]);
  }
  // Never the capture checkout (CAPTURE_CHECKOUT): the release runner owns it.
  for (const dir of [T.legacyCheckout, ...retiredLegacyCheckouts(), T.checkout, T.home]) {
    assertOwnPath(dir);
    if (existsSync(dir)) {
      log(`removing ${dir}`);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith(`robotmoney-smoke-${T.instance}-secrets-`)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
  log("down: nothing of the stage target is left");
  return 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function line(piece: string, state: string): void {
  console.log(`  ${piece.padEnd(22)} ${state}`);
}

async function remoteStatus(): Promise<number> {
  console.log(`[stage-target] status on ${T.host}`);
  const pg = run(["docker", "inspect", "-f", "{{.State.Status}} {{.Config.Image}} started {{.State.StartedAt}}", T.pgContainer]);
  line("postgres", pg.code === 0 ? `${T.pgContainer} ${pg.stdout.trim()} on ${T.pgBindHost}:${T.pgPort}` : "absent");
  if (pg.code === 0 && pg.stdout.startsWith("running")) {
    try {
      const s = parseKeyValues(psql(RESTORED_STATE_QUERY, { tuples: true }));
      line("database", `ledger=${s.ledger} deployment_identity=${s.identity_table} (${s.identity_kind}) ssl=${s.ssl} server=${s.server_version}`);
      line("roles", `rm_owner login=${s.rm_owner_login}; doadmin super=${s.doadmin_super} createrole=${s.doadmin_createrole}`);
    } catch (e) {
      line("database", `unreadable: ${(e as Error).message}`);
    }
  }
  line("volume", dockerNames("volume", `name=^${T.pgVolume}$`).length ? T.pgVolume : "absent");
  const homeEnv = join(T.home, ".env");
  if (existsSync(homeEnv)) {
    const keys = envKeyNames(readFileSync(homeEnv, "utf8"));
    const want: readonly string[] = PROD_HOME_ENV_KEYS;
    const same = keys.length === want.length && want.every((k) => keys.includes(k));
    line("~/.env", `${homeEnv} keys: ${keys.join(" ")} (${same ? "production's key names" : "DIFFERS from production's"})`);
    if (keys.includes("doadmin")) line("", "REFUSE: ~/.env holds a doadmin line; doadmin is stored in no file (D61)");
  } else line("~/.env", "absent");
  for (const [name, dir] of [["legacy checkout", T.legacyCheckout], ["release checkout", T.checkout]] as const) {
    const head = existsSync(dir) ? run(["git", "-C", dir, "log", "-1", "--format=%h %s"]).stdout.trim() : "";
    line(name, head ? `${dir} at ${head.slice(0, 100)}` : "absent");
  }
  const containers = projectContainers().map((n) => run(["docker", "inspect", "-f", "{{.Name}} {{.State.Status}}", n]).stdout.trim());
  line("v0.6.0 stack", containers.length ? "" : "no containers");
  for (const c of containers) line("", c);
  const site = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", `http://127.0.0.1:${T.legacyWebPort}/`]).stdout.trim();
  line("site", `http://127.0.0.1:${T.legacyWebPort}/ -> ${site || "no answer"}`);
  return 0;
}

/**
 * Stage only: give the stage doadmin a fresh password and print it, alone, to
 * stdout, for `| bun run role-passwords --target stage --doadmin-stdin`. It is
 * set through the container's local superuser socket (psql reads the statement
 * on stdin, never argv) and written to no file. A disposable stage credential:
 * production has no such command.
 */
function remoteDoadmin(): number {
  const running = run(["docker", "inspect", "-f", "{{.State.Status}}", T.pgContainer]);
  if (running.code !== 0 || !running.stdout.startsWith("running")) throw new Refusal(`${T.pgContainer} is not running: run \`stage-target up\` first`);
  const password = generatePassword();
  psql(doadminPasswordSql(password), { secret: true });
  process.stdout.write(`${password}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// The control machine
// ---------------------------------------------------------------------------

const SSH = ["ssh", "-o", "BatchMode=yes", T.host];

async function control(command: string, args: string[]): Promise<number> {
  const built = await Bun.build({ entrypoints: [import.meta.path], target: "bun" });
  if (!built.success || !built.outputs[0]) {
    for (const m of built.logs) console.error(m);
    throw new Error("could not bundle stage-target.ts");
  }
  const local = join(tmpdir(), `stage-target-${process.pid}.js`);
  writeFileSync(local, await built.outputs[0].text());
  try {
    must([...SSH, "mkdir", "-p", T.toolDir], "ssh mkdir");
    must(["scp", "-q", "-o", "BatchMode=yes", local, `${T.host}:${T.toolDir}/stage-target.js`], "scp");
  } finally {
    rmSync(local, { force: true });
  }
  const remote = ["bun", `${T.toolDir}/stage-target.js`, "remote", command, ...args].map(shellQuote).join(" ");
  const p = Bun.spawn([...SSH, remote], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return await p.exited;
}

const USAGE = `usage: bun scripts/release/stage-target.ts up --dump <dir on ${T.host}> [--replace] | status | down | doadmin`;

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  try {
    if (first === "remote") {
      const [command, ...args] = rest;
      if (command === "up") return await remoteUp(args);
      if (command === "down") return await remoteDown();
      if (command === "status") return await remoteStatus();
      if (command === "doadmin") return remoteDoadmin();
      console.error(USAGE);
      return 2;
    }
    if (first === "up" || first === "down" || first === "status" || first === "doadmin") return await control(first, rest);
    console.error(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`[stage-target] REFUSED: ${e.message}`);
      return 2;
    }
    console.error(`[stage-target] FAILED: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
