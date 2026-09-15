# Continuation handoff: Research Integrity phase

## Coordinator update: 2026-09-15, latest state

### What we are aiming to achieve

Complete Phase #975, **research integrity**, by merging the remaining features
in dependency order:

`#974 → #976 → #977 → #978 → #979`

The phase should leave analytics evidence append-only and reproducible: source
acquisitions and revisions are retained, runs bind to frozen data vintages,
outputs and reports are immutable snapshots, and the final compatibility-to-
ledger cutover is parity-proven, rollback-safe, and restorable from backup.

### Current implementation and CI status

- #974 is merged in PR #984.
- #976 is implemented on PR #985 at commit `4b550ac9cbee3c1b5cf04873e91f50f19e6fee6f`.
  The dedicated worktree is clean.
- The #976 fix changed `scripts/lib/swarm/session.ts` so transient session API
  read failures (such as the observed HTTP 502) are retried under the existing
  wait ceiling instead of being misreported as a missing `windowClosesAt`.
  Successful 200 responses that genuinely lack a deadline still fail loudly.
- Added unit coverage proves one transient failure recovers and persistent
  failures terminate at the ceiling.
- Local validation passed: root `bun run typecheck` and all 1,775 script unit
  tests, including 25 swarm-window tests.
- The backend workflow's exact local command also passed through its Docker-backed
  suite so far; the final exit status must be recorded when the process ends.
- A true local `e2e` smoke reproduction was run in the feature worktree as
  `CI=true SMOKE_PROJECT=rm_local_e2e_35006480793 bun run smoke`, with its
  transcript at `/tmp/rm-local-e2e.log`. Stack build, migrations, seeding, and
  API health passed; it stopped at the required live swarm step because this
  shell has no `OPENCODE_API_KEY` for the paid default model. That is an
  environment prerequisite, not evidence that the application path is green.
- The backend workflow's exact Docker-backed command completed locally green:
  1,919 passed, 15 expected live-provider skips, 0 failed (1,934 tests).
- Replacement E2E run: [workflow run 35006480793](https://github.com/robotmoney/robotmoney-frontend/actions/runs/35006480793)
  completed **red** (job `104507384680`). The original `windowClosesAt`
  failure did not recur; the session-window retry fix is validated against
  that failure mode.
- The final tail showed a separate capacity failure during browser checks:
  308 checks passed, 9 failed, several browser/API requests returned HTTP 502,
  Bun reported 10-second API request timeouts, the analytics producer had
  Yahoo/EDGAR provider timeouts, and PostgreSQL checkpoints took about
  269–270 seconds. This points to source-ledger/catch-up write pressure
  starving the API/Postgres stack, not to another session-window bug.
- The released log was fetched and tailed with:

  ```bash
  gh run view 35006480793 --job 104507384680 --log > /tmp/rm-e2e-35006480793.log
  tail -160 /tmp/rm-e2e-35006480793.log
  ```

### Tasks for the next agent

1. Investigate the demonstrated overload before rerunning E2E. Trace how
   producer indicator catch-up passes full provider histories into
   `captureSourceAcquisition`/`saveSourceAcquisition`; inspect row counts,
   transaction duration, and the 0057 indexes. Any fix must preserve the
   append-only evidence contract, add a regression/performance guard, and
   avoid hiding provider failures.
2. Run the CI-equivalent job locally before attempting another GitHub run:
   `bun run typecheck` plus the exact unit workflow command
   (`bun run test:unit -- --reporter=junit --reporter-outfile=/tmp/test-unit.junit.xml`)
   and its non-empty/zero-failure/JUnit tier checks. Run the focused backend
   suites and the full backend CI command as applicable; record any Docker or
   live-provider limitation explicitly.
3. After the local gate is green, push the narrowly scoped fix, rerun E2E, and
   tail the released log to verify both API capacity and the original session
   deadline path. Do not call #976 complete while E2E remains red.
4. Keep PR #985's body exactly `Closes #976`. Complete every #976 issue
   acceptance-criteria and test-plan checkbox with committed evidence, then
   post the integration handoff to #977.
4. Do not merge based on the primary worker's validation. Dispatch an
   independent compliance worker against the exact final SHA, record its
   verdict, run deterministic review routing, and dispatch data-integrity
   review because migration 0057/schema changes are in scope.
5. Merge #976 only through the repository merge gate. Then rebase the #977
   dedicated worktree onto the new `origin/main` and dispatch its Terra primary.
6. Continue serially through #977, #978, and #979. Each primary must finish its
   own implementation, runtime CI coverage, checklist, exact PR body, ready
   status, and green CI before independent review and merge. Do not dispatch a
   downstream implementation before its predecessor merges.

Do not edit the principal checkout, reset or clean the #976 worktree, reopen
#974's advisory, or modify Phase #975 tracking issues.

Continue the user-directed implementation of Phase #975, **without replanning**. The user explicitly said: "don't replan. just start work on all the phase's issues." Implement the issues in dependency order because they share persistence APIs and sequential migrations:

`#974 → #976 → #977 → #978 → #979`

## Completed

- Issue #974 merged in [PR #984](https://github.com/robotmoney/robotmoney-frontend/pull/984), merge commit `3922d590973a8987fe8942bd8efa9434a298dec5`.
- #974 implementation commit was `0fe3a5e4918a7e793cf3caf13bc0f59fb2b9da14`.
- #974 passed independent compliance and data-integrity review. The data-integrity review left one **medium advisory**: owner-authorized `TRUNCATE` can remove `raw_indicator_history` or `research_signals` rows without overwrite evidence. This was posted on PR #984; do not reopen #974 unless the user requests it.

## Active work

Issue #976 is partially implemented in this worktree:

`/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/feat-976-add-append-only-acquisition-and-source-value-led`

PR: [#985](https://github.com/robotmoney/robotmoney-frontend/pull/985), **open and draft**, branch head `fd79b7b1c473fef0e020b21450cd3843a72b69fc` (one commit: `chore: initialize issue #976 worktree`).

### Session 2026-09-15: coordinator inspection (read-only, nothing committed)

A worker was dispatched to finish #976 and was **cancelled by the user before it did any work**. The worktree is unchanged from the prior worker's handoff. Preserve all uncommitted changes; do not reset, clean, or restart.

Verified state as of handoff:

- **Typecheck passes**: `cd backend && bun run typecheck` → clean (tsc --noEmit, 0 errors).
- **Docker available** (bun 1.3.14, docker 29.1.3). Tests use ephemeral Postgres via `tests/preload.ts` (fails loudly if Docker missing).
- **New untracked files**: `backend/migrations/0057_source_acquisition_ledger.sql` (112 lines), `backend/src/analytics/source-ledger.ts` (140 lines), `backend/src/analytics/store/source-ledger-store.ts` (73 lines), `backend/tests/analytics-source-ledger.test.ts` (160 lines), `backend/tests/source-ledger-migration.test.ts` (73 lines).
- **Modified**: `backend/src/analytics/access/data-source.ts`, `api-client.ts`, `extract/{edgar,fetch-cache,geckoterminal,http,sources}.ts`, `index.ts`, `persistence.ts`, `store/direct.ts`, `backend/src/producer/index.ts`, `backend/src/api/routes/analytics.ts`, `contract/src/routes.{js,d.ts}`, `backend/tests/api/analytics-write.test.ts`, `backend/tests/append-only-enforcement.test.ts`, `backend/tests/producer-catchup.test.ts`.
- Implementation shape is complete per the ACs: migration 0057 creates the five immutable tables (source_acquisitions, source_acquisition_events, source_payloads, source_fetches, source_value_versions) with ENABLE ALWAYS immutability triggers, legacy_baseline backfill at statement_timestamp, and rm_worker/rm_readonly revokes; `source-ledger.ts` provides `captureSourceAcquisition`, `recordSourceFetch`, `redactRequestIdentity`, `payloadChecksum`, `AcquisitionSink`; `source-ledger-store.ts` persists atomically with advisory-lock serialized revision chains and idempotent replay; wiring exists through sources.ts fetchAll, data-source.ts research/backtest acquires, http.ts/edgar.ts/geckoterminal.ts byte-level recording, producer catch-up (requested_by_run_id null), runAnalytics (jobId association), and a new authenticated `POST /api/analytics/source-acquisitions` endpoint with whole-request validation, rollback, and replay.

### Test results (run by coordinator, 2026-09-15)

`cd backend && bun test tests/analytics-source-ledger.test.ts` → **2 failures**:

1. `every sources.ts provider variant records requests, ratio/fallback legs, pagination, releases, normalized values, and exact payload bytes` — **assertion at line 50 fails: expected 26 acquisitions, received 20**. The fixture's fetch log shows six `EMPTY` indicators returned 0 rows: `DEFI_TVL`, `STABLES`, `NEW_TOKENS`, `DEFI_GROWTH`, `STABLES_GROWTH`, `SHILLER_CAPE`. The fixture `providerResponse()` in the test does not serve a URL variant those sources actually request (it throws `unhandled fixture URL`, which sources.ts swallows into `[]`). Hypotheses to check in order: (a) the actual URLs requested by `fetchDefiLlamaTvl`/`fetchDefiLlamaStables`/`fetchShillerCape`/`fetchGeckoTerminalNewPools` differ from the fixture's `includes()` matchers (e.g. api.llama.fi paths, multpl vs raw.githubusercontent for the fallback/backfill leg); (b) geckoterminal `fetchNewPoolsPage` decodes base64 payloads so the fixture's plain `Response.json` shape no longer parses (its `withFetchCache<{payloadBase64}>` wrapper expects a cached envelope — verify a cache-miss path still works when no cache file exists); (c) shiller needs both the primary (raw.githubusercontent) AND the fallback (multpl.com) leg served. Also note the test expects `coinmetricsFetches = 4` (two source variants × two pages) and `shillerFetches = 2` (primary + fallback), and ratio legs counted on yahoo — so the fix must keep those counts while making all 26 indicators produce acquisitions. Failed acquisitions SHOULD still be persisted (sources.ts catch swallows the error after capture persists a `failed` event), so 20 vs 26 means six captures never ran at all — consistent with `fetchOne` throwing before `captureSourceAcquisition` is entered (i.e. the provider's own URL/driver erroring). Fix the fixtures to match real requested URLs and/or fix any source-side gap; the AC requires every source variant produce immutable evidence.
2. `date and instant market time round-trip exactly, and redaction removes credentials from identities and failures` — **timed out after 5000ms**. The test mocks `globalThis.fetch` to reject with `Error("Bearer secret-token https://x.test/?api_key=sentinel-credential")` and calls `fetchFred("X")`. Suspects: (a) fred.ts (or its wrapper) has a retry/backoff loop with sleeps that exceeds 5s even with instant rejects; (b) some code path uses a fetch binding captured before the mock (e.g. a module-level `const fetch` or `node:https`), so the real network request hangs until the AbortController timeout; (c) `Bun.CryptoHasher` usage in append-only-enforcement or elsewhere. Keep the redaction assertions (lines 140-141: `secret-token` and `sentinel-credential` must not appear in persisted evidence) — they are AC #6. The safest fix is to make the transport mock fail fast and synchronously (no retry sleeps), or inject a fast-failing transport into fetchFred.

**Not yet run**: `tests/api/analytics-write.test.ts`, `tests/producer-catchup.test.ts`, `tests/append-only-enforcement.test.ts`, `tests/source-ledger-migration.test.ts`, and the full `bun test` suite. Unknown whether they pass. The migration test spawns its own docker container (`rmtest_source_ledger_migration_*`) and fails loudly without Docker — that is correct per the loud-skip policy.

### Known quirks / frustrations

- `backend/src/api/routes/analytics.ts` contains a **pre-existing literal NUL byte** at offset ~6052 (inside a template literal `${indicator}\0${p.date}`) — present on HEAD too, not introduced by this work. Git therefore reports it as binary (`Bin 25966 -> 31814 bytes`) and rg refuses it; use `grep -a` / `strings` / the Read tool. Do NOT "fix" the NUL byte — it is intentional (or at least pre-existing) and out of scope.
- `grep -a` confirms the new endpoint exists in the route file: validation of `{ acquisition }` (UUID, provider, parserVersion, cacheIdentity, requestedByRunId, events lifecycle started→succeeded/failed, fetches ≤1000 with payload ≤50MB, values ≤MAX_RAW_POINTS) at lines ~232-276, and dispatch at `POST` + `p === A.sourceAcquisitions` at lines ~404/430/433.
- PR body currently is `Closes #976` plus a codesmith footer block. The handoff instruction says keep the body exactly `Closes #976`; before the merge gate, strip the codesmith footer if `merge-ready.sh` requires an exact body match.
- The user cancelled the delegated worker mid-dispatch. No code was changed this session. Do not treat this as a stand-down for the issue itself — #976 is still the active task.

### Next steps for the next agent

1. **Finish #976** (dispatch a fresh primary worker with the develop-issue contract, or do it directly if delegation is unavailable):
   - Fix the two failing tests above (fixtures for all 26 indicator sources; fast-failing redaction path).
   - Run the four focused suites (`analytics-source-ledger`, `api/analytics-write`, `producer-catchup`, `append-only-enforcement`) plus `source-ledger-migration.test.ts`, then the full `bun test --path-ignore-patterns='tests/geckoterminal-resilience.test.ts' --path-ignore-patterns='tests/token-prices-resilience.test.ts'` (the CI-equivalent command from `.github/workflows/backend.yml`).
   - Verify each new test executes in CI with >0 tests run (loud-skip policy; the migration test must run in CI, not just locally).
   - Stage all files explicitly by name (all 5 new + 17 modified), conventional commit, push. Keep PR body exactly `Closes #976` (strip the codesmith footer).
   - Tick every AC checkbox on issue #976 with committed-code evidence; mark the PR ready (`gh pr ready 985`) only when implementation + checklist are complete; poll CI until green.
   - Integration handoff: comment on #977 with changed files, new public APIs (AcquisitionSink, captureSourceAcquisition, recordSourceFetch, saveSourceAcquisition persistence/API/contract additions), and import-path changes.
2. **Coordinator gate for #976**: dispatch an independent compliance review against the exact head SHA and record the verdict; because this is a migration/schema PR, also dispatch the data-integrity review and post/record advisory findings. Do not self-grade.
3. **Merge #976** only through the repository merge gate (`merge-ready.sh` + whatever the gate requires). Verify PR body exactly `Closes #976` first.
4. **#977 → #978 → #979 sequence**: after each predecessor merges, rebase the next prepared PR onto the new `origin/main`, then dispatch its worker:
   - #977 → [PR #986](https://github.com/robotmoney/robotmoney-frontend/pull/986), worktree `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/feat-977-freeze-data-vintages-and-analytics-runs`
   - #978 → [PR #987](https://github.com/robotmoney/robotmoney-frontend/pull/987), worktree `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/feat-978-freeze-analytics-outputs-and-report-snapshots`
   - #979 → [PR #988](https://github.com/robotmoney/robotmoney-frontend/pull/988), worktree `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/feat-979-prove-analytics-dual-write-parity-and-cut-over-c`

## Required workflow

Use workers in dedicated worktrees. Do not edit the principal checkout. Read and follow:

- `/drive2/home/lucas/superfield/prompts/worker-prompts/develop-issue.md`
- `/drive2/home/lucas/superfield/prompts/skills/_shared/test-coverage-policy.md`
- repository instructions and the issue body for each feature

After each feature worker hands off:

1. Verify the PR body is exactly `Closes #N`, issue checklists are complete, and CI is green.
2. Dispatch independent compliance review for the exact head SHA; record the verdict.
3. Run deterministic risk routing; for migration/schema PRs, dispatch the data-integrity review and post/record advisory findings.
4. Merge only through the repository merge gate.
5. Rebase the next prepared PR onto the new `origin/main`, then dispatch its worker.

Do not run the repository-wide replan or modify Phase/Release tracking issues. Existing replan blocker issues #982 and #983 were closed as superseded by the user's direct-execution instruction.

## Tooling note

The earlier Superfield tooling defect that crashed replan audit on oversized environment arguments was fixed and merged upstream in `superfield-ai/prompts#193`; it is irrelevant to the direct feature sequence above.
