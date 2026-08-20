// Always-on worker process entry: resolves this process's execution lane and
// runs the drain/scheduler/reaper loops via runtime.ts. Run with
// `WORKER_LANE=<swarm|analytics|research|generic> bun run src/worker/index.ts`.
//
// WORKER_LANE is REQUIRED (issue #107): an empty or unknown lane fails loudly
// here instead of silently claiming every kind — the compose topology gives
// each lane its own container (worker-swarm / worker-analytics /
// worker-research; see docker-compose.yml).
import { warnIfStrategyVaultsUnconfigured } from "../config.ts";
import { closeDb } from "../db/worker-client.ts";
import { resolveLane } from "./lanes.ts";
import { startWorker } from "./runtime.ts";

// Empty strategy-vault list → loud warning, never a refusal to boot (issue
// #642, decision D37). This lane runs the wallet SAMPLER (handlers/wallet.ts),
// which writes the persisted history /allocation and /performance read, so an
// unconfigured list here silently bakes idle-USDC-only NAV into that history.
warnIfStrategyVaultsUnconfigured();

const worker = startWorker({ lane: resolveLane(process.env.WORKER_LANE) });

let shutdownStarted = false;
async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`\n${signal} received, shutting down…`);
  await worker.stop();
  await closeDb();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
