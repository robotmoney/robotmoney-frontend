// ⛔ RUN THIS ON THE DEDICATED STAGING HOST, NEVER THE PRODUCTION API HOST.
// This does a real Docker image build plus a full app boot — genuine compute
// and disk load that a machine serving live production traffic cannot spare
// (docs/runbooks/*.md §2, added 2026-08-17 after exactly this mistake).
//
// The heavy rehearsal: restore the Gate C backup into a throwaway local
// Postgres (same mechanism as restore-check.ts), then boot the REAL app
// against it with the EXACT command §7.3 runs for real cutover —
// `bun smoke -- --external-pg --no-tui` — so this release's actual
// migrations run for real, not just the static checks preflight.ts makes.
// Then verifies the site actually serves, reusing scripts/demo-frontend-check.ts
// (the same route/content checks CI runs), not a bespoke health probe.
//
// Runs the boot from an ISOLATED git worktree, never the checkout you are
// sitting in: `--external-pg` reads DATABASE_URL from repo-root .env
// (scripts/lib/demo-external-pg.ts), and overwriting the real .env — even
// temporarily — risks corrupting it (crash mid-run, concurrent access) or
// leaking the throwaway DB into a boot you run later by hand. The worktree
// gets its own throwaway .env instead; node_modules is symlinked in from the
// main checkout (same lockfile, same commit — safe, and skips a slow
// `bun install`).
//
// This is deliberately NOT run by restore-check.ts or on every preflight —
// it is much slower (a real docker-compose boot: image build/pull,
// migration, seed, health-wait, easily several minutes) and heavier than the
// SQL-only checks. Run it as a final confidence pass before cutover, not as
// routine preflight.
//
// Usage:
//   bun scripts/upgrades/0.2.1-to-0.2.2/stage-rehearsal.ts [backupDir]
//
// Exit codes: 0 = migrated and booted clean, frontend checks pass;
// 1 = the boot or a frontend check failed; 2 = could not run (missing files,
// docker/git failure).

import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBackupFiles, restoreBackupIntoContainer, teardownContainer } from "../../../../scripts/lib/restore-container.ts";

const NAME = "stage-rehearsal-0.2.2";
const log = (msg: string) => console.log(`[${NAME}] ${msg}`);
const err = (msg: string) => console.error(`[${NAME}] ${msg}`);

const scriptDir = dirname(fileURLToPath(import.meta.url));
// backend/scripts/upgrades/0.2.1-to-0.2.2/ -> <repo root>
const repoRoot = join(scriptDir, "..", "..", "..", "..");

async function spawn(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  return proc.exited;
}

/**
 * How long the boot gets to reach readiness (§5.3b.1 G3). Generous on purpose:
 * a cold run pulls base images and compiles before a single container starts.
 * This is a DEADLINE, not an estimate — exceeding it is a failure (G1), never
 * a reason to wait longer.
 */
const READY_DEADLINE_MS = 20 * 60 * 1000;
const READY_POLL_MS = 5_000;

interface DemoState {
  project: string;
  apiPort: number;
}

/** First `key=`/`key =` value in a dotenv-shaped file, or null. */
function readEnvKey(file: string, key: string): string | null {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === key) return m[2]!.trim().replace(/^["']|["']$/g, "") || null;
  }
  return null;
}

/**
 * The funded OpenCode Zen credential, which this rehearsal REQUIRES.
 *
 * A rehearsal exists to run what production runs. AGENT_MODEL unset resolves
 * to DEFAULT_AGENT_MODEL (`opencode/deepseek-v4-flash`) — production's model —
 * and that needs OPENCODE_API_KEY. An earlier version of this script pinned
 * AGENT_MODEL=free to avoid spending the key, which quietly rehearsed a
 * DIFFERENT system: scripts/lib/swarm/inference.ts documents that model choice
 * is not neutral for swarm authorship (some families refuse the persona task
 * outright), so a green `free` run does not predict a production boot.
 *
 * Resolution order — process env first (CI/shell), then the two dotenv files a
 * staging host actually keeps. Never falls back to a keyless model: the same
 * refuse-rather-than-substitute rule scripts/lib/onboarding-eval.ts enforces.
 */
function resolveZenKey(): { key: string; source: string } | { error: string } {
  const fromEnv = process.env.OPENCODE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "process environment" };
  for (const rel of [".env", ".env.readonly"]) {
    const file = join(repoRoot, rel);
    const found = readEnvKey(file, "OPENCODE_API_KEY");
    if (found) return { key: found, source: rel };
  }
  return {
    error:
      "OPENCODE_API_KEY is not set (checked the process environment, ./.env and ./.env.readonly). " +
      "This rehearsal boots the production model (AGENT_MODEL unset -> opencode/deepseek-v4-flash), " +
      "which requires a funded Zen key. Set it and re-run. Do NOT work around this with AGENT_MODEL=free: " +
      "that rehearses a different model than production, and model choice materially changes swarm " +
      "authorship (scripts/lib/swarm/inference.ts).",
  };
}

async function main(backupDirArg?: string): Promise<number> {
  const backup = resolveBackupFiles(backupDirArg);
  if ("error" in backup) {
    err(backup.error);
    return 2;
  }

  // Resolve the credential BEFORE the expensive work. Discovering a missing
  // key after a restore and a multi-minute image build is a wasted window.
  const zen = resolveZenKey();
  if ("error" in zen) {
    err(zen.error);
    return 2;
  }

  // The api/worker containers this script boots will dial this same Postgres
  // from INSIDE their own network namespace, where 127.0.0.1 means the
  // container itself, not this host — demo-external-pg.ts's own
  // assertReachableFromContainer() rejects that. Bind to the Docker bridge
  // gateway instead of the default 127.0.0.1: still not internet-routable
  // (unlike 0.0.0.0, which Docker's own iptables rules can expose past a
  // firewall that looks like it blocks the port), but reachable from sibling
  // containers on the default bridge network, which is what we need here.
  const bridgeGateway = new TextDecoder()
    .decode(Bun.spawnSync(["docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]).stdout)
    .trim();
  if (!bridgeGateway) {
    err("could not determine the Docker bridge gateway (docker network inspect bridge)");
    return 2;
  }

  const restored = await restoreBackupIntoContainer(backup, log, { bindHost: bridgeGateway });
  if ("error" in restored) {
    err(restored.error);
    if (restored.container) teardownContainer(restored.container, log);
    return 2;
  }

  const worktree = mkdtempSync(join(tmpdir(), "rm-stage-rehearsal-"));
  // Compose project names must be lowercase alphanumeric/hyphen/underscore —
  // backup.stamp has uppercase T/Z (ISO 8601 basic format).
  const project = `rm_stage_rehearsal_${backup.stamp.toLowerCase()}`;
  let worktreeAdded = false;
  // Declared out here so the finally block can stop it on EVERY exit path (G6).
  let bootProc: Bun.Subprocess | null = null;

  try {
    log(`creating isolated worktree at ${worktree}`);
    const worktreeCode = await spawn(["git", "worktree", "add", "--detach", worktree, "HEAD"], { cwd: repoRoot });
    if (worktreeCode !== 0) {
      err("git worktree add failed");
      return 2;
    }
    worktreeAdded = true;

    for (const rel of ["node_modules", "backend/node_modules"]) {
      const src = join(repoRoot, rel);
      const dest = join(worktree, rel);
      if (existsSync(src)) symlinkSync(src, dest, "dir");
    }

    const databaseUrl = `postgres://${restored.username}:${restored.password}@${restored.host}:${restored.port}/${restored.database}`;
    // NO AGENT_MODEL here, deliberately: unset resolves to DEFAULT_AGENT_MODEL,
    // which is what production runs. Pinning a model — free or otherwise —
    // would rehearse something production does not do. The funded key rides
    // along so that default model can actually authenticate.
    writeFileSync(
      join(worktree, ".env"),
      `DATABASE_URL=${databaseUrl}\nOPENCODE_API_KEY=${zen.key}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    log(`wrote worktree .env pointing at the restored container via ${restored.host} (never the real .env)`);
    log(`inference: production default model, OPENCODE_API_KEY from ${zen.source} — real spend on a real key`);

    log(`booting: bun scripts/demo.ts --smoke --external-pg --no-tui  (project=${project}, this can take several minutes)`);
    // §7.3's box: CI unset, or the boot tears itself down on exit.
    const { CI: _ci, ...envWithoutCi } = process.env as Record<string, string | undefined>;
    const bootEnv = { ...envWithoutCi, DEMO_PROJECT: project };
    // SUPERVISED, NOT AWAITED (§5.3b.1 G2). With CI unset this boot never
    // self-terminates BY DESIGN: it falls past demo-main's CI-gated exits
    // (scripts/lib/demo-main.ts:1175, :1212) into the LIVE steady-state loop
    // and cycles swarm sessions forever. That is correct for §7.3, where the
    // stack must stay up serving production — so awaiting it here hangs the
    // rehearsal permanently, which is exactly what it used to do. Setting CI
    // is NOT the fix: a truthy CI tears the stack down regardless of exit
    // code, leaving the frontend checks below nothing to hit.
    bootProc = Bun.spawn(["bun", "scripts/demo.ts", "--smoke", "--external-pg", "--no-tui"], {
      cwd: worktree,
      env: bootEnv,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });
    let bootExit: number | null = null;
    void bootProc.exited.then((c) => {
      bootExit = c;
    });

    const stateFile = join(worktree, ".agents", "demo-state.json");
    log(`waiting for readiness (deadline ${Math.round(READY_DEADLINE_MS / 60000)}m): ${stateFile} + GET /health`);
    const startedAt = Date.now();
    let ready: DemoState | null = null;
    let lastNote = "";
    while (Date.now() - startedAt < READY_DEADLINE_MS) {
      // Fail fast rather than burning the whole deadline: with CI unset a
      // boot that exits AT ALL has failed (a healthy one runs forever).
      if (bootExit !== null) {
        err(`boot exited ${bootExit} before becoming ready — this release's migrations did not apply cleanly against production-shaped data, or the stack did not come up`);
        return 1;
      }
      if (existsSync(stateFile)) {
        try {
          const state = JSON.parse(readFileSync(stateFile, "utf8")) as DemoState;
          if (state?.apiPort) {
            const health = await fetch(`http://127.0.0.1:${state.apiPort}/health`).catch(() => null);
            if (health?.ok) {
              ready = state;
              break;
            }
            lastNote = `api port ${state.apiPort} not healthy yet (${health?.status ?? "no response"})`;
          }
        } catch {
          lastNote = "demo-state.json present but not yet parseable";
        }
      } else {
        lastNote = "demo-state.json not written yet (still building/starting)";
      }
      await Bun.sleep(READY_POLL_MS);
    }

    if (!ready) {
      // G1: a deadline miss is a FAILURE, never a reason to keep waiting.
      err(`not ready within ${Math.round(READY_DEADLINE_MS / 60000)}m — last state: ${lastNote || "no signal"}`);
      return 1;
    }

    const backendUrl = `http://127.0.0.1:${ready.apiPort}`;
    log(`ready after ${Math.round((Date.now() - startedAt) / 1000)}s: project=${ready.project} api=${backendUrl} (/health OK)`);

    log("running scripts/demo-frontend-check.ts against the booted stack (same checks CI runs)");
    const checkCode = await spawn(["bun", "scripts/demo-frontend-check.ts"], {
      cwd: worktree,
      env: { ...process.env, BACKEND_URL: backendUrl },
    });
    if (checkCode !== 0) {
      err("frontend checks failed against the migrated, booted stack");
      return 1;
    }

    log("VERDICT: migrated and booted clean, frontend checks pass — this release is safe to run against production-shaped data");
    return 0;
  } finally {
    // G6: unconditional, and in this order — every path lands here, including
    // a readiness timeout and an unhandled throw. G5 makes promptness part of
    // the contract: the stack runs production's model on a funded key and
    // authors real takes on a timer, so a leftover stack is a leaking meter.
    log("tearing down");

    // 1. Stop the supervisor's child FIRST. demo-down while the boot is still
    //    live races its own orchestration, and a surviving boot keeps spending.
    if (bootProc) {
      try {
        bootProc.kill();
        await bootProc.exited;
      } catch {
        /* already gone */
      }
    }

    if (worktreeAdded) {
      // 2. DEMO_PROJECT explicitly: demo-down resolves the project from state,
      //    and this still has to work when the boot died before writing it.
      await spawn(["bun", "scripts/demo-down.ts"], {
        cwd: worktree,
        env: { ...process.env, DEMO_PROJECT: project },
      }).catch(() => {});
      // 3. demo-down deliberately KEEPS volumes (they outlive a stack restart).
      //    For a rehearsal they are pure litter — and member_home_* volumes
      //    hold agent working state from a production-data run.
      try {
        const ls = Bun.spawnSync(["docker", "volume", "ls", "-q", "--filter", `name=${project}`]);
        const vols = new TextDecoder().decode(ls.stdout).split("\n").map((v) => v.trim()).filter(Boolean);
        if (vols.length) {
          Bun.spawnSync(["docker", "volume", "rm", ...vols]);
          log(`removed ${vols.length} leftover volume(s)`);
        }
      } catch {
        /* best effort */
      }
      await spawn(["git", "worktree", "remove", "--force", worktree], { cwd: repoRoot }).catch(() => {});
    }
    teardownContainer(restored.container, log);
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
