// Registry mapping job `kind` → handler. A handler receives the job payload and
// does its work (idempotently, upserting on natural keys). Returns optional JSON
// recorded in job_runs.
import { analyticsRun } from "./analytics.ts";
import * as committee from "./committee.ts";

export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

export const handlers: Record<string, JobHandler> = {
  // smoke-test handler
  noop: async (payload) => ({ noop: true, echo: payload }),
  // run the analytics suite (regime + research signals) → DB
  "analytics.run": analyticsRun,
  // alias: regime only
  "regime.classify": (p) => analyticsRun({ ...p, tool: "regime" }),
  // committee session lifecycle
  "committee.open_session": committee.openSession,
  "committee.publish_brief": committee.publishBrief,
  "committee.close_window": committee.closeWindow,
  "committee.aggregate": committee.aggregateSession,
  "committee.publish": committee.publishSession,
};

export function getHandler(kind: string): JobHandler | undefined {
  return handlers[kind];
}
