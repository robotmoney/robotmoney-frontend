// The migration files on disk that production (v0.5.2) has NOT recorded: main's
// judge migrations and its second 0062, carried in by the 0.5.x -> main merge,
// and the merge's own 0081 (X3). They are the NEXT release's to declare
// (docs/plans/merge-0-5-x-into-main.md §6), so every test that grades a frozen
// v0.5.x release's migration facts against the checkout excludes exactly these
// — written out, not derived, so a new migration landing on either side has to
// be looked at rather than silently absorbed.
export const POST_V052_MIGRATIONS = [
  "0056_swarm_judge_requires_model.sql",
  "0057_swarm_judge_policy_stamp.sql",
  "0058_swarm_judge_fault_injection.sql",
  "0059_swarm_judgement_completion_usage.sql",
  "0062_rm_worker_analytics_ledger_read_grant.sql",
  "0081_swarm_judge_model_bare_id.sql",
] as const;
