# v0.5.0 production rollout

> Operator procedure for upgrading production from **v0.4.0** to **v0.5.0**.
> Executed against the release candidate tagged on the `releases-0.5.x`
> branch (the SHA and command output are re-resolved at that RC's cut per
> §3); this document is not authority for a moving branch.

**Scope:** This runbook contains release-*specific* steps for the v0.5.0
upgrade. The foundational release-runbook policy is in
[`release-runbooks.md`](../../technical/release-runbooks.md). This document
references that policy for generic gates (§4.1–4.9) and only describes what
is special about v0.4.0→v0.5.0.

> **Migration numbering note.** `backend/scripts/upgrades/0.3.0-to-0.4.0/`
> also lists `0053_database_role_taxonomy.sql` and `0054_rm_worker_allowlist.sql`
> in its own manifest. That folder is a frozen record of what v0.4.0 actually
> shipped and is left as-is rather than edited after the fact; those two
> migrations are v0.5.0's, not v0.4.0's — production, verified directly against
> a fresh replica capture on 2026-09-11, is at migration `0048`. See
> `backend/scripts/upgrades/0.4.0-to-0.5.0/release.ts`'s own header for the
> full account of how this happened (the rolling `next/` tracking directory
> `release-runbooks.md` §9 describes was never created for this cycle, so
> every migration merged after v0.4.0 shipped landed in the old folder
> instead of a new one).

The runbook is organized as:
- **Generic policy references** — map to `release-runbooks.md` §4 gates; these
  steps must not be altered without updating the policy first.
- **0.5.0-specific instructions** — the migration, role, and behavior changes
  unique to this release.

## 0. Release prerequisites

Maps to `release-runbooks.md` §4.1 (code-readiness gate). Do not start
preflight until all of these are true:

1. A `release:v0.5.0` tracking issue exists, its scope is frozen, and its
   Phases tasklist is complete — §4.1 requirement.
2. `releases-0.5.x` has been cut from the agreed main SHA and the release
   candidate is tagged there, not on `main` — §2 branch rule.
3. Required checks for that candidate pass — CI gating per policy.

## 1. Release identity

Maps to `release-runbooks.md` §3 (version tags and release candidates):

- Cut RC tags on `releases-0.5.x`, never on `main` — §2.
- `v0.5.0` tag lands on the release branch after postflight passes, at the
  same commit as production — §3, consequence 1.
- RC numbering: `v0.5.0-rc.N` with N counting from 0 — §3.

```bash
git fetch origin --tags
git switch releases-0.5.x
git rev-parse HEAD
bun install --force            # repo root; "postinstall" reinstalls backend/ too
bun install --force --cwd backend
```

Record the first SHA as `RC_SHA`. Tag and push per the RC cycle.

> 🔴 **`bun install --force` is not optional here, and re-run it after every
> `git switch`/`git checkout` that moves `<checkout>` onto different code** —
> see [`v0-4-0-rollout.md` §1](./v0-4-0-rollout.md#1-release-identity) for the
> exact production incident (`v0.4.0-rc.3`) this note exists to prevent. The
> same stale-`node_modules/@robotmoney/contract` failure mode applies here
> unchanged.

## 2. What changes

| Area | Release effect | Operator decision |
| --- | --- | --- |
| Signed-take attribution | `swarm_recommendations.signing_key_id` (0049) records the exact `swarm_member_keys` row that verified a take at submission time, so read paths stop silently checking a stored signature against a member's *current* key once it rotates. | None. Nullable, no backfill — rows written before this migration keep resolving through the old "currently active key" fallback, a stated, deliberate cutover point (see 0049's own header). |
| Key-history integrity | `swarm_member_keys` (0050) joins the append-only protected set — a key row can no longer be hard-deleted, only deactivated. | None. Every real rotation/deactivation path already deactivates rather than deletes. |
| Vault/allocation subject repair | `swarm_subjects` (0051) self-heals `robotmoney-vault` and `robotmoney-allocation` back to `recommendation_type = 'bucket_weights'` if a prior `ensureSmokeSubjectFixtures` bug (issue #780, fixed in the same PR) had clobbered either to `position_actions`. | None. Idempotent; a no-op if neither subject exists yet or both already read the right value. |
| Judge digest provenance | `swarm_session_judgements.digest_scheme` (0052) records which canonical form produced a row's `inputs_digest`, so `swarm-judge-replay` can distinguish "this row predates a canonicalization change" from "this row claims the current rule and no longer reproduces." | None for this release — the column exists for the *next* canonical-form change, not this one. |
| **Database role taxonomy** | **0053** re-owns every table, view, sequence, and function in `public` from the migration/bootstrap login to a new **`rm_owner`** role (`NOLOGIN` — no process may ever authenticate as it), revokes `PUBLIC`'s schema privileges, and re-grants `rm_app`/`rm_readonly` explicitly. **0054** replaces `rm_worker`'s broad/default grant with an explicit table allow-list — `rm_worker` can `SELECT` everywhere but `INSERT`/`UPDATE`/`DELETE` only on the 17 tables it actually queues/samples through. | **Verify BEFORE cutover** that the migration-time connection's role can execute `CREATE ROLE` (DigitalOcean managed Postgres's default admin role has this by default; a scoped-down migration credential may not) — see §3's precondition check. This is the highest-risk step in the release: getting it wrong changes who can read or write every table at once. |
| Consensus receipt auto-publish | `swarm.publish` (the worker cadence, not the HTTP publish route) now calls the receipt-publish path itself right after a session publishes — no separate admin call needed for an `enforce`-judged session. | None required. Structurally still a no-op for `off`/`shadow`-mode sessions (a `shadow` judgement is deliberately withheld from the session's own record, so there is no adopted opinion for a receipt to attest to) — this is not a bug the patch could or should remove. |
| Append-only preflight accuracy | `db-preflight`'s guard check no longer reports a table as "disarmed" (implying tampering) merely because its *own* opt-in migration (e.g. `0050` for `swarm_member_keys`) has not reached this database yet — it now gates each table on its own migration, not just `0032`'s. | None. Purely removes a false positive that every `smoke:twin`/`smoke:capture` run against a pre-0.5.0 database was hitting. |

No new environment variable is required by this release (unlike v0.4.0's
`SWARM_SCHEDULES_ENABLED`). §4 below is a placeholder for that reason — kept
present so the section numbering matches every other rollout runbook and
`release-runbooks.md`'s cross-references.

## 3. Database preflight and baseline

The forward-only runner keys migrations by **filename**, not checksum.
Confirm the migration diff against the last known-good tag before touching
anything:

```bash
git diff --name-status v0.4.0 "$RC_SHA" -- backend/migrations/
```

Maps to `release-runbooks.md` §4.2 (pre-upgrade baseline) and §4.3
(backup/restore smoke test). Expected new files (additive migrations per R1):

```text
0049_swarm_recommendations_signing_key.sql
0050_swarm_member_keys_append_only.sql
0051_swarm_vault_recommendation_type_repair.sql
0052_swarm_judgement_digest_scheme.sql
0053_database_role_taxonomy.sql
0054_rm_worker_allowlist.sql
0055_swarm_recommendations_member_received_idx.sql
```

Before any write, use the read-only replica procedure from
`rollout-procedure.md` §§3–5 and save this baseline beside the encrypted dump
and manifest — §4.2 requirement.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -c "
SELECT name, applied_at FROM schema_migrations
 WHERE name LIKE ANY (ARRAY['0049_%','0050_%','0051_%','0052_%','0053_%','0054_%','0055_%']) ORDER BY name;
SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('rm_owner','rm_app','rm_worker','rm_readonly');
"
```

On a clean v0.4.0 starting point the migration query returns no rows and
`rm_owner` does not yet exist. Any pre-existing row means this is not a clean
starting point: stop and record why before proceeding.

**Role-creation precondition (0053/0054), verify on the LIVE production
connection before scheduling cutover, not only on the replica:**

```bash
psql "$MIGRATE_DATABASE_URL" -X -c "SELECT rolcreaterole, rolsuper FROM pg_roles WHERE rolname = current_user;"
```

At least one of `rolcreaterole` or `rolsuper` must be `t`. If neither is,
`0053`'s `CREATE ROLE rm_owner ...` fails outright — this is a required,
loud failure, not a soft-fail worth adding a fallback for: proceeding without
this privilege is not a state this release can run in.

## 4. Configuration and deployment preparation

No new required environment variable ships with this release — see §2's
table. Confirm the deployment does not carry a stale `MIGRATE_DATABASE_URL`
scoped to a role narrower than the precondition in §3.

## 5. Stage rehearsal

Maps to `release-runbooks.md` §4.3 (backup/restore smoke test) and §4.4
(digital-smoke-twin rehearsal). Run on the dedicated staging host, with the
same RC that will be deployed. Use the shared data-path names rather than
constructing a database URL manually.

```bash
bun run smoke:capture
bun backend/scripts/upgrades/0.4.0-to-0.5.0/restore-check.ts "$RM_BACKUP_DIR" --emit-receipt
bun backend/scripts/upgrades/0.4.0-to-0.5.0/stage-rehearsal.ts "$RM_BACKUP_DIR" --emit-receipt
```

The restore check validates the v0.4.0 starting state. The rehearsal applies
the seven migrations to the restored smoke-twin, boots real services, and
executes the release postflight before teardown. It proves conformance to
the release acceptance criteria — §4.4 gate:

1. All seven full migration filenames appear once in `schema_migrations`.
2. `swarm_recommendations.signing_key_id` is nullable and its foreign key is
   `ON DELETE SET NULL`; `swarm_session_judgements.digest_scheme` is
   `NOT NULL DEFAULT 'derivation-v1'`.
3. `swarm_member_keys` carries both append-only triggers, `ENABLE ALWAYS`,
   calling `rm_append_only_guard()` — same shape as every other protected
   table.
4. Schema `public` is owned by `rm_owner` (`rolcanlogin = false`); every
   table/view/materialized view in it is owned by `rm_owner`; `PUBLIC` (the
   pseudo-role) has no `USAGE` on schema `public`. `rm_app`, `rm_worker`,
   `rm_readonly` can each still log in.
5. `rm_worker` has `SELECT` on every table and `INSERT`/`UPDATE`/`DELETE` on
   **exactly** the 17-table allow-list in `release.ts`'s
   `WORKER_WRITABLE_TABLES` — in particular, none of the judge, receipt, or
   append-only-protected tables.
6. `swarm_recommendations_member_received_idx` exists on
   `(member_id, received_at DESC)`.
7. A judged, `enforce`-mode session that reaches `swarm.publish` on the
   real worker cadence gets a `swarm_consensus_receipts` row with no
   separate admin call; a `shadow`-mode session publishes cleanly with no
   receipt and no thrown error.

Rehearse rollback: restore the pre-upgrade dump into a fresh local smoke-twin
and prove v0.4.0 services boot against the v0.5.0 schema. **The role/grant
changes (0053/0054) have no down migration** — record in the rehearsal report
exactly which role a rolled-back v0.4.0 boot connects as, and confirm it
still has the access v0.4.0 code expects. This is the one part of this
release where "restore the dump" is not obviously sufficient by itself,
because the dump does not carry the *roles* — those are cluster-level, not
database-level, objects, and a role created only by `0053` running forward
persists after a database-level restore. Bring back deleted `rm_owner` grants
would need `DROP OWNED BY rm_owner` / manual `REASSIGN OWNED` if a rollback
is ever actually exercised in anger; this runbook does not script that path
because it should not be needed — the default response to a failed migration
is the rehearsed restore of the pre-upgrade dump, executed BEFORE the role
migration step ever runs, not after.

## 6. Production cutover

Maps to `release-runbooks.md` §4.7 (production execution). **IRREVERSIBLE
FORWARD MIGRATION:** `migrate.ts` has no down path, and 0053/0054 additionally
have no meaningful rollback path at all (§5's note). Do not start without a
verified backup, completed rehearsal, and written rollback authority — §4.7
requirement.

1. Reconfirm RC SHA, deployment configuration, and production DB identity.
2. Reconfirm the §3 role-creation precondition on the actual migration
   connection that will run this deploy — not only on the replica used for
   preflight.
3. Re-run release preflight against the live replica and compare its
   baseline:

```bash
bun backend/scripts/upgrades/0.4.0-to-0.5.0/preflight.ts --emit-receipt
```

4. Deploy in provider order: database migration, API and every worker lane,
   then static frontend. Do not publish the new SPA before its API — R4
   (deploy provider before consumer).
5. Confirm the migration log names all seven new files exactly once — per R1
   (additive only).
6. Immediately after the migration step (before the API is serving traffic),
   confirm the API's own runtime role can still connect and query:

```bash
psql "$DATABASE_URL" -X -c "SELECT current_user, session_user;" # expect rm_app (or rm_worker for a worker-lane check)
```

If this fails, the deploy has migrated the schema but the running
application cannot reach it — stop before routing any traffic and follow
§8's rollback.

## 7. Postflight and controlled enablement

Maps to `release-runbooks.md` §4.9 (production rollout report). Run these
SELECT-only checks after deployment:

```bash
bun backend/scripts/upgrades/0.4.0-to-0.5.0/postflight.ts --emit-receipt=P8.postflight-prod
```

`subject-repair` may report `WARN` rather than `PASS` — that means neither
`robotmoney-vault` nor `robotmoney-allocation` needed repair on this database
(either both already read `bucket_weights`, or neither has convened a
session yet). It is not a blocking condition; only a `FAIL` (an existing
subject still reading `position_actions`) is.

No judge-mode enablement step is part of THIS release — `swarm_judge_config`
is unchanged by any of the seven migrations here. If the judge is already in
`enforce` from a prior release's controlled rollout (see
[`v0-4-0-rollout.md` §7](./v0-4-0-rollout.md#7-postflight-and-controlled-enablement)),
confirm after this deploy that a newly published, `enforce`-judged session
now carries a `swarm_consensus_receipts` row without an operator having
requested one — that is the one behavior change in this release an operator
can observe end to end.

## 8. Failure, rollback, and close

Maps to `release-runbooks.md` §4.8 (rollback) and §4.9 (production rollout
report).

For a failed migration, boot, invariant, or route check, stop and preserve
logs, receipts, and baseline. Default response is the rehearsed restore of
the encrypted pre-upgrade dump. Do not delete history rows to "clean up" a
failed attempt — `swarm_member_keys` joining the append-only set in this
release means that specific table now refuses it outright.

If `0053`/`0054` are the failure (the migration-time role could not create
`rm_owner`, or a runtime role lost access it needs), this is the scenario §5
flags as having no scripted rollback: restore the pre-upgrade dump into a
fresh environment rather than attempting to hand-unwind role ownership on
the live database.

After clean production postflight, tag the deployed commit and file the
report:

```bash
git tag -a v0.5.0 "$RC_SHA" -m 'v0.5.0'
git push origin v0.5.0
```

Include RC/tag, SHA, backup manifest, rehearsal and production receipts,
migration timing, the role-creation precondition's result, and operator
sign-off — §4.9 requirement. The release tracking issue is closed only after
this report is filed and the final tag exists on the release branch.
