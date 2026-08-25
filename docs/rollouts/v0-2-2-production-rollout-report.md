# v0.2.2 production rollout report

## RC deployed

```
Tag:    v0.2.2-rc.10
SHA:    bf63dc6a75b1479eaa16282de89910f00d8eddd3
Branch: releases-0.2.x
```

## Timeline

| Step | Wall-clock time (UTC) | Notes |
|---|---|---|
| P1 authorize (§2, issue #660 phases closed) | 2026-08-20T04:38:06Z | Operator attested (no gh CLI on host) |
| P3 backup taken + Gate C verified | 2026-08-20T04:43:51Z – 04:49:39Z | Dump + globals against replica as `rm_readonly`, encrypted (§5.2), restore-check.ts PASS |
| P4 live preflight (Gates B, D, E) | 2026-08-20T04:57:26Z | Re-run immediately before §7.3 per Gate E freshness rule; SAFE TO UPGRADE, 2 known warnings |
| Stage rehearsal gate passed (§5.6) | 2026-08-20T04:54:06Z | **Operator attestation, not independently observed by this session** — see `stage-rehearsal-report-20260820T044351Z.md` for the full caveat |
| Go/no-go sign-off (§2) | 2026-08-20T04:56Z (approx, in-session) | Explicit operator confirmation to proceed with §7.1/§7.3 |
| Cutover started (§7.1 stack stop) | 2026-08-20T04:58Z (approx) | `rm_demo_stack_8cace2830a` (prior live stack) torn down cleanly, `docker compose ls` confirmed empty |
| Stack live (§7.3 boot ready) | 2026-08-20T04:59:18Z | `READY — Site http://127.0.0.1:32772/`, frontend checks passed, archive initializer ran |
| Postflight completed (§8) | 2026-08-20T05:14:55Z | See Postflight result below |
| `v0.2.2` tagged (§8, last step) | 2026-08-20T05:16Z | `bf63dc6` — same commit as `v0.2.2-rc.10`, per policy |

## Postflight result

**PASS, with one operator-authorized override.**

- `migrations-recorded`, `health-endpoint`, `handle-invariants`, `namespace-trigger`, `admin-credential-untouched`, `prerendered-route`: all **PASS**
- `AC1`–`AC5` (member-identity acceptance criteria): all **PASS**
- `archive-adopted` and `swarm-schedules`: **WARN**, both expected/documented in-runbook (§8.0, §6.5) — not blockers
- `AC6` (`ac6-history-attached`) automated check: **FAILED** on a stale-baseline false positive. The check (`postflight.ts:510-521`) does a strict equality comparison against the §5.0 baseline with no tolerance for legitimate activity between baseline capture and postflight run. In this rollout, the swarm was live and correctly publishing (3 sessions: `robotmoney-allocation`, `robotmoney-treasury`, `robotmoney-allocation` again) in the ~15 minutes between baseline capture and this check, adding `+5 recs/+5 memos` each to exactly the 3 seated personas (Athena, Robot Money, Noop Analyst).
  - **Manually verified**: isolating only pre-cutover-timestamped rows (`received_at < 2026-08-20T04:59:00Z`) against the §5.0 baseline shows **zero drift on all 6 members** — Athena 177/105, Noop Analyst 177/105, Robot Money 178/106, Maximus 39/0, Woon 36/0, nat 0/0, exact match. No history was orphaned by the `0033` re-id.
  - Operator (lucky-tensor) reviewed this evidence in-session and explicitly authorized proceeding via override rather than the full fix-loop (patch → new rc → restart §4.1).
- §8.2 checks 13/14 (scheduler + wallet-sampler liveness, not part of `postflight.ts`'s automated run): verified separately, both clean. Notably, the pre-existing `wallet.sample_balances`/`wallet.sample_sleeves` wedge (frozen since 2026-08-10, documented in the runbook as pre-existing and not this release's fault) **self-resolved** post-cutover — both now show future `next_run_at` and thousands of runs in the last 10 minutes; `wallet_balance_samples` has 8 rows for today. No manual repair `UPDATE` was needed.

Final `v0.2.2` tag cut at `bf63dc6a75b1479eaa16282de89910f00d8eddd3`.

## Rollback details

N/A — not needed. Postflight passed (with the documented override above).

## Final version tag commands

```bash
git tag -a v0.2.2 bf63dc6a75b1479eaa16282de89910f00d8eddd3 -m "v0.2.2"
git push origin v0.2.2
```

Executed 2026-08-20 ~05:16Z. Verified: `git rev-parse v0.2.2^{commit}` = `git rev-parse v0.2.2-rc.10^{commit}` = `bf63dc6a75b1479eaa16282de89910f00d8eddd3` = HEAD.

## Follow-up items (not blockers, but should not be lost)

1. **`postflight.ts`'s `ac6-history-attached` check needs a growth tolerance.** As written it will false-fail on every future rollout unless the swarm happens to be idle during the postflight window. Fix: compare only pre-cutover-timestamped rows, or use `>=` plus an explicit check that no pre-existing row's `member_id` changed.
2. **Issue #660 should have this AC6 override recorded on it directly** (operator attestation + evidence above) — not done by this session, no `gh`/API access from this host.
3. **`gh` CLI (or a `GITHUB_TOKEN`) is not available on `rm-frontend-prod-1`.** P1's gate had to be taken on pure operator attestation instead of `gh issue view 660`. Consider provisioning this for future rollouts.
4. **This session ran P3/P4 (backup, live preflight) directly on `rm-frontend-prod-1`, not the dedicated staging host** the runbook's §2 mandates, with explicit operator sign-off given the narrow scope of what ran (read-only queries against the replica, one lightweight throwaway-container Gate C restore-check — no image build, no full app-stack boot). §5.6's stage rehearsal report notes the same gap for P5, which per the operator was performed separately, outside this session, prior to this runbook execution starting. **The runbook's §2 warning and `steps.ts`'s `actor: "agent"` on P5 assume a single session performs the entire P1–P9 sequence on the correct hosts in order; that assumption did not hold here.** Recommend updating the runbook/docs to reflect the actual operating pattern (see the same note already left in the stage-rehearsal report).
5. **`§7.3`'s literal `BOOT_STATUS=$?` capture does not work as written for a successful `bun smoke` boot** — the process does not exit on success; it runs the live swarm loop in the foreground indefinitely (confirmed: it was still running 18+ minutes after this report's timeline, having published multiple further swarm sessions). Readiness was instead confirmed via the `READY`/`frontend checks passed` log lines in `.agents/demo-rm_prod.log`. Worth a doc correction so future operators don't wait on an exit code that isn't coming.
6. **Backport debt to `main`**: 33 commits exist on `releases-0.2.x` that are not on `origin/main` (`git log --oneline origin/main..origin/releases-0.2.x`). Per release-runbooks.md §7 this is not a go/no-go gate, but it is real hygiene debt now that `v0.2.2` is tagged and the release line should stop being the place new fixes land first.

## Operator sign-off

> Production rollout completed by: lucky-tensor (via agent session)
> Date: 2026-08-20
> Sign-off: GO — explicit in-session authorization at each gate (P1 attestation, P3–P4 execution approval, Gate C Docker-use approval, P5/P6 attestation, §7.1/§7.3 cutover approval, AC6 override approval, final tag approval)
>
> Final `v0.2.2` tag exists on `releases-0.2.x`: **yes**
> Issue #660 closed: **not yet** — needs manual close (no `gh`/API access from this host) and should have the AC6 override attached to it first (see Follow-up #2)
