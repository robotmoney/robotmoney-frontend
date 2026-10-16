// The four parity domains, in sweep order (issue 1375). Pure and database-free,
// so the worker's analytics.parity_sweep handler can loop the domains without
// importing parity.ts, which holds the api's rm_app pool
// (tests/analytics-api-boundary.test.ts).
export type ParityDomain = "raw_indicator_history" | "regime_snapshots" | "research_signals" | "swarm_briefs";

export const ALL_PARITY_DOMAINS: readonly ParityDomain[] = [
  "raw_indicator_history",
  "regime_snapshots",
  "research_signals",
  "swarm_briefs",
];

export function isParityDomain(value: unknown): value is ParityDomain {
  return typeof value === "string" && (ALL_PARITY_DOMAINS as readonly string[]).includes(value);
}
