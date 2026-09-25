// Generic: restore an encrypted Gate C backup (docs/runbooks/*.md §5) into a
// THROWAWAY local Postgres container. Shared by restore-check.ts (SQL-level
// verification) and stage-rehearsal.ts (boots the real app against it) —
// factored out so both use the exact same restore mechanism instead of two
// copies drifting apart. Touches nothing on production: no network path to
// it at all once the encrypted files are read from disk.
//
// Uses Bun.spawn for docker/gpg/pg_restore/psql — there is no JS-native
// pg_dump-format reader.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// The SHARED ephemeral-Postgres pin. This file used to own the string; it does
// not any more, because the test harness needs the same one and the two drifted
// (issue #691). Everything about which major and why -alpine is not used lives
// in that module.
import { POSTGRES_IMAGE } from "./postgres-image.ts";
// The SHARED naming scheme. This is a raw `docker run`, so — exactly like
// backend/tests/preload.ts, the other non-compose spawner — it cannot inherit
// labels from a compose file and must stamp them itself. Unlabelled, a smoke-twin is
// invisible to smoke:reap and smoke:clean, which is how a container holding a full
// copy of production ends up living on a host indefinitely.
import {
  dockerLabelFlags,
  resolveStackEnvironment,
  ROLE_LABEL,
  stackLabels,
  stackProjectName,
  TWIN_ROLE,
} from "../stack/naming.ts";

export interface BackupFiles {
  stamp: string;
  dumpEnc: string;
  globalsEnc: string;
  passphraseFile: string;
}

export function resolveBackupFiles(backupDirArg?: string): BackupFiles | { error: string } {
  // Same precedence as rollout-receipt.ts's DEFAULT_BACKUP_DIR: explicit arg,
  // then RM_BACKUP_DIR, then v0.2.2's literal directory for that release only.
  const backupDir =
    backupDirArg ?? (process.env.RM_BACKUP_DIR?.trim() || join(homedir(), "rm-backup-v022"));
  const stampFile = join(backupDir, ".last-stamp");
  if (!existsSync(stampFile)) {
    return { error: `missing ${stampFile} — run §5.1's pg_dump/pg_dumpall first` };
  }
  const stamp = readFileSync(stampFile, "utf8").trim();
  const dumpEnc = join(backupDir, `rm-preupgrade-${stamp}.dump.gpg`);
  const globalsEnc = join(backupDir, `rm-globals-${stamp}.sql.gpg`);
  for (const f of [dumpEnc, globalsEnc]) {
    if (!existsSync(f)) return { error: `missing ${f} — run §5.1's pg_dump/pg_dumpall, then §5.2's gpg` };
  }
  // Called out separately because its absence has a specific, non-obvious
  // cause: encrypting with a bare interactive `gpg --symmetric` (as an early
  // revision of §5.2 showed) leaves no passphrase file, and decryption here
  // is non-interactive by design. The fix is to re-read §5.2, not to guess.
  const passphraseFile = join(backupDir, ".backup-passphrase");
  if (!existsSync(passphraseFile)) {
    return {
      error:
        `missing ${passphraseFile} — decryption here is non-interactive ` +
        `(gpg --batch --passphrase-file). Encrypt per §5.2, which generates this file and ` +
        `passes it to both gpg calls; a bare interactive 'gpg --symmetric' does not create it. ` +
        `If the backup is archived with the passphrase held elsewhere (§5.2 says it should be), ` +
        `restore it to this directory for the duration of this run.`,
    };
  }
  return { stamp, dumpEnc, globalsEnc, passphraseFile };
}

export interface RestoredContainer {
  container: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

const IMAGE = POSTGRES_IMAGE; // matches production's 18.x major version (server-version check)
const LOCAL_USER = "restore_check";
const LOCAL_DB = "rm_restore_check";

/**
 * Per-run password for the smoke-twin's superuser (docs/runbooks/*.md §5.3b.2 T4).
 *
 * Generated, never a constant. This container holds a COMPLETE copy of
 * production — admin_credential hashes, session tokens, member access keys and
 * emails — so the only thing that made a hardcoded password tolerable was T3's
 * non-routable bind. Two independent controls beat one control propping up
 * another: a leaked or mis-specified bind address should not also hand over a
 * password that is printed in the repo.
 *
 * Never logged. Callers get it on the returned RestoredContainer and pass it
 * through PGPASSWORD / a connection string.
 */
function generateLocalPassword(): string {
  return `rk_${crypto.randomUUID().replaceAll("-", "")}`;
}
// Only these two roles matter to anything downstream (Gate D's rm-worker-role
// check, the role query in §5.3) — the rest of a real globals dump is DO
// Managed Postgres's internal cluster role graph (_doadmin_*, _dodb*,
// doadmin_group, avn_* GUCs), which a vanilla postgres image cannot replicate
// and which nothing here checks anyway. Allowlist rather than fight it line
// by line.
const RESTORE_ROLES = ["rm_readonly", "rm_worker", "rm_owner", "rm_app"] as const;

/**
 * The roles that predate the 0053 taxonomy — what the opt-in bootstrap shaping
 * below grants its stand-in login, modelling the primary BEFORE 0053 ran.
 */
const PRE_TAXONOMY_ROLES = ["rm_readonly", "rm_worker"] as const;

/**
 * SQL that gives a restored twin production's POST-0053 ownership: `rm_owner`
 * owns `public` and every non-extension relation and function in it.
 *
 * WHY. pg_restore runs `--no-owner`, so everything lands owned by the container
 * superuser. Before v0.5.1 no twin ever had a pending migration (production had
 * recorded them all), so nothing noticed. v0.5.1 ships 0061/0063, and every
 * migration from 0054 on runs under `SET LOCAL ROLE rm_owner` (src/db/migrate.ts):
 * the 2026-09-25 rehearsal died on `role "rm_owner" does not exist`, and with the
 * role but not the ownership, `GRANT` as rm_owner fails on tables it does not own.
 * Production's own shape is rm_owner owning everything, so the twin gets that.
 *
 * PURE: exported so a unit test can pin it without a database.
 */
export function postTaxonomyOwnershipSql(owner = "rm_owner"): string {
  return `
    DO $own$
    DECLARE r record;
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${owner}') THEN
        RAISE NOTICE 'no ${owner} in the restored globals: a pre-0053 twin, ownership left as restored';
        RETURN;
      END IF;
      EXECUTE 'ALTER SCHEMA public OWNER TO ${owner}';
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
        EXECUTE format('ALTER %s %s OWNER TO ${owner}',
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
        EXECUTE format('ALTER ROUTINE %s OWNER TO ${owner}', r.object_name);
      END LOOP;
    END
    $own$;`;
}

/**
 * The smoke-twin's stand-in for the production primary's bootstrap login.
 *
 * WHY THIS EXISTS. The twin restores with `--no-owner --no-privileges` and then
 * migrates as the container SUPERUSER, so it has no ownership topology to
 * change and no privilege constraint while changing it. That makes the
 * rehearsal structurally unable to rehearse the one migration whose entire
 * purpose is ownership and grants (0053) — three separate defects in that file
 * were invisible to the twin, to this suite, and to the live preflight, which
 * audits role STATE read-only and never executes the migration SQL.
 *
 * Reshaping the twin to own its objects under a NON-superuser role, and then
 * pointing MIGRATE_DATABASE_URL at that role, is what makes the boot exercise
 * the path a production cutover actually takes.
 */
/**
 * PURE. The twin's schedule for the sessions it restored mid-window.
 *
 * A restored dump carries production's open sessions with production's
 * deadlines, up to six hours out. The driver waits out every window it meets,
 * in full and the same way on every boot, so the twin sets its OWN schedule on
 * its OWN copy at boot, the way it already sets its judge config: any restored
 * `collecting` session whose deadline lies beyond one twin window now closes
 * one twin window from boot. It only moves a deadline EARLIER, never later, and
 * it runs against the restored container, never a deployment's database.
 * There is no twin branch in the driver: timing is configuration, and
 * configuration is written at boot.
 */
export function retimeAdoptedWindowsSql(windowMs: number): string {
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error(`retimeAdoptedWindowsSql needs a positive window, got ${windowMs}`);
  return `UPDATE swarm_sessions SET window_closes_at = now() + interval '${windowMs} milliseconds'
 WHERE state = 'collecting' AND window_closes_at > now() + interval '${windowMs} milliseconds'
 RETURNING id, subject_id, window_closes_at`;
}

/** Apply retimeAdoptedWindowsSql inside the twin's restore container; logs each re-timed session. */
export function retimeAdoptedWindows(container: string, windowMs: number, log: (m: string) => void): number {
  const r = Bun.spawnSync(
    ["docker", "exec", container, "psql", "-U", LOCAL_USER, "-d", LOCAL_DB, "-X", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", retimeAdoptedWindowsSql(windowMs)],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`twin: re-timing restored open windows failed: ${r.stderr.toString().trim()}`);
  const rows = r.stdout.toString().split("\n").filter((l) => /^[0-9a-f-]{36}\t/.test(l));
  for (const row of rows) {
    const [id, subject, closes] = row.split("\t");
    log(`twin: restored session ${id} (${subject}) was mid-window; its window now closes ${closes} (the twin's ${windowMs / 60_000}-min cadence)`);
  }
  if (rows.length === 0) log("twin: no restored session was mid-window; nothing to re-time");
  return rows.length;
}

export const TWIN_BOOTSTRAP_ROLE = "rm_twin_bootstrap";

/** doadmin's exact production attribute set: rolsuper=false, the rest true. */
const TWIN_BOOTSTRAP_ATTRS = "LOGIN CREATEROLE CREATEDB BYPASSRLS REPLICATION";

/**
 * Give a restored twin production's privilege shape and return the URL a
 * migration run should use.
 *
 * Mirrors the production primary before 0053 has ever run: one non-superuser
 * bootstrap login owning `public` and everything in it, holding ADMIN OPTION on
 * the roles that predate the taxonomy (doadmin holds exactly that on rm_worker
 * and rm_readonly). Extension-owned objects are deliberately left alone — they
 * belong to the extension's lifecycle, and re-owning them fails outright for a
 * non-superuser.
 *
 * Returns the bootstrap URL; the caller sets it as MIGRATE_DATABASE_URL for the
 * boot. DATABASE_URL is untouched, so the running application is unaffected.
 */
/**
 * The migration credential a smoke-twin boot should use, or undefined to leave
 * `migrate.ts` on DATABASE_URL (the container superuser).
 *
 * OPT-IN via RM_TWIN_PRODUCTION_PRIVILEGES=1, which the stage rehearsal sets
 * and an ordinary `bun run smoke` does not. A development boot is not a
 * rehearsal: it should neither pay for the reshaping nor be broken by it.
 *
 * Throws rather than returning an error: a rehearsal that silently fell back to
 * a superuser migration would report a pass for the one thing it was changed to
 * stop missing.
 */
export function twinMigrationCredential(twinUrl: string, log: (m: string) => void): string | undefined {
  if (process.env.RM_TWIN_PRODUCTION_PRIVILEGES !== "1") return undefined;
  const shaped = shapeTwinToProductionPrivileges(twinUrl, log);
  if ("error" in shaped) throw new Error(shaped.error);
  // Set here rather than returned into a binding: smoke-main's compose env is
  // built from process.env through the MIGRATE_DATABASE_URL passthrough entry,
  // so this is what actually reaches the API container's migration run.
  process.env.MIGRATE_DATABASE_URL = shaped.url;
  return shaped.url;
}

export function shapeTwinToProductionPrivileges(
  superuserUrl: string,
  log: (m: string) => void,
): { url: string } | { error: string } {
  const password = `rk_${crypto.randomUUID().replaceAll("-", "")}`;
  // psql, not a postgres client: `scripts/` cannot import backend's `postgres`
  // dependency, and every other database step in this module already shells to
  // psql for exactly that reason.
  const ddl = `
    DROP ROLE IF EXISTS ${TWIN_BOOTSTRAP_ROLE};
    CREATE ROLE ${TWIN_BOOTSTRAP_ROLE} ${TWIN_BOOTSTRAP_ATTRS} PASSWORD '${password}';
    ${PRE_TAXONOMY_ROLES.map((r) => `GRANT ${r} TO ${TWIN_BOOTSTRAP_ROLE} WITH ADMIN OPTION;`).join("\n    ")}
    ALTER SCHEMA public OWNER TO ${TWIN_BOOTSTRAP_ROLE};
    DO $shape$
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
        EXECUTE format('ALTER %s %s OWNER TO ${TWIN_BOOTSTRAP_ROLE}',
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
        EXECUTE format('ALTER FUNCTION %s OWNER TO ${TWIN_BOOTSTRAP_ROLE}', r.object_name);
      END LOOP;
    END
    $shape$;`;
  const applied = Bun.spawnSync(["psql", "-X", "-v", "ON_ERROR_STOP=1", superuserUrl, "-c", ddl], { stderr: "pipe" });
  if (applied.exitCode !== 0) {
    return { error: `twin privilege shaping failed: ${new TextDecoder().decode(applied.stderr).trim()}` };
  }
  const counted = Bun.spawnSync(
    ["psql", "-X", "-Atc",
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p')
         AND pg_get_userbyid(c.relowner) = '${TWIN_BOOTSTRAP_ROLE}'`, superuserUrl],
    { stderr: "pipe" },
  );
  const owned = new TextDecoder().decode(counted.stdout).trim();
  log(`twin reshaped to production privileges: ${TWIN_BOOTSTRAP_ROLE} (NOT superuser) owns ${owned} public table(s)`);
  const u = new URL(superuserUrl);
  u.username = TWIN_BOOTSTRAP_ROLE;
  u.password = password;
  return { url: u.toString() };
}


async function run(cmd: string[], opts: { stdin?: ReadableStream | number; log: (m: string) => void }): Promise<number> {
  const proc = Bun.spawn(cmd, { stdin: opts.stdin ?? "ignore", stdout: "inherit", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (stderr.trim()) opts.log(stderr.trim());
  return code;
}

/**
 * Starts the container, loads the allowlisted roles, restores the dump, and
 * returns connection details — WITHOUT tearing anything down. Caller owns the
 * container's lifetime (a SQL-only check can tear down immediately after its
 * queries; a full app boot needs the container alive for much longer) and
 * MUST call teardownContainer() when done, success or failure.
 */
export async function restoreBackupIntoContainer(
  backup: BackupFiles,
  log: (m: string) => void,
  opts: {
    /**
     * Host interface the published port binds to. Default 127.0.0.1: genuinely
     * loopback-only, never reachable off this host regardless of firewall
     * rules. Pass the Docker bridge gateway (e.g. 172.17.0.1) instead ONLY
     * when a sibling container (not this host's own processes) needs to
     * reach it — that address is still not internet-routable, unlike
     * 0.0.0.0, which — because Docker inserts its own iptables rules ahead of
     * ufw/firewalld — CAN end up reachable from outside this host even when
     * the firewall appears to block the port. Never bind 0.0.0.0 here: this
     * container holds a restored copy of production data.
     */
    bindHost?: string;
    /**
     * The compose project this smoke-twin belongs to, when it belongs to one.
     *
     * A `--db smoke-twin` boot passes its smoke project so smoke:down and smoke:clean
     * scope to the smoke-twin like any other container that boot created. A standalone
     * smoke-twin (restore-check.ts) passes nothing and gets its own `smoke-twin` family name
     * — the two must not collide, because a standalone smoke-twin can legitimately run
     * beside a smoke.
     */
    project?: string;
    /**
     * A NAMED volume to hold the restored cluster, created here with the smoke's
     * labels so `smoke:clean` reclaims it by the same label scoping it uses for
     * every other volume a boot creates.
     *
     * Omitted (restore-check.ts) the data lives in the container's writable
     * layer and dies with it, which is right for a check that tears down in a
     * `finally`. A `--db smoke-twin` boot passes one because its contract is the
     * ephemeral-pgdata contract: teardown keeps the data, smoke:clean reclaims it.
     *
     * NOTE the volume must be created BEFORE `docker run`, because a volume
     * auto-created by `-v` carries no labels at all — which is precisely how a
     * copy of production becomes invisible to the tooling meant to reclaim it.
     */
    volume?: string;
  } = {},
): Promise<RestoredContainer | { error: string; container?: string }> {
  const bindHost = opts.bindHost ?? "127.0.0.1";
  const container = `rm-restore-${backup.stamp}-${Math.random().toString(36).slice(2, 8)}`;
  const environment = resolveStackEnvironment(process.env);
  const project = opts.project ?? stackProjectName("smoke-twin", environment);
  // ROLE_LABEL last so it cannot be overridden: the reaper's liveness rule
  // depends on a smoke-twin admitting what it is. See naming.ts's ROLE_LABEL.
  const labels = { ...stackLabels(environment, project), [ROLE_LABEL]: TWIN_ROLE };
  const labelFlags = dockerLabelFlags(labels);
  const volumeArgs: string[] = [];
  if (opts.volume) {
    // SMOKE_VOLUME_LABEL ("robotmoney.smoke=1") is what smoke:clean filters on —
    // docker-compose.smoke.yml stamps it on pgdata, and this is the non-compose
    // equivalent. Without it the volume is unreclaimable by the documented path.
    const created = await run(
      ["docker", "volume", "create", "--label", "robotmoney.smoke=1", ...dockerLabelFlags(labels), opts.volume],
      { log },
    );
    if (created !== 0) return { error: `docker volume create ${opts.volume} failed` };
    // MOUNT THE PARENT, not `/var/lib/postgresql/data`. Verified empirically on
    // this host against postgres:18: a volume at .../data makes the entrypoint
    // EXIT 1 rather than merely ignoring it —
    //
    //   "Counter to that, there appears to be PostgreSQL data in:
    //      /var/lib/postgresql/data (unused mount/volume)"
    //
    // PG 18 moved PGDATA into a major-version subdirectory
    // (/var/lib/postgresql/18/docker, docker-library/postgres#1259) so that
    // `pg_upgrade --link` does not cross a mount boundary, and the image treats
    // a mount at the old path as a misconfiguration worth refusing. The
    // documented 18+ configuration is a single mount at /var/lib/postgresql.
    //
    // NOT a contradiction of docker-compose.yml's `pgdata:/var/lib/postgresql/data`:
    // that service is pinned to an OLDER major on purpose (see postgres-image.ts's
    // header — a live data directory cannot be re-read by a different major, which
    // is what the --pg-data resume contract depends on). The smoke-twin has no such
    // constraint: it is restored fresh from a dump every boot.
    volumeArgs.push("-v", `${opts.volume}:/var/lib/postgresql`);
  }
  const localPassword = generateLocalPassword();
  log(`starting throwaway Postgres (${IMAGE})`);
  const runCode = await run(
    [
      "docker",
      "run",
      "-d",
      "--name",
      container,
      "-e",
      `POSTGRES_USER=${LOCAL_USER}`,
      "-e",
      `POSTGRES_PASSWORD=${localPassword}`,
      "-e",
      `POSTGRES_DB=${LOCAL_DB}`,
      "-p",
      `${bindHost}::5432`,
      // Docker's default /dev/shm is 64 MB. Postgres sizes parallel-query
      // shared memory there, and the 2026-09-24 stage twin's api died on
      // `could not resize shared memory segment ... No space left on device`
      // against a 6 GB restore. Production's managed primary has no such cap.
      "--shm-size",
      "1g",
      ...labelFlags,
      ...volumeArgs,
      IMAGE,
    ],
    { log },
  );
  if (runCode !== 0) return { error: "docker run failed" };

  const inspect = Bun.spawnSync([
    "docker",
    "inspect",
    "-f",
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    container,
  ]);
  const hostPort = new TextDecoder().decode(inspect.stdout).trim();
  log(`listening on ${bindHost}:${hostPort}`);

  const connArgs = [`--host=${bindHost}`, `--port=${hostPort}`, `--username=${LOCAL_USER}`];
  const env = { ...process.env, PGPASSWORD: localPassword };

  // Probe over the SAME path the work below uses: host -> published port ->
  // auth -> a real query. NOT `docker exec ... pg_isready`, which answers a
  // different question and answers it too early: the postgres image's
  // entrypoint runs a TEMPORARY server for initdb (bound inside the container
  // only), shuts it down, then starts the real one. An in-container probe goes
  // green against that temporary server, so the first host-side connection
  // lands in the shutdown window and dies with "server closed the connection
  // unexpectedly". Measured on postgres:18: in-container READY at t=2s,
  // host-side connections not accepted until t=3s.
  log("waiting for readiness");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const check = Bun.spawnSync(["psql", ...connArgs, `--dbname=${LOCAL_DB}`, "-X", "-Atc", "SELECT 1"], { env });
    if (check.exitCode === 0) {
      ready = true;
      log(`ready after ${i + 1}s`);
      break;
    }
    await Bun.sleep(1000);
  }
  if (!ready) return { error: "Postgres never became ready", container };

  log("loading globals (just the app-relevant roles)");
  const gpgGlobals = Bun.spawn(
    ["gpg", "--batch", "--yes", "--passphrase-file", backup.passphraseFile, "--decrypt", backup.globalsEnc],
    { stdout: "pipe", stderr: "inherit" },
  );
  const grepRoles = Bun.spawn(["grep", "-E", `^(CREATE ROLE|ALTER ROLE) (${RESTORE_ROLES.join("|")})\\b`], {
    stdin: gpgGlobals.stdout,
    stdout: "pipe",
  });
  const psqlGlobals = Bun.spawn(["psql", ...connArgs, `--dbname=${LOCAL_DB}`, "--set", "ON_ERROR_STOP=on", "-f", "-"], {
    stdin: grepRoles.stdout,
    stdout: "inherit",
    stderr: "inherit",
    env,
  });
  const globalsExit = await psqlGlobals.exited;
  log(`globals load exit=${globalsExit}`);
  if (globalsExit !== 0) return { error: "globals load failed", container };

  log("restoring dump");
  const gpgDump = Bun.spawn(
    ["gpg", "--batch", "--yes", "--passphrase-file", backup.passphraseFile, "--decrypt", backup.dumpEnc],
    { stdout: "pipe", stderr: "inherit" },
  );
  const pgRestore = Bun.spawn(
    ["pg_restore", ...connArgs, `--dbname=${LOCAL_DB}`, "--no-owner", "--no-privileges", "--exit-on-error"],
    { stdin: gpgDump.stdout, stdout: "inherit", stderr: "inherit", env },
  );
  const restoreExit = await pgRestore.exited;
  log(`pg_restore exit=${restoreExit}`);
  if (restoreExit !== 0) return { error: "pg_restore failed", container };

  log("giving rm_owner production's ownership of public (post-0053 shape)");
  const own = Bun.spawnSync(
    ["psql", ...connArgs, `--dbname=${LOCAL_DB}`, "--set", "ON_ERROR_STOP=on", "-c", postTaxonomyOwnershipSql()],
    { stdout: "pipe", stderr: "pipe", env },
  );
  if (own.exitCode !== 0) return { error: `ownership reshaping failed: ${own.stderr.toString().trim()}`, container };

  return {
    container,
    host: bindHost,
    port: Number(hostPort),
    username: LOCAL_USER,
    password: localPassword,
    database: LOCAL_DB,
  };
}

export function teardownContainer(container: string, log: (m: string) => void): void {
  log(`cleaning up: docker rm -f ${container}`);
  Bun.spawnSync(["docker", "rm", "-f", container]);
}

/**
 * Restore a backup, hand the caller the running smoke-twin, and ALWAYS tear it down.
 *
 * Extracted because restore-check.ts and any future release's equivalent do the
 * identical five things around their own version-specific queries: resolve the
 * files, restore, run something, unwind on failure, tear down in a finally. The
 * failure-path teardown is the part worth centralising — a checker that returns
 * early from the middle of its own try block is exactly how a container holding
 * a copy of production gets left behind.
 *
 * `fn` receives the running container. Its resolved value is returned verbatim;
 * a thrown error propagates AFTER teardown has run.
 *
 * Returns `{ error, code: 2 }` for the could-not-run cases (missing files, a
 * failed restore), matching the exit-code contract the upgrade scripts use:
 * 2 = could not run, distinct from 1 = ran and found a problem.
 */
export async function withSmokeTwinContainer<T>(
  opts: { backupDir?: string; log: (m: string) => void; bindHost?: string; project?: string; volume?: string },
  fn: (restored: RestoredContainer, backup: BackupFiles) => Promise<T>,
): Promise<T | { error: string; code: 2 }> {
  const backup = resolveBackupFiles(opts.backupDir);
  if ("error" in backup) return { error: backup.error, code: 2 };

  const restored = await restoreBackupIntoContainer(backup, opts.log, {
    bindHost: opts.bindHost,
    project: opts.project,
    volume: opts.volume,
  });
  if ("error" in restored) {
    if (restored.container) teardownContainer(restored.container, opts.log);
    return { error: restored.error, code: 2 };
  }

  try {
    return await fn(restored, backup);
  } finally {
    teardownContainer(restored.container, opts.log);
  }
}
