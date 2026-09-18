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
2. `releases-0.5.x` has been cut from the agreed main SHA — §2 branch rule.
   **No rc tag exists yet at this point** — see §1's revised order below.
3. Required checks on that branch tip pass — CI gating per policy.

## 1. Release identity

Maps to `release-runbooks.md` §3 (version tags and release candidates,
**revised 2026-09-11**: the rc tag is now cut only AFTER stage preflight and
rehearsal both pass, reversing every release through v0.4.0's tag-first
order):

- Cut RC tags on `releases-0.5.x`, never on `main` — §2.
- `v0.5.0` tag lands on the release branch after postflight passes, at the
  same commit as production — §3, consequence 1.
- RC numbering: `v0.5.0-rc.N` with N counting from 0 — §3. A rejected stage
  pass (§3/§5 below) consumes no rc number, since nothing is tagged yet when
  it happens — only a production postflight failure (§7) does.

```bash
git fetch origin --tags
git switch releases-0.5.x
git rev-parse HEAD
bun install --force            # repo root; "postinstall" reinstalls backend/ too
bun install --force --cwd backend
```

Record this SHA as `RC_SHA` — the commit stage validation runs against.
**Do not tag it yet.** The actual `git tag`/`git push` happens at the end of
§5, once every stage acceptance criterion has passed; `RC_SHA` names the
commit stage is currently validating whether or not a tag exists on it.

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
| Judge model invariant | **0056** requires every `shadow`/`enforce` row to name a model and repairs an invalid enabled/null row to `off`. **The D-A7 split, which this row previously stated wrongly:** a RUNTIME failure (the model was reached and misbehaved — timeout, unparseable answer, a number where prose was required) falls back to explicitly-labelled deterministic prose and the session publishes. A CONFIGURATION, CREDENTIAL or CREDIT failure (`credential_unconfigured`, `credential_rejected`, `credit_exhausted`, `model_not_supported`, `model_unconfigured`) FAILS CLOSED: nothing is judged, nothing is published, and the session's `swarm.judge` job records the class in `last_error`. `docs/architecture.md` §9.7 is the authority. | Re-enable with `mode` and `model` in one request; never expose an invalid intermediate pair. A fail-closed class is an operator fix, not a transient — see §8's judge triage table. |
| Consensus receipt auto-publish | `swarm.publish` (the worker cadence, not the HTTP publish route) now calls the receipt-publish path itself right after a session publishes — no separate admin call needed for an `enforce`-judged session. | None required. Structurally still a no-op for `off`/`shadow`-mode sessions (a `shadow` judgement is deliberately withheld from the session's own record, so there is no adopted opinion for a receipt to attest to) — this is not a bug the patch could or should remove. |
| Analyst allocation vector | A `bucket_weights` subject's brief now DECLARES the vector required (`takeSchema.weights.optional = false`, `buckets` = the four canonical vaults), the in-container member client asks its model for a `WEIGHTS:` control line and signs the resulting vector inside its canonical submission bytes, and receipt assembly REFUSES a `bucket_weights` session that produced no vector (`weights_absent_for_bucket_weights_subject` — deliberately outside `EXPECTED_RECEIPT_REFUSALS`, so the cadence run degrades). Before this, such a session published a signed, verified receipt with no `weights` field at all. | None at deploy time. After cutover, a published `robotmoney-vault` / `robotmoney-allocation` receipt must carry four `weights` entries totalling exactly 10,000 bps; a degraded `swarm.publish` naming `weights_absent_for_bucket_weights_subject` means the analysts are not authoring vectors and is a release-blocking condition, not a transient. |
| Allocation support | A `bucket_weights` receipt may not carry an allocation authored by only SOME of the takes it attests to. `meanTakeWeights()` averages over the VECTORS it finds, not over the takes, so a 1-of-3 allocation used to publish with `release_safety.take_count` reporting 3 and `thinly_supported` false — and a bucket a member never named was counted as that member's explicit 0.00 vote. Assembly now refuses with `weights_not_authored_by_every_take` (also outside `EXPECTED_RECEIPT_REFUSALS`). | None at deploy time. A degraded `swarm.publish` naming `weights_not_authored_by_every_take` means at least one member submitted a take with no four-bucket vector — check the member containers' `[inference] <member>: take attempt N/2` warnings, and any rmpc/MCP/API member submitting through the raw API. Treat it exactly like the row above: release-blocking, not a transient. |
| Missing-receipt visibility | `GET /api/admin/overview` reports one alert PER SESSION for every published session that lost a consensus receipt it could have had (`missingReceipts` on the projection, `swarm.consensus_receipt:<sessionId>` in the alert feed), over a 7-day window. Eligibility is judged against the mode and `min_takes` **that applied to that session** — read off its own append-only `swarm_session_judgements` row, and off the live config only for a session that was never judged and that the live POLICY PREDATES (`swarm_judge_config.policy_updated_at`, which moves only when `mode` or `min_takes` actually changes value — rotating the judge model is not a policy change and disturbs nothing) — plus, independently, its own `swarm.judge` job's `last_error`, matched on BOTH job shapes (`scope_type`/`scope_id` and `payload->>'sessionId'`), so a session scheduled by the driver is covered exactly like one created through the admin path. So raising `min_takes` or setting `mode: off` afterwards cannot retract an alert about a permanent loss. `off` and `shadow` raise nothing for sessions they cover: in both, a receipt is unreachable by construction. It is derived from state, so a later successful publication clears it and nothing has to be acknowledged. `swarm.publish` also degrades — instead of reporting a clean skip — when it refuses with `not_judged` AND that session's own `swarm.judge` job recorded a `last_error`. | None. A session named here is one that lost its receipt. Note for operators: an alert does NOT go away when you raise `min_takes` or turn the judge off — that is deliberate, and the only thing that clears it is a receipt (or the session ageing out of the 7-day window; a session published without a judgement is unrepairable, because `published` is terminal). |
| Judge mode patch | `POST /api/swarm/admin/judge {"mode":"enforce"}` alone now works and preserves the stored model. It previously returned 400 with a raw Postgres constraint string: the upsert's model-preserving `COALESCE` sat in a `DO UPDATE` arm PostgreSQL never reached, because it evaluates 0056's CHECK against the proposed INSERT tuple first. Sending `{ mode, model }` together is unchanged and still correct. | None. 0056 is unchanged and still refuses an on-with-no-model row — now in the function's own words rather than the driver's. |
| Runtime build identity | `GET /version` (and `build` on `GET /health`) report the full commit SHA and exact tag baked into the image at `docker build` time. `null` with a named reason when the image was built without them; a `+dirty` suffix when the tree was modified and a `+unknown` suffix when `git status` could not be run at all, so neither a modified nor an unchecked build can report the pinned SHA. | Check it after every deploy: `curl -s https://<host>/version` must equal the RC tag and SHA, with NO suffix. `+dirty` means the build tree was modified; `+unknown` means its `git status` failed (an unreadable index or permissions) and the tree was never checked — both fail AC-ID-03 and neither may be waved through. |
| Append-only preflight accuracy | `db-preflight`'s guard check no longer reports a table as "disarmed" (implying tampering) merely because its *own* opt-in migration (e.g. `0050` for `swarm_member_keys`) has not reached this database yet — it now gates each table on its own migration, not just `0032`'s. | None. Purely removes a false positive that every `smoke:twin`/`smoke:capture` run against a pre-0.5.0 database was hitting. |
| **Judge budget (`SWARM_JUDGE_TIMEOUT_MS`)** | **The one new environment variable in this release.** The judge's per-call budget default moves from 60 s to **300 s**, because the pinned model (`deepseek-v4-flash`) answers the real judge prompt in **58–175 s** measured against the funded key — so the old default aborted EVERY judging and published deterministic fallback prose under the judge's name, with every documented check green. The variable is now also carried from an operator's shell into the stack by `bun run smoke:stage` (`scripts/lib/smoke-compose-passthrough.ts`), which it was not: exporting it used to produce an empty value in the container and the default anyway. | **Optional.** The shipped default is workable on its own. Set it only to widen the budget further — in `./.env` beside `OPENCODE_API_KEY` (the channel that is actually working today), or exported before `smoke:stage`. A value that is not a positive number of milliseconds FAILS CLOSED at boot, by design: `60s`, `60_000` and `60000ms` are all refused rather than silently defaulted. |
| **Judge credential (`OPENCODE_API_KEY`)** | Read by **api** and **worker-swarm** (both interpolate it in `docker-compose.yml`); the judge uses the SAME vendor and the SAME key the member agents already use, so it adds no second credential. An UNFUNDED key is not an absent one: it authenticates and then refuses with `402 insufficient_credit`, which is a fail-closed class — the judge publishes nothing rather than dressing the refusal as an outage fallback. | **Confirm it is present AND funded before cutover.** The only precondition guard checks that it is non-empty. The postflight `judge-source` check below is what tells you afterwards whether a model ever actually answered. |
| **Fallback share is now a gate** | `postflight.ts` records a `judge-source` check and `GET /api/admin/overview` raises a `swarm.judge_fallback` alert: both report the SHARE of judgements authored by the deterministic fallback over the last 7 days, with their reasons. Per decision D15 they FAIL only at **100 %** — a stack that has never once reached the model is not producing acceptance evidence (`AC-MODEL-01`) — and report, without failing, anything less, because a partial fallback is `AC-FE-05` working as designed. The stage rehearsal additionally treats `model_timeout` as disqualifying for RC evidence. | None at deploy time. A `FAIL` here means no model has authored a judging in a week: read the reasons. `model_timeout` is a BUDGET problem (the row above), not an outage. |

This release DOES carry a new operator-settable variable —
`SWARM_JUDGE_TIMEOUT_MS`, the judge's per-call budget (see the row above). It is
optional, because the shipped default was raised to a value the pinned model
meets; §4 below says where to put it if you set it. (An earlier draft of this
runbook stated that no new environment variable was required by this release.
That was wrong, and it was wrong in the most expensive direction: an operator
following it deployed a judge that timed out on every session and published
fallback prose with every documented check green.)

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
0056_swarm_judge_requires_model.sql
```

Before any write, use the read-only replica procedure from
`rollout-procedure.md` §§3–5 and save this baseline beside the encrypted dump
and manifest — §4.2 requirement.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -c "
SELECT name, applied_at FROM schema_migrations
 WHERE name LIKE ANY (ARRAY['0049_%','0050_%','0051_%','0052_%','0053_%','0054_%','0055_%','0056_%']) ORDER BY name;
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

Confirm the deployment does not carry a stale `MIGRATE_DATABASE_URL` scoped to
a role narrower than the precondition in §3.

**`SWARM_JUDGE_TIMEOUT_MS` — the judge's per-call budget (optional).**

| Where | How it arrives | Notes |
| --- | --- | --- |
| `./.env` beside the compose files | `docker compose` reads `.env` and `docker-compose.yml` interpolates `${SWARM_JUDGE_TIMEOUT_MS:-}` into **api** and **worker-swarm** | The currently-working channel, and where `OPENCODE_API_KEY` already lives. |
| exported before `bun run smoke:stage` | `DEMO_COMPOSE_PASSTHROUGH` (`scripts/lib/smoke-compose-passthrough.ts`) forwards it, alongside `SWARM_JUDGE_BASE_URL` | This is new. Before it, an exported value reached nothing and the container saw an empty variable. |
| unset | `DEFAULT_JUDGE_TIMEOUT_MS` = **300 000 ms** (`backend/src/swarm/judge-budget.ts`) | The supported default. Sized at 1.7x the worst measured latency of the pinned model on a real judge prompt. |

Confirm what the containers actually received — an empty value is NOT the
default being "left alone", it is the symptom the old passthrough gap produced:

```bash
docker compose exec worker-swarm printenv SWARM_JUDGE_TIMEOUT_MS   # empty or a positive integer
```

A value that is not a positive number of milliseconds is refused at use rather
than silently defaulted (`resolveJudgeTimeoutMs`), so a typo fails closed and
publishes nothing — that is deliberate, and it is the loud failure you want.

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
the eleven migrations to the restored smoke-twin, boots real services, and
executes the release postflight before teardown. It proves conformance to
the release acceptance criteria — §4.4 gate:

1. All eleven full migration filenames appear once in `schema_migrations`.
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
7. `swarm_judge_config_mode_requires_model_check` is installed AND validated,
   no judge config row reads enabled with a NULL/blank model after the
   migration, and mode/model enablement is exercised atomically — the
   preflight reports the same constraint as ABSENT beforehand and WARNs in
   advance when 0056 is about to switch an enabled judge `off`.
8. A judged, `enforce`-mode session that reaches `swarm.publish` on the
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

### 5.1 Cut the RC tag

Only once every criterion above (1–8) passes — a rejected stage pass returns
to §3/§5 on a fixed commit and consumes no rc number, per §1's revised order.

**Criterion 8 is proved by `stage-rehearsal.ts` EXITING 0, not by reading the
postflight table.** It is the one criterion the runbook calls a behaviour change
an operator can observe end to end, and it is also the only one whose failure
mode is a fifteen-minute silent wait rather than a printed `FAIL` row: the
auto-publish never happens, the rehearsal blocks on the worker cadence, and the
postflight output that *did* complete still reads "criteria 1-7 passed". An
operator who interrupts that hang and tags anyway consumes an rc number on an
unrehearsed candidate. So: if the rehearsal did not run to completion and return
0, criterion 8 has NOT passed, whatever the table printed before the hang, and
no tag is cut.

```bash
git tag -a v0.5.0-rc.0 "$RC_SHA" -m 'v0.5.0-rc.0'
git push origin v0.5.0-rc.0
```

`N` counts from 0 for the first candidate that reaches this point; a
production postflight failure (§7) is what advances it to `rc.1`, `rc.2`, ...,
each cut only after ANOTHER full pass through §3/§5 on the patched commit —
never by re-tagging the same rejected commit.

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
   (deploy provider before consumer). "Then static frontend" is a COMMAND, not
   a reminder: `_static` is a build output that no image contains, and a deploy
   that skips it leaves the new API serving the previous release's SPA.

```bash
# On the deploy host, in the pinned checkout, AFTER the API is up:
RM_BUILD_COMMIT=$(git rev-parse HEAD) RM_BUILD_TAG=$(git describe --tags --exact-match HEAD) \
  bun run static:assemble
```

   The assembly writes `_static/.rm-static-manifest.json` (commit, tag and a
   content digest of everything it assembled); `/version` reports it as
   `static`, which is what makes step 4 checkable in §7 instead of assumed.

4a. **Images are built on `pinza` and shipped — never built here** (`AC-ID-05`).
   On `pinza`, in a checkout at the tag:

```bash
bun scripts/stack/ship-images.ts --tag v0.5.0-rc.N --host <deploy host>
```

   It verifies the checkout is the tag with an empty porcelain, builds the six
   images from the same compose model the stack runs, ships them with
   `docker save | ssh <host> docker load`, installs
   `/home/stage-server/fusion-stage/images.override.yaml` and
   `images.manifest.json` **outside** the checkout, and fails unless every
   image id on the host equals the one built on `pinza`. The boot then runs
   with `RM_IMAGES_OVERRIDE=/home/stage-server/fusion-stage/images.override.yaml`,
   which appends that file to the compose model and passes `--no-build`: a
   missing image stops the boot by name rather than being compiled here.
5. Confirm the migration log names all eleven new files exactly once — per R1
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

Migration 0056 may repair an enabled/null-model judge row to `off`. If the judge
was enabled before the upgrade, re-enable it only by setting `mode` and `model`
atomically. If the judge is already in
`enforce` from a prior release's controlled rollout (see
[`v0-4-0-rollout.md` §7](./v0-4-0-rollout.md#7-postflight-and-controlled-enablement)),
confirm after this deploy that a newly published, `enforce`-judged session
now carries a `swarm_consensus_receipts` row without an operator having
requested one — that is the one behavior change in this release an operator
can observe end to end.

Then run the four checks this release adds:

```bash
# 1. Identity. Must equal the RC tag and full SHA from §1 — no `+dirty` and
#    no `+unknown` suffix, and neither field null.
curl -s https://<host>/version

# 1a. The SERVED SPA is that same release. `.static.matches_image` is false
#     whenever `_static` was assembled from another commit than the API image
#     was built from — the signature of a deploy that skipped §6 step 4 — and
#     `.static.digest` null means the directory was never assembled at all.
curl -s https://<host>/version | jq -e '.static.matches_image == true and (.static.digest | startswith("sha256:"))'

# 2. The allocation is actually present. A published bucket_weights session
#    (robotmoney-vault / robotmoney-allocation) must carry four weights
#    totalling exactly 10000.
curl -s https://<host>/api/swarm/sessions/<sessionId>/consensus-receipt \
  | jq '.receipt.weights, ([.receipt.weights[].weight_bps] | add)'

# 2b. …and every analyst it attests to authored it. Both numbers must be equal
#     — the count of embedded submissions carrying a four-bucket vector, and
#     the count of embedded submissions. (Assembly refuses otherwise, so a
#     published receipt cannot fail this; run it once to prove the gate is live
#     rather than to look for a failure.)
curl -s https://<host>/api/swarm/sessions/<sessionId>/consensus-receipt \
  | jq '[.receipt.analyst_signatures[] | (.canonical_submission | fromjson)]
        | [ (map(select(.weights != null and (.weights | length) == 4)) | length), length ]'

# 3. Nothing lost a receipt. `missingReceipts.count` must be 0, and no
#    `swarm.consensus_receipt:<sessionId>` alert may be present.
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" https://<host>/api/admin/overview \
  | jq '.missingReceipts, [.alerts[] | select(.source | startswith("swarm.consensus_receipt"))]'

# 4. A MODEL ACTUALLY ANSWERED. The three checks above are ALL green on a stack
#    whose judge has never once been reached: a deterministic fallback receipt
#    is still a published receipt with four weights. This is the one that can
#    tell the difference, and the postflight `judge-source` row above says the
#    same thing from the database side.
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" https://<host>/api/admin/overview \
  | jq '[.alerts[] | select(.source == "swarm.judge_fallback")]'
```

`judge-source` / `swarm.judge_fallback` read as follows (decision D15):

| Reported | Meaning | Action |
| --- | --- | --- |
| `PASS` / `healthy` | every judgement in the window was authored by the model | none |
| `WARN` / `degraded` | some fell back; the reasons are named in the message | read the reasons. `model_timeout` means the budget is too small for the day the model is having — §4. Anything else, §8's triage table. |
| `FAIL` / `failed` | **100 % fallback over the window** — no model has authored a judging at all | release-blocking. Do not tag, do not cut over: nothing produced in this state is acceptance evidence (`AC-MODEL-01`). |
| `WARN` / `stale` | no judgements at all in the window | expected on a freshly migrated database; suspicious on a running one. |

## 8. Failure, rollback, and close

Maps to `release-runbooks.md` §4.8 (rollback) and §4.9 (production rollout
report).

For a failed migration, boot, invariant, or route check, stop and preserve
logs, receipts, and baseline. Default response is the rehearsed restore of
the encrypted pre-upgrade dump. Do not delete history rows to "clean up" a
failed attempt — `swarm_member_keys` joining the append-only set in this
release means that specific table now refuses it outright.

**Judge triage — the fail-closed classes (D-A7).** §7's check 3 is the alarm
that fires for all of these: the session publishes with no consensus receipt,
and `GET /api/admin/overview` names it. The class is in the session's own
`swarm.judge` job `last_error` (`judge_unavailable:<reason>`), and the stage
rehearsal now fails fast naming it instead of waiting out its deadline.

| `last_error` names | What actually happened | Fix |
| --- | --- | --- |
| `credit_exhausted` | the key authenticated and the account has no balance — Zen answered `402`/`CreditsError`. NOT an outage, and deliberately never dressed as one | fund the workspace. Nothing published while it was exhausted is evidence; re-run the affected sessions' judging after funding. |
| `credential_rejected` | `401`/`403` with no model complaint: wrong, revoked or truncated `OPENCODE_API_KEY` | re-issue the key into `./.env` for **api** and **worker-swarm**, recreate both, confirm with `printenv OPENCODE_API_KEY \| wc -c` (never print it). |
| `credential_unconfigured` | no key reached the process at all | the variable is absent from the service — check the compose interpolation and `.env`, not the vendor. |
| `model_not_supported` | the endpoint does not serve the configured model id | correct `swarm_judge_config.model` (a database row, set atomically with `mode`), not an environment variable. |
| `launcher_unavailable` | the RAIL, not the model and not the key (issue #1012): the `agent-launcher` service was unreachable, answered non-2xx, or reported that the judge container never launched, hung past its ceiling, or exited without one well-formed answer line | `docker compose ps agent-launcher` and its logs — it is the only service with the Docker socket. A launcher that never started is usually a missing `OPENCODE_API_KEY` or `SMOKE_PROJECT` in ITS environment (it refuses to boot without either). Nothing was asked of the model, so no spend and no evidence is affected. |
| `model_unconfigured` | `mode` is `shadow`/`enforce` with no model — impossible after 0056, possible on a restored older dump | re-enable with `mode` and `model` in ONE request. |
| `model_timeout` *(fallback, not fail-closed)* | the model was reached and did not answer inside the budget — the session publishes fallback prose | raise `SWARM_JUDGE_TIMEOUT_MS` (§4). Watch §7's check 4: at 100 % this is a release blocker even though every other check is green. |

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
