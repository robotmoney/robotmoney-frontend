# v0.6.2 stage preflight — 2026-10-14

**Verdict: NO-GO.** This was a preflight attempt, not a passed cutover rehearsal.

## Source and target

- Candidate: `5cb1baa502f9b3e68eefcb143763793c0b864a2d` on `releases-0.6.x`.
- Main merged: `a0c8457d` through merge commit `01bf7c87`.
- Runbook: [v0.6.2 delta](../runbooks/v0-6-2-rollout.md).
- SSH alias: `rm-frontend-stage-2`, using the control machine's existing SSH configuration.
- Candidate checkout: `/home/stage-server/rm-stage-target-v062`.
- Stage instance: `stage_target`, HOME `/home/stage-server/stage-target`.
- Database: `172.17.0.1:25060/defaultdb`, identity `rehearsal`.
- Command on control machine: `bun run release:run --target stage --preflight`.
- Control journal: `~/.local/state/robotmoney-release/stage/preflight-20261014T183428Z/`.

## Results

Target identity, clean candidate HEAD before install, origin branch membership,
checkout isolation and role login checks passed. The stage ledger reconciled with
production's v0.6.1 commit `bca5186eeac13163c25a22c268bca87078d9fb93`:
120 applied filenames, 123 candidate files, three pending migrations. Reconciliation
uses full filenames and shipped bytes, not a numeric maximum. Baseline row counts
and role checks were copied into the control journal's R2.3 receipts.

R2.5 failed with two baseline check failures:

- Sessions: treasury session `589c6957-df33-45db-978a-c832a8dcb1d6` was collecting
  for 1411 minutes; vault session `3580863c-7985-4513-8d81-a11db2e54833` for 1063
  minutes, beyond the gate's 780-minute limit.
- Error inventory: unclassified wallet-balance and vault-extractor failures,
  including unsupported-chain and invalid-address findings. Full findings are in
  `R2.5/receipts/prod-gate-baseline.md` and its JSON report.

The analytics worker subsequently reported `unhealthy`, with zero restarts. Nginx
and API remained healthy, also with zero restarts. Stage continued serving site
commit `bca5186e` and API commit `bca5186eeac13163c25a22c268bca87078d9fb93`, API
contract version `0.5.2`. No service replacement or migration occurred in this attempt.

P.ci was red because no check run existed when preflight queried the candidate;
GitHub workflows appeared later and were still queued during the attempt. This
report does not treat queued CI as green. P.go and P.recovery were pending; this
read-only preflight ran without a go file and did not start a release run.

## Capture and restore

Capture uses `rm_readonly` on production's read replica. The tool verified
`transaction_read_only=on`, `pg_is_in_recovery()=true`, server major 18. Capture
folder: `/home/stage-server/rm-backup-stage-20261014T183428Z`. The dump and its
passphrase stay on the capture host; neither is committed to Git.

R2.1 passed in 559 seconds; the dump was 533338713 bytes, plus 1817 bytes of
globals. R2.2 recorded encrypted-file SHA256 checksums. R2.4r restored successfully
(`pg_restore exit=0`) in 251 seconds, read back 120 ledger filenames, then removed
the disposable container. The control journal holds `R2.1/receipts/manifest.json`,
`R2.2/receipts/SHA256SUMS`, and `R2.4r/receipts/restore-proof.json`.

Preflight exited 2: **16 green, 2 red, 0 blocked, 2 pending**. Step-list hash:
`ff53d9b73904d7030d8a189165a6466357a3cf72a43068f48e798c19e83d82fb`.
No cutover step ran.

## Next execution

Resolve or explicitly triage each baseline finding under the existing release
policy. Rebuild stage from a fresh approved production dump before a full rehearsal;
this attempt inspected the existing stage target and did not rebuild it. Require CI
success and the runbook's website-continuity and website-only runner gaps to be
resolved before cutover. R6.1 still stops the entire stack, including nginx; no
zero-downtime claim follows from this attempt. No RC or final tag was created.

CI subsequently completed unit with two failures: the historical checkout fixture
and the delta runbook's 150-line limit. Both were corrected after this attempt: the
website procedure now lives in [a linked guide](../runbooks/website-rollout.md), while
the v0.6.2 delta is 145 lines. This does not turn the original candidate's CI green.

Local checks: docs lint passed; 123 release-runner, step-table and delta-runbook tests
passed after
making the historical dual-refusal test fixture independent of the new candidate
checkout path. Those corrections and this report are follow-up changes, not
part of the candidate SHA above. A fresh preflight/rehearsal is required for any
new candidate; this journal cannot authorize production.
