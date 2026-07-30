// Execution lanes (issue #107): deterministic kind-allowlist filtering for queue
// claims so interactive swarm work, regime analytics, and slow research
// fetches run with independent capacity. A lane is a pair of SQL LIKE pattern
// lists applied inside the FOR UPDATE SKIP LOCKED claim (loop.ts) — ownership
// semantics are unchanged, a lane only narrows WHICH pending kinds a worker may
// claim.
//
// Topology (production default = the docker-compose services):
//   - `committee` — RESERVED interactive lane; claims ONLY `committee.%`
//     session-lifecycle kinds. No other lane may claim them, so swarm work
//     is always immediately claimable regardless of what analytics/research are
//     doing (service `worker-committee`).
//   - `analytics` — non-research scheduled product pipelines
//     (vault/wallet/buybacks/projects): everything EXCEPT `committee.%` and
//     `research.%` (service `worker-analytics`). Legacy regime.classify rows are
//     disabled/dead-lettered and have no supported enqueue path.
//   - `research` — compatibility lane for legacy `research.%` queue rows. D25's
//     independent producer owns supported research execution; seed retires
//     pending rows and control-plane endpoints cannot create new ones.
//   - `generic` — single-process dev/tooling convenience: everything EXCEPT the
//     reserved `committee.%` kinds. A generic worker can NEVER consume reserved
//     interactive capacity. Not part of the compose topology.
//
// WORKER_LANE is REQUIRED for a worker process: empty or unknown lane names fail
// loudly at startup (resolveLane) rather than silently claiming everything.

export type LaneName = "committee" | "analytics" | "research" | "generic";

export interface Lane {
  readonly name: LaneName;
  /** SQL LIKE patterns this lane MAY claim (`kind LIKE ANY(include)`). */
  readonly include: readonly string[];
  /** SQL LIKE patterns this lane must NEVER claim (`kind NOT LIKE ALL(exclude)`). */
  readonly exclude: readonly string[];
}

const COMMITTEE_KINDS = "committee.%";
const RESEARCH_KINDS = "research.%";

export const LANES: Record<LaneName, Lane> = {
  committee: { name: "committee", include: [COMMITTEE_KINDS], exclude: [] },
  research: { name: "research", include: [RESEARCH_KINDS], exclude: [] },
  analytics: { name: "analytics", include: ["%"], exclude: [COMMITTEE_KINDS, RESEARCH_KINDS] },
  generic: { name: "generic", include: ["%"], exclude: [COMMITTEE_KINDS] },
};

// Human-readable claim summary for startup/health logging ("lane-aware status").
export function describeLane(lane: Lane): string {
  const inc = lane.include.join(", ");
  return lane.exclude.length ? `${inc} except ${lane.exclude.join(", ")}` : inc;
}

// Resolve a worker's lane from configuration (WORKER_LANE). FAIL-CLOSED: an
// empty/missing or unknown value throws at startup — a misconfigured worker must
// never fall through to claiming every kind (that would silently consume the
// reserved swarm capacity).
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
