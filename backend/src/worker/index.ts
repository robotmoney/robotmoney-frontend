// Always-on worker process: drains the job queue, ticks the scheduler, and
// reaps crashed jobs. Run with `bun run src/worker/index.ts`.
import { config } from "../config.ts";
import { closeDb } from "../db/client.ts";
import { processOneJob } from "./loop.ts";
import { tickScheduler } from "./scheduler.ts";
import { reapStuckJobs } from "./reaper.ts";

const IDLE_POLL_MS = Number(process.env.WORKER_IDLE_POLL_MS ?? 2000);
const SCHEDULER_TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? 30_000);
const REAPER_TICK_MS = Number(process.env.REAPER_TICK_MS ?? 60_000);

let running = true;
const stopped = new AbortController();

async function drainLoop() {
  while (running) {
    try {
      const did = await processOneJob();
      if (!did) await sleep(IDLE_POLL_MS); // nothing to do — back off
    } catch (err) {
      console.error("loop error:", err);
      await sleep(IDLE_POLL_MS);
    }
  }
}

async function periodic(label: string, fn: () => Promise<unknown>, everyMs: number) {
  while (running) {
    try {
      await fn();
    } catch (err) {
      console.error(`${label} error:`, err);
    }
    await sleep(everyMs);
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    if (stopped.signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    stopped.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

let shutdownStarted = false;
async function shutdown(signal: string) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`\n${signal} received, shutting down…`);
  running = false;
  stopped.abort();
  await Promise.allSettled(loops);
  await closeDb();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`worker ${config.workerId} starting (env=${config.env})`);
const loops = [
  drainLoop(),
  periodic("scheduler", tickScheduler, SCHEDULER_TICK_MS),
  periodic("reaper", reapStuckJobs, REAPER_TICK_MS),
];
