// Restore-verify the encrypted Gate C backup (docs/runbooks/*.md §5) into a
// THROWAWAY local Postgres container, THEN run this release's full preflight
// checks (preflight.ts's runChecks) against that restored copy. Touches
// nothing on production — no network path to it at all once the encrypted
// files are read from disk. This is deliberately the FIRST place preflight's
// checks run: the runbook's process is dump -> restore -> check the dump ->
// only then check the live replica (§4), never production first.
//
// Uses Bun.spawn for the docker/gpg/pg_restore/psql processes this inherently
// needs (there is no JS-native pg_dump-format reader) and the `postgres` npm
// client for the verification queries, so results are structured instead of
// parsed back out of psql's text output.
//
// Usage:
//   bun scripts/upgrades/0.2.1-to-0.2.2/restore-check.ts [backupDir]
//   backupDir defaults to ~/rm-backup-v022. Expects, inside it:
//     .last-stamp                       — the STAMP §5.1 generated
//     rm-preupgrade-<STAMP>.dump.gpg    — §5.1/§5.2's encrypted pg_dump
//     rm-globals-<STAMP>.sql.gpg        — §5.1/§5.2's encrypted pg_dumpall --globals-only
//     .backup-passphrase                — §5.2's gpg passphrase
//
// Exit codes: 0 = restore verified AND all preflight checks pass/warn,
// 1 = a verification query or a preflight check FAILed,
// 2 = could not run (missing files, docker/gpg/pg_restore failure).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { columnExists, createChecker, printVerdict } from "../../lib/checks.ts";
import { runChecks } from "./preflight.ts";

const NAME = "restore-check-0.2.2";
const log = (msg: string) => console.log(`[${NAME}] ${msg}`);
const err = (msg: string) => console.error(`[${NAME}] ${msg}`);

const IMAGE = "postgres:18"; // matches production's 18.4 major version (§4's server-version check)
const LOCAL_USER = "restore_check";
const LOCAL_PASSWORD = "throwaway-local-only";
const LOCAL_DB = "rm_restore_check";
// Only these two roles matter for verification (Gate D's rm-worker-role check,
// and the role query in §5.3) — the rest of a real globals dump is DO Managed
// Postgres's internal cluster role graph (_doadmin_*, _dodb*, doadmin_group,
// avn_* GUCs), which a vanilla postgres image cannot replicate and which
// nothing here checks anyway. Allowlist rather than fight it line by line.
const RESTORE_ROLES = ["rm_readonly", "rm_worker"] as const;

async function run(cmd: string[], opts: { stdin?: ReadableStream | number } = {}): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdin: opts.stdin ?? "ignore", stdout: "inherit", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (stderr.trim()) err(stderr.trim());
  return { code, stderr };
}

async function main(backupDirArg?: string): Promise<number> {
  const backupDir = backupDirArg ?? join(homedir(), "rm-backup-v022");
  const stampFile = join(backupDir, ".last-stamp");
  if (!existsSync(stampFile)) {
    err(`missing ${stampFile} — run §5.1's pg_dump/pg_dumpall first`);
    return 2;
  }
  const stamp = readFileSync(stampFile, "utf8").trim();
  const dumpEnc = join(backupDir, `rm-preupgrade-${stamp}.dump.gpg`);
  const globalsEnc = join(backupDir, `rm-globals-${stamp}.sql.gpg`);
  const passphraseFile = join(backupDir, ".backup-passphrase");
  for (const f of [dumpEnc, globalsEnc, passphraseFile]) {
    if (!existsSync(f)) {
      err(`missing ${f}`);
      return 2;
    }
  }

  const container = `rm-restore-check-${stamp}`;
  log(`starting throwaway Postgres (${IMAGE})`);
  const runResult = await run([
    "docker",
    "run",
    "-d",
    "--name",
    container,
    "-e",
    `POSTGRES_USER=${LOCAL_USER}`,
    "-e",
    `POSTGRES_PASSWORD=${LOCAL_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${LOCAL_DB}`,
    "-p",
    "127.0.0.1::5432",
    IMAGE,
  ]);
  if (runResult.code !== 0) {
    err("docker run failed");
    return 2;
  }

  try {
    const inspect = Bun.spawnSync([
      "docker",
      "inspect",
      "-f",
      '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
      container,
    ]);
    const hostPort = new TextDecoder().decode(inspect.stdout).trim();
    log(`listening on 127.0.0.1:${hostPort}`);

    log("waiting for readiness");
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const check = Bun.spawnSync(["docker", "exec", container, "pg_isready", "-U", LOCAL_USER, "-d", LOCAL_DB]);
      if (check.exitCode === 0) {
        ready = true;
        log(`ready after ${i + 1}s`);
        break;
      }
      await Bun.sleep(1000);
    }
    if (!ready) {
      err("Postgres never became ready");
      return 2;
    }

    const connArgs = ["--host=127.0.0.1", `--port=${hostPort}`, `--username=${LOCAL_USER}`];
    const env = { ...process.env, PGPASSWORD: LOCAL_PASSWORD };

    log("loading globals (just the app-relevant roles)");
    const gpgGlobals = Bun.spawn(
      ["gpg", "--batch", "--yes", "--passphrase-file", passphraseFile, "--decrypt", globalsEnc],
      { stdout: "pipe", stderr: "inherit" },
    );
    const grepRoles = Bun.spawn(
      ["grep", "-E", `^(CREATE ROLE|ALTER ROLE) (${RESTORE_ROLES.join("|")})\\b`],
      { stdin: gpgGlobals.stdout, stdout: "pipe" },
    );
    const psqlGlobals = Bun.spawn(
      ["psql", ...connArgs, `--dbname=${LOCAL_DB}`, "--set", "ON_ERROR_STOP=on", "-f", "-"],
      { stdin: grepRoles.stdout, stdout: "inherit", stderr: "inherit", env },
    );
    const globalsExit = await psqlGlobals.exited;
    log(`globals load exit=${globalsExit}`);
    if (globalsExit !== 0) return 2;

    log("restoring dump");
    const gpgDump = Bun.spawn(["gpg", "--batch", "--yes", "--passphrase-file", passphraseFile, "--decrypt", dumpEnc], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const pgRestore = Bun.spawn(
      ["pg_restore", ...connArgs, `--dbname=${LOCAL_DB}`, "--no-owner", "--no-privileges", "--exit-on-error"],
      { stdin: gpgDump.stdout, stdout: "inherit", stderr: "inherit", env },
    );
    const restoreExit = await pgRestore.exited;
    log(`pg_restore exit=${restoreExit}`);
    if (restoreExit !== 0) return 2;

    log("verification queries");
    const db = postgres({
      host: "127.0.0.1",
      port: Number(hostPort),
      username: LOCAL_USER,
      password: LOCAL_PASSWORD,
      database: LOCAL_DB,
      max: 1,
    });
    try {
      const counts = (await db`
        SELECT 'swarm_members' t, count(*) FROM swarm_members
        UNION ALL SELECT 'swarm_recommendations', count(*) FROM swarm_recommendations
        UNION ALL SELECT 'swarm_sessions', count(*) FROM swarm_sessions
        UNION ALL SELECT 'admin_credential', count(*) FROM admin_credential
        UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations
      `) as unknown as { t: string; count: string }[];
      for (const row of counts) log(`  ${row.t}: ${row.count}`);

      // §5.3's namespace invariant — same pre-0030 landmine as §8's checks
      // 4/6/7/9: swarm_members.handle does not exist until migration 0030
      // applies, so check column existence first (docs/runbooks/*.md §5.3).
      if (await columnExists(db, "swarm_members", "handle")) {
        const violations = (await db.unsafe(
          `SELECT a.id AS holder, a.handle AS handle, b.id AS shadowed
           FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id`,
        )) as unknown as { holder: string; handle: string; shadowed: string }[];
        if (violations.length > 0) {
          err(`${violations.length} handle/id namespace violation(s) in the restored copy`);
          return 1;
        }
        log("  namespace invariant: 0 rows (post-0030 backup, clean)");
      } else {
        log("  swarm_members.handle absent — this backup predates migration 0030 (expected pre-upgrade)");
      }

      log("");
      log("running this release's preflight checks against the restored dump");
      const checker = createChecker(`[${NAME}] `);
      await runChecks(db, checker);
      const preflightCode = printVerdict(checker.results, {
        logPrefix: `[${NAME}] `,
        okAll: `[${NAME}] VERDICT: DUMP SAFE TO UPGRADE`,
        okWithWarnings: `[${NAME}] VERDICT: DUMP SAFE TO UPGRADE`,
        blocked: `[${NAME}] VERDICT: DUMP BLOCKED`,
      });
      if (preflightCode !== 0) {
        err("a preflight check failed against the restored dump — do not proceed to the live replica (§4) until this is clean");
        return 1;
      }
    } finally {
      await db.end({ timeout: 5 });
    }

    log("restore verified and dump-based preflight is clean — safe to proceed to §4's live replica check");
    return 0;
  } finally {
    log(`cleaning up: docker rm -f ${container}`);
    Bun.spawnSync(["docker", "rm", "-f", container]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2])
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      err(`fatal: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 2;
    });
}
