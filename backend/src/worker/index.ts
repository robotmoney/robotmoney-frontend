// Always-on worker process entry: resolves this process's execution lane and
// runs the drain/scheduler/reaper loops via runtime.ts. Run with
// `WORKER_LANE=<swarm|analytics|research|generic> bun run src/worker/index.ts`.
//
// WORKER_LANE is REQUIRED (issue #107): an empty or unknown lane fails loudly
// here instead of silently claiming every kind — the compose topology gives
// each lane its own container (worker-swarm / worker-analytics /
// worker-research; see docker-compose.yml).
import { assertSwarmNotificationSafety, warnIfStrategyVaultsUnconfigured } from "../config.ts";
import { closeDb } from "../db/worker-client.ts";
import { resolveLane } from "./lanes.ts";
import { startWorker } from "./runtime.ts";

// Config-time notification-safety guard (issue #894): refuse to boot if the
// swarm session-lifecycle schedules are enabled without an explicit
// SWARM_PUBLIC_BASE_URL — otherwise a staging deployment would silently mail
// applicants a link back to production. Fail-closed at startup, matching the
// api entrypoint's assertNoVaultAddressCollision()/assertSwarmNotificationSafety()
// pattern. Every worker lane shares this boot path (the swarm lane is the one
// that actually enqueues the notification jobs), so the guard runs
// unconditionally here rather than only for WORKER_LANE=swarm.
assertSwarmNotificationSafety();

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
