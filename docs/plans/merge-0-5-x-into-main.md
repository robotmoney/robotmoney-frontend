# Merging `releases-0.5.x` into `main` — invariants

Branch: `merge/0.5.x-into-main`, which starts at `releases-0.5.x` (`3bddd2f1`, after
the v0.5.2 tag `becb6897`) and merges `origin/main` (`3bbeb497`) into it. The merge
base is `2605199a` (#988). Since then release has 134 commits and main has 24, and a
plain merge conflicts in 88 files.

This file is the checklist for resolving that merge. Each conflict is resolved to
satisfy the invariants below, and the merge counts as complete only when every
line in §5 has evidence.

## 0. The two rules that decide every conflict

1. **Nothing production runs regresses.** Production runs v0.5.2, cut from
   `releases-0.5.x`. Its database history (migration files and their content), its
   behaviour and its rollout tooling are facts, not preferences. Where main
   disagrees with a fact production depends on, release wins.
2. **Nothing merged to `main` is lost.** Every feature main carries keeps working
   after the merge. Where main and release fixed the same defect two ways, keep
   one copy. The newer design wins unless rule 1 says otherwise.

Where the two rules collide, §3 names the winner and the reason.

## 1. Kept from release (production v0.5.0 → v0.5.2)

| ID | Invariant |
|---|---|
| R1 | **Migration history is production's.** `0080_analytics_ledger_compaction.sql` is release's schema-only file (`bc71ae12`). `migrate.ts`'s `IN_TRANSACTION_AFTER_MIGRATION` and `RECLAIM_AFTER_MIGRATION` are empty. The data repair is the one-time `backend/scripts/upgrades/0.5.1-to-0.5.2/ledger-repair.ts`, and it never runs as a migration. |
| R2 | Migrations `0061_rm_worker_wallet_backfill_grant`, `0062_rm_readonly_sequence_select` and `0063_swarm_judge_model_default` stay byte-identical to what production recorded. |
| R3 | **Ledger writer semantics are D56 as amended on 2026-09-29:** a value within tolerance writes nothing, whatever its label (a label-only change is not a change); the ratio tolerance is 5e-6; vintages store id ranges; raw bodies are not stored (`source_payloads` dropped). `decisions.md` D56 is release's text. |
| R4 | **The judge never publishes a template opinion** (`a42d6c5a`). `judge()` returns a model-written opinion or throws. A judgement row's `source` is `model`. An exhausted `swarm.judge` job leaves the session unjudged, and it still publishes, without a judge block. |
| R5 | The judge prompt tells the model that a member holds one position per disagreement (`5fba6cac`). |
| R6 | **Judgements production recorded still replay.** `inputsDigest` reproduces the digests stored by v0.5.x. Replay (`backend/scripts/swarm-judge-replay.ts`) makes no model call and reports the judgement on file (`a42d6c5a`). |
| R7 | The driver waits on the `swarm.judge` job's own row (`GET /api/admin/jobs?id=`, `a070b8c5`). The publish wait survives the lane. The judge-wait ceiling covers one full judge attempt plus its retry. |
| R8 | The driver never seats a judge-role member as an analyst (`a0231e40`). The quorum does not count the judge as an absent analyst (quorum fallback filters `role = 'member'`, `910605d5`). |
| R9 | A failed regime refresh does not cancel a session: the brief publishes with the last saved regime (`3076156`). |
| R10 | There is no market-data refresh at startup. The producer holds at most 2 of the api's 10 database connections (`ANALYTICS_CONCURRENCY`, `910605d5`). |
| R11 | The API pool has `statement_timeout` and `idle_in_transaction_session_timeout` (`e0d40661`). |
| R12 | A read-only database session (SQLSTATE 25006) reads as "unavailable", not "disarmed". The analytics-ledger-guard step runs in prod-bootstrap. The producer never receives `MIGRATE_DATABASE_URL`. `WORKER_DATABASE_URL` is forwarded only on `--db external` boots. |
| R13 | The upgrade tooling that shipped each release is authoritative and complete: `backend/scripts/upgrades/0.4.0-to-0.5.0/*` (release's copies, which shipped v0.5.0), `0.5.0-to-0.5.1/*` and `0.5.1-to-0.5.2/*`, their tests, and `docs/runbooks/v0-5-{0,1,2}-rollout.md`. |
| R14 | Release gate tooling keeps working: `verify:live` (loads each session by id; tier `readonly` on demo boots, `full` on twin boots), `twin:gate`, `prod:gate` with the default-deny log classification (`scripts/lib/gate/`), `smoke:twin`/`smoke:twin:once`, twin judge enablement (`enableTwinJudge`), the twin's adopted-window handling, and `stageCadenceApplies`. |

## 2. Kept from main

| ID | Invariant |
|---|---|
| M1 | **Fusion (`21f4465b`), all of it:** judge model policy (the pinned acceptance model `deepseek-v4-flash`; the keyless free family refused everywhere); the fault-injection lever (0058, audited, double opt-in); spend recorded per judgement (0059); `policy_updated_at` (0057); a judge that is on must have a model (0056); `receipt-gap.ts` alerts; shared consensus-receipt fixtures and the cross-repo drift workflow. |
| M2 | **The judge runs in its own short-lived container, launched through `agent-launcher`** (#1014): `judge-launcher.ts`, `scripts/agent/{agent-launcher,judge-agent,judge-runner}.ts`, the compose services and the `launcher_unavailable` reason. The prompt is still rendered in the backend. |
| M3 | A refusal keeps its cause: `judgeSessionAdmin` preserves `judgeUnavailableReason` (`e3ca6cc`), and the admin judge route answers 503 `judge_unavailable` with that reason (never a bare 500). |
| M4 | **Receipt routes (fusion):** `/consensus-receipt` serves the bare canonical receipt; `/consensus-receipt/verified` serves the verified envelope; `/version` exists. Every client in this repo reads the route matching the shape it needs, including release's verify leg `scripts/lib/verify/legs/judge-receipt.ts`. |
| M5 | A receipt refuses a judgement that wasn't model-authored (#1021), checked once, by main's check on `judgement.source`. Publishing treats `judgement_not_authored` as terminal, not retryable. |
| M6 | **Take sections follow the subject** (#1025): an allocation session asks for REGIME + ALLOCATION + a `WEIGHTS:` line; every other subject asks for REGIME + SUBJECT. Targets come from the brief's `allocation.buckets`, and the hard-coded "95/5/0/0" is gone. Main's WEIGHTS format and parser win over release's control-line format (`e0d40661`). |
| M7 | 20 seats in the swarm (#1033, `SWARM_ROSTER_CAP` = 20). The judge's `MAX_POSITIONS` is the cap. The apply page reads `rosterCap`/`seatsFilled`. |
| M8 | Main's site, in full: research pages, the regime page rebuilt on the site's system with `lib/line-chart.js` (#1042), the smart contract risks index plus `/data/smart-contract-risks.json`, RSS, llms.txt and sitemap entries, and every site change from #1010–#1038. |
| M9 | CoinGecko Pro key (#1048): `COINGECKO_API_KEY` selects the Pro host with `x-cg-pro-api-key`; the corrupted `x-cg-smoke-api-key` header is gone; the key is passed only to worker-swarm, worker-analytics and worker-research. |
| M10 | The onboarding skill installs pinned `rmpc-v0.3.4`, checked against its bundled checksums (#1052). |
| M11 | CI (#1053): `contract/tests/live/` does not exist. The skill-URL byte check lives in `contract/tests/unit/`. The nightly `production-drift-audit.yml` is schedule-only and non-gating. |
| M12 | Governance (#1008): `.github/file-permissions.json` as main has it. |
| M13 | Main-only migrations `0056–0059` (judge) and `0062_rm_worker_analytics_ledger_read_grant` ship unchanged. |

## 3. Explicit resolutions (issues found in review, 2026-09-30)

| ID | Issue | Resolution |
|---|---|---|
| X1 | `0080` differs between the branches under one filename | R1: release's file. Main's in-migration repair, manifest rebuild hook and VACUUM hook are not carried. The manifest rebuild still happens inside `ledger-repair.ts`. |
| X2 | Two different `0062_*` files; main's 0056–0059 are unapplied in production | Keep all of them (R2, M13). A test proves that a database at production's v0.5.2 migration set applies the remaining files cleanly and ends with the same schema as a fresh database. |
| X3 | Judge model id: production stores `opencode/deepseek-v4-flash` (0063); main's policy and transport expect the bare `deepseek-v4-flash` | The transport sends `wireModelId(model)` on every path (launcher included). A new migration normalises a stored `opencode/` prefix to the bare id, so `setJudgeConfig`'s acceptance check and the stored value agree. `enableTwinJudge` writes the bare id. 0063 is untouched (R2). |
| X4 | Main writes fallback judgements; release forbids them | R4 wins. Main's error vocabulary (`JudgeUnavailableError`, `JudgeNothingToJudgeError`, `judgeTransportGap`, `launcher_unavailable`) is kept, and every failure path throws it. M3 carries the reason to the caller. |
| X5 | Release's driver treats only `succeeded`/`dead` as terminal; main's worker settles a failed judge as `failed` | `failed` is terminal for the driver's judge wait. The ceiling is derived from main's `DEFAULT_JUDGE_TIMEOUT_MS` (or `SWARM_JUDGE_TIMEOUT_MS`) × attempts, plus launcher start-up headroom. |
| X6 | Prompt and digest diverge | The prompt carries both sides' changes (R5 plus anything main added). The digest canonicalisation is release's, so production's digests replay (R6). If the canonical form differs from main's, the scheme label is not reused for two schemes. |
| X7 | Receipt route shape change breaks release's verify leg | The leg reads `/consensus-receipt/verified`, and a missing `verified` field fails instead of silently passing (M4). |
| X8 | `judgement_not_authored` is retried 5× | Terminal (M5). |
| X9 | Duplicate fixes: `closeWindow` / reschedule re-arm (`e0d40661` vs `2333e3f`) and the unauthored-judgement check | One copy each. Release's extra warn logging in the worker's `closeWindow` is kept. |
| X10 | Replay shape differs | Release's replay (R6). `backend/scripts/swarm-judge-replay.ts` follows it. |
| X11 | Smoke tooling solved the same problem twice (`requestsTwin`/`stageCadenceApplies`/`adoptionFilter`/`smoke:twin:once` vs `--cadence fast`/`seatAllActive`/`plan.kind` rename) | One design per concept. Release's twin behaviour is kept, because it was rehearsed on production dumps (R14). Main's `archive-restore` rename and `--cadence fast` are adopted where they don't change twin behaviour. Tests from both sides pass. |
| X12 | The onboarding driver seats test newcomers when a seat is free, and 20 seats leaves room for more (#1033 note) | The simulation onboarding driver never seats a newcomer on an external database (`--db external`), and this is pinned by a unit test. |
| X13 | the deleted live skill-URL test (`swarm-onboarding-skill-url-live.test.ts`): deleted on main, modified on release | Deleted (M11). |
| X14 | Changelog dates | Main's structure. Entries that shipped in v0.5.1 are dated as main dates them; main's pending block stays as the next release. `changelog.spec.ts` passes. |
| X15 | `frontend/test/unit.list`, `package.json` | Union of both sides. No script names collide. |
| X16 | `docs/decisions.md`, `docs/architecture.md` | D56 is release's (R3). Every other decision from both sides is kept, and no D-number is duplicated. |
| X17 | `0.4.0-to-0.5.0` upgrade scripts and `v0-5-0-rollout.md` (add/add) | Release's copies (R13). The runbook's header records that v0.5.0 shipped (`ec261867`). |
| X18 | Production does not yet run `agent-launcher`, and has no `COINGECKO_API_KEY` | Not a code conflict. Recorded as prerequisites for the next release cut from `main` (§6). |
| X19 | Found while resolving: main's `0062_rm_worker_analytics_ledger_read_grant` grants on `source_payloads`, which release's 0080 drops. On production that migration runs after 0080 and would fail. | **Deviation from M13, deliberate.** The file grants per table, only where the table exists. No database has recorded main's copy except environments built from main, and a recorded migration never re-runs. Evidence: `migration-history-merge.test.ts`. |
| X20 | Found while resolving: with the judge out of process, a refusal logs `DEGRADED … judge_unavailable:<reason>` instead of throwing `JudgeUnavailable` in-process | `twin-gate` also treats `judge_unavailable:` as fatal (`twin-gate.test.ts`). |

## 4. Deliberately dropped

| What | Why |
|---|---|
| Main's `0080` body (541 lines) and its `rebuildVintageManifests` / VACUUM hooks in `migrate.ts` | X1. The repair runs once, as a script. |
| Main's `fallbackOutcome` / `source: "fallback"` writes | X4 / R4. Rows with `source = 'fallback'` from before this change still read and display. |
| Main's `0.4.0-to-0.5.0` upgrade copies | X17. They never shipped. |
| Main's tests of those copies: `rollout-postflight-0-5-0`, `stage-rehearsal-fusion-receipt`, `stage-rehearsal-judge-diagnosis`, the three postflight `judge-source` database tests in `judge-budget-fallback-rate`, and `resolveAcceptanceFlag`'s tests in `acceptance-path-stack-config` | X17. They test code that never shipped. The fallback-share rule itself stays (`summarizeJudgeSources`), and its pure tests stay. |
| `analytics-ledger-compaction-migration.test.ts` and `fixtures/ledger/0080_…as-merged-1046.sql` | X1. Release deleted both in `bc71ae12`; the merge had re-added main's copies. |
| Release's `tests/support/stub-judge.ts` | Replaced by main's launcher stub (`judge-stub.ts`); nothing imports it. |
| Release's control-line `WEIGHTS` format, and its edits to `swarm-inference-opencode-argv.test.ts` | M6. |
| Main's `defaultSmokeTwinJudgeMode` | R14. Release's `enableTwinJudge` is the one path that turns on the twin's judge. |
| Release's `judgeCredentialEnv` and its forced 180 s smoke judge timeout | M2. Main's inference preflight delivers the key, and 180 s is below main's 300 s budget. |
| the deleted live skill-URL test (`swarm-onboarding-skill-url-live.test.ts`) | X13. |

## 5. Definition of done (evidence)

- [ ] No conflict markers anywhere (`git grep -nE '^(<<<<<<<|>>>>>>>)( |$)'` is empty).
- [ ] `bun run typecheck` and `cd backend && bunx tsc --noEmit` are clean.
- [ ] `bun run test:unit`: no failures beyond those present on both parents (baseline recorded in §7).
- [ ] `cd backend && bun test`: same.
- [ ] `bun run check-contract`, `bun run check:agent-surface` and `bash scripts/lint-docs.sh` pass.
- [ ] Contract unit tests pass (`cd contract && bun test tests/unit`).
- [ ] X2's migration-history test passes.
- [ ] Every ID in §1–§3 is backed by a named test or a grep, recorded in §7.
- [ ] Every main-only and release-only file at the merge base..tip is present, except the files §4 lists.

## 6. Next-release prerequisites (not part of this merge)

- Production needs the `agent-launcher` service (docker.sock) before the judge can run (M2).
- Production needs `COINGECKO_API_KEY` for the three worker lanes (M9).
- Production will apply `0056–0059`, `0062_rm_worker_analytics_ledger_read_grant` and X3's migration on its next boot. The next release's upgrade tooling must declare them.
- The receipt URL's shape changes for outside consumers (M4).
- Retire the test members Nyx and Draco (#1033).

## 7. Evidence

_Filled in as the merge is resolved._
