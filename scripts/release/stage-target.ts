#!/usr/bin/env bun
// The stage target: a production-shaped target on stage-2 for unmodified
// rehearsals (D61 rule 2, docs/runbooks/stage-target.md).
//
//   bun scripts/release/stage-target.ts dump      (S0: reuse the newest dump at most 24 h old, else capture one)
//   bun scripts/release/stage-target.ts up --dump <dir on stage-2 | newest> [--replace]
//   bun scripts/release/stage-target.ts status
//   bun scripts/release/stage-target.ts down
//   bun scripts/release/stage-target.ts doadmin   (stage only: a fresh doadmin password on stdout, for a pipe)
//
// Run from the CONTROL machine. It bundles itself, copies the bundle to the
// stage host and runs it there over ssh with stdin closed (`remote <command>`).
// Every secret is generated and written on the host: no password crosses ssh,
// appears in a process argument or reaches this terminal.
//
// What `up` builds, in order. It holds no past-upgrade fact (issue 1272):
// the tag and commit come from production's /api/version, the ledger from the
// dump itself, and the running checkout is whatever production runs.
//   1. the running checkout, at the tag production reports (else its commit);
//   2. `$HOME` for the target, with a self-signed TLS certificate;
//   3. a long-lived Postgres 18 container over TLS on a fixed port, its data in
//      a named volume;
//   4. DigitalOcean's role shape from the dump's own globals, with generated
//      passwords (rm_owner with a password nobody keeps, doadmin CREATEROLE
//      with a password held in memory for the checks, then dropped);
//   5. the restored dump, then its own ledger read back in applied order;
//   6. production's owners and grants, from a replay of exactly that ledger
//      in a scratch database (the capture carries none), copied onto the
//      restored copy and compared line by line; the identity row enrolled
//      rehearsal;
//   7. `~/.env` with production's key names plus the rm_owner line;
//   8. the stack, booted the production way from the running checkout:
//      credential file, env rewrite, service tokens, boot, the in-house
//      members rebound onto the stage keys, boot again. Docker keeps it
//      running, as on production. The release checkout is not made here: R1.1
//      clones it.
//
// doadmin is stored in no file (D61, owner 2026-10-08). The stage sequence is
// the release runbook's own first steps (S0 `dump`, S1 `up --dump newest`, S2
//
//   bun scripts/release/stage-target.ts doadmin | bun run role-passwords --target stage --doadmin-stdin
//
// ), run by `release:run --target stage --until S2`. `doadmin` gives the stage doadmin a fresh password
// through the container's local superuser socket and prints it to stdout, for
// that pipe and nothing else. It exists because this is a disposable stage
// database; production has no such command (its doadmin is typed by the admin).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEnvFile } from "../lib/env-role.ts";
import { POSTGRES_IMAGE } from "../lib/postgres-image.ts";
import { resolveBackupFiles, restorePipelineArgv, SHM_FLAGS } from "../lib/restore-container.ts";
import { instanceStackProject } from "../lib/smoke-state.ts";
import { repoMigrations } from "./ledger.ts";
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
  GRANTS_RECONCILE_FILE,
  grantsReconcileScript,
  GENERATED_PASSWORD_ROLES,
  globalsToRoleSql,
  newestFreshDump,
  LEDGER_TABLE_SQL,
  parseKeyValues,
  parseRunningVersion,
  pgHbaConf,
  PROD_HOME_ENV_KEYS,
  removalRefusal,
  replayMigrationScript,
  RESTORED_STATE_QUERY,
  restoredProblems,
  ROLE_SHAPE_QUERY,
  roleShapeProblems,
  rolePasswordSql,
  shellQuote,
  STAGE_TARGET as T,
  stageTargetDirs,
  tlsSettingsSql,
  upPlan,
  type GeneratedPasswordRole,
  type RunningVersion,
  type StageHomeEnv,
  type UpPlan,
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

/** The compose project the instance's stack runs under. */
function targetProject(): string {
  return instanceStackProject(T.instance, {});
}

function projectContainers(): string[] {
  const names = new Set<string>();
  const p = targetProject();
  for (const n of dockerNames("container", `label=com.docker.compose.project=${p}`)) names.add(n);
  for (const n of dockerNames("container", `label=robotmoney.smoke.project=${p}`)) names.add(n);
  return [...names];
}

function existingPieces(): string[] {
  const pieces: string[] = [];
  if (dockerNames("container", `name=^${T.pgContainer}$`).length) pieces.push(`container ${T.pgContainer}`);
  if (dockerNames("volume", `name=^${T.pgVolume}$`).length) pieces.push(`volume ${T.pgVolume}`);
  for (const dir of stageTargetDirs()) if (existsSync(dir)) pieces.push(`directory ${dir}`);
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

/** Clone the repository into `dir` and detach it at `ref`: the tag production reports, else its commit. */
function cloneAt(dir: string, ref: string): void {
  log(`cloning ${ref} into ${dir}`);
  const cloned = run(["git", "clone", "--quiet", "--reference-if-able", T.referenceClone, "--dissociate", T.repoUrl, dir]);
  if (cloned.code !== 0) {
    log(`clone from ${T.repoUrl} failed (${cloned.stderr.trim().split("\n").pop()}); cloning from ${T.referenceClone} instead`);
    rmSync(dir, { recursive: true, force: true });
    must(["git", "clone", "--quiet", "--no-hardlinks", T.referenceClone, dir], "git clone");
    must(["git", "-C", dir, "remote", "set-url", "origin", T.repoUrl], "git remote set-url");
  }
  must(["git", "-C", dir, "fetch", "--quiet", "--tags", "origin"], "git fetch --tags");
  must(["git", "-C", dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", ref], `git checkout ${ref}`);
}

/** What production runs, from its /api/version: the commit the dump's world is at, and the tag the boot carried. */
async function readRunningVersion(): Promise<RunningVersion> {
  const url = `${T.productionOrigin}/api/version`;
  let text: string | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "cache-control": "no-cache" } });
    text = res.ok ? await res.text() : null;
  } catch { text = null; }
  const v = parseRunningVersion(text);
  if ("error" in v) throw new Refusal(`${url}: ${v.error}`);
  log(`production runs ${v.commit.slice(0, 8)}${v.tag ? ` (${v.tag})` : " (no tag)"} per ${url}`);
  return v;
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
 * Replay the dump's own ledger (the plan's list, in the dump's order) from
 * the running checkout in a scratch database, as the migrate applied it, then
 * the grants reconcile, and return the statements that give the restored copy
 * the same owners and grants, with the reference fingerprint.
 */
function referenceGrants(plan: UpPlan): { statements: string; fingerprint: string } {
  const dir = join(T.runningCheckout, "backend", "migrations");
  log(`replaying the dump's ${plan.replay.length} ledger files as doadmin in ${T.referenceDatabase}, in the dump's order`);
  psql(`DROP DATABASE IF EXISTS ${T.referenceDatabase};`);
  psql(`CREATE DATABASE ${T.referenceDatabase} OWNER doadmin;`);
  psql(LEDGER_TABLE_SQL, { user: "doadmin", db: T.referenceDatabase });
  for (const f of plan.replay) {
    psql(replayMigrationScript(f, readFileSync(join(dir, f), "utf8")), { user: "doadmin", db: T.referenceDatabase, single: true });
  }
  psql(grantsReconcileScript(readFileSync(join(T.runningCheckout, GRANTS_RECONCILE_FILE), "utf8")), { user: "doadmin", db: T.referenceDatabase, single: true });
  const statements = psql(ACL_EXPORT_SQL, { db: T.referenceDatabase, tuples: true });
  const fingerprint = psql(ACL_FINGERPRINT_SQL, { db: T.referenceDatabase, tuples: true });
  psql(`DROP DATABASE ${T.referenceDatabase};`);
  log(`reference: ${statements.split("\n").filter(Boolean).length} ownership and grant statements`);
  return { statements, fingerprint };
}

/** The restored database's ledger, in the order it was applied: the dump's own list, never a constant. */
function readRestoredLedger(): string[] {
  return psql(`SELECT name FROM schema_migrations ORDER BY applied_at, name COLLATE "C";`, { tuples: true }).split("\n").filter(Boolean);
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
    SWARM_SCHEDULES_ENABLED: "0",
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
  // Production's ~/.env holds rm_owner since role-passwords ran (2026-10-08).
  appendFileSync(homeEnv, `rm_owner = ${passwords.rm_owner}\n`);
  log(`wrote ${homeEnv} (0600): ${envKeyNames(readFileSync(homeEnv, "utf8")).join(", ")}`);
  return values;
}

function checkDatabase(passwords: Record<GeneratedPasswordRole, string>, replayed: readonly string[]): string[] {
  const state = parseKeyValues(psql(RESTORED_STATE_QUERY, { tuples: true }));
  const ledger = readRestoredLedger();
  const problems = restoredProblems(state, ledger, replayed);
  problems.push(...roleShapeProblems(psql(ROLE_SHAPE_QUERY, { tuples: true }), psql(DOADMIN_ADMIN_QUERY, { tuples: true })));
  for (const role of ["doadmin", "rm_app", "rm_worker", "rm_readonly"] as const) {
    const r = hostPsql(role, passwords[role], "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid();");
    if (r.code !== 0 || r.stdout.trim() !== "t") problems.push(`${role} cannot log in over TLS from the host (${r.stderr.trim().split("\n")[0] ?? ""})`);
  }
  if (state.rm_owner_login === "false") {
    const owner = hostPsql("rm_owner", passwords.rm_owner, "SELECT 1;");
    if (owner.code === 0) problems.push("rm_owner logged in; production's rm_owner is NOLOGIN");
  }
  const su = run(["psql", "-X", "-At", `host=${T.pgBindHost} port=${T.pgPort} dbname=${T.database} user=${T.superuser} sslmode=require connect_timeout=5`, "-c", "SELECT 1"], { env: { PGPASSWORD: "x" } });
  if (su.code === 0) problems.push("the container superuser logged in over the network");
  const plain = run(["psql", "-X", "-At", `host=${T.pgBindHost} port=${T.pgPort} dbname=${T.database} user=rm_app sslmode=disable connect_timeout=5`, "-c", "SELECT 1"], { env: { PGPASSWORD: passwords.rm_app } });
  if (plain.code === 0) problems.push("rm_app logged in without TLS");
  log(`database: ledger=${state.ledger} identity=${state.identity_table} rm_owner_login=${state.rm_owner_login} doadmin_super=${state.doadmin_super} doadmin_createrole=${state.doadmin_createrole} ssl=${state.ssl} server=${state.server_version}`);
  return problems;
}

/**
 * The database: roles from the globals, the restored dump, its own ledger
 * read back, the running checkout cloned at production's ref (so it holds
 * every file that ledger names), the plan, the reference replay and its
 * owners and grants copied onto the restored copy.
 */
async function buildDatabase(backup: ReturnType<typeof readDumpPreflight>, running: RunningVersion): Promise<{ passwords: Record<GeneratedPasswordRole, string>; plan: UpPlan }> {
  startPostgres();
  await waitForPostgres();
  enableTls();
  const passwords = Object.fromEntries(GENERATED_PASSWORD_ROLES.map((r) => [r, generatePassword()])) as Record<GeneratedPasswordRole, string>;
  const globals = decryptGlobals(backup);
  applyRoles(globals, passwords);
  psql(`ALTER DATABASE ${T.database} OWNER TO doadmin;`);
  log(`restoring ${backup.dumpEnc} into ${T.database} (the long step)`);
  const started = Date.now();
  const pipeline = Bun.spawn(restorePipelineArgv(backup.passphraseFile, backup.dumpEnc, T.pgContainer, T.superuser, T.database), {
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const restoreExit = await pipeline.exited;
  if (restoreExit !== 0) throw new Error(`pg_restore failed (exit ${restoreExit})`);
  log(`restore done in ${Math.round((Date.now() - started) / 1000)} s`);
  const ledger = readRestoredLedger();
  log(`the dump's ledger: ${ledger.length} rows, newest ${ledger.at(-1)}`);
  const planned = upPlan({ ledger, running }, repoMigrations(join(T.runningCheckout, "backend", "migrations")));
  if ("errors" in planned) throw new Error(`the dump cannot be replayed from the running checkout: ${planned.errors.join("; ")}`);
  const reference = referenceGrants(planned);
  // The replay ran 0053, whose ALTER ROLE lines are cluster-wide: put production's attribute lines back.
  applyRoles(globals, passwords);
  psql(bindDatabase(reference.statements, T.database), { single: true });
  const restored = psql(ACL_FINGERPRINT_SQL, { tuples: true });
  const diff = fingerprintDiff(reference.fingerprint, restored);
  if (diff.onlyReference.length || diff.onlyRestored.length) {
    for (const l of diff.onlyReference.slice(0, 20)) log(`  only in the replayed ledger: ${l}`);
    for (const l of diff.onlyRestored.slice(0, 20)) log(`  only in the restored dump:   ${l}`);
    throw new Error(`owners and grants differ from the replayed ledger: ${diff.onlyReference.length} and ${diff.onlyRestored.length} lines`);
  }
  log(`owners and grants equal the replayed ledger (${restored.split("\n").filter(Boolean).length} lines)`);
  const enrolled = parseKeyValues(psql(ENROLL_REHEARSAL_SQL, { tuples: true }));
  if (enrolled.identity_kind !== "rehearsal") throw new Error(`the identity row reads ${enrolled.identity_kind} after the enrollment`);
  log("deployment_identity enrolled rehearsal");
  psql("ANALYZE;");
  return { passwords, plan: planned };
}

/**
 * Bring the stack up the production way, from the running checkout under
 * `env -i`: the credential file for the in-house members (fresh stage keys),
 * the ~/.env rewrite, the service tokens, boot, the rebind of the in-house
 * members onto those keys (the dump holds production's), boot again. Docker
 * keeps the stack running, as on production. This builds the stage world; it
 * is no release step.
 */
async function startStack(): Promise<void> {
  const receipts = join(T.home, ".local", "state", "robotmoney-release", "stage-target-up");
  mkdirSync(receipts, { recursive: true });
  const confirm = `${T.pgBindHost}:${T.pgPort}/${T.database}`;
  const env = ["env", "-i", `HOME=${T.home}`, "PATH=/home/stage-server/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "RM_ENV=stage", "PROJECTS_SOURCE=live"];
  const steps: [string, string[]][] = [
    ["credentials", ["bun", "scripts/release/credentials-init.ts", "--receipt-dir", receipts]],
    ["env rewrite", ["bun", "scripts/release/env-rewrite.ts", "--run", new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"), "--receipt-dir", receipts]],
    ["tokens", ["bun", "scripts/prod-init.ts", "provision-tokens", "--instance", T.instance, "--confirm-target", confirm]],
    ["boot 1", ["bun", "run", "smoke", "--static-port", "--instance", T.instance]],
    ["rebind", ["bun", "scripts/prod-init.ts", "rebind-members", "--instance", T.instance, "--confirm-target", confirm]],
    ["boot 2", ["bun", "run", "smoke", "--static-port", "--instance", T.instance]],
  ];
  for (const [name, argv] of steps) await stream([...env, ...argv], `stack: ${name}`, { cwd: T.runningCheckout });
}

async function waitForSite(): Promise<boolean> {
  const deadline = Date.now() + 45 * 60_000;
  let lastNote = 0;
  while (Date.now() < deadline) {
    const r = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", `http://127.0.0.1:${T.webPort}/`]);
    if (r.stdout.trim() === "200") {
      log(`the site answers 200 on :${T.webPort}`);
      return true;
    }
    if (Date.now() - lastNote > 120_000) {
      lastNote = Date.now();
      log(`waiting for :${T.webPort} (${r.stdout.trim() || "no answer"})`);
    }
    await Bun.sleep(10_000);
  }
  return false;
}

/** What the booted stack reports, for the record and the status. */
function servedVersion(): string {
  return run(["curl", "-s", "--max-time", "5", `http://127.0.0.1:${T.webPort}/api/version`]).stdout.trim() || "(no answer)";
}

/** The production dumps on this host, with the `capturedAt` their manifests carry. */
function listDumps(): { dir: string; capturedAt?: string }[] {
  const home = process.env.HOME ?? "";
  const out: { dir: string; capturedAt?: string }[] = [];
  for (const name of readdirSync(home)) {
    if (!name.startsWith("rm-backup-prod-")) continue;
    const dir = join(home, name);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { capturedAt?: string };
      out.push({ dir, capturedAt: manifest.capturedAt });
    } catch {
      out.push({ dir });
    }
  }
  return out;
}

/**
 * S0 (SR.0, owner 2026-10-08): the newest production dump on this host that is
 * at most 24 hours old, else a new capture from production's read replica by the
 * capture checkout (the same `bun smoke:capture` R2.1 runs). Never a stale dump.
 */
async function remoteDump(): Promise<number> {
  const fresh = newestFreshDump(listDumps(), new Date());
  if (fresh) {
    log(`reusing ${fresh}: the newest dump, at most ${T.maxDumpAgeHours} h old`);
    return 0;
  }
  const checkout = CAPTURE_CHECKOUT.checkout;
  if (!existsSync(join(checkout, ".git"))) throw new Refusal(`no dump is at most ${T.maxDumpAgeHours} h old, and the capture checkout ${checkout} is absent: clone it, then run this again`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const out = join(process.env.HOME ?? "", `rm-backup-prod-${stamp}`);
  log(`no dump is at most ${T.maxDumpAgeHours} h old: capturing ${out} from production's read replica`);
  await stream(["bun", "run", "smoke:capture", "--out", out], "smoke:capture", { cwd: checkout, env: { RM_ENV: "stage" } });
  return 0;
}

async function remoteUp(args: string[]): Promise<number> {
  const dumpIdx = args.indexOf("--dump");
  const dumpArg = dumpIdx >= 0 ? args[dumpIdx + 1] : undefined;
  if (!dumpArg) throw new Refusal("up needs --dump <dir on the stage host | newest>");
  const dumpDir = dumpArg === "newest" ? newestFreshDump(listDumps(), new Date()) : dumpArg;
  if (!dumpDir) throw new Refusal(`--dump newest: no dump on this host is at most ${T.maxDumpAgeHours} h old; run \`stage-target dump\` first (S0)`);
  const replace = args.includes("--replace");
  const backup = readDumpPreflight(dumpDir);
  const running = await readRunningVersion();

  const existing = existingPieces();
  if (existing.length) {
    if (!replace) throw new Refusal(`a stage target already exists (${existing.join("; ")}). Pass --replace to rebuild it`);
    log(`--replace: taking the existing target down first`);
    await remoteDown();
  }
  for (const port of [T.pgPort, T.webPort]) {
    const holder = portHolder(port);
    if (holder) throw new Refusal(`port ${port} is held: ${holder}`);
  }

  mkdirSync(T.home, { recursive: true, mode: 0o700 });
  chmodSync(T.home, 0o700);
  cloneAt(T.runningCheckout, running.tag ?? running.commit);
  const head = run(["git", "-C", T.runningCheckout, "rev-parse", "HEAD"]).stdout.trim();
  if (head !== running.commit) throw new Error(`the running checkout is at ${head}, but production's ${running.tag ?? "commit"} is ${running.commit}`);
  await bunInstall(T.runningCheckout, [".", "backend"]);

  const { passwords, plan } = await buildDatabase(backup, running);
  const problems = checkDatabase(passwords, plan.replay);
  if (problems.length) {
    for (const p of problems) log(`  PROBLEM: ${p}`);
    throw new Error(`the stage database does not match the dump's shape (${problems.length} problems)`);
  }
  log("the stage database matches the dump's shape");
  writeEnvFiles(passwords);
  writeFileSync(join(T.home, "stage-target.json"), `${JSON.stringify({
    builtAt: new Date().toISOString(),
    dump: dumpDir,
    stamp: backup.stamp,
    running: { commit: running.commit, tag: running.tag, ref: plan.ref },
    ledger: plan.replay.length,
    pg: `${T.pgContainer} ${POSTGRES_IMAGE} ${T.pgBindHost}:${T.pgPort}/${T.database}`,
  }, null, 2)}\n`, { mode: 0o600 });

  await startStack();
  const up = await waitForSite();
  const after = checkDatabase(passwords, plan.replay);
  for (const p of after) log(`  PROBLEM after the boot: ${p}`);
  await remoteStatus();
  if (!up) {
    log(`the site did not answer on :${T.webPort}`);
    return 1;
  }
  return after.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------

/** `down` removes only its own folders, never the release runner's capture checkout. */
function assertOwnPath(dir: string): void {
  const refusal = removalRefusal(dir, [CAPTURE_CHECKOUT.checkout]);
  if (refusal !== undefined) throw new Error(refusal);
}

async function remoteDown(): Promise<number> {
  // The stack, by its own tool and state, from whichever checkout still holds the tool.
  const state = join(T.home, ".local", "state", "robotmoney-smoke", T.instance);
  const tool = [T.runningCheckout, T.checkout].find((d) => existsSync(join(d, "package.json")));
  if (existsSync(state) && tool !== undefined) {
    log(`bun smoke:down --instance ${T.instance} (from ${tool})`);
    run(["bun", "smoke:down", "--instance", T.instance], { cwd: tool, env: { HOME: T.home, RM_ENV: "stage" } });
  }
  const containers = projectContainers();
  if (containers.length) {
    log(`removing ${containers.length} stack container(s)`);
    run(["docker", "rm", "-f", "-v", ...containers]);
  }
  for (const p of [targetProject()]) {
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
  for (const dir of [T.runningCheckout, T.checkout, T.home]) {
    assertOwnPath(dir);
    if (existsSync(dir)) {
      log(`removing ${dir}`);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith(`robotmoney-smoke-${targetProject()}-secrets-`)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
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
      line("database", `ledger=${s.ledger} deployment_identity=${s.identity_table} ssl=${s.ssl} server=${s.server_version}`);
      line("roles", `rm_owner login=${s.rm_owner_login}; doadmin super=${s.doadmin_super} createrole=${s.doadmin_createrole}`);
      if (s.identity_table !== "none") {
        line("identity row", psql("SELECT string_agg(kind::text, ',') FROM deployment_identity;", { tuples: true }).trim());
      }
    } catch (e) {
      line("database", `unreadable: ${(e as Error).message}`);
    }
  }
  line("volume", dockerNames("volume", `name=^${T.pgVolume}$`).length ? T.pgVolume : "absent");
  const homeEnv = join(T.home, ".env");
  if (existsSync(homeEnv)) {
    const keys = envKeyNames(readFileSync(homeEnv, "utf8"));
    const want: readonly string[] = PROD_HOME_ENV_KEYS;
    const pre = keys.length === want.length && want.every((k) => keys.includes(k));
    const after = keys.length === want.length + 1 && want.every((k) => keys.includes(k)) && keys.includes("rm_owner");
    line("~/.env", `${homeEnv} keys: ${keys.join(" ")} (${pre ? "production's key names: role-passwords not yet run" : after ? "production's key names + the rm_owner line role-passwords wrote" : "DIFFERS from production's"})`);
    if (keys.includes("doadmin")) line("", "REFUSE: ~/.env holds a doadmin line; doadmin is stored in no file (D61)");
  } else line("~/.env", "absent");
  for (const [name, dir] of [["running checkout", T.runningCheckout], ["release checkout", T.checkout]] as const) {
    const head = existsSync(dir) ? run(["git", "-C", dir, "log", "-1", "--format=%h %s"]).stdout.trim() : "";
    const tag = existsSync(dir) ? run(["git", "-C", dir, "describe", "--tags", "--exact-match"]).stdout.trim() : "";
    line(name, head ? `${dir} at ${head.slice(0, 100)}${tag ? ` (${tag})` : ""}` : "absent");
  }
  const containers = run(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${targetProject()}`, "--format", "{{.Names}} {{.Status}} {{.Ports}}"]).stdout.trim();
  line("stack", containers ? `project ${targetProject()}` : "no containers");
  for (const c of containers.split("\n").filter(Boolean)) line("", c);
  const site = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", `http://127.0.0.1:${T.webPort}/`]).stdout.trim();
  line("site", `http://127.0.0.1:${T.webPort}/ -> ${site || "no answer"}`);
  line("/api/version", servedVersion().slice(0, 200));
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

const USAGE = `usage: bun scripts/release/stage-target.ts dump | up --dump <dir on ${T.host} | newest> [--replace] | status | down | doadmin`;

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  try {
    if (first === "remote") {
      const [command, ...args] = rest;
      if (command === "dump") return await remoteDump();
      if (command === "up") return await remoteUp(args);
      if (command === "down") return await remoteDown();
      if (command === "status") return await remoteStatus();
      if (command === "doadmin") return remoteDoadmin();
      console.error(USAGE);
      return 2;
    }
    if (first === "dump" || first === "up" || first === "down" || first === "status" || first === "doadmin") return await control(first, rest);
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
