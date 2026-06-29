// Registry mapping job `kind` → handler. A handler receives the job payload and
// does its work (idempotently, upserting on natural keys). Returns optional JSON
// recorded in job_runs.
import { regimeClassify } from "./regime.ts";

export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

export const handlers: Record<string, JobHandler> = {
  // smoke-test handler
  noop: async (payload) => ({ noop: true, echo: payload }),
  // regime classification → regime_snapshots
  "regime.classify": regimeClassify,
};

export function getHandler(kind: string): JobHandler | undefined {
  return handlers[kind];
}
