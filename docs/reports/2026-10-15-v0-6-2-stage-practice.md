# v0.6.2 stage practice run of the runbook overhaul — 2026-10-14/15

**Verdict: the runbook ran end to end on stage. This is not a stage pass for v0.6.2.**
The owner ordered red findings overridden for this session only. Two steps were
accepted rather than passed (R2.5, W1), so SP.8 refuses this journal for production.

## Source and target

- Branch: `qa/0.6.x-2026-10-14`, cut from `releases-0.6.x` at `a314e887`, with the
  runbook overhaul (1355) merged in and a fresh lockfile resolve (`9cdaf4b5`).
- Passing run commit: `b6e68ce48b0f54f7e675ae6ea86ff61e142ee4fd`.
- Stage target: `stage-target up` from dump `20261014T151849Z` (7 h old), at v0.6.1 `bca5186e`.
- Go: `commit`, `operator`, `date` (D70 shape). Triage: the fixture
  `scripts/tests/fixtures/release/stage-preflight-20261014T225244Z.triage.txt`.
- Journals on the control machine, under `~/.local/state/robotmoney-release/stage/`:
  - `preflight-20261014T225244Z`: 20 green, P.ci red (CI still running; unit failed
    on the missing fixture). Committed as the preflight fixture.
  - `20261014T230723Z`: failed at R6.7a twice (findings 1 and 2), abandoned.
  - `20261014T233156Z`: **passed**, with R2.5 and W1 accepted.
- Stage was torn down at 2026-10-15T00:21Z.

## What the passing run proved

- Every step ran as written, from R1.1 to W3, on a QA commit (D70, SP.8 by tree).
- Migrations 0120 to 0122 applied under the running v0.6.1 (R6.3, 12 s).
- The rolling boot (R6.7a, 98 s) replaced api, worker-analytics, system-scheduler,
  then analytics-producer, one at a time. website-server was never recreated: its
  new `nginx.conf` shipped by graceful reload.
- The website probe (C0 to C9) recorded 138 answers over 137 s on `/` and
  `/version.json`: every answer 200, no gap.
- The 30-minute soak ran W2 (soak checks), R7.4a and W3 (19 log receipts).

## Findings

1. **Fixed: a failed rolling boot stopped the serving api.** Run `20261014T230723Z`:
   R6.7a's readiness failed, and the smoke failure path stopped api, worker-analytics
   and analytics-producer. `/api/version` answered 503 until they were started by hand.
   A `--static-port` boot now keeps them running (`smoke-failure.ts` `kept`).
2. **Fixed: a failed rolling boot could not be resumed.** The smoke journal refused,
   because the producer had moved to the plan's new image inside a phase that never
   committed. A resume now accepts the image this compose project built (same plan id).
3. **Fixed: CI never ran on `qa/*` pushes**, so P.ci could not pass on a QA commit.
   Every workflow now runs on `qa/**`; `fusion/**` is dropped (owner).
4. **Fixed: an integration test still expected the old `holders` receipt key.**
5. **Open, product: `projects.refresh_wallets` hangs forever.** It hung on stage in
   v0.6.1 and again in v0.6.2 (jobs 71389428, 71388991), and made worker-analytics
   unhealthy at R2.5 and W1. `backend/src/chain/base-rpc-client.ts` clears the request
   timeout once the headers arrive, so `res.json()` has no deadline; `rpcBatchRequest`
   has the same flaw. The worker loop has no per-job limit. Needs its own PR before
   the production run.
6. **Open: the api was SIGKILLed once, 100 s after its boot,** in run
   `20261014T230723Z` (exit 137, no Docker kill or OOM event). The producer seed met
   the gap and failed R6.7a. It did not repeat in the passing run, where the api
   peaked at 174 MiB with 5.4 GB free. Cause unknown; the kernel log is not readable
   as `stage-server`.
7. **Open, small: the old analytics-producer exits 137 on replacement.** It does not
   stop within Docker's grace period.
8. **Open, data: production state in the dump.** Sessions stuck in `judging` and
   `collecting`, and a degraded vault extractor, need the owner's real triage before
   the production R2.5.
