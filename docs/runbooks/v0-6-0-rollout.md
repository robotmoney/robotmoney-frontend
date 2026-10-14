# v0.6.0 production rollout — history of the first cutover on the smoke production design

> **History (frozen 2026-10-12, issue 1272; shortened 2026-10-13, issue 1261).** This runbook
> records the v0.6.0 cutover as it ran. Nothing reads it: the step list, the step-list hash and
> the ledger check live in `scripts/release/` and are described in
> [`release-run.md`](./release-run.md). The one-time steps of this release and its 76/44 ledger
> split are no longer in the generic list. Numbers below are as of the cutover and are not kept
> current. The standing checks are in
> [`release-standing-runbook.md`](./release-standing-runbook.md); the live delta runbook is
> the newest `vX-Y-Z-rollout.md`.
>
> Full text as it was executed: `git show v0.6.0:docs/runbooks/v0-6-0-rollout.md`. The
> blockers B1 to B27, the findings of the 2026-10-08 stage runs, the pending-migration
> classification and the comparison with the 0.5.x runbooks are in that revision, not here.

## What this release was

| Item | Value |
|---|---|
| Release branch | `releases-0.6.x` |
| QA branch | `qa/0.6.x-2026-10-08` (policy §4.6, the first QA branch) |
| From | v0.5.4 at `1cda4085`: checkout `/root/robotmoney-frontend`, a tmux host driver, compose project `rm_prod`, a 76-name migration ledger |
| To | v0.6.0 at `e96d4598` in `/root/rm-060`, instance `rm_prod`, booted by `bun smoke --static-port` |
| Cut over | 2026-10-08 22:10 UTC, production run of `bun run release:run --target prod` |
| Tags | `v0.6.0-rc.0` and `v0.6.0`, both at `e96d4598` (the final tag was pushed 2026-10-09, post-mortem finding 20) |
| Window | Long and breaking: the stack was down from R6.1 to R6.9, 149 s on stage |
| Written against | standing runbook at `d84f4a2c` |
| Report | [`2026-10-07-v0-6-0-stage-rehearsal.md`](../reports/2026-10-07-v0-6-0-stage-rehearsal.md); the post-mortem [`2026-10-09T1704Z-0.6.0-upgrade.md`](../post-mortems/2026-10-09T1704Z-0.6.0-upgrade.md) |

v0.6.0 changed how production is deployed, not what the product does (owner, 2026-10-03). It moved
production from the old host shape (`RM_ENV=smoke`, overlay compose, an in-process host driver)
onto the adopted design ([`smoke-production-spec.md`](../technical/smoke-production-spec.md) §9.3,
D47), and it was the first release executed end to end by the runner (D61, owner 2026-10-08): one
go file, no person on a host, every database operation a committed script with a receipt.

## The delta it carried

- **Schema.** 46 pending files from the 76-name ledger, 8 of them `breaking`, applied by R6.3 in one
  migrate with `0081_deployment_identity` first. The ledger went from 76 to 122 rows.
  `0107_revoke_runtime_delete` took `DELETE`/`TRUNCATE` from every runtime role, so no code-only
  rollback existed after R6.3 (recovery was a restore of the R2.1 dump).
- **Credentials.** `~/.env` cut to the D61 allowlist (R6.2). `rm_owner` set by `role-passwords`
  before the run. Three service tokens minted (R6.5). The in-house roster written to
  `credential.json` and the four in-house members moved from fixture keys to it, one way, with a
  second boot to seat the participants on the new keys. Those were this release's one-time steps.
  They ran once and are not part of any later release.
- **Runtime.** Sessions timed by `system-scheduler` per subject epoch. The judge is a participant
  (`themis`). No container holds a Docker socket. The site is its own release unit (R6.10). The old
  checkout was renamed and locked after the migrate.
- **Checks.** The log gates ported to the instance model (1071). The cumulative standing invariants
  ported as `bun run soak:checks` (1179). Schedule parity (R7.4a) and the graded watch (W1) added.

## Exceptions the owner recorded (2026-10-08)

- SP.6 and SV.5 for the published AUM figure: no step recorded or compared it.
- SW.2 over the watch window: `soak:checks` ran at READY only.
- The stage watch was a 15-minute check with sessions deferred; production kept the graded watch.
- SR.1, SR.9 and the full tier of SR.3 ran on a short accelerated twin at the release commit, not
  on the stage target.

## What happened after the cutover

- The first post-cutover windows ran 8.7 to 8.8 h, then every subject ran back-to-back 6 h
  epochs: 16 sessions a day instead of 4. Blocker B3 had read production's 6 h window length as
  the per-subject cadence. On 2026-10-09 the owner chose one session per subject per day, applied
  by hand through the admin subject route, then made durable by migration 0117 in v0.6.1.
- Weightless vault takes from external members were refused with 400 (the four-weight rule).
  The owner decided the vault take carries no weight vector (migration 0116, v0.6.1).
- The release branch did not contain the production commit, because the QA branch was squash
  merged. Fixed 2026-10-09 by resetting `releases-0.6.x` to `e96d4598` (D62).
- These and the rest are in the post-mortem. Under D63 the shipped commit kept its final tag and
  the fixes shipped as v0.6.1-rc.0.

## What this release taught the standing runbook

- Every production data change ships as a migration (owner, 2026-10-09; standing rule 7). The
  hand-applied 24 h epochs were the last admin-route write.
- The runner holds no fact of a past upgrade (issue 1272): the baseline is read from the running
  system and a one-time action is a delta step of its own release.
- Stage runs a release-branch commit, the rc is cut there once stage passes, and production runs
  only by that rc tag (D64).
- A release that reached production gets its tag unless rolled back (D63).
