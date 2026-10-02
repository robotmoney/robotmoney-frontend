/** Facts unique to the v0.5.3 -> v0.5.4 upgrade: a backend and driver patch with no migration. */
import { PRIOR_RELEASE_MIGRATIONS as V051, RELEASE_MIGRATIONS as V052 } from "../0.5.1-to-0.5.2/release.ts";

export const TAG_GLOB = "v0.5.4*";

/** What production records at v0.5.3 (its backend is v0.5.2's): v0.5.1's set plus v0.5.2's 0080. */
export const PRIOR_RELEASE_MIGRATIONS = [...V051, ...V052] as const;

/** v0.5.4 applies no migration. Anything pending on the dump is drift, not this release. */
export const RELEASE_MIGRATIONS = [] as const;

/** Tables the v0.5.4 changes read or write, which must exist in a v0.5.3 dump. */
export const REQUIRED_TABLES = [
  "swarm_sessions",
  "swarm_brief_revisions",
  "swarm_session_judgements",
  "source_fetches",
  "buyback_swaps",
  "buyback_scan_state",
] as const;
