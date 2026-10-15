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
5. **Open, product, in production since v0.6.0: `projects.refresh_wallets` holds the
   analytics lane 73% of the day.** It does not hang. The production dump's `job_runs`
   show it refreshed 4 wallets in under a second until 2026-10-08. The fixture-source
   guard (1244) moved production to the live source; discovery then loaded the v0
   roster, and from 2026-10-09 06:20 it reads 793 wallets, one RPC call each, at the
   shared 0.25 calls/s budget: 52 min per attempt (793 / 0.25 = 3172 s). 8 non-Base
   wallets always fail, so every slot ends `degraded` and is retried 5 times, about
   4.4 h of each 6 h. Every other analytics job waits behind it: on 2026-10-12/13 the
   median start lag was 40 min (max 72 min) for `wallet.sample_balances`,
   `wallet.sample_sleeves`, `ops.repair_gaps` and the rest, against 1 to 2 s before.
   The worker's 15-min progress budget then marks worker-analytics unhealthy, which
   is what failed R2.5 and W1. Fix in its own PR: batch the wallets (Multicall3), and
   do not retry a degrade that is permanent (an unsupported chain).
   Separately, `base-rpc-client.ts` clears its timeout once headers arrive, so a body
   read has no deadline; this did not cause the stall, but is worth the same PR.
6. **Open, product, in production since v0.6.0: no vault TVL has updated.**
   `projects.fetch_vaults` fails `totalAssets()` on `0x7689…Cb07` (Bankr Agent Token
   LP, `strategy_type: lp-fees`, not an ERC-4626 vault: the call reverts on Base), and
   one failed vault degrades the whole run with `updated: 0`. Fix: read only ERC-4626
   vaults through `totalAssets()`, and degrade per vault as the wallets do (346).
7. **Fixed: healthy sessions were graded stuck.** Migration 0117 (1263) moved every
   subject to 24 h epochs on 2026-10-09; a session collects for its whole epoch.
   The gates failed any open session older than 780 min (13 h), a limit set by the
   gate port (1132) for 6 h epochs. The dump's sessions run on an exact 24 h cadence
   per subject, 6 h apart: none was stuck. Both gates now measure from the session's
   own deadline (judging deadline, else window close), with 120 min of grace.
8. **Open, small: api, system-scheduler and analytics-producer ignore `docker stop`.**
   `backend/Dockerfile` has no init, and only the worker handles SIGTERM. Bun runs as
   PID 1, so SIGTERM is ignored, and Docker kills each one after 10 s (exit 137). Every
   rolling replacement waits 10 s and cuts in-flight requests. Fix: `init: true` in
   compose, and a SIGTERM drain in each entrypoint.
9. **Open: the api was SIGKILLed once, 100 s after its boot,** in run
   `20261014T230723Z` (exit 137, no Docker kill or OOM event). The producer seed met
   the gap and failed R6.7a. It did not repeat in the passing run, where the api
   peaked at 174 MiB with 5.4 GB free. The resume overwrote R6.7a's logs, so no
   evidence is left. Cause unknown; the kernel log is not readable as `stage-server`.
10. **Fixed: `docker inspect` receipts were not valid JSON.** The scrubber matched the
    key `token` in the rm-token bind mount and swallowed the closing quote. It now keeps
    the quote.

## Stage QA run on the five-phase runbook (2026-10-15)

Run `20261015T210118Z` at `ff1d2ef9`, step list `9910d29b`, one command:
`bun run release:run --target stage --go <go>`. Status passed; S07-soak-gate and S08-soak-checks
were accepted (owner's practice-run override), every other step was ok or skipped. Committed as
`scripts/tests/fixtures/release/stage-run-20261015T210118Z.json`.

- QA: Q01-lockfile caught a stale lockfile on the run before (`undici-types` 8.12.2), refreshed on
  the QA branch. Q02-dump reused the day's dump; Q03-stage-up built stage; Q05-scope matched all 29 PRs.
- Preflight P01 to P08 and the cutover passed. The cutover window (C05-migrate to READY) was 181 s;
  the website probe saw no failed answer.
- Every v0.6.2 version check, V01 to V11, passed on its first live run.
- Findings:
  11. **Open, product (1375): the parity sweep ends the api.** One sweep raises the api from 71 MiB
      to 5.9 GiB and leaves it at 2.5 GiB. After the rolling boot the api restarted twice, each time
      during a sweep (21:29:12 to 21:30:04Z, 21:33:08 to 21:34:02Z); production failed 17 sweeps
      since 2026-10-09 with "socket connection closed".
  12. **Fixed: tools trusted the stack record's api port.** A restarted container gets a new host
      port (32975 recorded, 32977 live); S08's health checks read a healthy api as unreachable. The
      tools now ask `docker port`.
  13. **Open, product (1378): a boot releases a burst.** The worker claims before the api listens,
      the reaper re-queues a dump's running job, and catch-up queues one parity sweep per missed
      hour; the worker's first claim after the rolling boot was a sweep, under a second after it
      started. Logs since C10 are saved in the run journal's `boot-logs/`.
  14. **Fixed (1275, merged)**; **in progress (1373)**: the wallet refresh's lane hold.
