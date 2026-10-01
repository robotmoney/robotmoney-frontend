// Execution lanes (issue #107): deterministic kind-allowlist filtering for queue
// claims. A lane is a pair of SQL LIKE pattern lists applied inside the
// FOR UPDATE SKIP LOCKED claim (loop.ts) — ownership semantics are unchanged, a
// lane only narrows WHICH pending kinds a worker may claim.
//
// Topology (production default = the docker-compose services):
//   - `analytics` — the scheduled product pipelines (vault/wallet/buybacks/
//     projects), service `worker-analytics`. It never claims the kinds the
//     independent producer replaced (D25): those rows are retired, and a
//     retired row must stay unclaimed rather than run on a database-holding
//     worker.
//   - `generic` — single-process dev/tooling convenience: every kind. Not part of
//     the compose topology.
//
// Regime and research compute belong to `analytics-producer`, which submits over
// REST. There is no lane for it (issue #1026 wave 6, D55).
//
// THERE IS NO SWARM LANE. Session work is not queue work any more: per
// docs/technical/system-scheduler-spec.md §1 the `system-scheduler` container
// drives a subject's epoch and the participants do the work that needs a model,
// over HTTP from their own containers. Nothing enqueues a `swarm.%` kind, so
// there is no reserved capacity left to protect and no pattern left to exclude.
//
// WORKER_LANE is REQUIRED for a worker process: empty or unknown lane names fail
// loudly at startup (resolveLane) rather than silently claiming everything.

export type LaneName = "analytics" | "generic";

export interface Lane {
  readonly name: LaneName;
  /** SQL LIKE patterns this lane MAY claim (`kind LIKE ANY(include)`). */
  readonly include: readonly string[];
  /** SQL LIKE patterns this lane must NEVER claim (`kind NOT LIKE ALL(exclude)`). */
  readonly exclude: readonly string[];
}

// Queue kinds the producer replaced (D25). No lane claims them but `generic`.
const PRODUCER_OWNED_KINDS = "research.%";

export const LANES: Record<LaneName, Lane> = {
  analytics: { name: "analytics", include: ["%"], exclude: [PRODUCER_OWNED_KINDS] },
  generic: { name: "generic", include: ["%"], exclude: [] },
};

// Human-readable claim summary for startup/health logging ("lane-aware status").
export function describeLane(lane: Lane): string {
  const inc = lane.include.join(", ");
  return lane.exclude.length ? `${inc} except ${lane.exclude.join(", ")}` : inc;
}

// Resolve a worker's lane from configuration (WORKER_LANE). FAIL-CLOSED: an
// empty/missing or unknown value throws at startup — a misconfigured worker must
// never fall through to claiming every kind.
export function resolveLane(raw: string | undefined | null): Lane {
  const value = (raw ?? "").trim();
  const valid = Object.keys(LANES).join(" | ");
  if (!value) {
    throw new Error(`WORKER_LANE is required — set one of ${valid} (see backend/src/worker/lanes.ts)`);
  }
  const lane = LANES[value as LaneName];
  if (!lane) {
    throw new Error(`invalid WORKER_LANE "${value}" — expected one of ${valid}`);
  }
  return lane;
}
