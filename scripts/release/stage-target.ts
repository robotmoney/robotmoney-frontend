#!/usr/bin/env bun
// The stage target: a production-shaped target on stage-2 for unmodified
// rehearsals (D61 rule 2, docs/runbooks/stage-target.md).
//
//   bun scripts/release/stage-target.ts up --dump <dir on stage-2> [--replace]
//   bun scripts/release/stage-target.ts status
//   bun scripts/release/stage-target.ts down
//
// Run from the CONTROL machine. It bundles itself, copies the bundle to the
// stage host and runs it there over ssh with stdin closed (`remote <command>`).
// Every secret is generated and written on the host: no password crosses ssh,
// appears in a process argument or reaches this terminal.
//
// What `up` builds, in order:
//   1. the two checkouts: legacy v0.5.4 at production's commit, v0.6.0 at the
//      release commit;
//   2. `$HOME` for the target, with a self-signed TLS certificate;
//   3. a long-lived Postgres 18 container over TLS on a fixed port, its data in
//      a named volume;
//   4. DigitalOcean's role shape from the dump's own globals, with generated
//      passwords (rm_owner NOLOGIN with a password, doadmin CREATEROLE);
//   5. production's owners and grants, from a replay of the 76 ledger files in
//      a scratch database (the capture carries none);
//   6. the restored dump, with those owners and grants, checked against the
//      pre-cutover shape (ledger 76, no deployment_identity);
//   7. `~/.env` with production's key names plus rm_owner and doadmin, and the
//      legacy checkout `.env` with production's key names;
//   8. the legacy stack and its driver in tmux, started as production's are.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEnvFile } from "../lib/env-role.ts";
import { POSTGRES_IMAGE } from "../lib/postgres-image.ts";
import { resolveBackupFiles, restorePipelineArgv, SHM_FLAGS } from "../lib/restore-container.ts";
import { instanceStackProject } from "../lib/smoke-state.ts";
import {
  ACL_EXPORT_SQL,
  ACL_FINGERPRINT_SQL,
  bindDatabase,
  composeLegacyCheckoutEnv,
  composeStageHomeEnv,
  D61_HOME_ENV_KEYS,
  DOADMIN_ADMIN_QUERY,
  dumpAgeHours,
  envKeyNames,
  fingerprintDiff,
  GENERATED_PASSWORD_ROLES,
  globalsToRoleSql,
  LEGACY_LEDGER_TABLE_SQL,
  legacyLaunchScript,
  legacyMigrationScript,
  parseKeyValues,
  pgHbaConf,
  PRECUTOVER_STATE_QUERY,
  precutoverProblems,
  PROD_HOME_ENV_KEYS,
  PROD_LEGACY_CHECKOUT_ENV_KEYS,
  PROVISION_TAXONOMY_FILE,
  provisionTaxonomyScript,
  ROLE_SHAPE_QUERY,
  roleShapeProblems,
  rolePasswordSql,
  shellQuote,
  STAGE_TARGET as T,
  tlsSettingsSql,
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

function tmuxHasSession(): boolean {
  return run(["tmux", "has-session", "-t", `=${T.driverSession}`]).code === 0;
}

/** The compose projects this target's stacks may run under: the legacy one and v0.6's for the instance. */
function targetProjects(): string[] {
  return [...new Set([T.legacyProject, instanceStackProject(T.instance, {})])];
}

function projectContainers(): string[] {
  const names = new Set<string>();
  for (const p of targetProjects()) {
    for (const n of dockerNames("container", `label=com.docker.compose.project=${p}`)) names.add(n);
    for (const n of dockerNames("container", `label=robotmoney.smoke.project=${p}`)) names.add(n);
  }
  return [...names];
}

function existingPieces(): string[] {
  const pieces: string[] = [];
  if (dockerNames("container", `name=^${T.pgContainer}$`).length) pieces.push(`container ${T.pgContainer}`);
  if (dockerNames("volume", `name=^${T.pgVolume}$`).length) pieces.push(`volume ${T.pgVolume}`);
  for (const dir of [T.home, T.checkout, T.legacyCheckout]) if (existsSync(dir)) pieces.push(`directory ${dir}`);
  if (tmuxHasSession()) pieces.push(`tmux session ${T.driverSession}`);
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
 * Replay production's ledger in a scratch database, as the legacy runner did,
 * and return the statements that give the restored copy the same owners and
 * grants, with the reference fingerprint.
 */
function referenceGrants(baseline: readonly string[]): { statements: string; fingerprint: string } {
  const dir = join(T.legacyCheckout, "backend", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const missing = baseline.filter((f) => !files.includes(f));
  const extra = files.filter((f) => !baseline.includes(f));
  if (missing.length || extra.length) {
    throw new Error(`the legacy checkout's migrations are not production's ledger: missing ${missing.join(",") || "none"}, extra ${extra.join(",") || "none"}`);
  }
  log(`replaying production's ${files.length} ledger files as doadmin in ${T.referenceDatabase}`);
  psql(`DROP DATABASE IF EXISTS ${T.referenceDatabase};`);
  psql(`CREATE DATABASE ${T.referenceDatabase} OWNER doadmin;`);
  psql(LEGACY_LEDGER_TABLE_SQL, { user: "doadmin", db: T.referenceDatabase });
  for (const f of files) {
    psql(legacyMigrationScript(f, readFileSync(join(dir, f), "utf8")), { user: "doadmin", db: T.referenceDatabase, single: true });
  }
  log("applying the out-of-band taxonomy provisioning (0053 alone, as provision-db-role-taxonomy.sh did)");
  psql(provisionTaxonomyScript(readFileSync(join(dir, PROVISION_TAXONOMY_FILE), "utf8")), { user: "doadmin", db: T.referenceDatabase, single: true });
  const statements = psql(ACL_EXPORT_SQL, { db: T.referenceDatabase, tuples: true });
  const fingerprint = psql(ACL_FINGERPRINT_SQL, { db: T.referenceDatabase, tuples: true });
  psql(`DROP DATABASE ${T.referenceDatabase};`);
  log(`reference: ${statements.split("\n").filter(Boolean).length} ownership and grant statements`);
  return { statements, fingerprint };
}

function readBaseline(): string[] {
  const baseline = JSON.parse(readFileSync(join(T.checkout, T.baselineFile), "utf8")) as { ledger: { file: string }[] };
  return baseline.ledger.map((l) => l.file);
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
    rm_owner: passwords.rm_owner,
    doadmin: passwords.doadmin,
    OPENCODE_API_KEY: stageDefault.OPENCODE_API_KEY!,
    COINGECKO_API_KEY: stageDefault.COINGECKO_API_KEY!,
  };
  const homeEnv = join(T.home, ".env");
  writeFileSync(homeEnv, composeStageHomeEnv(values), { mode: 0o600 });
  chmodSync(homeEnv, 0o600);
  const legacyEnv = join(T.legacyCheckout, ".env");
  writeFileSync(legacyEnv, composeLegacyCheckoutEnv(values), { mode: 0o600 });
  chmodSync(legacyEnv, 0o600);
  log(`wrote ${homeEnv} (0600): ${envKeyNames(readFileSync(homeEnv, "utf8")).join(", ")}`);
  log(`wrote ${legacyEnv} (0600): ${envKeyNames(readFileSync(legacyEnv, "utf8")).join(", ")}`);
  return values;
}

function checkDatabase(passwords: Record<GeneratedPasswordRole, string>, baseline: readonly string[]): string[] {
  const state = parseKeyValues(psql(PRECUTOVER_STATE_QUERY, { tuples: true }));
  const ledger = psql("SELECT name FROM schema_migrations ORDER BY name COLLATE \"C\";", { tuples: true }).split("\n").filter(Boolean);
  const problems = precutoverProblems(state, ledger, baseline);
  problems.push(...roleShapeProblems(psql(ROLE_SHAPE_QUERY, { tuples: true }), psql(DOADMIN_ADMIN_QUERY, { tuples: true })));
  for (const role of ["doadmin", "rm_app", "rm_worker", "rm_readonly"] as const) {
    const r = hostPsql(role, passwords[role], "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid();");
    if (r.code !== 0 || r.stdout.trim() !== "t") problems.push(`${role} cannot log in over TLS from the host (${r.stderr.trim().split("\n")[0] ?? ""})`);
  }
  const owner = hostPsql("rm_owner", passwords.rm_owner, "SELECT 1;");
  if (owner.code === 0) problems.push("rm_owner logged in; production's rm_owner is NOLOGIN");
  const su = run(["psql", "-X", "-At", `host=${T.pgBindHost} port=${T.pgPort} dbname=${T.database} user=${T.superuser} sslmode=require connect_timeout=5`, "-c", "SELECT 1"], { env: { PGPASSWORD: "x" } });
  if (su.code === 0) problems.push("the container superuser logged in over the network");
  const plain = run(["psql", "-X", "-At", `host=${T.pgBindHost} port=${T.pgPort} dbname=${T.database} user=rm_app sslmode=disable connect_timeout=5`, "-c", "SELECT 1"], { env: { PGPASSWORD: passwords.rm_app } });
  if (plain.code === 0) problems.push("rm_app logged in without TLS");
  log(`database: ledger=${state.ledger} identity=${state.identity_table} rm_owner_login=${state.rm_owner_login} doadmin_super=${state.doadmin_super} doadmin_createrole=${state.doadmin_createrole} ssl=${state.ssl} server=${state.server_version}`);
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
  psql("ANALYZE;");
  return passwords;
}

function startDriver(): void {
  const script = join(T.home, "legacy-launch.sh");
  writeFileSync(script, legacyLaunchScript(T), { mode: 0o700 });
  log(`starting tmux session ${T.driverSession}: bash ${script}`);
  must([
    "tmux", "new-session", "-d", "-s", T.driverSession, "-c", T.legacyCheckout, "-e", `HOME=${T.home}`,
    `bash ${shellQuote(script)}; exec bash`,
  ], "tmux new-session");
}

/** The legacy driver: production's runs as `bun scripts/smoke.ts --smoke --static-port --db external --no-tui`. */
function driverPid(): string | null {
  const r = run(["pgrep", "-u", T.user, "-f", "^bun scripts/smoke.ts --smoke --static-port --db external"]);
  for (const pid of r.stdout.split("\n").filter(Boolean)) {
    const cwd = run(["readlink", `/proc/${pid}/cwd`]).stdout.trim();
    if (cwd === T.legacyCheckout) return pid;
  }
  return null;
}

/** After the site answers, the driver must still be running, as production's is. */
async function driverStaysUp(): Promise<boolean> {
  for (let i = 0; i < 9; i++) {
    await Bun.sleep(10_000);
    if (!driverPid()) {
      const tail = readFileSync(join(T.home, T.driverLog), "utf8").split("\n").filter((l) => /FAIL|FATAL|exited with code/.test(l)).slice(-5);
      for (const l of tail) log(`  driver: ${l.slice(0, 240)}`);
      log("the legacy driver exited after the boot; production's keeps running");
      return false;
    }
  }
  log(`the legacy driver is running (pid ${driverPid()}) 90 s after the site answered`);
  return true;
}

async function waitForLegacySite(): Promise<boolean> {
  const deadline = Date.now() + 45 * 60_000;
  let lastNote = 0;
  while (Date.now() < deadline) {
    const r = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", `http://127.0.0.1:${T.legacyWebPort}/`]);
    if (r.stdout.trim() === "200") {
      log(`legacy site answers 200 on :${T.legacyWebPort}`);
      return true;
    }
    if (!tmuxHasSession()) throw new Error(`tmux session ${T.driverSession} is gone`);
    if (Date.now() - lastNote > 120_000) {
      lastNote = Date.now();
      const tail = run(["tmux", "capture-pane", "-p", "-t", T.driverSession]).stdout.split("\n").filter(Boolean).slice(-2);
      log(`waiting for :${T.legacyWebPort} (${r.stdout.trim() || "no answer"}); driver: ${tail.join(" | ").slice(0, 300)}`);
    }
    await Bun.sleep(10_000);
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
  await bunInstall(T.legacyCheckout, ["."]);
  await bunInstall(T.checkout, [".", "backend"]);

  const passwords = await buildDatabase(backup, baseline);
  const problems = checkDatabase(passwords, baseline);
  if (problems.length) {
    for (const p of problems) log(`  PROBLEM: ${p}`);
    throw new Error(`the stage database does not match production's pre-cutover shape (${problems.length} problems)`);
  }
  log("the stage database matches production's pre-cutover shape");
  writeEnvFiles(passwords);
  writeFileSync(join(T.home, "stage-target.json"), `${JSON.stringify({
    builtAt: new Date().toISOString(),
    dump: dumpDir,
    stamp: backup.stamp,
    legacyCommit: T.legacyCommit,
    checkoutCommit: T.checkoutCommit,
    pg: `${T.pgContainer} ${POSTGRES_IMAGE} ${T.pgBindHost}:${T.pgPort}/${T.database}`,
  }, null, 2)}\n`, { mode: 0o600 });

  startDriver();
  const up = (await waitForLegacySite()) && (await driverStaysUp());
  const after = checkDatabase(passwords, baseline);
  for (const p of after) log(`  PROBLEM after the legacy boot: ${p}`);
  await remoteStatus();
  if (!up) {
    log(`the legacy site did not answer on :${T.legacyWebPort}; read the driver: tmux capture-pane -p -t ${T.driverSession}`);
    return 1;
  }
  return after.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------

function assertOwnPath(dir: string): void {
  const allowed = [T.home, T.checkout, T.legacyCheckout] as string[];
  if (!allowed.includes(dir)) throw new Error(`refusing to remove ${dir}: not a stage-target path`);
}

async function remoteDown(): Promise<number> {
  if (tmuxHasSession()) {
    log(`stopping the driver in tmux session ${T.driverSession}`);
    run(["tmux", "send-keys", "-t", `=${T.driverSession}`, "C-c"]);
    for (let i = 0; i < 30; i++) {
      const pane = run(["tmux", "list-panes", "-t", `=${T.driverSession}`, "-F", "#{pane_current_command}"]).stdout.trim();
      if (pane === "bash") break;
      await Bun.sleep(1000);
    }
    run(["tmux", "kill-session", "-t", `=${T.driverSession}`]);
  }
  // The v0.6 stack, if a rehearsal booted one, by its own tool and state.
  const v06State = join(T.home, ".local", "state", "robotmoney-smoke", T.instance);
  if (existsSync(v06State) && existsSync(join(T.checkout, "package.json"))) {
    log(`bun smoke:down --instance ${T.instance}`);
    run(["bun", "smoke:down", "--instance", T.instance], { cwd: T.checkout, env: { HOME: T.home, RM_ENV: "stage" } });
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
  for (const dir of [T.legacyCheckout, T.checkout, T.home]) {
    assertOwnPath(dir);
    if (existsSync(dir)) {
      log(`removing ${dir}`);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith(`robotmoney-smoke-${T.legacyProject}-secrets-`)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
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
      const s = parseKeyValues(psql(PRECUTOVER_STATE_QUERY, { tuples: true }));
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
    const want = [...PROD_HOME_ENV_KEYS, ...D61_HOME_ENV_KEYS];
    const same = keys.length === want.length && want.every((k) => keys.includes(k));
    line("~/.env", `${homeEnv} keys: ${keys.join(" ")} (${same ? "production's key names + rm_owner, doadmin" : "DIFFERS from production's"})`);
  } else line("~/.env", "absent");
  const legacyEnv = join(T.legacyCheckout, ".env");
  if (existsSync(legacyEnv)) {
    const keys = envKeyNames(readFileSync(legacyEnv, "utf8"));
    const same = keys.length === PROD_LEGACY_CHECKOUT_ENV_KEYS.length && PROD_LEGACY_CHECKOUT_ENV_KEYS.every((k) => keys.includes(k));
    line("legacy checkout .env", `${same ? "production's key names" : "DIFFERS"}: ${keys.join(" ")}`);
  }
  for (const [name, dir] of [["legacy checkout", T.legacyCheckout], ["v0.6.0 checkout", T.checkout]] as const) {
    const head = existsSync(dir) ? run(["git", "-C", dir, "log", "-1", "--format=%h %s"]).stdout.trim() : "";
    line(name, head ? `${dir} at ${head.slice(0, 100)}` : "absent");
  }
  if (tmuxHasSession()) {
    const cmd = run(["tmux", "list-panes", "-t", `=${T.driverSession}`, "-F", "#{pane_current_command} in #{pane_current_path}"]).stdout.trim();
    const pid = driverPid();
    line("driver", `tmux ${T.driverSession}: ${cmd}; smoke:archive ${pid ? `running (pid ${pid})` : "NOT running"}`);
    const tail = run(["tmux", "capture-pane", "-p", "-t", T.driverSession]).stdout.split("\n").filter(Boolean).slice(-3);
    for (const t of tail) line("", t.slice(0, 160));
  } else line("driver", "no tmux session");
  const containers = run(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${T.legacyProject}`, "--format", "{{.Names}} {{.Status}} {{.Ports}}"]).stdout.trim();
  line("legacy stack", containers ? "" : "no containers");
  for (const c of containers.split("\n").filter(Boolean)) line("", c);
  const site = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", `http://127.0.0.1:${T.legacyWebPort}/`]).stdout.trim();
  line("legacy site", `http://127.0.0.1:${T.legacyWebPort}/ -> ${site || "no answer"}`);
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

const USAGE = `usage: bun scripts/release/stage-target.ts up --dump <dir on ${T.host}> [--replace] | status | down`;

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  try {
    if (first === "remote") {
      const [command, ...args] = rest;
      if (command === "up") return await remoteUp(args);
      if (command === "down") return await remoteDown();
      if (command === "status") return await remoteStatus();
      console.error(USAGE);
      return 2;
    }
    if (first === "up" || first === "down" || first === "status") return await control(first, rest);
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
