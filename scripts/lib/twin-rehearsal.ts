// ⛔ RUN THIS ON THE DEDICATED STAGING HOST, NEVER THE PRODUCTION API HOST.
// It does a real Docker image build plus a full app boot — genuine compute and
// disk load that a machine serving live production traffic cannot spare
// (docs/runbooks/*.md §2, added 2026-08-17 after exactly this mistake).
//
// THE HEAVY REHEARSAL, version-agnostic. Boot the real app against a restored
// copy of production with the EXACT command a cutover runs, so this release's
// migrations run for real rather than only being inspected, then verify the site
// actually serves — reusing scripts/demo-frontend-check.ts, the same route and
// content checks CI runs, not a bespoke health probe.
//
// WHY THIS IS NOT UNDER upgrades/<version>/. It used to be, as
// stage-rehearsal.ts, and nothing in it was ever version-specific except its own
// name: the restore, the readiness contract, the supervision rule and the
// teardown order are properties of "boot a twin and check it", not of 0.2.2. A
// release directory was therefore the one place it could not be found from, and
// `main` — already past v0.2.2 — had no twin entry point at all. The per-release
// scripts that ARE version-specific (preflight.ts, postflight.ts,
// restore-check.ts) stay where they are; this is the durable half.
//
// WHAT IS DURABLE, AND WHAT THE RELEASE STILL OWNS. This driver's contract is
// "a twin came up and served" — restore, boot, readiness, supervision, teardown
// — which is exactly the part that does not change per release. The CHECKS do
// change, so they stay with the release: preflight is a separate, earlier
// command, and postflight is handed back through `onReady` rather than guessed
// at here.
//
// WHY POSTFLIGHT IS A HOOK AND NOT A SEPARATE COMMAND. The twin exists only
// inside this function's try block — the finally below tears it down. Telling an
// operator to "run postflight against the twin afterwards" is therefore an
// instruction to race a watcher against teardown from a second terminal, which
// is not a procedure. G8 (docs/runbooks/rollout-procedure.md) makes that window
// part of the contract instead, and `onReady` is where a release plugs into it.
//
// WHAT REPLACED THE ISOLATED WORKTREE. This used to `git worktree add` a
// throwaway checkout, symlink node_modules into it and write a throwaway `.env`,
// for ONE reason: `--external-pg` read DATABASE_URL from repo-root `.env`, and
// overwriting that file on a staging host risks corrupting a real credential.
// `--db twin` constructs its URL in-process and writes no file, so all of it is
// gone, and demo-twin.ts's assertTwinIsTarget() covers the risk it existed for.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { twinUrlFromContainer } from "./demo-twin.ts";

/**
 * How long the boot gets to reach readiness. Generous on purpose: a cold run
 * pulls base images and compiles before a single container starts. This is a
 * DEADLINE, not an estimate — exceeding it is a failure, never a reason to wait
 * longer.
 */
export const READY_DEADLINE_MS = 20 * 60 * 1000;
export const READY_POLL_MS = 5_000;

/** Repo root, resolved from this module rather than cwd. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface DemoState {
  project: string;
  apiPort: number;
  /** Written only by a `--db twin` boot — see demo-main.ts's writeStateFile(). */
  twinContainer?: string;
}

async function spawn(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  return proc.exited;
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

/** The ONE credential file every twin/rollout command reads. */
export const READONLY_ENV_FILE = ".env.readonly";

/**
 * The funded OpenCode Zen credential, which this rehearsal REQUIRES.
 *
 * A rehearsal exists to run what production runs. AGENT_MODEL unset resolves to
 * DEFAULT_AGENT_MODEL — production's model — and that needs OPENCODE_API_KEY. An
 * earlier version pinned AGENT_MODEL=free to avoid spending the key, which
 * quietly rehearsed a DIFFERENT system: scripts/lib/swarm/inference.ts documents
 * that model choice is not neutral for swarm authorship (some families refuse
 * the persona task outright), so a green `free` run does not predict production.
 *
 * `.env.readonly` IS THE ONLY FILE CONSULTED, and `.env` is deliberately NOT in
 * the chain any more. On a staging host `.env` is where the application's WRITER
 * DATABASE_URL lives, and every command in this family — twin:capture,
 * twin:rehearse, `bun run twin`, the release preflight — is defined by NOT
 * needing that credential. Reading `.env` made the twin tooling depend on the
 * one file it exists to stay away from, and made "which key did that run use?"
 * a question with two possible answers. One low-privilege file now serves the
 * whole family, which is exactly what .env.readonly.example describes it as.
 *
 * The process environment still wins, because that is how CI and a one-off shell
 * override supply it; it is not a file and cannot be the writer credential by
 * accident.
 *
 * The key is passed to the boot in its ENVIRONMENT, never written to a file.
 * That does not violate the flags-not-env-vars rule, which is scoped to
 * DATA-PATH decisions (see demo-db-mode.ts): this is a credential, handed to a
 * child exactly as the analytics and automation tokens are.
 */
export function resolveZenKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: string } | { error: string } {
  const fromEnv = env.OPENCODE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "process environment" };
  const found = readEnvKey(join(repoRoot, READONLY_ENV_FILE), "OPENCODE_API_KEY");
  if (found) return { key: found, source: READONLY_ENV_FILE };
  return {
    error:
      `OPENCODE_API_KEY is not set. This command reads it from ./${READONLY_ENV_FILE} (or the process ` +
      `environment) — NOT from ./.env, which holds the writer credential this family of commands ` +
      `deliberately does not use. Add OPENCODE_API_KEY to ./${READONLY_ENV_FILE} and re-run. ` +
      "Do NOT work around this with AGENT_MODEL=free: that rehearses a different model than production, " +
      "and model choice materially changes swarm authorship (scripts/lib/swarm/inference.ts).",
  };
}

/** What a release's own checks are handed while the twin is still up. */
export interface TwinWindow {
  /** The booted stack's API base, e.g. http://127.0.0.1:54321. */
  backendUrl: string;
  /** A direct connection URL for the twin's Postgres. Never logged. */
  databaseUrl: string;
  log: (m: string) => void;
  err: (m: string) => void;
}

export interface RehearsalOptions {
  /** Label for this run's log lines and its compose project. */
  name: string;
  /** Where the encrypted backup lives; defaults to restore-container.ts's default. */
  backupDir?: string;
  /**
   * This release's own checks, run against the migrated twin after the boot
   * serves and BEFORE teardown (G8). Return 0 to pass; any other value fails
   * the rehearsal. Omit it and the rehearsal grades restore + boot + serve
   * only, which is what `bun run twin:rehearse` does.
   */
  onReady?: (window: TwinWindow) => Promise<number>;
}

/**
 * Run the rehearsal. Returns the process exit code:
 *   0 = migrated, booted clean, frontend checks pass
 *   1 = the boot or a check failed
 *   2 = could not run (missing credential, docker failure)
 */
export async function runTwinRehearsal(opts: RehearsalOptions): Promise<number> {
  const log = (m: string) => console.log(`[${opts.name}] ${m}`);
  const err = (m: string) => console.error(`[${opts.name}] ${m}`);

  // Resolve the credential BEFORE the expensive work. Discovering a missing key
  // after a restore and a multi-minute image build is a wasted window.
  const zen = resolveZenKey();
  if ("error" in zen) {
    err(zen.error);
    return 2;
  }

  // Compose project names must be lowercase alphanumeric/hyphen/underscore.
  const project = `rm_demo_rehearsal_${opts.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`;
  let bootProc: Bun.Subprocess | null = null;

  try {
    const args = ["bun", "scripts/demo.ts", "--smoke", "--db", "twin", "--no-tui"];
    if (opts.backupDir) args.push("--backup-dir", opts.backupDir);
    log(`booting: ${args.slice(1).join(" ")}  (project=${project}, this can take several minutes)`);
    log(`inference: production default model, OPENCODE_API_KEY from ${zen.source} — real spend on a real key`);

    // CI is STRIPPED: this must be the boot a cutover runs, and a truthy CI
    // tears the stack down regardless of exit code, leaving the frontend checks
    // nothing to hit.
    const { CI: _ci, ...envWithoutCi } = process.env as Record<string, string | undefined>;
    bootProc = Bun.spawn(args, {
      cwd: repoRoot,
      env: { ...envWithoutCi, DEMO_PROJECT: project, OPENCODE_API_KEY: zen.key },
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });
    let bootExit: number | null = null;
    void bootProc.exited.then((c) => {
      bootExit = c;
    });

    // SUPERVISED, NOT AWAITED. With CI unset the boot never self-terminates BY
    // DESIGN: it falls past demo-main's CI-gated exits into the LIVE
    // steady-state loop and cycles sessions forever. That is correct for a
    // cutover, where the stack must stay up serving — so awaiting it here would
    // hang the rehearsal permanently.
    const stateFile = join(repoRoot, ".agents", "demo-state.json");
    log(`waiting for readiness (deadline ${Math.round(READY_DEADLINE_MS / 60000)}m): ${stateFile} + GET /health`);
    const startedAt = Date.now();
    let ready: DemoState | null = null;
    let lastNote = "";
    while (Date.now() - startedAt < READY_DEADLINE_MS) {
      // Fail fast rather than burning the whole deadline: with CI unset a boot
      // that exits AT ALL has failed (a healthy one runs forever).
      if (bootExit !== null) {
        err(`boot exited ${bootExit} before becoming ready — this release's migrations did not apply cleanly against production-shaped data, or the stack did not come up`);
        return 1;
      }
      if (existsSync(stateFile)) {
        try {
          const state = JSON.parse(readFileSync(stateFile, "utf8")) as DemoState;
          if (state?.apiPort && state.project === project) {
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
      // A deadline miss is a FAILURE, never a reason to keep waiting.
      err(`not ready within ${Math.round(READY_DEADLINE_MS / 60000)}m — last state: ${lastNote || "no signal"}`);
      return 1;
    }

    const backendUrl = `http://127.0.0.1:${ready.apiPort}`;
    log(`ready after ${Math.round((Date.now() - startedAt) / 1000)}s: project=${ready.project} api=${backendUrl} (/health OK)`);

    log("running scripts/demo-frontend-check.ts against the booted stack (same checks CI runs)");
    const checkCode = await spawn(["bun", "scripts/demo-frontend-check.ts"], {
      env: { ...process.env, BACKEND_URL: backendUrl },
    });
    if (checkCode !== 0) {
      err("frontend checks failed against the migrated, booted stack");
      return 1;
    }

    if (opts.onReady) {
      // The twin's URL is recovered from the container, not from
      // demo-state.json, which redacts it — see twinUrlFromContainer().
      const databaseUrl = ready.twinContainer ? twinUrlFromContainer(ready.twinContainer) : null;
      if (!databaseUrl) {
        // NEVER a pass. A release's checks not running is indistinguishable, in
        // the receipt, from them running and finding nothing wrong.
        err(
          ready.twinContainer
            ? `could not recover a connection URL for twin container ${ready.twinContainer} — this release's checks did not run`
            : "the booted stack recorded no twin container — this rehearsal did not run against a twin at all",
        );
        return 1;
      }
      const hookCode = await opts.onReady({ backendUrl, databaseUrl, log, err });
      if (hookCode !== 0) return hookCode === 2 ? 2 : 1;
      log("VERDICT: migrated and booted clean, frontend checks pass, this release's checks are clean against the twin");
      return 0;
    }

    log("VERDICT: migrated and booted clean, frontend checks pass — this release is safe to run against production-shaped data");
    return 0;
  } finally {
    // Unconditional, and in this order — every path lands here, including a
    // readiness timeout and an unhandled throw. Promptness is part of the
    // contract: the stack runs production's model on a funded key and authors
    // real takes on a timer, so a leftover stack is a leaking meter.
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

    // 2. DEMO_PROJECT explicitly: demo-down resolves the project from state, and
    //    this still has to work when the boot died before writing it. demo-down
    //    also removes the twin CONTAINER, which is why nothing here does.
    await spawn(["bun", "scripts/demo-down.ts"], {
      env: { ...process.env, DEMO_PROJECT: project },
    }).catch(() => {});

    // 3. demo-down deliberately KEEPS volumes — including the twin's, whose
    //    contract is that it survives teardown. For a REHEARSAL they are pure
    //    litter, and both the twin volume and the member_home_* volumes hold
    //    data derived from production. Scoped to this run's project, never a
    //    bare demo:clean, which is host-wide.
    try {
      const ls = Bun.spawnSync(["docker", "volume", "ls", "-q", "--filter", `name=${project}`]);
      const vols = new TextDecoder().decode(ls.stdout).split("\n").map((v) => v.trim()).filter(Boolean);
      if (vols.length) {
        Bun.spawnSync(["docker", "volume", "rm", ...vols]);
        log(`removed ${vols.length} leftover volume(s) holding production-derived data`);
      }
    } catch {
      /* best effort */
    }
  }
}
