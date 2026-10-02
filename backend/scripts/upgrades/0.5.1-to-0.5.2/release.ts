/** Facts unique to the v0.5.1 -> v0.5.2 upgrade. */
import { PRIOR_RELEASE_MIGRATIONS as V050_WITH_0062, RELEASE_MIGRATIONS as V051 } from "../0.5.0-to-0.5.1/release.ts";

export const TAG_GLOB = "v0.5.2*";

/** What production records at v0.5.1: v0.5.0's set, the out-of-band 0062, and v0.5.1's 0061 and 0063. */
export const PRIOR_RELEASE_MIGRATIONS = [...V050_WITH_0062, ...V051] as const;

/**
 * The one migration v0.5.2 applies: the analytics-ledger schema change (issue
 * 1035, PRs 1046 and 1051). It is not reversible: it DROPS source_payloads,
 * which v0.5.1's writer still inserts into. The ledger's data is repaired
 * separately, once, by ledger-repair.ts in this folder (runbook R6.4c), which
 * is not reversible either. Going back to v0.5.1 after either therefore needs
 * a database restore (R3 backup or point-in-time), not only old code.
 */
export const RELEASE_MIGRATIONS = ["0080_analytics_ledger_compaction.sql"] as const;

/** Tables 0080 compacts or drops, which must exist in a v0.5.1 dump. */
export const REQUIRED_TABLES = [
  "source_value_versions",
  "analytics_vintage_members",
  "analytics_overwrite_events",
  "source_payloads",
] as const;
