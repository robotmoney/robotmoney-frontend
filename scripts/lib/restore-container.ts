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
// labels from a compose file and must stamp them itself. Unlabelled, a twin is
// invisible to demo:reap and demo:clean, which is how a container holding a full
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
  const backupDir = backupDirArg ?? join(homedir(), "rm-backup-v022");
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
 * Per-run password for the twin's superuser (docs/runbooks/*.md §5.3b.2 T4).
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
const RESTORE_ROLES = ["rm_readonly", "rm_worker"] as const;

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
     * The compose project this twin belongs to, when it belongs to one.
     *
     * A `--db twin` boot passes its demo project so demo:down and demo:clean
     * scope to the twin like any other container that boot created. A standalone
     * twin (restore-check.ts) passes nothing and gets its own `twin` family name
     * — the two must not collide, because a standalone twin can legitimately run
     * beside a demo.
     */
    project?: string;
    /**
     * A NAMED volume to hold the restored cluster, created here with the demo's
     * labels so `demo:clean` reclaims it by the same label scoping it uses for
     * every other volume a boot creates.
     *
     * Omitted (restore-check.ts) the data lives in the container's writable
     * layer and dies with it, which is right for a check that tears down in a
     * `finally`. A `--db twin` boot passes one because its contract is the
     * ephemeral-pgdata contract: teardown keeps the data, demo:clean reclaims it.
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
  const project = opts.project ?? stackProjectName("twin", environment);
  // ROLE_LABEL last so it cannot be overridden: the reaper's liveness rule
  // depends on a twin admitting what it is. See naming.ts's ROLE_LABEL.
  const labels = { ...stackLabels(environment, project), [ROLE_LABEL]: TWIN_ROLE };
  const labelFlags = dockerLabelFlags(labels);
  const volumeArgs: string[] = [];
  if (opts.volume) {
    // DEMO_VOLUME_LABEL ("robotmoney.demo=1") is what demo:clean filters on —
    // docker-compose.demo.yml stamps it on pgdata, and this is the non-compose
    // equivalent. Without it the volume is unreclaimable by the documented path.
    const created = await run(
      ["docker", "volume", "create", "--label", "robotmoney.demo=1", ...dockerLabelFlags(labels), opts.volume],
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
    // is what the --pg-data resume contract depends on). The twin has no such
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
