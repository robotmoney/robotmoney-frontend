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
import { resolveBackupFiles, restoreBackupIntoContainer, teardownContainer } from "../../lib/restore-container.ts";

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

interface DemoState {
  project: string;
  apiPort: number;
}

async function main(backupDirArg?: string): Promise<number> {
  const backup = resolveBackupFiles(backupDirArg);
  if ("error" in backup) {
    err(backup.error);
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
    // AGENT_MODEL=free: this rehearsal is about migrations + boot + page
    // serving, not agent-simulation quality — avoid needing (or spending)
    // the real, funded OPENCODE_API_KEY the main .env carries.
    writeFileSync(join(worktree, ".env"), `DATABASE_URL=${databaseUrl}\nAGENT_MODEL=free\n`, "utf8");
    log(`wrote worktree .env pointing at the restored container via ${restored.host} (never the real .env)`);

    log(`booting: bun scripts/demo.ts --smoke --external-pg --no-tui  (project=${project}, this can take several minutes)`);
    // §7.3's box: CI unset, or the boot tears itself down on exit.
    const { CI: _ci, ...envWithoutCi } = process.env as Record<string, string | undefined>;
    const bootEnv = { ...envWithoutCi, DEMO_PROJECT: project };
    const bootCode = await spawn(["bun", "scripts/demo.ts", "--smoke", "--external-pg", "--no-tui"], {
      cwd: worktree,
      env: bootEnv,
    });
    log(`boot exit=${bootCode}`);
    if (bootCode !== 0) {
      err("boot failed — this release's migrations did not apply cleanly against production-shaped data, or the stack did not come up healthy");
      return 1;
    }

    const stateFile = join(worktree, ".agents", "demo-state.json");
    if (!existsSync(stateFile)) {
      err(`boot exited 0 but ${stateFile} is missing — cannot find the api port`);
      return 2;
    }
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as DemoState;
    const backendUrl = `http://127.0.0.1:${state.apiPort}`;
    log(`stack is up: project=${state.project} api=${backendUrl}`);

    log("checking /health");
    const health = await fetch(`${backendUrl}/health`).catch((e) => {
      err(`GET /health failed: ${e instanceof Error ? e.message : e}`);
      return null;
    });
    if (!health || !health.ok) {
      err(`/health returned ${health?.status ?? "no response"}`);
      return 1;
    }
    log(`/health: ${health.status}`);

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
    log("tearing down");
    if (worktreeAdded) {
      await spawn(["bun", "scripts/demo-down.ts"], { cwd: worktree }).catch(() => {});
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
