// Facts about the v0.2.2 release itself that the GATE SCRIPTS execute against.
//
// Split out of steps.ts on 2026-08-20, from running the runbook and watching
// the invalidation churn: steps.ts is the step MANIFEST (ids, titles, phases,
// which host may run what), and gates listed it in their `depends-on` only
// because the migration list happened to live there too. So editing a step's
// title — pure display metadata — invalidated Gate C, Gate B and the twin
// postflight, and each of those costs minutes to re-earn.
//
// The rule this file encodes: `depends-on` must name what a step EXECUTES, and
// nothing else. A constant the checks read belongs here; a label a human reads
// belongs in the manifest. Nothing in this file may import from steps.ts, or
// the split is undone.

/**
 * Every migration this release applies, in runner order (readdir + JS sort,
 * src/db/migrate.ts:39-41). THE single source: preflight.ts and postflight.ts
 * both import this. They used to each declare their own copy and the copies
 * disagreed — postflight was corrected to six in 27ec374, preflight was not.
 *
 * §5.6, §8.0's check-2 row and §8's check 2 all cite this list;
 * backend/tests/rollout-steps.test.ts asserts each file exists under
 * backend/migrations/.
 */
export const THIS_RELEASE_MIGRATIONS = [
  "0029_admin_auth_recovery.sql",
  "0029_admin_passkey.sql",
  "0030_swarm_member_handle.sql",
  "0031_swarm_member_handle_namespace.sql",
  "0032_append_only_history.sql",
  "0033_swarm_member_uuid_ids.sql",
] as const;

/** Selects this release's tags and no others (§7.2 cuts `v0.2.2-rc.N`). */
export const TAG_GLOB = "v0.2.2*";

/** The release tracking issue whose Phase tasklist gates preflight (§2). */
export const TRACKING_ISSUE = 660;
