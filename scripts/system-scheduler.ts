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
//   2. HTTP startup check (§1, §7): is the API there, and is the token good?
//      Either failure exits non-zero with the reason, so Docker's restart
//      policy and an operator see the same thing.
//   3. Serve the health surface, immediately — before the first rebuild — so an
//      operator watching a scheduler that cannot reach its API sees WHY rather
//      than a refused connection.
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

  const startup = await runStartupCheck({ apiUrl: env.apiUrl, token });
  clock.markAuthenticated(startup.tokenValid, startup.error ?? undefined);
  if (!startup.ok) {
    console.error(`[system-scheduler] startup check failed: ${startup.error}`);
    health.stop();
    return 1;
  }
  log("startup check passed: API reachable, token accepted");

  // The consumer owns §3.1. Its hooks are the only place the clock is driven
  // from the stream, and `onRebuild` is the ONE path every kind of downtime
  // converges on (§3.2).
  const consumer: SchedulerStreamConsumer = new SchedulerStreamConsumer(
    api,
    {
      applyEvent: (event) => clock.applyEvent(event),
      onRebuild: async (snapshot, trigger) => {
        log(`rebuild (${trigger}) at cursor ${snapshot.cursor}`);
        await clock.rebuild(snapshot as unknown as SchedulerFullRead);
      },
      runJob: async (job) => {
        // §6.3's ad-hoc pushes. The scheduler acks through the API when done;
        // an unknown kind is left UNACKED on purpose, so the API redelivers it
        // to a build that understands it rather than this one swallowing it.
        throw new Error(`unknown pushed job kind: ${job.kind}`);
      },
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
        if (!consumer.current) continue;
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

  await consumer.start();
  await connect();
  clock.markStreamSynchronized(consumer.current);
  log("clock running");

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
