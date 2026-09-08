# v0.4.1 production rollout

> Operator procedure for upgrading production from **v0.4.0** to **v0.4.1**.
> The candidate currently under test is **`v0.4.1-rc.3`** at commit
> `ebee27c9c8fd18a49da0f3143df1ac4482bde365` on `releases-0.4.x`.
> Re-resolve the tag and SHA when a later RC is cut; this document is not
> authority for a moving branch.

This runbook implements the foundational policy in
[`docs/technical/release-runbooks.md`](../technical/release-runbooks.md) and
the shared mechanics in [`rollout-procedure.md`](./rollout-procedure.md).
v0.4.1 is **not** code-only: it carries four additive migrations
(`0045`-`0048`) and switches production's closed-day price reads onto a new
table (D41). Do not run this as a no-op cutover.

## 1. Release identity and objective

The objective is to deploy the v0.4.1 boot/release-tooling corrections and the
D41 price-series split while preserving the v0.4.0 application, schema, and
judge/receipt invariants:

- retain all six v0.4.0 migrations and the v0.4.0 judge/receipt invariants;
- apply the four additive v0.4.1 migrations and land the new tables they create;
- switch closed-day allocation/performance price reads to the `asset_prices`
  join (D41 MIGRATE step) while today's live point keeps its existing fused
  read;
- backfill `swarm_sessions.subject_name` for every session whose subject was
  renamed after the session was recorded;
- ship third-party judging as a global, admin-flippable, **off-by-default**
  gate (`swarm_judge_config.third_party_enabled`);
- make stale copied `@robotmoney/contract` dependencies fail clearly before
  prerendering can publish an incomplete frontend;
- provide the unambiguous `smoke:archive` production-shaped smoke command;
- correct the operator-facing migration count and release procedure text.

The release-specific tools are in `backend/scripts/upgrades/0.4.0-to-0.4.1/`.
Unlike the original v0.4.1 candidate, migrations now run the normal way: at
backend boot, via `backend/src/db/migrate.ts`. There is no separate manual
migration-runner invocation.

## 2. Code delta: systems upgraded and risks

The release contains the following changes relative to `v0.4.0`:

| Code or document | System affected | What changes in production | Primary risk | Mitigation |
| --- | --- | --- | --- | --- |
| `backend/migrations/0045_chain_address_floors.sql`, `backend/src/chain/address-floor-resolver.ts` | Wallet backfill | New `chain_address_floors` cache table holding each tracked address's on-chain deployment block; backfill consults it before issuing a block-addressed read | A wrong or missing floor either wastes RPC calls or wrongly skips a genuinely-covered day | Postflight confirms the table exists; floors are resolved lazily and self-heal, they are never destructively overwritten |
| `backend/migrations/0046_asset_prices.sql`, `backend/src/ops/asset-prices.ts`, `backend/src/chain/asset-price-floor.ts`, `backend/src/chain/wallet-*.ts` | Price/holdings read path (D41) | New `asset_prices`/`asset_price_floors` tables; migration seeds `asset_prices` from existing `live`/`seed` rows in `wallet_balance_samples`/`wallet_sleeve_samples`; reads for a **closed** day now join amount against this table instead of the old fused `price_usd` column — today's live point is unaffected | A bad seed or join produces a wrong historical valuation on `/allocation`/`/performance`; an empty seed manufactures gaps | Postflight asserts `asset_prices` is non-empty after migration; rehearsal spot-checks a known closed-day total against the pre-migration fused value before and after |
| `backend/migrations/0047_swarm_session_subject_name_backfill.sql` | Swarm session history | One-time, idempotent `UPDATE` re-syncing `swarm_sessions.subject_name` to each subject's current `name` | None if idempotent as written; a mid-migration subject rename could theoretically race it | Postflight confirms zero sessions remain drifted from their subject's current name |
| `backend/migrations/0048_swarm_judge_third_party_flag.sql`, `backend/src/swarm/admin.ts`, `backend/src/swarm/judge-session.ts` | Swarm judging | Adds `swarm_judge_config.third_party_enabled boolean NOT NULL DEFAULT false`; a `judgeMemberId` judgement is refused fail-closed until an admin flips it | None if left at its shipped default; flipping it live is a separate, deliberate operator action, not part of this cutover | Postflight asserts the flag is `false` on the row with `id=1`; do not enable it during this rollout |
| `scripts/lib/contract-freshness.ts`, `scripts/prerender.ts` | Static frontend assembly and boot/build tooling | Prerender now compares `contract/src/routes.js` with the copied package under `node_modules/@robotmoney/contract` and fails with a repair instruction when stale or missing | A deployment with stale dependencies stops during assembly; without this guard it could fail opaquely or publish incomplete route output | Run `bun install --force` at repo root and backend after every checkout change; require static assembly to pass in rehearsal and production |
| `package.json` (`smoke:archive`) | Operator smoke/rehearsal tooling | The old production-shaped smoke invocation has an explicit name and uses `--smoke --static-port --db external` | An operator may invoke bare `bun run smoke`, which is the simulation boot and is unsafe for populated data | Use `bun run smoke:archive`; audit deployment scripts for removed `demo:*` names |
| `backend/scripts/db-preflight.ts` | Database safety diagnostics | Refusal text points to `smoke:archive` | Documentation/tooling can direct an operator to the wrong boot mode | Verify the command exists and run the named command during rehearsal |
| `backend/scripts/upgrades/0.3.0-to-0.4.0/{release,postflight}.ts` | Release verification tooling | The v0.4.0 migration manifest and report now correctly include migration `0044_wallet_backfill_leg_terminal.sql` | A stale count could make an otherwise successful 0.4.0 database appear incomplete, or hide a missing migration | The 0.4.1 preflight checks all six filenames and treats only 0045-0048 as expected-pending |
| `docs/runbooks/**`, tests | Operator procedure and CI evidence | The documented command paths and migration set match the code | Procedure drift can cause a bad rollout despite healthy application code | Rehearse from this document and keep receipts beside the backup |
| `scripts/smoke-frontend-check.ts` | Operator rehearsal/CI tooling | `wallet-balances` live-provenance check's `allowedDegrades` now includes `'backfilled'` alongside `'stale'`/`'seed'` | Found by rc.1's own P5 rehearsal: a same-day rehearsal restores `job_schedules` with a `next_run_at` already due by boot time, so the first cron tick is a same-bucket catch-up (`worker/handlers/slot.ts`) and every leg is relabelled `'backfilled'` (`worker/handlers/wallet.ts:63`) even though the read is genuinely live (`wallet-valuation.ts:57`) — this failed every same-day rehearsal regardless of release, not a v0.4.1 regression | Confirmed production's replica data is 100% `'live'` for the two most recent sample days before this fix; unit test added for the `'backfilled'` case |
| `frontend/public/assets/js/app/alpine/views/allocation.js`, `frontend/public/views/allocation.html`, `frontend/public/assets/js/app/lib/allocation-subject.js` | `/allocation` frontend | `/vault` is retired and its route repointed to the rebuilt `/allocation` policy page (RM-115); the hero switches from a fan chart to a donut | A route rename that silently breaks bookmarked links or e2e coverage of the old `/vault` view | `scripts/tests/unit/e2e-route-rename-guard.test.ts` and `frontend/test/browser/allocation-view.spec.ts` are part of CI on this branch |

Systems that are **not** upgraded by this release:

- no existing table, column, index, trigger, or grant is altered (0045-0048
  are additive only — new tables and one new nullable-default column);
- no v0.4.0 judge/receipt table, trigger, or grant changes;
- **today's live price point is unaffected** — only closed-day reads move to
  the new join.

The application/API, worker images, static frontend assembly, and operator smoke
tooling are still treated as one release surface because `scripts/**`,
`package.json`, and the frontend build are part of the deployed checkout.

## 3. Preconditions and release candidate

Do not begin until the release tracking issue and its linked work are complete,
CI is green, and the operator has authorized this production rollout.

```bash
git fetch origin --tags
git switch releases-0.4.x
git rev-parse HEAD
git tag --points-at HEAD -l 'v0.4.1-rc.*'
bun install --force
bun install --force --cwd backend
```

Record the printed SHA as `RC_SHA`. The tag must be on
`releases-0.4.x`, never on `main`.

The forced installs are a blocking prerequisite. Bun copies the local
`@robotmoney/contract` file dependency; it does not reliably provide a live
symlink. A checkout that moved past a contract change can therefore run old
route definitions without an import error.

## 4. Baseline, backup, and live preflight

Export a unique backup directory and follow `rollout-procedure.md` for the
replica identity assertion, encrypted capture, and restore proof:

```bash
export RM_BACKUP_DIR=/path/outside/checkout/rm-backup-v041-$(date -u +%Y%m%dT%H%M%SZ)
bun run smoke:capture
bun backend/scripts/upgrades/0.4.0-to-0.4.1/restore-check.ts "$RM_BACKUP_DIR" --emit-receipt
```

Before deployment, record a read-only baseline beside the dump. At minimum,
capture the full `schema_migrations` set, counts for `swarm_sessions`,
`swarm_session_judgements`, `swarm_consensus_receipts`, and (pre-migration)
`wallet_balance_samples`/`wallet_sleeve_samples` `live`/`seed` rows, the
current judge configuration, and a handful of known closed-day allocation
totals from `/allocation`. The baseline is what the D41 read-path switch and
the `asset_prices` seed get compared against after cutover; it is not
reconstructed after the fact.

Run the live check against `.env.readonly` and confirm its redacted target is
the production replica:

```bash
bun backend/scripts/upgrades/0.4.0-to-0.4.1/preflight.ts --emit-receipt
```

The preflight is blocking if any of these occur:

- one of the six v0.4.0 migration filenames is absent;
- an unexpected migration is pending — i.e. anything pending other than the
  four v0.4.1 filenames (`0045`-`0048`);
- one of `0045`-`0048` is already recorded (the target is not a clean
  pre-migration v0.4.0 database);
- one of `chain_address_floors`, `asset_prices`, `asset_price_floors` already
  exists;
- the database contains a migration absent from the checkout;
- a required v0.4.0 judge/receipt table is absent;
- the target is not proven read-only.

`0045`-`0048` pending is the expected, safe state to deploy from. Any other
migration drift has no safe interpretation here: stop and resolve the target
or branch mismatch instead of allowing the application boot to perform an
unplanned schema change.

## 5. Digital smoke-twin rehearsal

Use the same RC, forced installs, backup, and deployment environment intended
for production. The release-specific rehearsal restores the backup into a
local smoke-twin, boots the real stack (which applies `0045`-`0048` via
`migrate.ts` on the way up), runs the frontend checks, and runs the 0.4.1
postflight before teardown:

```bash
bun install --force
bun install --force --cwd backend
bun backend/scripts/upgrades/0.4.0-to-0.4.1/stage-rehearsal.ts "$RM_BACKUP_DIR" --emit-receipt
```

The rehearsal is a pass only when all of the following are true:

1. The restored database passes the v0.4.0-baseline and clean-target checks.
2. The stack reaches `/health` and the standard smoke frontend checks pass.
3. Static assembly reaches prerender with a fresh contract dependency.
4. The archive-shaped command is present and correctly named:
   `bun run smoke:archive`.
5. All ten migration filenames (`0039`-`0048`) are recorded and the v0.4.0
   runtime tables remain intact after boot.
6. `chain_address_floors`, `asset_prices`, and `asset_price_floors` exist,
   and `asset_prices` is non-empty.
7. Zero `swarm_sessions` rows still show a `subject_name` that disagrees with
   their subject's current name.
8. `swarm_judge_config.third_party_enabled` is `false`.
9. A closed-day allocation total pulled from the rehearsed stack matches the
   pre-migration baseline value for the same day within rounding — this is
   the one check that catches a bad `asset_prices` seed or a broken join,
   neither of which any FAIL/PASS check above can see on its own.

Rehearse rollback by checking out `v0.4.0`, running both forced installs, and
booting it against a **fresh** restored copy (the pre-migration dump, not the
smoke-twin post-migration). This release is a real forward-only migration —
`migrate.ts` has no down path — so the database-restore path is the rollback,
not an optional extra; rehearse it and record the restore duration.

Write the stage report with the backup manifest, receipts, RC SHA, boot output,
route-check output, baseline comparison, and operator go/no-go sign-off.

## 6. Production cutover

**IRREVERSIBLE FORWARD MIGRATION:** `migrate.ts` has no down path. Do not
start without a verified backup, completed rehearsal, and written rollback
authority. Do not manually edit `schema_migrations` at any point.

1. Reconfirm `RC_SHA`, the tag, production database identity, and the fresh
   backup.
2. Reconfirm the live preflight receipt is current and passed.
3. Deploy in provider order: the v0.4.1 backend/API first (its boot applies
   `0045`-`0048` via `migrate.ts` before it starts serving), then every worker
   lane, then static frontend last. Do not publish the new SPA before its API.
4. Run `bun install --force` at the repository root and
   `bun install --force --cwd backend` in the deployment checkout.
5. Start the backend and workers; wait for `/health` and the normal readiness
   gates.
6. Confirm the migration log names `0045`-`0048` exactly once each, and that
   `0039`-`0044` are unchanged — per the additive-only contract.
7. Run static assembly/prerender and publish the frontend only after the API
   is healthy.
8. Do **not** flip `swarm_judge_config.third_party_enabled` during cutover;
   verify it stayed `false` after the API is serving.

## 7. Production postflight

Load and assert the writer `DATABASE_URL` as described in
`rollout-procedure.md`, then run:

```bash
bun backend/scripts/upgrades/0.4.0-to-0.4.1/postflight.ts --emit-receipt=P8.postflight-prod
```

The script performs SELECT-only checks: all ten migrations recorded, v0.4.0
runtime tables intact, the three new tables present and `asset_prices`
non-empty, zero drifted `subject_name` rows, `third_party_enabled = false`,
and contract freshness in the deployed checkout. Also verify manually from
the deployed origin:

- `/health` is healthy and identifies the production environment;
- `/allocation`, `/performance`, and representative swarm pages render;
- the closed-day allocation totals captured in the baseline still match after
  the read path switched to the `asset_prices` join;
- static assembly completed without a contract-freshness error;
- `smoke:archive` is the documented production-shaped smoke command;
- no production automation still invokes `demo:*` or assumes bare `smoke` is
  the archive boot;
- judge mode/config (including `third_party_enabled`), schedules, migration
  records, and key row counts match baseline.

Any failure is a stop condition. Preserve logs, receipts, and the baseline.

## 8. Rollback and completion

For a contract-freshness or static-assembly failure caught before the API
started serving migrated data, stop publishing and roll back the application
checkout to `v0.4.0`, then run both forced installs before restarting — the
migration already applied is additive and does not block a v0.4.0 boot. For
an unexpected database or runtime invariant failure (a wrong `asset_prices`
seed, a bad join, a drifted `subject_name`, or anything else postflight
catches), the default remediation is the rehearsed encrypted backup restore,
since `migrate.ts` has no down path; an alternate remediation requires the
operator to record it along with the required second sign-off.

For judge-only degradation (an unexpectedly enabled `third_party_enabled`),
set it back to `false` first — that is the narrow reversible mitigation; a
full restore is for a failed release invariant.

If the candidate needs a fix, cut the next `v0.4.1-rc.*`, repeat the preflight
and rehearsal gates, and deploy only that new RC. Do not move the final tag
onto an unverified commit.

After clean production postflight, create `v0.4.1` on the exact commit running
in production—the final tag and the successful RC must point to the same
commit—then file the production rollout report and close the release issue.
