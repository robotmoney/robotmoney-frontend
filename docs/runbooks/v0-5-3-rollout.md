# v0.5.3 production rollout — the website only

> **Frozen historical record of releases-0.5.x.** Its commands are retired under D47 and must not be copied.
> For how deployment works now, read `docs/technical/smoke-production-spec.md`.

> **Status: proposal (2026-09-30).** Walk this runbook on `v0.5.3-rc.0` (then `rc.1`, …). Stage steps (R1, R4) run on
> this machine and `rm-frontend-stage-2`. Production steps (R2, R6–R8) run on `rm-frontend-prod-1` and start only on the
> owner's go. It is the first release that uses `bun run site:redeploy`.

## 0. Why v0.5.3, and why it is a different kind of release

v0.5.3 ships two frontend PRs of David's that were merged to `main` after `releases-0.5.x` was cut:

| PR | What | Backend? |
|---|---|---|
| 1052 | The onboarding skill installs a pinned `rmpc-v0.3.4`, checked against the checksums it carries | No |
| 1042 | The research pages and the regime page on the site's system, a smart contract risks index, the regime and indicator pages readable by agents | No |

Nothing in `backend/`, `contract/`, `docker-compose*.yml` or `website-server/` changes, and **no migration runs**.

That changes the shape of the release. v0.5.2 stopped the stack, migrated, repaired the database and rebooted, and
its window ran 1 hour 41 minutes (`docs/reports/2026-09-29-v0-5-2-ledger-repair-cutover-postmortem.md`). The site is
served by `website-server`, a stock nginx container that holds no pages: it serves the checkout's `_static/` through a
**read-only bind mount**. A new site is a change to the files in one directory. So v0.5.3:

- does **not** stop the driver, stop or restart any container, touch the database, or need a maintenance window;
- is deployed by `bun run site:redeploy`, which builds the site aside, swaps the files in place, and proves that not
  one container moved;
- is undone in seconds from the backup the tool takes, with **no database restore** (R9).

## 1. Release identity

| Item | Value |
|---|---|
| From | `v0.5.2` (`becb6897`), running on `rm-frontend-prod-1` |
| To | `v0.5.3-rc.N` → `v0.5.3`, cut from `releases-0.5.x` |
| Migrations | **None** |
| Containers restarted | **None**. R6 fails if any service container's id or start time changes |
| Window | No maintenance window. The swap itself is one `rsync` of about 80 files, measured at **0.1 to 0.3 s**; the whole tool run measured **4 to 6 s** on stage-2 (the build is 1 s). Production has not been measured: expect under a minute, and abandon the run if the build passes **10 minutes** |
| Rollback | `bun scripts/redeploy-website.ts --live /root/robotmoney-frontend --rollback <backup>`, about 5 s. No database involved |

### 1.1 What the changelog may claim

PR 1042's changelog text was written for everything on `main`. On `releases-0.5.x` it was resolved so that every claim
is true of what this line ships (commit `8c7dad93`): the "Twenty seats in the swarm" entry is out (feature 1033 is
not here); "a session's receipt returns its exact signed bytes" and "the API reports the exact build it runs" are out
(main-only backend work; the release's own changelog had already claimed both); the roadmap line stays "readable by
people and by agents" (recording receipts on Base is main-only). **Any later change to the changelog is checked
against this rule**: a claim about the api or the swarm needs the code that does it on this branch.

### 1.2 Decisions (owner)

| ID | Question | Decision |
|---|---|---|
| F1 | Cloudflare purge after R6 | Decided: none needed. Every JS import and stylesheet URL carries a content stamp (`docs/technical/static-asset-cache.md`), so an old cached file cannot be requested. Owner action, optional: set the zone's Browser Cache TTL to "Respect Existing Headers" |
| F2 | The `main` merge-back | Not part of v0.5.3. `main` and `releases-0.5.x` have different migration lineages (main has five migrations the release lacks; the release has two main lacks), so it is its own work item |

## R1. Code readiness (workstation)

| Step | Command | Pass |
|---|---|---|
| R1.1 | Merge `feat/0-5-3-frontend` into `releases-0.5.x` (fast-forward); `RC_SHA=$(git rev-parse HEAD)` | one line of history, no merge surprises |
| R1.2 | `git diff --name-only v0.5.2 "$RC_SHA"` | only `frontend/`, `scripts/` (the redeploy tool, its tests, the two PRs' scripts), `docs/` and `package.json`. **No** `backend/`, `contract/`, `website-server/`, `docker-compose*.yml` |
| R1.3 | `bun run --cwd frontend test` | 0 fail (988 at the time of writing) |
| R1.4 | `bun test website-redeploy.test.ts` (a releases-0.5.x test, not on main) | 0 fail |
| R1.5 | `bun run --cwd frontend assemble` | prerenders every sitemap route |
| R1.6 | `bunx playwright test frontend/test/browser/changelog.spec.ts frontend/test/browser/preview-routes.spec.ts frontend/test/browser/preview-smoke.spec.ts frontend/test/browser/api-unreachable.spec.ts --workers=1 --retries=3` | 0 failed. A test that passes only on retry is `ERR_NETWORK_CHANGED` noise from this machine's network and is fine; a test that fails all four attempts is not. (`spa.spec.ts` has 15 failures that are identical on v0.5.2 and are not this release's.) |
| R1.7 | `bash scripts/tests/site-redeploy-integration.sh` (needs Docker, network) | `ALL CHECKS PASSED`: a real compose stack, a dry run, a redeploy, a rollback, and a forced failure that restores the old site |

## R2. Production baseline (read-only, `rm-frontend-prod-1`)

| Step | Command | Pass | Record |
|---|---|---|---|
| R2.1 | `git -C /root/robotmoney-frontend describe --tags`; `docker ps --format '{{.Names}} {{.Status}}'`; `curl -s https://robotmoney.network/version.json` | `v0.5.2`; six containers healthy; commit `becb6897` | all three |
| R2.2 | `docker logs --since 24h rm_prod-website-server-1 2>&1 \| grep -aEc '" 5[0-9][0-9] '` | recorded (2026-09-30: 1 in 18 h, the 00:30:11 502) | the count |
| R2.3 | A status sweep of the public pages R7.2 lists | 200 on each | the list |
| R2.4 | Nothing else is working on the host: `tmux ls`, `ps -eo args \| grep -E 'claude\|redeploy'` | no deploy or cutover running. An idle `claude` session in pane `0:1.0` is noted and left alone, but nobody may drive it during R6 | the output |

## R3. Backup

There is **no database step**: v0.5.3 does not touch the database. The tool takes its own backup of the live `_static/`
(3.4 MB) at R6.3 and writes it beside the live checkout under `site-backups/`.

## R4. Stage rehearsal (`rm-frontend-stage-2`)

The swap is file-only, so this rehearses the procedure and the tool against a real stack with the production
compose files, not the database.

| Step | Command | Pass | Record |
|---|---|---|---|
| R4.1 | Wipe and check out v0.5.2: `bun run smoke:down; docker rm -fv $(docker ps -aq); bun run smoke:clean`; `git checkout --detach v0.5.2` | 0 containers | HEAD |
| R4.2 | Boot a stack on the repaired v0.5.2 backup (about 3 minutes): in tmux, `bun smoke:twin -- --reuse --backup-dir ~/rm-backup-v052-repaired --no-tui 2>&1 \| tee ~/twin-053.log` | `READY`, `131 checks · 0 failed` | READY time |
| R4.3 | A scratch clone of the RC: `D=~/rm-site-$RC_SHA; git clone --depth 50 --branch releases-0.5.x <origin> $D; git -C $D checkout -q $RC_SHA; bun install --frozen-lockfile --cwd $D` | HEAD = `RC_SHA` | path |
| R4.4 | `cd $D && bun scripts/redeploy-website.ts --live ~/robotmoney-frontend --dry-run` | every line `PASS`; "what changes" is 124 changed, 7 added, 0 removed (every application script is rewritten by the cache-bust stamp; it was 74 before) | the output |
| R4.5 | The same without `--dry-run` | `DONE`; `every one of 38 routes answers 200`; `only the website moved` | the receipt |
| R4.6 | `… --rollback <the backup it printed>` | `rolled back`; `version.json` is v0.5.2's commit again | the output |
| R4.7 | Redeploy once more (R4.5) and leave it | as R4.5 | — |
| R4.7a | The checks R7 runs on production, run here first: `curl -s http://127.0.0.1:48787/ \| grep -o 'assets/js/app/main.js[^"]*'` (carries `?v=` and 8 hex), and a Chromium load of `/`, `/vaults`, `/vault/rmusdc`, `/swarm`, `/regime`, `/changelog` against `http://127.0.0.1:48787` counting module requests, any not ending in the stamp, any status 400 or above, and page errors; then `bun run verify:live --tier readonly` pointed at the stage site | stamp present; 0 unstamped, 0 failed, 0 page errors; `VERIFIED` with only the two higher-tier `skipped` warnings. Production must not be the first place these run (2026-09-30 they were) | the output |
| R4.8 | Tear the stack down within 30 minutes: `bun run smoke:down; docker rm -fv $(docker ps -aq); bun run smoke:clean`. A running twin spends inference credit on every session | 0 containers | time |

### Rehearsal record, 2026-09-30, commit `d6ec0265`

Stage-2, a real stack booted from the repaired v0.5.2 backup at `becb6897`, six service containers, `131 checks · 0 failed`.

| Step | Result |
|---|---|
| R4.4 dry run | every line `PASS`; `74 changed, 7 added, 0 removed`; 38 routes prerendered; nothing changed |
| R4.5 redeploy | swap **0.1 s**, `DONE in 4s`; `every one of 38 routes answers 200`; `only the website moved — 6 service containers: same ids, same start times`; `version.json` = `d6ec0265` |
| R4.6 rollback | `rolled back — the site is commit becb6897; no container moved` |
| R4.7 redeploy again | swap 0.3 s, `DONE in 6s`, same two proofs |
| R4.8 teardown | 0 containers, 0 volumes |

**What the rehearsals found, all fixed, each with a regression test.** (1) In the local integration test: the rsync mode spec
left directories at 744 and nginx answered 500 (Appendix A). (2) On stage-2, first run: `version.json` holds git's
*abbreviated* hash, 7 characters in a shallow clone and 8 on a workstation, and the tool demanded 8; it rejected a correct
deploy and rolled it back, which also showed the automatic rollback working on a real stack. Hashes now match by prefix.
(3) Teardown used `docker rm -f`, which leaves the postgres container's anonymous volume; it is `docker rm -fv`.

## R5. Go / no-go and RC tag

| Step | Action | Pass |
|---|---|---|
| R5.1 | Owner reviews R1 and R4 and the F1 decision, and gives a written "go". The commit R4 ran must be the one R5.2 tags; a later commit means R4 again unless it changes only `docs/` | "go" with name and time |
| R5.2 | `git tag -a v0.5.3-rc.N "$RC_SHA" -m 'v0.5.3-rc.N' && git push origin v0.5.3-rc.N` | tag points at `RC_SHA` |

## R6. Production deploy (`rm-frontend-prod-1`, root)

No window is announced; nothing stops. Run it from a **scratch clone** of the RC, never from the live checkout: the
live checkout sits under the running host driver and must not move.

| Step | Command | Pass | Record |
|---|---|---|---|
| R6.1 | `D=/root/rm-site-$RC_SHA; git clone -q --depth 50 --branch releases-0.5.x "$(git -C /root/robotmoney-frontend remote get-url origin)" $D && git -C $D checkout -q "$RC_SHA" && bun install --frozen-lockfile --cwd $D && bun install --frozen-lockfile --cwd $D/backend` | `git -C $D rev-parse HEAD` = `RC_SHA` | path |
| R6.2 | `cd $D && bun scripts/redeploy-website.ts --live /root/robotmoney-frontend --public https://robotmoney.network --dry-run` | every line `PASS`: the stack has six containers, the live site is `becb6897`, the changed-file guard passes, the build checks pass. The diff matches R4.4's (124 changed, 7 added, 0 removed) | the output |
| R6.3 | The same command without `--dry-run`. Record `T0=$(date -u +%FT%TZ)` first | `DONE in Ns`, `every one of 38 routes answers 200`, `only the website moved`. It prints the receipt and the undo command | receipt path |
| R6.4 | `curl -s https://robotmoney.network/version.json`, then `curl -s https://robotmoney.network/ \| grep -o 'assets/js/app/main.js[^"]*'` | the commit is `RC_SHA`'s first 8 characters, and the entry point carries `?v=` with 8 hex characters | the output |

**Abort rules.** The tool changes nothing until its backup and swap, so *Ctrl-C is safe* at any point before the line
`backup —`. It is abandoned if the build passes 10 minutes. After `swapped in` do not interrupt: the swap is about
0.1 s and the checks that follow either pass or restore the old site. If it exits `1`, the old site is already back
(it says so); stop and read the failure. If it exits `2`, it refused before changing anything.

## R7. Postflight

| Step | Check | Pass |
|---|---|---|
| R7.1 | `docker ps --format '{{.Names}} {{.Status}}'` | the same six containers, **Up since the v0.5.2 boot** (22:26 UTC on 09-29), not restarted |
| R7.2 | A browser pass on `https://robotmoney.network`: home, `/vaults`, `/vault/rmusdc`, `/swarm`, a published session, a judgement page, a member page, `/deposit`, `/changelog` (it lists the regime page and the DeFi index as "Next release"), `/skills`, `/regime`, `/regime/indicators`, `/smart-contract-risks` | every page renders data, no console error |
| R7.3 | `cd /root/robotmoney-frontend && bun run verify:live --tier readonly --emit-receipt=P8.verify-prod-v0.5.3` | exit 0; the two `skipped` warnings are the higher tiers |
| R7.4 | `docker logs --since "$T0" rm_prod-website-server-1 2>&1 \| grep -aEc '" 5[0-9][0-9] '` | 0 |
| R7.5 | **Tag `v0.5.3` on `RC_SHA` now** (owner, 2026-09-29: a release is tagged when its post-deploy checks pass, before any watch): `git tag -a v0.5.3 "$RC_SHA" -m v0.5.3 && git push origin v0.5.3` | tag pushed |

## R8. Watch (one hour, not a 24-hour soak)

Nothing ran that could regress the api, the workers or the database, so the v0.5.2 soak does not apply. Watch what a
site change can break: from `T0` to `T0 + 1 h`, at 15, 30 and 60 minutes, run R7.1 and R7.4 again and
`docker logs --since "$T0" rm_prod-website-server-1 2>&1 \| grep -a '\[error\]'`.

Pass: no 5xx, no nginx `[error]`, the same six containers. A failure here is a rollback (R9) only if pages are broken
for readers; otherwise it is a follow-up release.

### Production record, 2026-09-30 (release candidate `v0.5.3-rc.1`, final tag `v0.5.3`, both on `cb82726f`)

| Step | Result |
|---|---|
| R6.1, R6.2 | clone at `cb82726f`; dry run every line `PASS`; `124 changed, 7 added, 0 removed` |
| R6.3 | `T0` 2026-09-30T20:11:21Z; backup `/root/site-backups/2026-09-30T201122Z-becb6897`; swap 0.1 s; `DONE in 1s`; `every one of 38 routes answers 200`; `only the website moved — 6 service containers: same ids, same start times`; `public site … serves cb82726f` |
| R6.4 | `version.json` = `cb82726`; entry point `assets/js/app/main.js?v=aa327588` |
| R7.1 | the same six containers, Up since the v0.5.2 boot (not restarted) |
| R7.2 | 10 public pages 200; a Chromium load of 6 pages fetched 88 modules, all `?v=aa327588`, 0 failed, 0 page errors |
| R7.3 | `verify:live --tier readonly` exit 0, the two higher-tier `skipped` warnings only; receipt `P8.verify-prod-v0.5.3` |
| R7.5 | `v0.5.3` tagged and pushed |
| R8 (checked at T0 + 4 h 18 min) | six containers Up and healthy, 8,044 website log lines. **One 5xx and one nginx `[error]`, both the same event:** 21:40:16 UTC, `GET /api/swarm/sessions/2026-09-28/woon` from the host driver (`Bun/1.3.14`), `upstream prematurely closed connection` from the api. That is an api drop on a driver request, not a website file, and the same class as the 00:30:11 502 recorded at R2.2. It did not touch readers' pages. The watch was not run at 15, 30 and 60 minutes as written; it was checked once, late |

What this release did not catch: nothing in R4 looked at sessions. After it, a reader reported no completed sessions since 09-28
(they were completing; the page showed the row-creation date). Fixes: opened-at (PR 1057) and the driver's regime day (PR 1059, issue 1058).

## R9. Rollback — seconds, and no database restore

1. `bun /root/rm-site-$RC_SHA/scripts/redeploy-website.ts --live /root/robotmoney-frontend --rollback /root/site-backups/<the directory R6.3 printed>`
2. Expect `rolled back — the site is commit becb6897; no container moved`.
3. No purge is needed (F1). Check that `version.json` shows the rollback commit.

The rollback puts back exactly the files and permissions the backup holds. If the tool itself cannot run, the backup
is a plain tarball: `tar -xzf /root/site-backups/<dir>/_static-becb6897.tar.gz -C /root/robotmoney-frontend/_static`
restores the files in place (extract into the existing directory; never delete and recreate it: the container's bind
mount follows the directory's inode).

## R10. Completion

1. `v0.5.3` is tagged at R7.5.
2. Write the rollout report: every step's evidence, R4's output, the R6.3 receipt, R7. The production record above is its source.
3. The merge of `releases-0.5.x` into `main` is tracked separately (F2).

## Appendix A. `bun run site:redeploy`

`scripts/redeploy-website.ts`, with its checks in `scripts/lib/website-redeploy.ts`. Run it from a scratch clone of
the release; `--live` names the running stack's checkout.

| Flag | Meaning |
|---|---|
| `--live <dir>` | The running stack's checkout (or `RM_LIVE_CHECKOUT`). Required |
| `--public <origin>` | Also read `<origin>/version.json` and warn if the edge still serves the old commit |
| `--dry-run` | Preflight, build and checks; stop before the backup and the swap |
| `--rollback <backup-dir>` | Put a backup back, with the same proof that no container moved |
| `--build-dir`, `--keep N`, `--concurrency N` | Where to build, how many backups to keep (5), route-sweep parallelism (8) |
| `--allow-dirty`, `--no-auto-rollback` | Overrides, for rehearsals only |

**What it does, in order:** (1) finds the stack from `.agents/smoke-state.json` and refuses unless the website container
is running, healthy and mounts exactly `<live>/_static` read-only; (2) refuses a dirty tree, a run from the live
checkout, a change to `website-server/` (the nginx image would have to be recreated), and too little disk; warns on
compose-file changes; (3) builds the site into a side directory (the live site is untouched); (4) checks the build:
`version.json` names this commit, every sitemap route was prerendered, every stylesheet `?v=` stamp matches its file,
no symlinks, not implausibly small; (5) backs up the live `_static/`; (6) swaps the files in with
`rsync --checksum --delay-updates --delete-after --chmod=D755,F644`; (7) verifies: the directory is the same inode,
the live files equal the build, `/version.json` and every sitemap route answer 200 through the container, `/health` (the
api behind it) answers, and **every service container has the same id and start time as before**; (8) on any failure
there, restores the backup and exits 1.

**Files it writes:** `<live>/../site-builds/<commit>/` (removed on success) and `<live>/../site-backups/<time>-<commit>/`
holding `_static-<commit>.tar.gz` and `receipt.json` (phases, diff counts, containers before and after).

**Limits, stated:** it does not touch the Cloudflare edge (no purge is needed, F1); it cannot ship a change to `website-server/` (nginx
image) or to the compose files' other services; and it says nothing about the api, which it only checks through
`/health`.

### What the integration test found

`scripts/tests/site-redeploy-integration.sh` runs the tool against a real compose stack. It found one bug in the first
version, which would have taken production's site down: `--chmod=Du=rwx,go=rx,Fu=rw,go=r` ended every directory at mode 744
(in rsync each clause applies to files and directories unless prefixed), nginx in the container could not enter any
directory, and every page answered 500. The tool's own post-swap checks caught it; its rollback could not repair it,
because it reused the same swap. Both are fixed (`D755,F644`; a rollback keeps the backup's own modes) and each has a
regression test.
