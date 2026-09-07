# v0.4.1 production rollout

> Operator procedure for upgrading production from **v0.4.0** to **v0.4.1**.
> The candidate currently under test is **`v0.4.1-rc.1`** at commit
> `cfbe9789c7eee3adc2a93af2e4a315dbdcc82031` on `releases-0.4.x`.
> Re-resolve the tag and SHA when a later RC is cut; this document is not
> authority for a moving branch.

This runbook implements the foundational policy in
[`docs/technical/release-runbooks.md`](../technical/release-runbooks.md) and
the shared mechanics in [`rollout-procedure.md`](./rollout-procedure.md).
It is deliberately a code-only upgrade: v0.4.1 adds no migration and must not
change production database state.

## 1. Release identity and objective

The objective is to deploy the v0.4.1 boot and release-tooling corrections while
preserving the successfully deployed v0.4.0 application and schema:

- retain all six v0.4.0 migrations and the v0.4.0 judge/receipt invariants;
- make stale copied `@robotmoney/contract` dependencies fail clearly before
  prerendering can publish an incomplete frontend;
- provide the unambiguous `smoke:archive` production-shaped smoke command;
- correct the operator-facing migration count and release procedure text.

The release-specific tools are in
`backend/scripts/upgrades/0.4.0-to-0.4.1/`. There is intentionally no
`migrate.ts` invocation in this runbook.

## 2. Code delta: systems upgraded and risks

The release contains the following changes relative to `v0.4.0`:

| Code or document | System affected | What changes in production | Primary risk | Mitigation |
| --- | --- | --- | --- | --- |
| `scripts/lib/contract-freshness.ts`, `scripts/prerender.ts` | Static frontend assembly and boot/build tooling | Prerender now compares `contract/src/routes.js` with the copied package under `node_modules/@robotmoney/contract` and fails with a repair instruction when stale or missing | A deployment with stale dependencies stops during assembly; without this guard it could fail opaquely or publish incomplete route output | Run `bun install --force` at repo root and backend after every checkout change; require static assembly to pass in rehearsal and production |
| `package.json` (`smoke:archive`) | Operator smoke/rehearsal tooling | The old production-shaped smoke invocation has an explicit name and uses `--smoke --static-port --db external` | An operator may invoke bare `bun run smoke`, which is the simulation boot and is unsafe for populated data | Use `bun run smoke:archive`; audit deployment scripts for removed `demo:*` names |
| `backend/scripts/db-preflight.ts` | Database safety diagnostics | Refusal text points to `smoke:archive` | Documentation/tooling can direct an operator to the wrong boot mode | Verify the command exists and run the named command during rehearsal |
| `backend/scripts/upgrades/0.3.0-to-0.4.0/{release,postflight}.ts` | Release verification tooling | The v0.4.0 migration manifest and report now correctly include migration `0044_wallet_backfill_leg_terminal.sql` | A stale count could make an otherwise successful 0.4.0 database appear incomplete, or hide a missing migration | The 0.4.1 preflight checks all six filenames and no pending migration |
| `docs/runbooks/**`, tests | Operator procedure and CI evidence | The documented command paths and migration count match the code | Procedure drift can cause a bad rollout despite healthy application code | Rehearse from this document and keep receipts beside the backup |

Systems that are **not** upgraded by this release:

- no database tables, columns, indexes, triggers, grants, or data are changed;
- no new API endpoint or API response contract is introduced;
- no swarm judge behavior, schedule, or feature-mode change is intended;
- no migration or seed step is run during cutover.

The application/API, worker images, static frontend assembly, and operator smoke
tooling are still treated as one release surface because `scripts/**`,
`package.json`, and the frontend build are part of the deployed checkout.

## 3. Preconditions and release candidate

Do not begin until the release tracking issue and its linked work are complete,
CI is green, and the operator has authorized a code-only production rollout.

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
`swarm_session_judgements`, and `swarm_consensus_receipts`, and the current
judge configuration. The baseline proves this patch release did not alter
data; it is not reconstructed after cutover.

Run the live check against `.env.readonly` and confirm its redacted target is
the production replica:

```bash
bun backend/scripts/upgrades/0.4.0-to-0.4.1/preflight.ts --emit-receipt
```

The preflight is blocking if any of these occur:

- one of the six v0.4.0 migration filenames is absent;
- any migration is pending in the candidate checkout;
- the database contains a migration absent from the checkout;
- a required v0.4.0 judge/receipt table is absent;
- the target is not proven read-only.

There is no safe interpretation of a pending migration here. Stop and resolve
the target or branch mismatch instead of allowing the application boot to
perform an unplanned schema change.

## 5. Digital smoke-twin rehearsal

Use the same RC, forced installs, backup, and deployment environment intended
for production. The release-specific rehearsal restores the backup into a
local smoke-twin, boots the real stack, runs the frontend checks, and runs the
0.4.1 postflight before teardown:

```bash
bun install --force
bun install --force --cwd backend
bun backend/scripts/upgrades/0.4.0-to-0.4.1/stage-rehearsal.ts "$RM_BACKUP_DIR" --emit-receipt
```

The rehearsal is a pass only when all of the following are true:

1. The restored database passes the v0.4.0 schema and no-pending-migration
   checks.
2. The stack reaches `/health` and the standard smoke frontend checks pass.
3. Static assembly reaches prerender with a fresh contract dependency.
4. The archive-shaped command is present and correctly named:
   `bun run smoke:archive`.
5. The six migration filenames and v0.4.0 runtime tables remain intact after
   boot.
6. No new migration, seed, judge-mode change, or unexpected data mutation is
   observed.

Rehearse rollback by checking out `v0.4.0`, running both forced installs, and
booting it against a fresh restored copy. Because this release is code-only,
the normal rollback is a code rollback; nevertheless, the release policy's
database-restore path must also be rehearsed and its use or documented waiver
recorded in the report.

Write the stage report with the backup manifest, receipts, RC SHA, boot output,
route-check output, baseline comparison, and operator go/no-go sign-off.

## 6. Production cutover

The database migration step is explicitly **NO-OP** for v0.4.1. Do not run the
0.3.0→0.4.0 migration runner and do not edit `schema_migrations`.

1. Reconfirm `RC_SHA`, the tag, production database identity, and the fresh
   backup.
2. Reconfirm the live preflight receipt is current and passed.
3. Deploy the v0.4.1 backend/API and all worker lanes from the tagged checkout.
4. Run `bun install --force` at the repository root and
   `bun install --force --cwd backend` in the deployment checkout.
5. Start the backend and workers; wait for `/health` and the normal readiness
   gates.
6. Run static assembly/prerender and publish the frontend only after the API
   is healthy.
7. Verify that no migration ran and that the six v0.4.0 migration records are
   unchanged.

The provider-before-consumer order still applies even though the provider
change is a no-op: production database identity/check first, backend/workers
next, frontend/static publish last.

## 7. Production postflight

Load and assert the writer `DATABASE_URL` as described in
`rollout-procedure.md`, then run:

```bash
bun backend/scripts/upgrades/0.4.0-to-0.4.1/postflight.ts --emit-receipt=P8.postflight-prod
```

The script performs SELECT-only checks for the unchanged v0.4.0 schema and
checks contract freshness in the deployed checkout. Also verify manually from
the deployed origin:

- `/health` is healthy and identifies the production environment;
- `/allocation`, `/performance`, and representative swarm pages render;
- static assembly completed without a contract-freshness error;
- `smoke:archive` is the documented production-shaped smoke command;
- no production automation still invokes `demo:*` or assumes bare `smoke` is
  the archive boot;
- judge mode, schedules, migration records, and key row counts match baseline.

Any failure is a stop condition. Preserve logs, receipts, and the baseline.

## 8. Rollback and completion

For a contract-freshness or static-assembly failure, stop publishing and roll
back the application checkout to `v0.4.0`, then run both forced installs before
restarting. For an unexpected database or runtime invariant failure, use the
rehearsed encrypted backup restore unless the operator records an alternate
remediation and the required second sign-off.

If the candidate needs a fix, cut `v0.4.1-rc.2` (or the next RC), repeat the
preflight and rehearsal gates, and deploy only that new RC. Do not move the
final tag onto an unverified commit.

After clean production postflight, create `v0.4.1` on the exact commit running
in production—the final tag and the successful RC must point to the same
commit—then file the production rollout report and close the release issue.
