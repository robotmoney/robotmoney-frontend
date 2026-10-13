# v0.6.1 production rollout — the post-mortem fixes, as a delta runbook

> **History (frozen 2026-10-13, issue 1261).** v0.6.1 shipped on 2026-10-10. This runbook is the
> record of that release's delta, written in the shape every later delta runbook keeps: it holds
> only what v0.6.1 changed. Everything the release repeated is a row of
> [`release-standing-runbook.md`](./release-standing-runbook.md), cited by ID. The steps are the
> generic list in [`release-run.md`](./release-run.md); the runner reads nothing from this file.
> The live delta runbook is the newest `vX-Y-Z-rollout.md`.

## Inherits the standing runbook

This release ran **every check in the standing runbook** as it stood at `e578e480`. It adds the
v0.6.1-specific checks below and cites standing checks by ID. The standing IDs map to the runner
steps as [`release-run.md`](./release-run.md#the-step-list) records (the `standing` column).

**Exceptions** (carried over from v0.6.0, owner 2026-10-08, restoring issue agent-executed
runbooks (1225)): SP.6 and SV.5 for the published AUM figure; SW.2 over the watch window
(`soak:checks` runs at READY only); the stage watch is 15 minutes with sessions deferred.

**Rule (owner, 2026-10-09).** Every production data change ships as a migration. The 24 h epochs
applied by hand on 2026-10-09 were the last admin-route write; migration 0117 made them durable.

## 1. Release identity

| Item | Value |
|---|---|
| Release branch | `releases-0.6.x`, taking `main` by merge (D62 route (a)) |
| From | v0.6.0 at `e96d4598`, `/root/rm-060`, instance `rm_prod`, ledger through `0115` |
| To | v0.6.1 at `bca5186e`, `/root/rm-061`, the same instance |
| Stage run | `20261009T234226Z`, passed |
| Production run | `20261010T004257Z`, 2026-10-10 |
| Tags | `v0.6.1-rc.0` and `v0.6.1`, both at `bca5186e` |
| Window | Short: no `breaking` migration, so R6.1 to R6.9 is one stop, one migrate, one boot |
| Tracking | the post-mortem fixes pr (1263); post-mortem [`2026-10-09T1704Z-0.6.0-upgrade.md`](../post-mortems/2026-10-09T1704Z-0.6.0-upgrade.md) |

## 2. The delta

### 2.1 Migrations (R6.3 applies them, in filename order)

| File | Does | Postflight |
|---|---|---|
| `0116_vault_subject_position_actions` | The vault subject becomes `position_actions`, as treasury and woon are. A vault take carries no weight vector; past vault receipts keep theirs (owner decision 1) | section 3, check A |
| `0117_subject_daily_epochs` | `epoch_duration_seconds = 86400` for the four subjects, anchored to the old rotation (vault 00:52, woon 06:58, allocation 13:00, treasury 19:03 UTC). A no-op on production, which held the values from the 2026-10-09 hand edit (owner decision 3) | R7.4a, section 4 |
| `0118_purge_projects_fixture_rows` | The projects fixture rows of issue 1208 leave production. A migration, not the script that issue named (owner decision 5) | R7.5: the count only shrinks by the purged rows, R2.3 names them |
| `0119_rejected_take_health_event` | `rejected_take` joins the agent-health event kinds, one per (session, member, code) | section 3, check C |

R2.3 lists the four as the pending set; R6.3's receipt lists them applied, so the ledger ends at `0119`.

### 2.2 API

| Change | What a participant sees | Finding |
|---|---|---|
| `GET /api/swarm/open-sessions` (contract 0.5.2) | Every collecting session, not the newest one. `open-session` is unchanged. The participation page, the skill and the samples read the list | 5 |
| `signing-payload` parity with `submit` | Both call the same `weightsRefusal`. A draft the submit would refuse is refused at the payload step | 10 |
| Refusal logging | `submit` logs each refusal and records the `rejected_take` health event. A refused take is no longer an invisible absence | hard to see |
| Docs | Skill, participation, API reference and how-it-works pages say only allocation takes weights; an unknown bucket name is in the error table | 2, 14, 15 |

### 2.3 Release tooling that changed with this release

- The runner's baseline became the v0.6.0 ledger (every file through 0115), and R1.2 accepted a
  ledger that records 0081 as an ordinary file. Superseded by issue 1272: the ledger is now a
  prefix check by filename set, with no baseline constant.
- The one-time v0.6.0 credential steps left the step list. `RM_CREDENTIALS` is checked at R1.2.
- `stage-target up` boots the v0.6.0 stack the way the cutover did, with `PROJECTS_SOURCE=live`.

## 3. Release-specific postflight checks (after R7.3, before W1)

| Check | Tool | Pass |
|---|---|---|
| A. A vault take carries no weights | `manual`: the vault brief's `takeSchema` names no weights, and the first vault receipt published after READY carries no weight vector | the receipt's `weights` is absent |
| B. Allocation requires the four canonical weights | `manual`: a draft with two buckets is refused at `signing-payload` with `weights_required_for_bucket_weights_subject`; a draft with the four is accepted | 400, then 200 |
| C. A refusal is a health event | R7.3a: no unclassified line for `/api/swarm/submit`; R7.3b (R8.o) lists the refusal lines as INFO | 0 unclassified |
| D. `open-sessions` lists every collecting session | `manual`: the count equals the number of subjects with an open window | 4 after the first turnover |

A, B and D had no asserting tool at this release: `manual` rows, read from the public API by the
operator after READY (policy §5: a check with no tool is a missing tool).

## 4. The turnover proof for 24 h epochs (R7.4a and W1)

- Every active subject reads `epoch_duration_seconds = 86400` at R7.4a.
- The windows open at the 2026-10-09 turnover were the transition: vault 6 h, woon 12 h,
  allocation 18 h, treasury 24 h, each followed by 24 h windows (post-mortem finding 7, observed).
- W1 is the 37 h graded watch: every subject publishes one judged session after READY. Sessions in
  flight at R2.3 published on their unmoved close.

## 5. The member notice

The notice to woon, shodai, zyfai and dualmint is drafted in the post-mortem (owner decision 4,
not decided). It states the weights rule, the 24 h schedule, `open-sessions` and the
`signing-payload` parity. It is sent only on the owner's word, after the vault change reaches
production. It is not a runner step.

## 6. How the run went

- The stage run passed at `bca5186e`. Stage and production ran a PR head, not a release-branch
  commit: the squash merges carried its tree to `main` and `releases-0.6.x` under other hashes,
  and `/api/version` read `"tag": null` because the rc tag was pushed after R1.1 had fetched.
  D64 (owner, 2026-10-10) is the fix: stage runs a release-branch commit, the rc is cut there,
  and production runs only by the rc tag.
- R7.3a failed on one boot-race line (issue 1280) with production healthy. The runner could not
  pass it, so W1, R7.4a and W3 never ran. The owner tagged `v0.6.1` by hand under D63. Issue 1282
  added `--accept`, so a later run records such a decision in the journal and continues.
- The R2.5 baseline on production named two new log shapes (issue 1278): nginx access-log lines
  for scanner probes and one judge SSE reconnect. Both became classifications in v0.6.2.
- The 24 h epochs were observed at the turnover. The anchors still carried the old rotation's
  drift (closes 5 h 49 m to 6 h 06 m apart), fixed by migration 0121 in v0.6.2.

## 7. Recovery

No `breaking` migration, so no step of this release took a runtime grant away and the restore
path of the recovery matrix was never needed. The go named the signed matrix as
[`release-run.md`](./release-run.md#the-go-file) requires (SC.1).
