#!/usr/bin/env bun
// `system-scheduler` — THE CONTAINER. Issue #1026 W4, part 3.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §1, §3, §3.1, §3.2, §7 and
// §8, and docs/technical/smoke-production-spec.md §3 and §6.3.
//
//   §1: "`system-scheduler` is one long-running container. It replaces the
//    process formerly called `worker-swarm`. There is no separate clock process
//    and no separate executor process."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS PROCESS HOLDS, AND WHAT IT DOES NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// It holds ONE credential: an API automation token, read from a file the boot
// placed in the instance's state directory (smoke §3). It holds no database
// role password, no Ed25519 signing key, no model key and no Docker socket.
//
// That is enforced by construction, not by discipline: nothing in
// `scripts/lib/system-scheduler/` imports anything under `backend/`, because
// `backend/src/config.ts` requires DATABASE_URL at module scope and a single
// import of it — direct or two hops away — would make a database credential a
// startup requirement of this process. `system-scheduler-health.test.ts`
// asserts the module graph and plants a violation to prove the check can fail.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE OF A RUN
// ─────────────────────────────────────────────────────────────────────────────
//
//   1. Read the token file. No file, no start.
//   2. Serve the health surface immediately — before the startup check and
//      before the first rebuild — so an operator watching a scheduler that
//      cannot reach its API sees WHY rather than a refused connection.
//   3. HTTP startup check (§1, §7): is the API there, and is the token good?
//      The two failures end differently, and the reasoning is at the call site:
//      a rejected token exits non-zero, an unreachable API stays up unhealthy
//      and lets the connect loop bring it in.
//   4. Open the stream and rebuild. Every later rebuild — a gap, a resync, a
//      stalled connection, a drop — goes through the same path, which is why
//      §3.2 can treat four kinds of downtime identically.
//   5. Wait. The process now does nothing at all until a timer fires or a frame
//      arrives. There is no tick.
//
// THE KEEPALIVE WATCHDOG IS THE ONE PERIODIC THING IN THE PROCESS, and §6.3
// admits it by name: "The connection carries a transport-level keepalive … A
// missed keepalive is a dropped connection." It compares two numbers and makes
// no API call, which is why §10's "between instants … makes no API call" holds
// with it running.
//
// Steps 4 and 5 — the stream, the clock, the reconnect loop and the watchdog —
// are `SchedulerRuntime` (lib/system-scheduler/runtime.ts), so the wiring a
// test drives is the wiring this process runs. What stays here is what only a
// process has: the token file, the health port, the exit decision and signals.
import { SchedulerHttpApi } from "./lib/system-scheduler/api-client.ts";
import { runStartupCheck, serveHealth } from "./lib/system-scheduler/health.ts";
import { SchedulerRuntime } from "./lib/system-scheduler/runtime.ts";
import { realTimers } from "./lib/system-scheduler/types.ts";

/** Where the boot places this instance's token (smoke §3). */
const TOKEN_FILE_ENV = "SCHEDULER_TOKEN_FILE";

export interface SchedulerEnv {
  apiUrl: string;
  tokenFile: string;
  healthPort: number;
  /** How long the connection may go quiet before the keepalive watchdog acts. */
  keepaliveBudgetMs: number;
  /** How often the watchdog compares those two numbers. Not an API call. */
  watchdogMs: number;
}

export class SchedulerConfigError extends Error {}

/**
 * Read the environment.
 *
 * The token is NOT an environment variable, and the difference is the whole of
 * smoke §3: "a file the boot places in the instance's state directory, named
 * per instance, never in `~/.env` and never in the image." An env var is
 * visible in `docker inspect`, is inherited by every child process, and is
 * baked into the compose file an operator commits. A file is not.
 */
export function readSchedulerEnv(env: Record<string, string | undefined> = process.env): SchedulerEnv {
  const apiUrl = env.SCHEDULER_API_URL ?? env.API_URL ?? "";
  if (!apiUrl) throw new SchedulerConfigError("SCHEDULER_API_URL is required");
  const tokenFile = env[TOKEN_FILE_ENV] ?? "";
  if (!tokenFile) throw new SchedulerConfigError(`${TOKEN_FILE_ENV} is required`);
  return {
    apiUrl,
    tokenFile,
    healthPort: Number(env.SCHEDULER_HEALTH_PORT ?? 8090),
    keepaliveBudgetMs: Number(env.SCHEDULER_KEEPALIVE_BUDGET_MS ?? 45_000),
    watchdogMs: Number(env.SCHEDULER_WATCHDOG_MS ?? 5_000),
  };
}

export async function readToken(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new SchedulerConfigError(`automation token file not found: ${path}`);
  }
  const token = (await file.text()).trim();
  if (!token) throw new SchedulerConfigError(`automation token file is empty: ${path}`);
  return token;
}

/**
 * Run the container. Resolves only on a startup failure; a running scheduler
 * never returns, it exits on a signal.
 *
 *   2 — the configuration or the token file is missing (nothing was started)
 *   1 — the API rejected the token (health was served, then stopped)
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const log = (msg: string): void => {
    console.log(`[system-scheduler] ${msg}`);
  };

  let cfg: SchedulerEnv;
  let token: string;
  try {
    cfg = readSchedulerEnv(env);
    token = await readToken(cfg.tokenFile);
  } catch (err) {
    console.error(`[system-scheduler] ${String((err as Error).message)}`);
    return 2;
  }

  const api = new SchedulerHttpApi({ apiUrl: cfg.apiUrl, token });
  const probe = () => runStartupCheck({ apiUrl: cfg.apiUrl, token });
  const runtime = new SchedulerRuntime(api, {
    timers: realTimers(),
    probe,
    keepaliveBudgetMs: cfg.keepaliveBudgetMs,
    watchdogMs: cfg.watchdogMs,
    log,
  });
  const clock = runtime.clock;

  // Health first: a scheduler that cannot start is far more useful answering
  // 503 with a reason than refusing the connection.
  const health = serveHealth(cfg.healthPort, () => clock.health);
  log(`health on :${health.port}/health`);

  // ───────────────────────────────────────────────────────────────────────────
  // The startup check, and why its two failures end differently
  // ───────────────────────────────────────────────────────────────────────────
  //
  // §1: the check "exits or reports unhealthy on either failure." Both are
  // allowed, and the two failures want different ones:
  //
  //   * A REJECTED TOKEN (401/403) is permanent. No amount of waiting fixes a
  //     secret the API does not know, and a container that sat there unhealthy
  //     for ever would be indistinguishable from one waiting on a slow
  //     dependency. It exits non-zero; under `restart: unless-stopped` that is
  //     a visible crash-loop with the reason in the log, which is what an
  //     operator needs.
  //
  //   * AN UNREACHABLE API is ordinary at boot — this container and `api` start
  //     together, and `depends_on` is start ordering, not readiness. Exiting
  //     would make a normal race into a crash-loop, and it would take the health
  //     surface down with it, so the one place the reason is written would be
  //     the one place nobody can read. It stays up, reports unhealthy WITH the
  //     reason, and the connect loop brings it in when the API arrives. This is
  //     not polling: the loop is failure-triggered and backs off, which §4.6
  //     distinguishes from a tick in as many words. A reachable API answering
  //     5xx is the same case: nothing has rejected the token.
  const startup = await probe();
  if (startup.tokenRejected) {
    console.error(`[system-scheduler] the API rejected this automation token: ${startup.error}`);
    health.stop();
    return 1;
  }
  clock.markAuthenticated(startup.tokenValid, startup.error ?? undefined);
  if (!startup.ok) {
    log(`startup check: ${startup.error} — staying up and reporting unhealthy while the connect loop retries`);
  } else {
    log("startup check passed: API reachable, token accepted");
  }

  // No job hook, and its absence is the design. §6.3 (amended 2026-09-24,
  // D52): "The stream carries change events only. Every piece of work the
  // scheduler does follows from an event or a timer; there is no ad-hoc job
  // kind for the API to push, ack or redeliver."
  await runtime.start();

  const shutdown = (signal: string): void => {
    log(`${signal}: stopping`);
    runtime.stop();
    health.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Nothing further. The process is now driven by its timers and its socket.
  await new Promise<void>(() => {});
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
