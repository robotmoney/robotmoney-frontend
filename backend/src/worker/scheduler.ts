// The worker's scheduler tick. The schedules are read and their due slots
// enqueued by the api (pipeline/queue-store.ts tickScheduler, issue 1034,
// decision D75): the worker only drives the cadence.
import { tickScheduler as tick } from "./pipeline-client.ts";

/**
 * Enqueue jobs for every schedule whose next run is due, and advance it. Safe
 * for several workers at once: the api locks the due rows with SKIP LOCKED and
 * each slot's dedupe_key enqueues it at most once. Returns how many jobs it
 * enqueued.
 */
export async function tickScheduler(): Promise<number> {
  return tick();
}
