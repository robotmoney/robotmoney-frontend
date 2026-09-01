# v0.4.0 production rollout

> Operator procedure for upgrading production from **v0.3.0** to **v0.4.0**.
> It was prepared against `main` at **`a7a7bd90`** on 2026-09-01. Re-resolve the
> target SHA and command output when an RC is cut; this document is not
> authority for a moving branch.

This runbook implements the shared policy in
[release-runbooks.md](../technical/release-runbooks.md) and uses the shared
backup, smoke-twin, credential, and deployment procedures in
[rollout-procedure.md](./rollout-procedure.md) and
[deployment.md](./deployment.md). Those documents own the mechanics; this one
identifies what is special about this release.

## 0. Release prerequisites

Do not start preflight until all of these are true:

1. A `release:v0.4.0` tracking issue exists, its scope is frozen, and its
   Phases tasklist is complete.
2. `releases-0.4.x` has been cut from the agreed main SHA and the release
   candidate is tagged there, not on `main`.
3. Required checks for that candidate pass.

## 1. Release identity

```bash
git fetch origin --tags
git switch releases-0.4.x
git rev-parse HEAD
git merge-base --is-ancestor v0.3.0 HEAD
git rev-list --count v0.3.0..HEAD
git log --oneline v0.3.0..HEAD
git diff --check v0.3.0..HEAD
```

Record the first SHA as `RC_SHA`. Pick the next unused candidate number, then
tag that exact SHA. Never deploy a branch tip that moves after the tag.

```bash
git tag -l 'v0.4.0-rc.*'
git tag -a v0.4.0-rc.<N> "$RC_SHA" -m 'v0.4.0 release candidate <N>'
git push origin v0.4.0-rc.<N>
```

`v0.4.0` is created only after production postflight passes, at the same commit
as the deployed final RC.

## 2. What changes

| Area | Release effect | Operator decision |
| --- | --- | --- |
| Swarm consensus judge | Adds optional `judged` state, a mutable DB-backed judge switch, append-only judgement history, and immutable consensus receipts. | Leave judge **off** at cutover; run a bounded shadow soak before considering `enforce`. |
| Swarm scheduling | The production host driver gains the judge step. `SWARM_SCHEDULES_ENABLED=0` is required for a static-port production boot, so the host driver—not backend crons—orders judge between aggregate and publish. | Export `SWARM_SCHEDULES_ENABLED=0` explicitly in production configuration. |
| Public UI and tooling | `/vault` replaces the depositor-facing allocation page; `/allocation` and `/allocation2` resolve to it. “demo” commands, compose file, state file, and `RM_ENV` are renamed “smoke.” | Update automation and operator aliases before deployment; do not keep invoking removed `demo:*` commands. |

The judge is explanatory only: allocation weights remain derived from the frozen
take set. A default database starts with `swarm_judge_config.mode = 'off'` and
`model = NULL`; this reproduces v0.3.0 behaviour. Turning it on without a model
records fallback/template prose, not a model opinion.

`GECKO_MIN_INTERVAL_MS` supersedes `GECKO_OHLCV_MIN_INTERVAL_MS`. Preserve an
existing value by moving it to the new name; the old name remains a fallback,
but is not the long-term configuration interface.

## 3. Database preflight and baseline

The forward-only runner keys migrations by **filename**, not checksum. The only
edit to pre-existing `0033_wallet_backfill.sql` changes comments and does not
rerun on production. Verify that fact from the pinned RC; do not delete or edit
`schema_migrations` to force a rerun.

```bash
git diff --word-diff=plain v0.3.0 "$RC_SHA" -- backend/migrations/0033_wallet_backfill.sql
git diff --name-status v0.3.0 "$RC_SHA" -- backend/migrations/
```

The expected new files are exactly:

```text
0039_swarm_judge.sql
0040_swarm_judgements_append_only.sql
0041_swarm_judgement_soak_record.sql
0042_swarm_consensus_receipts.sql
```

Before any write, use the read-only replica procedure from rollout-procedure
§§3–5 and save this baseline beside the encrypted dump and manifest:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -c "
SELECT name, applied_at FROM schema_migrations
 WHERE name LIKE ANY (ARRAY['0039_%','0040_%','0041_%','0042_%']) ORDER BY name;
SELECT state, count(*) FROM swarm_sessions GROUP BY state ORDER BY state;
"
```

On a direct v0.3.0 upgrade the migration query returns no rows and `judged`
cannot appear. Any pre-existing judge state means this is not a clean v0.3.0
starting point: stop and record why before proceeding.

## 4. Configuration and deployment preparation

Update the deployment configuration before the backend rollout:

```dotenv
# Required for the static-port production driver in this release.
SWARM_SCHEDULES_ENABLED=0

# Optional: rename a retained Gecko interval override.
# GECKO_MIN_INTERVAL_MS=<previous GECKO_OHLCV_MIN_INTERVAL_MS value>

# Optional only if a later model-backed shadow soak is planned.
# SWARM_JUDGE_BASE_URL=https://opencode.ai/zen/v1
# SWARM_JUDGE_TIMEOUT_MS=60000
```

Do not add `SWARM_JUDGE_MODEL`: model selection is stored in the judge-config
row and changed through the privileged API. Confirm `OPENCODE_API_KEY` is
available only if a model-backed soak is planned.

| Before v0.4.0 | v0.4.0 |
| --- | --- |
| `bun run demo` | `bun run smoke` |
| `demo:stage`, `demo:down`, `demo:status`, `demo:clean`, `demo:reap` | corresponding `smoke:*` command |
| `docker-compose.demo.yml` | `docker-compose.smoke.yml` |
| `.agents/demo-state.json` | `.agents/smoke-state.json` |
| `RM_ENV=demo` | `RM_ENV=smoke` |

Check CI/deployment scripts, service units, and operator documentation for old
names. A stale command is a release blocker because the old package scripts no
longer exist.

## 5. Stage rehearsal

Run on the dedicated staging host, with the same RC that will be deployed. Use
the shared data-path names rather than constructing a database URL manually.

```bash
bun run smoke:capture
bun scripts/upgrades/0.3.0-to-0.4.0/restore-check.ts "$RM_BACKUP_DIR" --emit-receipt
bun scripts/upgrades/0.3.0-to-0.4.0/stage-rehearsal.ts "$RM_BACKUP_DIR" --emit-receipt
```

The restore check validates the v0.3.0 starting state. The rehearsal applies
the four migrations to the restored smoke-twin, boots real services, and
executes the release postflight before teardown. It proves:

1. All four full migration filenames appear once in `schema_migrations`.
2. `swarm_sessions_state_check` admits `judged`; `swarm_judge_config` contains
   exactly `id=1, mode='off'`; and the new history tables are empty initially.
3. Statement- and row-level append-only triggers are `ENABLE ALWAYS` on both
   history tables; the receipt table also has its two UPDATE-refusing triggers.
   `rm_worker` lacks INSERT, UPDATE, and DELETE on the protected/config tables.
4. `/vault`, `/allocation`, and `/allocation2` render the vault factsheet;
   `/performance` remains its own route. Exercise changed swarm admin routes
   only with an authenticated token.
5. `bun run --cwd backend swarm-judge:replay -- --limit 10` exits zero. A
   historical tie-break report is informational; a vector mismatch or replay
   write is a failure.

Rehearse rollback: restore the pre-upgrade dump into a fresh local smoke-twin
and prove v0.3.0 services boot against the v0.4.0 schema. Record duration,
migration output, and every non-empty judge/receipt observation in the report.

## 6. Production cutover

**IRREVERSIBLE FORWARD MIGRATION:** `migrate.ts` has no down path. Do not start
without a verified backup, completed rehearsal, and written rollback authority.

1. Reconfirm RC SHA, deployment configuration, and production DB identity.
2. Re-run release preflight against the live replica and compare its baseline:

```bash
bun scripts/upgrades/0.3.0-to-0.4.0/preflight.ts --emit-receipt
```

3. Deploy in provider order: database migration, API and every worker lane,
   then static frontend. Do not publish the new SPA before its API.
4. Confirm the migration log names all four new files exactly once.
5. Do **not** enable the judge during cutover. Verify its config after the API
   is serving:

```bash
curl --fail-with-body -H "X-Admin-Token: $ADMIN_TOKEN" \
  "$RM_PUBLIC_BASE_URL/api/swarm/admin/judge"
```

Expected initial state is `mode: "off"`, a positive `minTakes`, and `model:
null`. If it is anything else, set it to off and investigate the prior state;
do not assume a pre-existing value is safe.

## 7. Postflight and controlled enablement

Run these SELECT-only checks after deployment:

```bash
bun scripts/upgrades/0.3.0-to-0.4.0/postflight.ts --emit-receipt=P8.postflight-prod
bun run --cwd backend swarm-judge:replay -- --limit 10
```

Verify `/vault`, `/allocation`, `/allocation2`, `/performance`, swarm archive
and session pages, and the authenticated judge endpoint from the deployed
origin. Confirm production automation invokes no `demo:*` script.

Judge activation is separate and reversible:

1. Set a reviewed model and `mode: "shadow"` through `POST /api/swarm/admin/judge`.
2. Observe completed sessions through authenticated `GET
   /api/swarm/admin/sessions/<id>/judgements`: source/fallback reason, thin
   support, drop counts, and absence of unexpected application.
3. Re-run replay; every sampled vector must remain reproducible.
4. Only with recorded operator approval may mode move to `enforce`. Verify a
   judged session applies prose but never changes take-derived weights.
5. If behaviour degrades, POST `{"mode":"off"}` immediately. This stops new
   judging without redeploy; append-only history is retained.

Consensus receipts are not mass-published at release time. Before publishing
one for a terminal session, verify its judgement and canonical bytes. A receipt
is immutable: a correction requires a new session, never UPDATE or DELETE.

## 8. Failure, rollback, and close

For a failed migration, boot, invariant, replay, or route check, stop and
preserve logs, receipts, and baseline. Default response is the rehearsed restore
of the encrypted pre-upgrade dump. Do not delete history rows to “clean up” a
failed attempt.

For judge-only degradation, set the DB-backed mode to `off` first. That is the
narrow reversible mitigation; full restore is for a failed release invariant.

After clean production postflight, tag the deployed commit and file the report:

```bash
git tag -a v0.4.0 "$RC_SHA" -m 'v0.4.0'
git push origin v0.4.0
```

Include RC/tag, SHA, backup manifest, rehearsal and production receipts,
migration timing, judge mode, route checks, shadow-soak decision, and operator
sign-off.
