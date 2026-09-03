# v0.4.0 production rollout

> Operator procedure for upgrading production from **v0.3.0** to **v0.4.0**.
> Executed against the **`v0.4.0-rc.1`** candidate on the `releases-0.4.x`
> branch (the SHA and command output were re-resolved at that RC's cut per
> §3); this document is not authority for a moving branch.

**Scope:** This runbook contains release-*specific* steps for the v0.4.0 upgrade.
The foundational release-runbook policy is in [`release-runbooks.md`](../../technical/release-runbooks.md). This document references that policy for generic gates (§4.1–4.9) and only describes what is special about v0.3.0→v0.4.0.

> **Frontend scope corrected 2026-09-02.** An earlier draft of this document
> described `/vault` as replacing the depositor-facing allocation page. That was
> reverted on `main` in #834, which returned `/allocation` and `/performance` to
> the nav and pinned `/vault` to not-found, and #840 then rewrote the copy on
> both pages. `frontend/public/assets/js/app/routes.js` on `main` is the
> authority: `/allocation` and `/performance` have their own views, `/allocation2`
> maps to the performance view, and `/vault` maps to the not-found view. Re-check
> that file when the RC is cut rather than trusting this paragraph.

The runbook is organized as:
- **Generic policy references** — map to `release-runbooks.md` §4 gates; these steps must not be altered without updating the policy first.
- **0.4.0-specific instructions** — the migration, config, and smoke-details unique to this release.

## 0. Release prerequisites

Maps to `release-runbooks.md` §4.1 (code-readiness gate). Do not start preflight until all of these are true:

1. A `release:v0.4.0` tracking issue exists, its scope is frozen, and its
   Phases tasklist is complete — §4.1 requirement.
2. `releases-0.4.x` has been cut from the agreed main SHA and the release
   candidate is tagged there, not on `main` — §2 branch rule.
3. Required checks for that candidate pass — CI gating per policy.

## 1. Release identity

Maps to `release-runbooks.md` §3 (version tags and release candidates). The RC
cycle and branch placement follow the policy:

- Cut RC tags on `releases-0.4.x`, never on `main` — §2.
- `v0.4.0` tag lands on the release branch after postflight passes, at the same
  commit as production — §3, consequence 1.
- RC numbering: `v0.4.0-rc.N` with N counting from 0 — §3.

```bash
git fetch origin --tags
git switch releases-0.4.x
git rev-parse HEAD
```

Record the first SHA as `RC_SHA`. Tag and push per the RC cycle.

## 2. What changes

| Area | Release effect | Operator decision |
| --- | --- | --- |
| Swarm consensus judge | Adds optional `judged` state, a mutable DB-backed judge switch, append-only judgement history, immutable consensus receipts, and the judge role graduation (`0043`) that lets an existing swarm member author judgements. | Leave judge **off** at cutover; run a bounded shadow soak before considering `enforce`. |
| Swarm scheduling | The production host driver gains the judge step. `SWARM_SCHEDULES_ENABLED=0` is required for a static-port production boot, so the host driver—not backend crons—orders judge between aggregate and publish. | Export `SWARM_SCHEDULES_ENABLED=0` explicitly in production configuration. |
| Public UI and tooling | `/allocation` and `/performance` are the depositor-facing pages and both are in the nav. `/vault` resolves to not-found by an explicit route entry, and `/allocation2` is a legacy redirect to `/performance`. “demo” commands, compose file, state file, and `RM_ENV` are renamed “smoke.” | Update automation and operator aliases before deployment; do not keep invoking removed `demo:*` commands. Do not smoke-test `/vault` as a live page. |

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

Maps to `release-runbooks.md` §4.2 (pre-upgrade baseline) and §4.3 (backup/restore
smoke test). Expected new files (additive migrations per R1):

```text
0039_swarm_judge.sql
0040_swarm_judgements_append_only.sql
0041_swarm_judgement_soak_record.sql
0042_swarm_consensus_receipts.sql
0043_swarm_member_judges.sql
```

Before any write, use the read-only replica procedure from `rollout-procedure.md`
§§3–5 and save this baseline beside the encrypted dump and manifest — §4.2 requirement.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -c "
SELECT name, applied_at FROM schema_migrations
 WHERE name LIKE ANY (ARRAY['0039_%','0040_%','0041_%','0042_%','0043_%']) ORDER BY name;
SELECT state, count(*) FROM swarm_sessions GROUP BY state ORDER BY state;
```

On a direct v0.3.0 upgrade the migration query returns no rows and `judged`
cannot appear. Any pre-existing judge state means this is not a clean v0.3.0
starting point: stop and record why before proceeding.

## 4. Configuration and deployment preparation

Maps to `release-runbooks.md` §4.4 (foundational release workflow — config prep) and
§8 compatibility contract (R1 additive migrations, R4 deploy order).

Update the deployment configuration before the backend rollout:

```dotenv
# Required for the static-port production driver in this release.
SWARM_SCHEDULES_ENABLED=0

# Optional: rename a retained Gecko interval override.
# GECKO_MIN_INTERVAL_MS=<previous GECKO_OHLCV_MIN_INTERVAL_MS value>

# Optional only if a later model-backed shadow soak is planned.
# SWARM_JUDGE_BASE_URL=https://opencode.ai/zen/v1
# SWARM_JUDGE_TIMEOUT_MS=60000

# Per R1 (additive only): do not add SWARM_JUDGE_MODEL — model selection is
# stored in the judge-config row and changed through the privileged API.
# Confirm OPENCODE_API_KEY is available only if a model-backed soak is planned.
```

| Before v0.4.0 | v0.4.0 |
| --- | --- |
| `bun run demo` | `bun run smoke` |
| `demo:stage`, `demo:down`, `demo:status`, `demo:clean`, `demo:reap` | corresponding `smoke:*` command |
| `docker-compose.demo.yml` | `docker-compose.smoke.yml` |
| `.agents/demo-state.json` | `.agents/smoke-state.json` |
| `RM_ENV=demo` | `RM_ENV=smoke` |

Check CI/deployment scripts, service units, and operator documentation for old
names. A stale command is a release blocker because the old package scripts no
longer exist. Per R3 (API responses only gain fields), consumers must not send
new request fields until the API is deployed.

## 5. Stage rehearsal

Maps to `release-runbooks.md` §4.3 (backup/restore smoke test) and §4.4
(digital-smoke-twin rehearsal). Run on the dedicated staging host, with the same
RC that will be deployed. Use the shared data-path names rather than constructing
a database URL manually.

```bash
bun run smoke:capture
bun backend/scripts/upgrades/0.3.0-to-0.4.0/restore-check.ts "$RM_BACKUP_DIR" --emit-receipt
bun backend/scripts/upgrades/0.3.0-to-0.4.0/stage-rehearsal.ts "$RM_BACKUP_DIR" --emit-receipt
```

The restore check validates the v0.3.0 starting state. The rehearsal applies
the five migrations to the restored smoke-twin, boots real services, and
executes the release postflight before teardown. It proves conformance to the
release acceptance criteria — §4.4 gate.

1. All five full migration filenames appear once in `schema_migrations` — §4.4
   criterion.
2. `swarm_sessions_state_check` admits `judged`; `swarm_judge_config` contains
   exactly `id=1, mode='off'` with a positive `min_takes` and `model=NULL`; and
   the new history tables are empty initially.
3. Statement- and row-level append-only triggers are `ENABLE ALWAYS` on both
   history tables; the receipt table also has its two UPDATE-refusing triggers.
   `rm_worker` lacks INSERT, UPDATE, and DELETE on the protected/config tables.
4. `/allocation` renders the depositor-facing allocation page and `/performance`
   renders the protocol wallets. `/allocation2` redirects to `/performance`, and
   `/vault` renders not-found: that is the expected result, not a deploy fault.
   Exercise changed swarm admin routes only with an authenticated token.
5. `bun run --cwd backend swarm-judge:replay -- --limit 10` exits zero. A
   historical tie-break report is informational; a vector mismatch or replay
   write is a failure.

Rehearse rollback: restore the pre-upgrade dump into a fresh local smoke-twin
and prove v0.3.0 services boot against the v0.4.0 schema. Record duration,
migration output, and every non-empty judge/receipt observation in the report —
§4.4 requirement.

## 6. Production cutover

Maps to `release-runbooks.md` §4.7 (production execution). **IRREVERSIBLE FORWARD
MIGRATION:** `migrate.ts` has no down path. Do not start without a verified backup,
completed rehearsal, and written rollback authority — §4.7 requirement.

1. Reconfirm RC SHA, deployment configuration, and production DB identity.
2. Re-run release preflight against the live replica and compare its baseline:

```bash
bun backend/scripts/upgrades/0.3.0-to-0.4.0/preflight.ts --emit-receipt
```

3. Deploy in provider order: database migration, API and every worker lane,
   then static frontend. Do not publish the new SPA before its API — R4 (deploy
   provider before consumer).
4. Confirm the migration log names all five new files exactly once — per R1
   (additive only).
5. Do **not** enable the judge during cutover. Verify its config after the API
   is serving:

```bash
curl --fail-with-body -H "X-Admin-Token: $ADMIN_TOKEN" \
  "$RM_PUBLIC_BASE_URL/api/swarm/admin/judge"
```

Expected initial state is `mode: "off"`, a positive `minTakes`, and `model: null`.
If it is anything else, set it to off and investigate the prior state; do not
assume a pre-existing value is safe. Per R1, the DB can always be safely ahead
of the code.

## 7. Postflight and controlled enablement

Maps to `release-runbooks.md` §4.9 (production rollout report). Run these
SELECT-only checks after deployment:

```bash
bun backend/scripts/upgrades/0.3.0-to-0.4.0/postflight.ts --emit-receipt=P8.postflight-prod
bun run --cwd backend swarm-judge:replay -- --limit 10
```

Verify `/allocation`, `/performance`, `/allocation2` (redirects to
`/performance`), swarm archive and session pages, and the authenticated judge
endpoint from the deployed origin. `/vault` must return not-found. Confirm
production automation invokes no `demo:*` script — R3 corollary.

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
is immutable: a correction requires a new session, never UPDATE or DELETE — R1.

## 8. Failure, rollback, and close

Maps to `release-runbooks.md` §4.8 (rollback) and §4.9 (production rollout report).

For a failed migration, boot, invariant, replay, or route check, stop and
preserve logs, receipts, and baseline. Default response is the rehearsed restore
of the encrypted pre-upgrade dump. Do not delete history rows to "clean up" a
failed attempt.

For judge-only degradation, set the DB-backed mode to `off` first. That is the
narrow reversible mitigation; full restore is for a failed release invariant —
§4.8 default, overridable per §4.9 with second sign-off.

After clean production postflight, tag the deployed commit and file the report:

```bash
git tag -a v0.4.0 "$RC_SHA" -m 'v0.4.0'
git push origin v0.4.0
```

Include RC/tag, SHA, backup manifest, rehearsal and production receipts,
migration timing, judge mode, route checks, shadow-soak decision, and operator
sign-off — §4.9 requirement. The release tracking issue is closed only after
this report is filed and the final tag exists on the release branch.
