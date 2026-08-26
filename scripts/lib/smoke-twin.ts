// BRINGING UP A DIGITAL TWIN for `bun smoke -- --db smoke-twin`.
//
// WHAT A TWIN IS. A local Postgres container holding a restored copy of the
// production database, which the stack then boots against. It exists so an
// upgrade can be rehearsed — real migrations, against real production-shaped
// data, on a machine that is not production — before the same commands are run
// for real. docs/technical/release-runbooks.md §4.4 is the gate it serves.
//
// WHY IT IS NOT `--db external`. It used to borrow that flag, which was wrong in
// the one way that matters: external means "somebody else's server, and nothing
// you do here can be undone", and a smoke-twin is the exact opposite — this boot
// created it and may reclaim it. The banner an operator saw on every rehearsal
// therefore said something false, which is how a real warning stops being read.
//
// WHAT THIS MODULE OWNS. Restoring the dump into a labelled container backed by
// a labelled volume, handing back the connection details, and the ONE assertion
// that the stack is really pointed at it. It deliberately does NOT own the
// scenario (that is --smoke), the checks (preflight.ts / postflight.ts stay
// separate runbook steps), or the capture (smoke:capture).
//
// DATA LIFETIME — the same contract an ephemeral boot's pgdata follows, which is
// what the operator already knows. Teardown removes the CONTAINER and keeps the
// VOLUME; `bun run smoke:clean` reclaims it. That is a deliberate choice with a
// real consequence, stated in the boot banner rather than buried here: a
// restored copy of production, including admin password hashes, session tokens
// and member access keys, stays on this host until somebody reclaims it.
//
// EVERY BOOT RESTORES FRESH. Reattaching to a surviving smoke-twin is NOT supported,
// and that is the point: the first boot MIGRATES the copy, so a second boot
// against the same volume would rehearse an already-upgraded database and go
// green for a reason that has nothing to do with the upgrade under test.
import { restoreBackupIntoContainer, resolveBackupFiles, teardownContainer } from "./restore-container.ts";
import { redactPostgresUrl } from "./smoke-external-pg.ts";
import type { DataPathRequest, ResolvedDataPath } from "./smoke-db-mode.ts";

export type SmokeTwinDataPath = Extract<ResolvedDataPath, { kind: "smoke-twin" }>;

export interface SmokeTwinHandle {
  dataPath: SmokeTwinDataPath;
  container: string;
  volume: string;
}

/**
 * The docker bridge gateway, e.g. 172.17.0.1.
 *
 * The api and worker containers dial this smoke-twin from INSIDE their own network
 * namespaces, where 127.0.0.1 means the container itself — smoke-external-pg.ts's
 * assertReachableFromContainer() rejects that address for exactly this reason.
 * The bridge gateway is reachable from sibling containers and is still not
 * internet-routable, unlike 0.0.0.0, which Docker's own iptables rules can
 * expose past a firewall that appears to block the port. Never 0.0.0.0 here:
 * this container holds a copy of production.
 */
function bridgeGateway(): string {
  const out = Bun.spawnSync([
    "docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  const gw = new TextDecoder().decode(out.stdout).trim();
  if (!gw) throw new Error("--db smoke-twin: could not determine the Docker bridge gateway (docker network inspect bridge)");
  return gw;
}

/** The volume this boot's smoke-twin data lives in. Named after the project so
 *  smoke:clean's label scoping reclaims it with everything else the boot made. */
export function smokeTwinVolumeName(project: string, stamp: string): string {
  return `${project}_smoke-twin_${stamp.toLowerCase()}`;
}

/**
 * Restore the backup into a throwaway local Postgres and return how to reach it.
 *
 * THROWS with the actionable message rather than falling back to an ephemeral
 * database: a rehearsal that quietly ran against an empty database would report
 * a clean upgrade of nothing at all.
 */
export async function bringUpTwin(opts: {
  backupDir?: string;
  project: string;
  log: (m: string) => void;
}): Promise<SmokeTwinHandle> {
  const backup = resolveBackupFiles(opts.backupDir);
  if ("error" in backup) throw new Error(`--db smoke-twin: ${backup.error}`);

  const volume = smokeTwinVolumeName(opts.project, backup.stamp);
  opts.log(`--db smoke-twin: restoring backup ${backup.stamp} into a local container (this takes a few minutes)`);
  const restored = await restoreBackupIntoContainer(backup, opts.log, {
    bindHost: bridgeGateway(),
    project: opts.project,
    volume,
  });
  if ("error" in restored) {
    // Tear the half-built container down here: it is not yet recorded anywhere
    // the normal cleanup path can find it.
    if (restored.container) teardownContainer(restored.container, opts.log);
    throw new Error(`--db smoke-twin: ${restored.error}`);
  }

  const url = `postgres://${restored.username}:${restored.password}@${restored.host}:${restored.port}/${restored.database}`;
  return {
    container: restored.container,
    volume,
    dataPath: {
      kind: "smoke-twin",
      backupDir: opts.backupDir,
      url,
      redactedUrl: redactPostgresUrl(url),
      container: restored.container,
      volume,
      stamp: backup.stamp,
    },
  };
}

/**
 * Prove the stack is pointed at the smoke-twin and nothing else.
 *
 * This replaces a whole apparatus. A release's stage-rehearsal.ts used to run
 * the boot from an isolated git worktree with a throwaway `.env`, for one reason
 * recorded in its header: `--external-pg` read DATABASE_URL from the repo-root
 * `.env`, and on a staging host that file holds PRODUCTION credentials, so
 * pointing the boot at a smoke-twin meant overwriting it. `--db smoke-twin` constructs its
 * URL in-process and writes no file, so the worktree, the symlinked node_modules
 * and the throwaway `.env` all go away. (v0.2.2's copy still has them — it is
 * kept as it executed — so read this as "how v0.3.0 onward does it".)
 *
 * What does not go away is the risk they were insurance against: compose
 * auto-loads the repo-root `.env`, so a stale DATABASE_URL there is one
 * precedence rule away from being what the containers actually dial. The rule is
 * on our side — buildSpawnEnv passes DATABASE_URL explicitly and compose ranks
 * the shell environment above `.env` — but "safe by precedence" is an argument,
 * and this is an assertion. A rehearsal that silently ran against production
 * would be the worst outcome this repo has.
 */
export function assertSmokeTwinIsTarget(spawnEnv: Record<string, string>, smokeTwinUrl: string): void {
  if (spawnEnv.DATABASE_URL !== smokeTwinUrl) {
    throw new Error(
      `--db smoke-twin: the compose environment's DATABASE_URL is NOT the smoke-twin's — refusing to boot. ` +
        `The stack would have migrated and written to ${redactPostgresUrl(spawnEnv.DATABASE_URL ?? "(unset)")} ` +
        `instead of the restored copy. (The repo-root .env is auto-loaded by compose; the stack config must win.)`,
    );
  }
}

/**
 * The data path a boot actually runs against: the requested one, with a smoke-twin
 * restored if that is what was asked for.
 *
 * Owns the FATAL path itself rather than handing smoke-main another try/catch —
 * smoke-main.ts is under a hard size ceiling (smoke-main-split.test.ts), and the
 * decision about what to print when a restore fails belongs with the restore.
 */
export async function resolveSmokeTwinDataPath(
  requested: DataPathRequest,
  project: string,
  log: (m: string) => void,
): Promise<{ dataPath: ResolvedDataPath; container?: string }> {
  if (requested.kind !== "smoke-twin") return { dataPath: requested };
  try {
    const smokeTwin = await bringUpTwin({ backupDir: requested.backupDir, project, log });
    return { dataPath: smokeTwin.dataPath, container: smokeTwin.container };
  } catch (err) {
    log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/** What teardown says about a smoke-twin whose container it just removed. */
export function smokeTwinTeardownNarration(dp: ResolvedDataPath): string | undefined {
  return dp.kind === "smoke-twin"
    ? `smoke-twin container removed; its restored copy of production is KEPT in volume ${dp.volume} — reclaim with: bun run smoke:clean`
    : undefined;
}

/**
 * What to tell the operator after a smoke-twin boot ends.
 *
 * Deliberately NOT called "resume": an ephemeral or --pg-data boot rejoins the
 * data it left behind, but a smoke-twin re-boot restores FRESH from the backup and
 * discards everything the last run migrated. Using the same word for both would
 * teach exactly the wrong expectation.
 */
export function smokeTwinResumeHint(dp: ResolvedDataPath): string[] {
  if (dp.kind !== "smoke-twin") return [];
  return [
    `the smoke-twin's restored copy of production is KEPT in volume ${dp.volume}.`,
    `  re-run (restores a FRESH copy):  bun smoke -- --db smoke-twin`,
    `  reclaim the copy:                bun run smoke:clean`,
  ];
}

/** What the leave-running failure path must say, or a copy of production leaks silently. */
export function smokeTwinLeftRunningHint(container: string | undefined): string[] {
  return container
    ? [
        `  smoke-twin:        ${container} is STILL RUNNING and holds a copy of production.`,
        `               remove it with: docker rm -f ${container}   (then: bun run smoke:clean)`,
      ]
    : [];
}

/** `docker inspect -f <format> <container>`, or "" when the daemon says no. */
function dockerInspect(container: string, format: string): string {
  const out = Bun.spawnSync(["docker", "inspect", "-f", format, container]);
  return out.exitCode === 0 ? new TextDecoder().decode(out.stdout).trim() : "";
}

/**
 * Recover a RUNNING smoke-twin's connection URL from the container itself.
 *
 * Deliberately not read out of `.agents/smoke-state.json`: smoke-main.ts redacts
 * every non-ephemeral DATABASE_URL there because that file lives inside the
 * checkout, and a smoke-twin's superuser password is a real credential — generated
 * fresh per run by restore-container.ts. What the state file DOES record is the
 * container's name, and the daemon on this host will hand back the rest. So a
 * release's own postflight can be pointed at the smoke-twin while it is still up,
 * without the password ever being written to disk.
 *
 * Returns null when the container is gone or does not answer. A caller must
 * treat that as "this check could not run" — never as a pass.
 */
export function smokeTwinUrlFromContainer(
  container: string,
  // Injected so the assembly below is testable in the checkout-only tier; the
  // default is the only implementation anything ships with.
  inspect: (format: string) => string = (format) => dockerInspect(container, format),
): string | null {
  const host = inspect('{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostIp}}');
  const port = inspect('{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}');
  if (!host || !port) return null;

  // The credentials are the ones restore-container.ts passed as -e on `docker
  // run`, so the container is their only authority.
  const env = new Map<string, string>();
  for (const line of inspect("{{range .Config.Env}}{{println .}}{{end}}").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const user = env.get("POSTGRES_USER");
  const password = env.get("POSTGRES_PASSWORD");
  const database = env.get("POSTGRES_DB");
  if (!user || !password || !database) return null;

  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}
