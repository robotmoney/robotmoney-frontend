// ⛔ RUN THIS ON THE DEDICATED STAGING HOST, NEVER THE PRODUCTION API HOST.
// It does a real Docker image build plus a full app boot — genuine compute and
// disk load that a machine serving live production traffic cannot spare
// (docs/runbooks/*.md §2, added 2026-08-17 after exactly this mistake).
//
// THE HEAVY REHEARSAL, version-agnostic. Boot the real app against a restored
// copy of production with the EXACT command a cutover runs, so this release's
// migrations run for real rather than only being inspected, then verify the site
// actually serves — reusing scripts/smoke-frontend-check.ts, the same route and
// content checks CI runs, not a bespoke health probe.
//
// WHY THIS IS NOT UNDER upgrades/<version>/. It used to be, copied whole into
// each release's stage-rehearsal.ts, and none of it was ever version-specific
// except the name: the restore, the readiness contract, the supervision rule and
// the teardown order are properties of "boot a smoke-twin and check it", not of any
// one release. A release directory was therefore the one place it could not be
// found from, and `main` had no smoke-twin entry point at all.
//
// stage-rehearsal.ts DID NOT GO AWAY. v0.3.0's is now a thin wrapper over this
// driver that supplies its own postflight and emits P5.rehearsal-boot; v0.2.2's
// is left exactly as it executed, because a shipped release directory is the
// record of what that release actually checked. The per-release scripts that ARE
// version-specific (preflight.ts, postflight.ts, restore-check.ts) stay where
// they are; this is the durable half.
//
// WHAT IS DURABLE, AND WHAT THE RELEASE STILL OWNS. This driver's contract is
// "a smoke-twin came up and served" — restore, boot, readiness, supervision, teardown
// — which is exactly the part that does not change per release. The CHECKS do
// change, so they stay with the release: preflight is a separate, earlier
// command, and postflight is handed back through `onReady` rather than guessed
// at here.
//
// WHY POSTFLIGHT IS A HOOK AND NOT A SEPARATE COMMAND. The smoke-twin exists only
// inside this function's try block — the finally below tears it down. Telling an
// operator to "run postflight against the smoke-twin afterwards" is therefore an
// instruction to race a watcher against teardown from a second terminal, which
// is not a procedure. The historical G8 procedure required checks to run
// before teardown, and `onReady` is where a release plugs into that window.
//
// WHAT REPLACED THE ISOLATED WORKTREE. This used to `git worktree add` a
// throwaway checkout, symlink node_modules into it and write a throwaway `.env`,
// for ONE reason: `--external-pg` read DATABASE_URL from repo-root `.env`, and
// overwriting that file on a staging host risks corrupting a real credential.
// `--db smoke-twin` constructs its URL in-process and writes no file, so all of it is
// gone, and smoke-twin.ts's assertSmokeTwinIsTarget() covers the risk it existed for.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeEnvFilePath } from "./env-role.ts";
import { smokeTwinUrlFromContainer } from "./smoke-twin.ts";
import { instancePaths, stateRoot } from "./smoke-state.ts";
import { refuseCheckoutEnvFile } from "../smoke.ts";

/**
 * How long the boot gets to reach readiness. Generous on purpose: a cold run
 * pulls base images and compiles before a single container starts. This is a
 * DEADLINE, not an estimate — exceeding it is a failure, never a reason to wait
 * longer.
 */
export const READY_DEADLINE_MS = 20 * 60 * 1000;
export const READY_POLL_MS = 5_000;

/** Default ceiling on the post-readiness check window (RehearsalOptions.checkDeadlineMs).
 *
 *  45 minutes: enough for a release to watch a 30s-tick scheduler fire and a
 *  paced backfill day complete against a metered RPC budget, and far short of
 *  "nobody noticed it was still up". */
export const CHECK_DEADLINE_MS = 45 * 60 * 1000;

/** Repo root, resolved from this module rather than cwd. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface SmokeState {
  project: string;
  apiPort: number;
  /**
   * website-server's host port — the static/SPA origin since issue #892, and
   * the one a page fetch must use. The api port answers /views/* with the SPA
   * shell, so checking content against it misses every assertion while looking
   * like a content regression.
   */
  webPort?: number;
  /** Written only by a `--local dump` boot — see smoke-main.ts's writeStateFile(). */
  smokeTwinContainer?: string;
  /** When the boot wrote the file; a file older than this rehearsal's boot is a previous run's. */
  createdAt?: string;
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

/** The ONE credential file every smoke-twin/rollout command reads: $HOME/.env
 *  (the same file .env.example describes — discrete DO tokens plus one role
 *  line per role; the staging host's copy carries only rm_readonly). */
export const READONLY_ENV_FILE = homeEnvFilePath();

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
 * FROM THE PROCESS ENVIRONMENT, AND NOWHERE ELSE. It used to be read from
 * $HOME/.env as a fallback. Spec §3 (as amended by D52) makes that file hold
 * EXACTLY the connection values, the three runtime role passwords, RM_ENV and
 * RM_CREDENTIALS — "It must not contain ... a model key" — and preflight check 4
 * refuses any other key there on prod. A model key belongs to the participant
 * that spends it (its credential.json entry); the operator running a one-off
 * rehearsal supplies this one to this command, in the shell that runs it (CI:
 * the repository secret), and the file never learns it.
 *
 * The key is passed to the boot in its ENVIRONMENT, never written to a file.
 * That does not violate the flags-not-env-vars rule, which is scoped to
 * DATA-PATH decisions (see smoke-db-mode.ts): this is a credential, handed to a
 * child exactly as the analytics and automation tokens are.
 */
export function resolveZenKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: string } | { error: string } {
  const fromEnv = env.OPENCODE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "process environment" };
  return {
    error:
      "OPENCODE_API_KEY is not set in this command's environment. Export it in the shell that runs the " +
      `rehearsal; it is never read from ${READONLY_ENV_FILE}, which holds only the §3 keys (spec §3, preflight ` +
      "check 4), nor from a repo-root .env. " +
      "Do NOT work around this with AGENT_MODEL=free: that rehearses a different model than production, " +
      "and model choice materially changes swarm authorship (scripts/lib/swarm/inference.ts).",
  };
}

/** What a release's own checks are handed while the smoke-twin is still up. */
export interface SmokeTwinWindow {
  /** The booted stack's API base, e.g. http://127.0.0.1:54321. */
  backendUrl: string;
  /** A direct connection URL for the smoke-twin's Postgres. Never logged. */
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
   * This release's own checks, run against the migrated smoke-twin after the boot
   * serves and BEFORE teardown (G8). Return 0 to pass; any other value fails
   * the rehearsal. Omit it and the rehearsal grades restore + boot + serve
   * only, which is what `bun run smoke:twin:once` does.
   *
   * THE DURATION OF THIS AWAIT IS THE TWIN'S LIFETIME. That is the whole
   * hold-open mechanism — there is no flag, and deliberately so (a flag would
   * mean an unsupervised standing smoke-twin holding production-derived data with a
   * graded receipt attached to nothing, which is what `bun run smoke:twin` is for and
   * why it carries the warning it does). A release that needs to observe
   * something slow — a scheduled job firing, a backfill completing — simply
   * takes longer to return, and `checkDeadlineMs` below is what keeps that
   * bounded.
   */
  onReady?: (window: SmokeTwinWindow) => Promise<number>;
  /**
   * Ceiling on the `onReady` await, i.e. on how long the smoke-twin may stay up after
   * readiness. Defaults to CHECK_DEADLINE_MS.
   *
   * WHY A SECOND DEADLINE, rather than widening READY_DEADLINE_MS: that one
   * bounds readiness, and merging them would make "the image build was slow"
   * and "a check hung" the same failure with the same message. They want
   * different diagnoses.
   *
   * WHY A CEILING AT ALL: G1 says a rehearsal terminates on its own, always,
   * and G5 says spend is bounded. When the hook was a single postflight spawn
   * that cost seconds, an unbounded await was harmless. Once a release can hold
   * the window open for minutes to watch a scheduler tick, an unbounded await
   * is a new way to leak exactly what the `finally` exists to prevent.
   */
  checkDeadlineMs?: number;
}

/**
 * Run the rehearsal. Returns the process exit code:
 *   0 = migrated, booted clean, frontend checks pass
 *   1 = the boot or a check failed
 *   2 = could not run (missing credential, docker failure)
 */
export async function runSmokeTwinRehearsal(opts: RehearsalOptions): Promise<number> {
  const log = (m: string) => console.log(`[${opts.name}] ${m}`);
  const err = (m: string) => console.error(`[${opts.name}] ${m}`);

  // No env file from the checkout (criterion 122). The boot below inherits this
  // process's environment, so a `.env` bun loaded HERE would reach it even
  // though the child itself runs with --no-env-file. package.json runs this as
  // `bun --no-env-file`; a hand-typed run without it is refused, not trusted.
  const envFileRefusal = refuseCheckoutEnvFile(process.execArgv, { script: "smoke:twin:once", file: "scripts/smoke-twin-rehearse.ts" });
  if (envFileRefusal) {
    err(`FATAL: ${envFileRefusal}`);
    return 2;
  }

  // Resolve the credential BEFORE the expensive work. Discovering a missing key
  // after a restore and a multi-minute image build is a wasted window.
  const zen = resolveZenKey();
  if ("error" in zen) {
    err(zen.error);
    return 2;
  }

  // The compose project is NOT chosen here. It used to be pinned through
  // SMOKE_PROJECT, which spec §1 retires with no alias: the boot names its own
  // project from its environment, and this rehearsal learns it from the state
  // file the boot writes (the first one written after the boot started).
  let project: string | null = null;
  let rehearsalInstance: string | null = null;
  let bootProc: Bun.Subprocess | null = null;
  const bootStartedAt = Date.now();

  try {
    // `--migrate` is explicit because no mode implies it (spec §4.3, §5): a
    // restored dump sits on the schema production had when it was taken, and
    // the non-superuser migration RM_TWIN_PRODUCTION_PRIVILEGES shapes below is
    // the thing this rehearsal exists to run. Without it the boot refuses a
    // stale schema rather than serving it (smoke-main.ts's preflight).
    // Its OWN deployment instance (spec §1.1), so its journal, receipt and stack
    // record never mix with the host's standing instance, and teardown can name
    // exactly this stack.
    const instance = `rm_twin_rehearsal_${randomBytes(4).toString("hex")}`;
    rehearsalInstance = instance;
    const args = ["bun", "--no-env-file", "scripts/smoke.ts", "--local", opts.backupDir ? `dump=${opts.backupDir}` : "dump", "--migrate", "--instance", instance];
    log(`booting: ${args.slice(2).join(" ")}  (this can take several minutes)`);
    log(`inference: production default model, OPENCODE_API_KEY from ${zen.source} — real spend on a real key`);

    // CI is STRIPPED: this must be the boot a cutover runs, and a truthy CI
    // tears the stack down regardless of exit code, leaving the frontend checks
    // nothing to hit.
    const { CI: _ci, ...envWithoutCi } = process.env as Record<string, string | undefined>;
    bootProc = Bun.spawn(args, {
      cwd: repoRoot,
      env: {
        ...envWithoutCi,
        OPENCODE_API_KEY: zen.key,
        // A REHEARSAL migrates the way a cutover does: as a non-superuser
        // bootstrap login, not as the twin container's superuser. Without this
        // the boot bypasses every ACL check a production migration faces, and
        // the rehearsal cannot see an ownership or grant defect — which is how
        // 0053 reached a production runbook with three of them. See
        // shapeTwinToProductionPrivileges() in restore-container.ts.
        RM_TWIN_PRODUCTION_PRIVILEGES: "1",
      },
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });
    let bootExit: number | null = null;
    void bootProc.exited.then((c) => {
      bootExit = c;
    });

    // SUPERVISED, NOT AWAITED. `bun smoke` exits 0 at readiness (spec §1) and
    // leaves the stack up under Docker; a non-zero exit before readiness is the
    // failure. The record of what it brought up is the instance's
    // stack-state.json, polled here together with GET /health.
    const stateFile = instancePaths(stateRoot(process.env), instance).stackStateFile;
    log(`waiting for readiness (deadline ${Math.round(READY_DEADLINE_MS / 60000)}m): ${stateFile} + GET /health`);
    const startedAt = Date.now();
    let ready: SmokeState | null = null;
    let lastNote = "";
    while (Date.now() - startedAt < READY_DEADLINE_MS) {
      // Fail fast rather than burning the whole deadline: with CI unset a boot
      // that exits AT ALL has failed (a healthy one runs forever).
      if (bootExit !== null && bootExit !== 0) {
        err(`boot exited ${bootExit} before becoming ready — this release's migrations did not apply cleanly against production-shaped data, or the stack did not come up`);
        return 1;
      }
      if (existsSync(stateFile)) {
        try {
          const state = JSON.parse(readFileSync(stateFile, "utf8")) as SmokeState;
          const fresh = state?.createdAt !== undefined && Date.parse(state.createdAt) >= bootStartedAt;
          if (state?.apiPort && fresh) {
            project = state.project;
            const health = await fetch(`http://127.0.0.1:${state.apiPort}/health`).catch(() => null);
            if (health?.ok) {
              ready = state;
              break;
            }
            lastNote = `api port ${state.apiPort} not healthy yet (${health?.status ?? "no response"})`;
          }
        } catch {
          lastNote = "stack-state.json present but not yet parseable";
        }
      } else {
        lastNote = "stack-state.json not written yet (still building/starting)";
      }
      await Bun.sleep(READY_POLL_MS);
    }

    if (!ready) {
      // A deadline miss is a FAILURE, never a reason to keep waiting.
      err(`not ready within ${Math.round(READY_DEADLINE_MS / 60000)}m — last state: ${lastNote || "no signal"}`);
      return 1;
    }

    // /health is the api's; the frontend checks fetch PAGES, which only
    // website-server serves (issue #892). Deliberately no fallback to apiPort:
    // that is exactly the misconfiguration this fixes, and it fails as a wall
    // of "MISSING" content assertions that reads like a broken frontend.
    if (!ready.webPort) {
      err("stack-state.json has no webPort — the boot never recorded the website-server port it was assigned");
      return 1;
    }
    const backendUrl = `http://127.0.0.1:${ready.webPort}`;
    log(`ready after ${Math.round((Date.now() - startedAt) / 1000)}s: project=${ready.project} api=http://127.0.0.1:${ready.apiPort} (/health OK) web=${backendUrl}`);

    // WORKER LANES MUST BE HEALTHY, not merely running.
    //
    // /health above is the API's alone, and the frontend checks below assert
    // static CONTENT — neither can see a wedged worker lane, so a rehearsal
    // could report a clean release while swarm/analytics/research were failing
    // every cycle. That is not hypothetical: the gap was found by booting a
    // standing twin and looking at the lanes by hand, which is exactly the
    // inspection a green rehearsal is supposed to make unnecessary.
    //
    // The lanes' own healthcheck is the right signal precisely because it is
    // not "the process exists": each writes a heartbeat from INSIDE its work
    // loop with its own staleness budget (backend/src/ops/healthcheck.ts), so
    // an idle lane stays green and a deadlocked one goes red.
    const laneDeadline = Date.now() + 180_000;
    let lanes = "";
    for (;;) {
      const ps = Bun.spawnSync(["docker", "ps", "--filter", `label=com.docker.compose.project=${ready.project}`, "--format", "{{.Names}}\t{{.Status}}"]);
      lanes = new TextDecoder().decode(ps.stdout).trim();
      // `docker compose run` children (analytics-producer-run-*, the per-member
      // member-agent containers) carry the same project label but are one-shot
      // and come and go mid-rehearsal; gating on them would stall on a
      // container that is *supposed* to exit.
      const rows = lanes.split("\n").filter(Boolean).filter((r) => !/-run-[0-9a-f]{6,}/.test(r));
      // Only containers that DECLARE a healthcheck report one; the rest are
      // judged by still being up, which is all docker can tell us about them.
      const unhealthy = rows.filter((r) => /unhealthy/i.test(r));
      const starting = rows.filter((r) => /health: starting/i.test(r));
      if (rows.length && unhealthy.length === 0 && starting.length === 0) {
        log(`all ${rows.length} container(s) healthy:\n${lanes.split("\n").map((l) => `  ${l}`).join("\n")}`);
        break;
      }
      if (Date.now() > laneDeadline) {
        err("container health did not settle within 180s — a lane is unhealthy or never left 'starting':");
        for (const r of [...unhealthy, ...starting]) err(`  ${r}`);
        for (const r of unhealthy) {
          const name = r.split("\t")[0]!;
          const insp = Bun.spawnSync(["docker", "inspect", "--format", "{{range .State.Health.Log}}{{.Output}}{{end}}", name]);
          const why = new TextDecoder().decode(insp.stdout).trim().split("\n").slice(-3).join(" | ");
          if (why) err(`  ${name}: ${why}`);
        }
        return 1;
      }
      await Bun.sleep(5000);
    }

    log("running scripts/smoke-frontend-check.ts against the booted stack (same checks CI runs)");
    const checkCode = await spawn(["bun", "scripts/smoke-frontend-check.ts"], {
      env: { ...process.env, BACKEND_URL: backendUrl },
    });
    if (checkCode !== 0) {
      err("frontend checks failed against the migrated, booted stack");
      return 1;
    }

    // PRODUCT invariants, same driver CI and the cutover run. The frontend
    // checks above assert CONTENT; this asserts that the swarm pipeline
    // produced decisions and that each published allocation vector still
    // recomputes from its own published takes (D42). tier=full: a twin may be
    // driven.
    log("verifying product invariants against the migrated stack (verify-live)");
    const verifyCode = await spawn(["bun", "run", "scripts/verify-live.ts", "--base", backendUrl, "--tier", "full"]);
    if (verifyCode !== 0) {
      err("product verification failed against the migrated, booted stack");
      return 1;
    }

    if (opts.onReady) {
      // The smoke-twin's URL is recovered from the container, not from
      // the stack record, which redacts it — see smokeTwinUrlFromContainer().
      const databaseUrl = ready.smokeTwinContainer ? smokeTwinUrlFromContainer(ready.smokeTwinContainer) : null;
      if (!databaseUrl) {
        // NEVER a pass. A release's checks not running is indistinguishable, in
        // the receipt, from them running and finding nothing wrong.
        err(
          ready.smokeTwinContainer
            ? `could not recover a connection URL for smoke-twin container ${ready.smokeTwinContainer} — this release's checks did not run`
            : "the booted stack recorded no smoke-twin container — this rehearsal did not run against a smoke-twin at all",
        );
        return 1;
      }
      // Race the hook against BOTH a deadline and the boot's own death.
      //
      // The boot supervision matters as much as the deadline: until the window
      // could be held open, nothing watched `bootExit` after readiness, because
      // the hook returned in seconds. Over a window of minutes the stack can
      // die underneath the checks — and then they either hang on a dead port or,
      // worse, grade a corpse and report green.
      const deadlineMs = opts.checkDeadlineMs ?? CHECK_DEADLINE_MS;
      const checksStartedAt = Date.now();
      log(`running this release's checks against the smoke-twin (deadline ${Math.round(deadlineMs / 60000)}m)`);
      const TIMED_OUT = Symbol("timeout");
      const BOOT_DIED = Symbol("boot-died");
      // The deadline timer MUST be cancellable. Promise.race does not cancel
      // the promises that lose it, so a bare `Bun.sleep(deadlineMs)` keeps the
      // event loop alive for the full deadline after the hook has returned —
      // the rehearsal completes, tears down, writes its receipt, and then sits
      // there for the rest of the 45 minutes. Observed exactly that on
      // 2026-08-22: two runs finished all their work and stayed resident. A
      // deadline added to enforce G1 ("it terminates on its own, always") must
      // not be the thing that breaks it.
      // The boot itself exits at readiness now (spec §1), so "the boot died" is
      // "this project's api container stopped running": polled, and cancelled
      // with the deadline for the reason given below.
      let goneTimer: ReturnType<typeof setInterval> | undefined;
      const stackGone = new Promise<void>((resolve) => {
        goneTimer = setInterval(() => {
          const ps = Bun.spawnSync(["docker", "ps", "-q", "--filter", `label=com.docker.compose.project=${ready!.project}`, "--filter", "label=com.docker.compose.service=api"]);
          if (ps.exitCode === 0 && new TextDecoder().decode(ps.stdout).trim() === "") resolve();
        }, 10_000);
      });
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<number>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(TIMED_OUT as unknown as number), deadlineMs);
      });
      let hookCode: number;
      try {
        hookCode = await Promise.race([
          opts.onReady({ backendUrl, databaseUrl, log, err }),
          deadline,
          stackGone.then(() => BOOT_DIED as unknown as number),
        ]);
      } finally {
        clearTimeout(deadlineTimer);
        clearInterval(goneTimer);
      }
      if ((hookCode as unknown) === TIMED_OUT) {
        err(
          `this release's checks did not finish within ${Math.round(deadlineMs / 60000)}m — treating as a FAILED rehearsal, not as patience (G1). The smoke-twin is being torn down now; a check that cannot bound its own wait must say so rather than hold a metered stack open.`,
        );
        return 1;
      }
      if ((hookCode as unknown) === BOOT_DIED) {
        err(
          `the stack's api stopped DURING this release's checks, after ${Math.round((Date.now() - checksStartedAt) / 1000)}s — any check that had already passed graded a stack that is now gone. This is a failed rehearsal.`,
        );
        return 1;
      }
      if (hookCode !== 0) return hookCode === 2 ? 2 : 1;
      log("VERDICT: migrated and booted clean, frontend checks pass, this release's checks are clean against the smoke-twin");
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

    // 1. Stop the supervisor's child FIRST. smoke-down while the boot is still
    //    live races its own orchestration, and a surviving boot keeps spending.
    if (bootProc) {
      try {
        bootProc.kill();
        await bootProc.exited;
      } catch {
        /* already gone */
      }
    }

    // 2. smoke-down resolves the project from the state file the boot wrote
    //    (on success, or best-effort on a failed boot). It also removes the
    //    dump's CONTAINER, which is why nothing here does.
    if (rehearsalInstance) {
      await spawn(["bun", "--no-env-file", "scripts/smoke-down.ts", "--instance", rehearsalInstance], {}).catch(() => {});
    }

    // 3. smoke-down deliberately KEEPS volumes — including the smoke-twin's, whose
    //    contract is that it survives teardown. For a REHEARSAL they are pure
    //    litter, and both the smoke-twin volume and the member_home_* volumes hold
    //    data derived from production. Scoped to this run's project, never a
    //    bare smoke:clean, which is host-wide.
    try {
      if (!project) throw new Error("the boot never recorded its project; no volume to scope a cleanup to");
      const ls = Bun.spawnSync(["docker", "volume", "ls", "-q", "--filter", `name=${project}`]);
      const vols = new TextDecoder().decode(ls.stdout).split("\n").map((v) => v.trim()).filter(Boolean);
      if (vols.length) {
        Bun.spawnSync(["docker", "volume", "rm", ...vols]);
        log(`removed ${vols.length} leftover volume(s) holding production-derived data`);
      }
    } catch (e) {
      // Best effort, but never silent: a skipped cleanup leaves production data on disk.
      err(`volume cleanup skipped: ${e instanceof Error ? e.message : String(e)} — reclaim with bun run smoke:clean`);
    }
  }
}
