# Continuation prompt: release-v1 demo/smoke convergence

Continue work in `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/release-v1` on branch `release-v1`. The last committed checkpoint before the current WIP is `0c0ead7`. The associated work is PR #538 and issue #537. There is a large uncommitted WIP diff. Preserve it and all user changes; do not reset, discard, or overwrite them. This WIP is being committed and pushed only as a checkpoint at the user's explicit request, not as an assertion of merge readiness.

## Authoritative architecture

`bun run demo` and `bun smoke` are one toolchain and infrastructure. They must share build, start, migrate, readiness, session execution, assertions, cleanup, and OpenCode execution. Their only intentional difference is the initial database/agent condition:

- Demo uses a simulation database initializer and provides seeded simulation users.
- Smoke restores the archive and provides continuity to the investment-committee agents.

Do not allow parallel or duplicated lifecycle implementations to drift. Production must use the same tested lifecycle, and duplicate scenario paths should be removed or consolidated.

## Completed WIP

- Removed `DEMO_MODE` carefully throughout active code/config/tests/docs; the invoked scenario already defines the mode.
- Made demo cache TTL behavior explicit.
- Added shared prebuild behavior.
- Added a shared OpenCode execution specification covering DeepSeek, deterministic title behavior, timeout propagation, and telemetry.
- Added inference/container diagnostics and preserved bounded artifacts for failures.
- Fixed cleanup/reaping for network-only Docker orphans.
- Added a typed scenario plan.
- Added one-migrate/already-migrated bootstrap behavior.
- Made roster direction explicit.

Manual cleanup removed 28 orphan Docker networks. The reaper fix now labels and discovers future network-only orphans rather than depending on surviving containers.

## Runtime evidence

Real demo log: `.agents/demo-rm_demo_stack_c741c7ede8.log`

- Reached READY.
- Loaded 11 projects and 23 schedules.
- Seated 4 simulated members.
- Received 3 of 4 DeepSeek takes.

Real smoke log: `.agents/demo-rm_demo_stack_8eb5261eae.log`

- Restored 3 members, 4 subjects, and 216 takes from the archive.
- Used the exact investment-committee identities.
- Received 3 of 3 DeepSeek takes.
- Failed the Athena `SUBJECT` lead-in invariant.

These `.agents` files are runtime evidence only. Do not commit runtime artifacts or secrets; `.agents` must remain runtime-only.

## Unresolved blockers

The latest final review was **FAIL**, despite many focused tests and typechecks passing. Do not describe this branch as ready to merge until all blockers are resolved and CI is green.

1. The initializer currently runs before API health/readiness; establish the correct shared lifecycle ordering.
2. Smoke still performs a simulation write through `subject_fixtures`; eliminate that violation of archive/continuity initialization.
3. Define and enforce the exact backend frozen-roster denominator.
4. Outer member-agent pipe draining is unbounded; make shutdown/draining reliably bounded without losing useful diagnostics.
5. Ensure production uses the tested shared lifecycle and remove/consolidate duplicate scenario implementations.
6. After fixes, rerun a real demo and then a real smoke sequentially. Confirm their shared stages behave identically and only their initializers differ.
7. Resolve the Athena `SUBJECT` lead-in invariant failure rather than weakening a valid assertion without evidence.

Prior fix workers were paused before making edits. Inspect the current WIP and repository state before resuming; do not assume their proposed changes landed.

## Safe continuation checklist

- Start with the mandated Superfield session/worktree checks and remain in this worktree.
- Inspect `git status`, the checkpoint commit, and the entire WIP diff before editing.
- Protect unrelated/user-authored changes and avoid destructive Git operations.
- Trace demo, smoke, and production entrypoints into the shared scenario/lifecycle code; eliminate structural duplication rather than applying mode-specific patches.
- Keep DeepSeek as the primary model for all committee agents. A GPT auxiliary/title request is not acceptable; retain the deterministic-title prevention and telemetry.
- Fix each blocker with focused executable assertions, including failure/timeout paths and exact roster semantics.
- Run focused unit/integration tests, database-backed tests, root and backend typechecks, Compose validation, and `git diff --check`.
- Run real `bun run demo` and then real `bun smoke` sequentially, capturing and reviewing their logs and cleanup state.
- Confirm no secrets, runtime logs, databases, generated artifacts, or `.agents` contents enter the commit.
- Commit and push only intentional source/test/docs changes, then inspect CI on the new head.
- Mark ready or merge only after required CI is green and the runtime/blocker evidence supports readiness.
