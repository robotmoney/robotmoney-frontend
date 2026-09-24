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
import { SchedulerClock } from "./lib/system-scheduler/clock.ts";
import { SchedulerHttpApi } from "./lib/system-scheduler/api-client.ts";
import { runStartupCheck, serveHealth } from "./lib/system-scheduler/health.ts";
import { SchedulerStreamConsumer } from "./lib/system-scheduler/stream-consumer.ts";
import { realTimers, type SchedulerFullRead } from "./lib/system-scheduler/types.ts";

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

export async function main(): Promise<number> {
  const log = (msg: string): void => {
    console.log(`[system-scheduler] ${msg}`);
  };

  let env: SchedulerEnv;
  let token: string;
  try {
    env = readSchedulerEnv();
    token = await readToken(env.tokenFile);
  } catch (err) {
    console.error(`[system-scheduler] ${String((err as Error).message)}`);
    return 2;
  }

  const api = new SchedulerHttpApi({ apiUrl: env.apiUrl, token });
  const clock = new SchedulerClock(api, { timers: realTimers(), log });

  // Health first: a scheduler that cannot start is far more useful answering
  // 503 with a reason than refusing the connection.
  const health = serveHealth(env.healthPort, () => clock.health);
  log(`health on :${health.port}/health`);

  // ───────────────────────────────────────────────────────────────────────────
  // The startup check, and why its two failures end differently
  // ───────────────────────────────────────────────────────────────────────────
  //
  // §1: the check "exits or reports unhealthy on either failure." Both are
  // allowed, and the two failures want different ones:
  //
  //   * A REJECTED TOKEN is permanent. No amount of waiting fixes a secret the
  //     API does not know, and a container that sat there unhealthy for ever
  //     would be indistinguishable from one waiting on a slow dependency. It
  //     exits non-zero; under `restart: unless-stopped` that is a visible
  //     crash-loop with the reason in the log, which is what an operator needs.
  //
  //   * AN UNREACHABLE API is ordinary at boot — this container and `api` start
  //     together, and `depends_on` is start ordering, not readiness. Exiting
  //     would make a normal race into a crash-loop, and it would take the health
  //     surface down with it, so the one place the reason is written would be
  //     the one place nobody can read. It stays up, reports unhealthy WITH the
  //     reason, and the connect loop below brings it in when the API arrives.
  //     This is not polling: the loop is failure-triggered and backs off, which
  //     §4.6 distinguishes from a tick in as many words.
  const startup = await runStartupCheck({ apiUrl: env.apiUrl, token });
  clock.markAuthenticated(startup.tokenValid, startup.error ?? undefined);
  if (startup.apiReachable && !startup.tokenValid) {
    console.error(`[system-scheduler] the API rejected this automation token: ${startup.error}`);
    health.stop();
    return 1;
  }
  if (!startup.ok) {
    log(`startup check: ${startup.error} — staying up and reporting unhealthy while the connect loop retries`);
  } else {
    log("startup check passed: API reachable, token accepted");
  }

  // The consumer owns §3.1. Its hooks are the only place the clock is driven
  // from the stream, and `onRebuild` is the ONE path every kind of downtime
  // converges on (§3.2).
  const consumer: SchedulerStreamConsumer = new SchedulerStreamConsumer(
    api,
    {
      applyEvent: (event) => clock.applyEvent(event),
      onRebuild: async (snapshot, trigger) => {
        // A full read that came back IS proof the token is accepted right now,
        // which is the only honest basis for the health surface's
        // `authenticated`. The startup check answers it once; this keeps
        // answering it, so a token re-provisioned underneath a running
        // scheduler shows up here rather than staying true from boot.
        clock.markAuthenticated(true);
        log(`rebuild (${trigger}) at cursor ${snapshot.cursor}`);
        await clock.rebuild(snapshot as unknown as SchedulerFullRead);
      },
      // NO `runJob` HOOK, and its absence is the design. §6.3 (amended
      // 2026-09-24, D52): "The stream carries change events only. Every piece
      // of work the scheduler does follows from an event or a timer; there is
      // no ad-hoc job kind for the API to push, ack or redeliver."
      //
      // `SchedulerStreamConsumer` still HANDLES a job frame — it was built
      // before the amendment and is a sibling's committed work, not this
      // part's to rewrite — but nothing here supplies a driver for one, so a
      // frame that arrived would be a no-op rather than silently executed
      // work. The consumer's route, its migration and its ack endpoint need
      // reconciling against the amended §6.3; that is recorded, not done here.
    },
    { keepaliveBudgetMs: env.keepaliveBudgetMs },
  );

  /** Open the socket and hand every frame to the consumer. */
  const connect = async (): Promise<void> => {
    await api.subscribeStream(
      consumer.cursor,
      (frame) => consumer.receive(frame),
      (reason) => {
        log(`stream closed: ${reason}`);
        clock.markStreamSynchronized(false);
        void reconnect();
      },
    );
    clock.markStreamSynchronized(consumer.current);
  };

  let reconnecting = false;
  const reconnect = async (): Promise<void> => {
    if (reconnecting) return;
    reconnecting = true;
    try {
      for (;;) {
        // §6.3: "A dropped connection is reconnected with backoff and followed
        // by a full read. The scheduler does not replay from its last cursor
        // after a drop; it rebuilds." `reconnect()` does the full read; this
        // loop only has to re-open the socket on the cursor it landed on.
        await consumer.reconnect();
        if (!consumer.current) {
          // `reconnect()` swallows the full read's error to keep backing off,
          // so re-probe to find out WHICH failure it was. A rejected token is
          // permanent and the health surface must say so rather than reporting
          // an endless reconnect; an unreachable API is the ordinary case and
          // the loop keeps going.
          const probe = await runStartupCheck({ apiUrl: env.apiUrl, token });
          clock.markAuthenticated(probe.tokenValid, probe.error ?? undefined);
          continue;
        }
        try {
          await connect();
          clock.markStreamSynchronized(true);
          return;
        } catch (err) {
          log(`reconnect failed: ${String((err as Error)?.message ?? err)}`);
          clock.markStreamSynchronized(false);
        }
      }
    } finally {
      reconnecting = false;
    }
  };

  // The first connect goes through the SAME loop every later one does. §3.2
  // treats four kinds of downtime identically — a crash, a dead connection, a
  // gap, a resync — and a boot against an API that is not up yet is the first
  // of them. A separate first-connect path would be a fifth case with its own
  // behaviour, which is exactly what §3.2 says there must not be.
  try {
    await consumer.start();
    await connect();
    clock.markStreamSynchronized(consumer.current);
    log("clock running");
  } catch (err) {
    log(`initial connect failed: ${String((err as Error)?.message ?? err)}`);
    clock.markStreamSynchronized(false);
    void reconnect();
  }

  // §6.3's silent-failure detection. Two numbers compared on an interval; no
  // API call, no read of business state.
  const watchdog = setInterval(() => {
    void consumer.checkKeepalive().then((rebuilt) => {
      clock.markStreamSynchronized(consumer.current);
      if (rebuilt) log("missed keepalive: rebuilt");
    });
  }, env.watchdogMs);

  const shutdown = (signal: string): void => {
    log(`${signal}: stopping`);
    clearInterval(watchdog);
    api.closeStream();
    clock.stop();
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
