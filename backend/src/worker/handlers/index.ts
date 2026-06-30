// Registry mapping job `kind` → handler. A handler receives the job payload and
// does its work (idempotently, upserting on natural keys). Returns optional JSON
// recorded in job_runs.
import { analyticsRun } from "./analytics.ts";

export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

export const handlers: Record<string, JobHandler> = {
  // smoke-test handler
  noop: async (payload) => ({ noop: true, echo: payload }),
  // run the analytics suite (regime + research signals) → DB
  "analytics.run": analyticsRun,
  // alias: regime only
  "regime.classify": (p) => analyticsRun({ ...p, tool: "regime" }),
};

export function getHandler(kind: string): JobHandler | undefined {
  return handlers[kind];
}
