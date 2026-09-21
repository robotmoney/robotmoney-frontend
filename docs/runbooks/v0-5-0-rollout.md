# v0.5.0 production rollout

> Operator procedure for upgrading production from **v0.4.0** to **v0.5.0**.
> **No RC is cut yet on this branch.** The candidate is whatever `v0.5.0-rc.*`
> tag is next cut on `releases-0.5.x`; record its tag and SHA here when it
> exists. Note that `v0.5.0-rc.1` through `v0.5.0-rc.8` already exist from the
> abandoned attempt and point at `releases-0.6.x`, so the next RC here is
> `rc.9` unless those tags are retired first. This document is not authority
> for a moving branch.
>
> **The RC tag is cut at §5.1, after stage preflight and rehearsal both
> pass — not before them.** As of v0.5.0 the stage gates run against the
> untagged branch tip, reversing the tag-first order every release through
> v0.4.0 used (`release-runbooks.md` §3, revised 2026-09-11). A rejected
> stage pass therefore consumes no rc number.

This runbook implements the foundational policy in
[`docs/technical/release-runbooks.md`](../technical/release-runbooks.md) and
the shared mechanics in [`rollout-procedure.md`](./rollout-procedure.md).
v0.5.0 is **not** code-only: it carries eighteen additive migration files
(`0045`-`0061`) and switches production's closed-day price reads onto a new
table (D41). Four of the eighteen (`0045`-`0048`) already reached production
outside this rollout, so the cutover applies the remaining fourteen — see the
RESOLVED note below. Do not run this as a no-op cutover.

**Provenance.** This procedure is the v0.4.2 runbook, carried over whole. The
0.4 patch track (v0.4.1, v0.4.2) was abandoned without either release ever
reaching production, so its gate work is inherited here rather than rewritten,
and v0.4.0 is the baseline v0.5.0 upgrades from.

**RESOLVED 2026-09-18 — production is at `0048`, and this is a RESUME.** The
open question this runbook used to carry (is production at `0044` or `0048`?)
was settled against the live read-only replica. It is at `0048`. The ledger:

| Migrations | `applied_at` | What applied them |
| --- | --- | --- |
| `0039`-`0044` | 2026-09-04T21:37:30Z | the v0.4.0 release |
| `0045`-`0048` | 2026-09-08T14:43:24Z | **an ordinary deploy, not a rollout** |

`0045`-`0048` landed in a single boot, 231ms apart, four days after v0.4.0.
The recorded filenames match this branch's own `0045`-`0048` exactly, so they
are this migration line and not `releases-0.6.x`'s colliding set. At that
moment `main` already carried `0049`/`0050`, so the deployed build predated
them — a build cut from the ~4h window on 2026-09-07 between `0048` landing
(17:52Z) and `0049` landing (22:36Z).

**The consequence is structural, and it outlives this release.** Migrations
reach production when a build carrying them boots, whatever branch that build
came from — `migrate.ts` runs at boot and applies whatever is pending. So the
premise that a release rollout is what moves production's schema is false;
this runbook gates a migration set that partly arrives on its own. Fourteen
migrations (`0049`-`0061`) are still pending and this rollout applies those.
Treat the same drift as possible again before each cutover: §4.4's preflight
is what re-establishes the real starting point, and it now reports a
resumable prefix rather than refusing outright.

**Still true and still blocking:** the role taxonomy has never been
provisioned — `rm_owner` and `rm_app` do not exist in `pg_roles` at all, and
`rm_worker` holds none of `0054`'s grants. `0053`/`0054` never reached
production because no deployed build has carried them. §4.1 is therefore a
real, unstarted operator action, not a formality.

Note also that `releases-0.6.x` carries entirely different migration files at
numbers `0056`-`0061` (judge policy/fault-injection work) than this branch
does (analytics ledger work); the two lines collide on those numbers and
cannot both be deployed to the same database.

## 1. Release identity and objective

The objective is to apply the D41 price-series split and its accompanying
fixes while preserving the v0.4.0 application, schema, and judge/receipt
invariants:

- retain all six v0.4.0 migrations and the v0.4.0 judge/receipt invariants;
- apply the fourteen still-pending v0.5.0 migration files (`0049`-`0061`, of
  the eighteen the release carries) and land the new tables they create,
  leaving `0045`-`0048`'s existing records and tables untouched;
- switch closed-day allocation/performance price reads to the `asset_prices`
  join (D41 MIGRATE step) while today's live point keeps its existing fused
  read;
- backfill `swarm_sessions.subject_name` for every session whose subject was
  renamed after the session was recorded;
- ship third-party judging as a global, admin-flippable, **off-by-default**
  gate (`swarm_judge_config.third_party_enabled`);
- rebuild `/allocation` as the policy page and retire `/vault` (RM-115).

The release-specific tools are in `backend/scripts/upgrades/0.4.0-to-0.5.0/`.
Migrations run the normal way: at backend boot, via
`backend/src/db/migrate.ts`. The migration session's credential is
`MIGRATE_DATABASE_URL` when that variable is set, and `DATABASE_URL`
otherwise (`backend/src/db/migrate.ts:34`). Migrations `0054` and later run
`SET LOCAL ROLE rm_owner` inside that session (`migrate.ts:58`), so whoever
applies them must hold `rm_owner` membership — §4.1's credential cutover is
what provisions that. There is no migration-runner invocation beyond running
the migration command (or the boot) with `MIGRATE_DATABASE_URL` set for that
run only.

## 2. Code delta: systems upgraded and risks

The release contains the following changes relative to `v0.4.0`:

| Code or document | System affected | What changes in production | Primary risk | Mitigation |
| --- | --- | --- | --- | --- |
| `backend/migrations/0045_chain_address_floors.sql`, `backend/src/chain/address-floor-resolver.ts` | Wallet backfill | New `chain_address_floors` cache table holding each tracked address's on-chain deployment block; backfill consults it before issuing a block-addressed read | A wrong or missing floor either wastes RPC calls or wrongly skips a genuinely-covered day | Postflight confirms the table exists; floors are resolved lazily and self-heal, they are never destructively overwritten |
| `backend/migrations/0046_asset_prices.sql`, `backend/src/ops/asset-prices.ts`, `backend/src/chain/asset-price-floor.ts`, `backend/src/chain/wallet-*.ts` | Price/holdings read path (D41) | New `asset_prices`/`asset_price_floors` tables; migration seeds `asset_prices` from existing `live`/`seed` rows in `wallet_balance_samples`/`wallet_sleeve_samples`; reads for a **closed** day now join amount against this table instead of the old fused `price_usd` column — today's live point is unaffected | A bad seed or join produces a wrong historical valuation on `/allocation`/`/performance`; an empty seed manufactures gaps | Postflight asserts `asset_prices` is non-empty after migration; rehearsal spot-checks a known closed-day total against the pre-migration fused value before and after |
| `backend/migrations/0047_swarm_session_subject_name_backfill.sql` | Swarm session history | One-time, idempotent `UPDATE` re-syncing `swarm_sessions.subject_name` to each subject's current `name` | None if idempotent as written; a mid-migration subject rename could theoretically race it | Postflight confirms zero sessions remain drifted from their subject's current name |
| `backend/migrations/0048_swarm_judge_third_party_flag.sql`, `backend/src/swarm/admin.ts`, `backend/src/swarm/judge-session.ts` | Swarm judging | Adds `swarm_judge_config.third_party_enabled boolean NOT NULL DEFAULT false`; a `judgeMemberId` judgement is refused fail-closed until an admin flips it | None if left at its shipped default; flipping it live is a separate, deliberate operator action, not part of this cutover | Postflight asserts the flag is `false` on the row with `id=1`; do not enable it during this rollout |
| `backend/migrations/0049_swarm_recommendations_signing_key.sql`, `backend/src/swarm/domain.ts` | Swarm take integrity | Adds nullable `swarm_recommendations.signing_key_id` FK to `swarm_member_keys`; an accepted take records the exact key that verified it, so reads survive key rotation. Pre-existing rows stay NULL by design — a documented cutover point, not an accidental gap | A NULL column handling defect makes reads fall back to the old "currently active key" lookup for every pre-cutover take | Postflight confirms the migration is recorded; NULL rows keep the documented fallback, never a crash |
| `backend/migrations/0050_swarm_member_keys_append_only.sql` | Swarm key history | `swarm_member_keys` joins the append-only protected set (0032): DELETE and TRUNCATE are refused, while UPDATE stays legal — rotations keep retiring a key as `active = false` | A legitimate removal being refused would be a very narrow operational surprise, and the register-member hard-DELETE that previously destroyed key rows is removed in the same commit | Postflight confirms the migration is recorded |
| `backend/migrations/0051_swarm_vault_recommendation_type_repair.sql` | Swarm subjects | One-time idempotent `UPDATE` restoring `recommendation_type = 'bucket_weights'` on `robotmoney-vault`/`robotmoney-allocation` after a smoke-fixture upsert clobbered it to `position_actions`; a subject legitimately running `position_actions` is left alone | None beyond the two named framework subjects; the WHERE clause targets exactly the clobbered value | Idempotent — reruns match zero rows once both subjects read `bucket_weights` |
| `backend/migrations/0052_swarm_judgement_digest_scheme.sql`, `backend/src/swarm/judge.ts`, `backend/src/swarm/judge-replay.ts` | Swarm judging | Adds `swarm_session_judgements.digest_scheme text NOT NULL DEFAULT 'derivation-v1'`, recording which canonical form produced each stored `inputs_digest` so `swarm-judge-replay` can tell expected history from a real mismatch | Every existing row is re-stamped under the current scheme, so nothing needs a backfill | Postflight confirms the migration is recorded |
| `backend/migrations/0053_database_role_taxonomy.sql` | Database roles | Creates `rm_owner` (NOLOGIN), `rm_app` and `rm_readonly`, and re-attributes `rm_worker`, which **`0016` created** — see §4.1.1, which tables each role's true origin. Re-owns the application's `public` relations/functions under `rm_owner`, EXCLUDING objects owned by an extension (pgcrypto's `digest()` et al stay with the extension); DDL now runs as `SET ROLE rm_owner` | The ownership sweep re-stamps every APPLICATION object in `public`; fully transactional and idempotent on rerun. It must also be expressible by a NON-superuser: the primary's bootstrap login `doadmin` is `rolsuper=false`, which is what forced this migration's three corrections (§4.1.2) | Postflight confirms the migration is recorded. Runtime roles do **not** authenticate unchanged: this release is the cutover that points `DATABASE_URL` at `rm_app`, `WORKER_DATABASE_URL` at `rm_worker`, and the migration run at a bootstrap login holding `rm_owner` membership (§4.1; `docs/runbooks/deployment.md` §4.3/§4.3.1; `scripts/ops/provision-db-role-taxonomy.sh`). `backend/src/config.ts:710` refuses a doadmin `DATABASE_URL` at production boot, and `backend/src/db/worker-client.ts:20` hard-requires `WORKER_DATABASE_URL` in production |
| `backend/migrations/0054_rm_worker_allowlist.sql` | Worker permissions | Replaces 0016's broad default worker grant with an explicit allow-list: `rm_worker` keeps SELECT everywhere but INSERT/UPDATE/DELETE only on the tables queue/sampler handlers actually write | A worker lane touching a table missing from the allow-list fails its writes at boot instead of silently depending on a blanket grant | Postflight confirms the migration is recorded |
| `backend/migrations/0055_swarm_recommendations_member_received_idx.sql` | Swarm takes | Adds `swarm_recommendations (member_id, received_at DESC)` so `getMembers()`'s per-member `max(received_at)` lateral is an index-only walk instead of a scan | A redundant index if the read path never runs; otherwise negligible | Postflight confirms the migration is recorded |
| `backend/migrations/0056_analytics_overwrite_events.sql`, `backend/src/analytics/**` | Analytics research integrity | New `analytics_overwrite_events` table and `rm_capture_analytics_overwrite()` SECURITY DEFINER function; an owner-installed trigger records immutable evidence whenever a current-view analytics table is updated or deleted | An evidence-append failure surfacing on every current-view write would trip the analytics pipeline loudly | Postflight confirms the table exists |
| `backend/migrations/0057_source_acquisition_ledger.sql`, `backend/src/analytics/store/source-ledger-store.ts` | Analytics evidence | Five append-only tables (`source_acquisitions`, `source_acquisition_events`, `source_payloads`, `source_fetches`, `source_value_versions`) recording what a producer knew, when, and with which payload | Checksum-constrained payload rows are write-once; a broken producer that never emits events is simply dead storage | Postflight confirms the tables exist |
| `backend/migrations/0058_analytics_run_ledger.sql`, `backend/src/analytics/run-ledger.ts`, `backend/src/analytics/store/run-ledger-store.ts` | Analytics runs | Five immutable tables (`analytics_ledger_methodology_versions`, `analytics_ledger_runs`, `analytics_ledger_run_events`, `analytics_data_vintages`, `analytics_vintage_members`) freezing per-run methodology, a write-once run header, lifecycle events, and frozen data vintages | Run headers are immutable by design; a code path trying to update a run fails loudly, never silently mutates | Postflight confirms the tables exist |
| `backend/migrations/0059_analytics_output_and_report_snapshots.sql`, `backend/src/analytics/store/output-snapshot-store.ts`, `backend/src/swarm/domain.ts` | Analytics outputs, report snapshots, swarm briefs | `analytics_output_snapshots`/`analytics_report_snapshots` keep byte-exact, checksummed outputs and reports per run; new `swarm_brief_revisions` makes brief bodies append-only; `swarm_briefs`/`swarm_recommendations` gain nullable `report_snapshot_id` (no backfill — same documented cutover shape as 0049) | Every pre-cutover brief/take stays NULL-report, and report bytes are stored once per run (never overwritten) | Postflight confirms the tables exist |
| `backend/migrations/0059_swarm_framework_subject_snapshot_cleanup.sql` | Swarm subject history | Deletes fabricated `swarm_subject_snapshots` for framework subjects (no real book to scrape) by temporarily disabling the append-only triggers inside the migration transaction, then re-enabling them `ENABLE ALWAYS` | The delete touches only rows whose subject's `source->>'type'` is `framework`; a future framework subject would match, but the guard is fully restored before the transaction commits | Idempotent — reruns match 0 rows once cleaned |
| `backend/migrations/0060_analytics_ledger_cutover.sql`, `backend/src/analytics/cutover/*`, `backend/src/db/analytics-ledger-guard.ts`, `backend/scripts/analytics-ledger-cutover-gate.ts` | Analytics reads (issue #979/#988) | Two new tables: the single-row `analytics_read_mode` operator switch (seeded `compatibility` — the mode every consumer has always used) and the immutable `analytics_parity_observations` evidence ledger (blocked from UPDATE/DELETE/TRUNCATE, `rm_app`-only append, `rm_worker` revoked). Dual-write parity checks run automatically (§6.1); flipping the switch to `ledger` is the operator-run cutover gate CLI, refused until a matching observation window exists | Reads silently resolve from the wrong side after a bad flip | The flip is gate-refused until every domain has a fresh, unbroken, sufficiently long/large matching window; rollback is the same non-destructive single UPDATE (§6.1). **That was unreachable for `swarm_briefs` until 2026-09-18:** the parity check compared ALL brief history against a ledger `0059` deliberately does not backfill, so that domain reported `matched=false` on every sweep and the gate could never pass on a database carrying pre-`0059` briefs — production being exactly that. Scoped to the ledger era since; if you see the gate refuse on `swarm_briefs` alone, check you are running that fix before blaming the data |
| `backend/migrations/0061_source_value_provenance.sql`, `backend/src/analytics/source-ledger.ts` | Raw-history provenance | Adds nullable `source_value_versions.provenance` text carrying the data source label (`live`/`seed`) at acquisition time, so ledger-mode raw-series reads return the same provenance the compatibility tables do | Pre-0061 rows stay NULL by design — the append-only trigger forbids the backfill | Postflight confirms the migration is recorded; NULL is the honest "not recorded" label, never a fabrication |
| `frontend/public/assets/js/app/alpine/views/allocation.js`, `frontend/public/views/allocation.html`, `frontend/public/assets/js/app/lib/allocation-subject.js` | `/allocation` frontend | `/vault` is retired and its route repointed to the rebuilt `/allocation` policy page (RM-115); the hero switches from a fan chart to a donut | A route rename that silently breaks bookmarked links or e2e coverage of the old `/vault` view | `scripts/tests/unit/e2e-route-rename-guard.test.ts` and `frontend/test/browser/allocation-view.spec.ts` are part of CI on this branch |

Systems that are **not** upgraded by this release:

- every touch on an existing table is additive and idempotent: 0049/0052 add
  nullable/defaulted columns (`swarm_recommendations.signing_key_id`,
  `swarm_session_judgements.digest_scheme`), 0050 adds an append-only guard on
  `swarm_member_keys`, 0053 introduces the role taxonomy, 0054 narrows the
  worker to an explicit table allow-list, and 0055 adds one index; no existing
  row or column is rewritten by DDL (0047/0051/0059's fixes are one-time,
  idempotent data updates restricted to their stated scope);
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
git switch releases-0.5.x
git rev-parse HEAD
git tag --points-at HEAD -l 'v0.5.0-rc.*'   # expected: prints nothing yet
bun install --force
bun install --force --cwd backend
```

Record the SHA printed by `git rev-parse HEAD` as `RC_SHA` — the commit the
stage gates validate. **Do not tag it yet.** The `git tag --points-at` line
is a confirmation that nothing is tagged here, not a lookup: the actual
`git tag`/`git push` happens at §5.1, once every stage acceptance criterion
has passed. `RC_SHA` names the commit stage is currently validating, whether
or not a tag yet points at it. When the tag is cut it must be on
`releases-0.5.x`, never on `main`.

The forced installs are a blocking prerequisite. Bun copies the local
`@robotmoney/contract` file dependency; it does not reliably provide a live
symlink. A checkout that moved past a contract change can therefore run old
route definitions without an import error.

## 4. Baseline, backup, and live preflight

**4.1 — Role/credential cutover (run this FIRST; it gates everything below).**
This release is the first one that cannot boot on the old credentials:

- `backend/src/config.ts:710-712` **refuses** a `doadmin` `DATABASE_URL` in
  production — the API process dies at boot if the host still uses one;
- `backend/src/db/worker-client.ts:20-22` **hard-requires**
  `WORKER_DATABASE_URL` in production — the worker process dies at boot
  without it;
- migrations `0054` and later run `SET LOCAL ROLE rm_owner`
  (`backend/src/db/migrate.ts:58`), which only a session holding `rm_owner`
  **membership** can execute — the runtime `rm_app` role empirically cannot
  (permission denied).

**4.1.1 — The four roles, and where each comes from.** They do not all have
the same origin, which is why "provision the four roles" alone is not an
instruction anyone can follow:

| Role | Login? | Created by | Used as | Production state (verified 2026-09-18) |
| --- | --- | --- | --- | --- |
| `rm_owner` | **NOLOGIN** | `0053` | owns every `public` object; DDL runs as it via `SET LOCAL ROLE` | **ABSENT** |
| `rm_app` | LOGIN | `0053` | `DATABASE_URL` — the API runtime | **ABSENT** |
| `rm_worker` | LOGIN | **`0016`** — and, since 2026-09-21, `0053` too. `0053` used to only re-attribute it, which aborted an out-of-band `0053` on any cluster `0016` had never reached; `0054` narrows its grants | `WORKER_DATABASE_URL` — worker lanes | present, **without any of `0054`'s grants** |
| `rm_readonly` | LOGIN | `0053` if absent | `$HOME/.env` — preflight's own login | present (this runbook's preflight already authenticates as it) |

`rm_owner` never authenticates and therefore never gets a password. The other
three need one, but the script prompts for them **only** under
`--set-passwords`: rotating a live credential is not something a re-run may do
as a side effect. A brand-new cluster is the one case that needs the flag, and
the script's verification reports a password-less runtime role wherever it is
allowed to read `pg_authid`.

**4.1.2 — What actually initializes them.** `scripts/ops/provision-db-role-taxonomy.sh`
is the whole mechanism. It applies `backend/migrations/0053_database_role_taxonomy.sql`
(and, since v0.5.1, `0062`) through `psql` as the bootstrap login, then verifies
the end state and exits non-zero if it is wrong. It changes **no** password
unless `--set-passwords` is passed — see the ⚠ in `v0-5-1-rollout.md`, which is
the same warning and the same reason.

The `.env` it reads is the host's own `$HOME/.env`, in the discrete-token form
every other consumer of that file uses (issue #699, `scripts/lib/env-role.ts`):

```bash
# $HOME/.env, the single credential file. The bootstrap login (doadmin) is
# normally ABSENT from it and the command prompts once, interactively.
host = <primary-host>
port = 25060
database = defaultdb
sslmode = require
rm_app = <…>
rm_worker = <…>

scripts/ops/provision-db-role-taxonomy.sh "$HOME/.env"
```

The pre-#699 shape — a `.env` carrying `MIGRATE_DATABASE_URL` — is still
accepted. The script never prints, writes or logs a password; it resolves the
bootstrap credential once and passes it to `psql` through `PGPASSWORD` rather
than on its argv, the one exception being a password already embedded inside a
legacy URL, which is used as-is and is briefly visible in `ps`.

**The bootstrap login is whichever admin login you run that command as** —
on the managed primary that is `doadmin`. It needs to be able to `CREATE
ROLE`. This matters beyond the one command: `0053` ends with
`GRANT rm_owner TO current_user` (`0053_database_role_taxonomy.sql:25`), so
the login that runs the script is, by that act, the one that ends up holding
`rm_owner` membership — and is therefore the login `MIGRATE_DATABASE_URL`
must name at §6. Run the script as one login and set `MIGRATE_DATABASE_URL`
to another and `0054` fails with permission denied.

**4.1.3 — `0053` is applied twice, and that is correct.** The script applies
`0053`'s SQL through `psql`, which does **not** write `schema_migrations` —
`migrate.ts` owns that ledger. So after the script runs, `0053` is still
*pending*, and the §6 boot re-applies and then records it. That is safe by
construction: every `CREATE ROLE` in the file is guarded by
`IF NOT EXISTS (SELECT FROM pg_roles ...)`, and the ownership sweep is
re-runnable and transactional. **Expect `0053` in the §6 migration log even
though you already ran it here** — its absence would be the anomaly, not its
presence. Do not "fix" this by hand-editing `schema_migrations` (§6).

**4.1.4 — Install the credentials.** Then, on the cutover host:

- `DATABASE_URL` → the **`rm_app`** login (deployment.md §4.3);
- `WORKER_DATABASE_URL` → the **`rm_worker`** login (deployment.md §4.3);
- the migration run gets **`MIGRATE_DATABASE_URL`** → the §4.1.2 bootstrap
  login that now holds `rm_owner` membership (`backend/src/db/migrate.ts:34`
  reads it for the migration run). Set it for the migration command only —
  never on the long-lived processes.

The taxonomy cutover is human-run by design
(`docs/runbooks/deployment.md` §4.3/§4.3.1): it writes to the **primary**, so
it is an operator action, never an agent's, and it cannot be run from the
stage host, which holds no writer credential.

Run this pre-step **before** `smoke:capture` in §4.2: the globals dump then
carries the taxonomy, and the `role-readiness` preflight record (§4.4)
against the live target can pass. Re-run §4.4's preflight afterwards — it is
the check that confirms §4.1 actually landed, and as of 2026-09-18 it FAILs
with `role(s) absent from pg_roles: rm_owner, rm_app`, meaning none of this
section has been done yet.

**4.2 — Backup, restore proof, and baseline.** Export a unique backup
directory and follow `rollout-procedure.md` for the replica identity
assertion, encrypted capture, and restore proof:

```bash
export RM_BACKUP_DIR=/path/outside/checkout/rm-backup-v042-$(date -u +%Y%m%dT%H%M%SZ)
bun run smoke:capture
bun backend/scripts/upgrades/0.4.0-to-0.5.0/restore-check.ts "$RM_BACKUP_DIR" --emit-receipt
```

`smoke:capture` writes into `$RM_BACKUP_DIR` (the same variable restore-check
and the rehearsal read). Gate C restores the dump into a container-superuser
database and grades the schema; it does not grade roles or credentials — the
smoke-twin carries only `rm_readonly`/`rm_worker` out of the globals dump
(`scripts/lib/restore-container.ts`'s `RESTORE_ROLES`). **Deployed**
credential readiness is gated by the `role-readiness` preflight record
against the **live** target (§4.4), never by the twin. The §5 rehearsal does
now exercise the migration under a non-superuser bootstrap login (see §5) —
that covers the migration SQL's privilege requirements, not which URLs the
cutover host has installed.

**4.3 — Baseline.** Before deployment, record a read-only baseline beside the dump. At minimum,
capture the full `schema_migrations` set, counts for `swarm_sessions`,
`swarm_session_judgements`, `swarm_consensus_receipts`, and (pre-migration)
`wallet_balance_samples`/`wallet_sleeve_samples` `live`/`seed` rows, the
current judge configuration, and a handful of known closed-day allocation
totals from `/allocation`. The baseline is what the D41 read-path switch and
the `asset_prices` seed get compared against after cutover; it is not
reconstructed after the fact.

**4.4 — Live preflight (role/credential gate).** Run the live check against `$HOME/.env` and confirm its redacted target is
the production replica:

```bash
bun backend/scripts/upgrades/0.4.0-to-0.5.0/preflight.ts --emit-receipt
```

The `role-readiness` record is this release's credential gate. With read-only
catalog queries only — `pg_roles`, `pg_auth_members`,
`has_table_privilege`; no `SET ROLE`, no writes — it verifies that the §4.1
cutover has landed on the live target: the four taxonomy roles exist with
0053's attributes, a LOGIN role holds `rm_owner` membership (so
`migrate.ts`'s `SET LOCAL ROLE rm_owner` can run for `0054`+), neither
runtime role holds it, and `rm_worker` carries the grants 0054 expects.
Where a fact cannot be verified read-only the record FAILs with the exact
manual confirmation — it never passes silently.

The preflight is blocking if any of these occur:

- one of the six v0.4.0 migration filenames is absent;
- an unexpected migration is pending — i.e. anything pending other than the
  eighteen v0.5.0 migration files (`0045`-`0061`);
- the recorded `0045`-`0061` migrations are **not a gap-free prefix** of the
  release set, or are recorded out of order — `migrate.ts` applies pending
  migrations in order, so it cannot produce a gap; one means a wrong target
  or a hand-edited `schema_migrations`. A gap-free prefix (production's
  `0045`-`0048`) is a resume and passes, naming what is already applied and
  what is still pending;
- a table belonging to a **pending** migration already exists, or a table
  belonging to an **already-applied** one is missing;
- one of the tables v0.5.0 creates already exists;
- the database contains a migration absent from the checkout;
- a required v0.4.0 judge/receipt table is absent;
- the target is not proven read-only;
- the `role-readiness` record fails: a taxonomy role is absent or
  mis-attributed (e.g. `rm_owner` LOGIN, a runtime role NOLOGIN or
  SUPERUSER), no LOGIN role holds `rm_owner` membership, `rm_app` or
  `rm_worker` holds it, or `rm_worker` lacks an allow-list grant — complete
  §4.1 (`scripts/ops/provision-db-role-taxonomy.sh`; `deployment.md`
  §4.3/§4.3.1) and re-run;
- the deployed credential arrangement cannot be confirmed: on the cutover
  host, `DATABASE_URL` must name `rm_app` (never `doadmin` — `config.ts`
  refuses it at boot), `WORKER_DATABASE_URL` must name `rm_worker`
  (`worker-client.ts` hard-requires it in prod), and the migration run must
  set `MIGRATE_DATABASE_URL` to a login holding `rm_owner` membership
  (`migrate.ts:34`). The preflight cannot read the deployed env; the
  operator confirms these before §6 and records the confirmation in the
  stage report.

`0045`-`0061` pending is the expected, safe state to deploy from. Any other
migration drift has no safe interpretation here: stop and resolve the target
or branch mismatch instead of allowing the application boot to perform an
unplanned schema change.

## 5. Digital smoke-twin rehearsal

Use the same RC, forced installs, backup, and deployment environment intended
for production. The release-specific rehearsal restores the backup into a
local smoke-twin, boots the real stack (which applies whatever the restored
dump leaves pending — `0049`-`0061`, since the dump carries `0045`-`0048`
— via `migrate.ts` on the way up), runs the frontend checks, and runs the
0.5.0 postflight — and the §5 criterion 10 allocation comparison — before
teardown:

```bash
bun install --force
bun install --force --cwd backend
bun backend/scripts/upgrades/0.4.0-to-0.5.0/stage-rehearsal.ts "$RM_BACKUP_DIR" --emit-receipt
```

The smoke-twin restores into a container-superuser database
(`rollout-procedure.md` G7/T1), carrying only `rm_readonly` and `rm_worker`
out of the globals dump. **Its migration run, however, is no longer a
superuser's.** The rehearsal sets `RM_TWIN_PRODUCTION_PRIVILEGES=1`, which
reshapes the restored twin so a non-superuser bootstrap login — the
attributes of the production primary's `doadmin`: `rolsuper=false` with
CREATEROLE/CREATEDB/BYPASSRLS/REPLICATION — owns `public` and everything in
it, then points `MIGRATE_DATABASE_URL` at that login
(`shapeTwinToProductionPrivileges()` in `scripts/lib/restore-container.ts`).

This was added because the previous arrangement could not see an ownership or
grant defect at all: `0053` reached this runbook with three, each of which
failed immediately under a real bootstrap login and passed silently under a
superuser. So a green rehearsal **is** now evidence that the migrations apply
under production's privilege model.

It remains **not** evidence for the credential cutover itself — that the
cutover host's `DATABASE_URL` names `rm_app`, that `WORKER_DATABASE_URL`
names `rm_worker`, that a real bootstrap login holds `rm_owner`. Those are
deployed-environment facts no twin can observe; they are gated by the
`role-readiness` preflight record against the **live** target (§4.4).

The rehearsal is a pass only when all of the following are true:

1. The restored database passes the v0.4.0-baseline and clean-target checks.
2. The stack reaches `/health` and the standard smoke frontend checks pass.
3. Static assembly reaches prerender with a fresh contract dependency.
4. The archive-shaped command is present and correctly named:
   `bun run smoke:archive`.
5. All twenty-four migration files are recorded — `0039`-`0048` plus
   `0049`-`0058` plus both `0059` files plus `0060` and `0061` — and the
   v0.4.0 runtime tables remain intact after boot.
6. `chain_address_floors`, `asset_prices`, and `asset_price_floors` exist
   with `asset_prices` non-empty, and the analytics/source/snapshot tables
   0056-0061 create (e.g. `analytics_overwrite_events`,
   `source_value_versions`, `analytics_ledger_runs`,
   `analytics_output_snapshots`, `swarm_brief_revisions`,
   `analytics_read_mode`, `analytics_parity_observations`) are present.
7. Zero `swarm_sessions` rows still show a `subject_name` that disagrees with
   their subject's current name.
8. `swarm_judge_config.third_party_enabled` is `false`.
9. The boot's migration run authenticated as the non-superuser bootstrap
   login, not as the twin's superuser. The boot log names it
   (`twin reshaped to production privileges: rm_twin_bootstrap (NOT
   superuser) owns N public table(s)`); its absence means the rehearsal fell
   back to a superuser migration and criterion 10 below is the only thing
   that still distinguishes this run from the old, privilege-blind one.
10. The closed-day allocation total computed from the rehearsed stack's new
    `asset_prices` join matches, within rounding, the same day computed from
    the pre-migration fused read. `stage-rehearsal.ts` now computes BOTH
    sides inside the migrated twin (0046 leaves the fused `price_usd` /
    `value_usd` columns in place) for the most recent closed day
    `asset_prices` covers, allowing one cent per symbol, and fails the
    rehearsal on any divergence — this is the one check that catches a bad
    `asset_prices` seed or a broken join, which no structural FAIL/PASS
    check can see. The §4.3 baseline totals remain a separate operator
    cross-check against the live cutover (§7).

11. Product verification passed against the migrated, booted stack. The
    rehearsal runs `scripts/verify-live.ts --tier full` after the frontend
    checks (`scripts/lib/smoke-twin-rehearsal.ts`), which asserts what the
    schema checks above cannot: that the swarm pipeline produced decisions and
    that each published allocation vector still recomputes from its own
    published takes (D42). A WARN on `swarm:vector-recomputable` means no
    `bucket_weights` session was available to recompute — that is NOT a pass of
    the invariant, only an absence of evidence, and it is expected until a
    `bucket_weights` session publishes after `0051` lands.

12. **The rehearsed session seated the WHOLE restored roster.** A twin boot
    adopts every ACTIVE member the dump restored — not only the three personas
    holding a committed key (`scripts/lib/swarm/fixtures/persona-keys.json`).
    Members without one sign with a key their container generates for that boot
    and the harness registers against the restored member id; the boot names
    them (`N seat(s) sign with a SIMULATED per-boot key: …`). This is safe
    ONLY on a twin, and the code restricts it to one: the database is a
    throwaway copy restored per boot, so a re-keyed member never outlives the
    run and never touches the real member (`adoptionFilter`'s `twin` branch,
    `scripts/lib/smoke-mode.ts`).

    Two things enforce it rather than leaving it to a reader: the boot itself
    throws if any active character is left unseated
    (`unseatedActiveCharacters()`), and `verify-live --tier full` records
    `twin-roster:every-active-member-seated` against the live stack. That check
    reports a WARN, not a FAIL, while the session is still inside its collection
    window — the rehearsal runs minutes after the brief publishes, and member
    containers file a few at a time, so "not everyone yet" is unproven rather
    than disproven there. It FAILs once the window has closed or the session
    published without them; the boot-time throw is what makes seating itself
    deterministic. Read the
    boot's `swarm now N seats` line against the roster count — a twin that
    rehearses 3 of 7 members looks EXACTLY like a session where four members
    had nothing to say, which is how it went unnoticed on stage until
    2026-09-18.

Rehearse rollback by checking out `v0.4.0`, running both forced installs, and
booting it against a **fresh** restored copy (the pre-migration dump, not the
smoke-twin post-migration). This release is a real forward-only migration —
`migrate.ts` has no down path — so the database-restore path is the rollback,
not an optional extra; rehearse it and record the restore duration.

Write the stage report with the backup manifest, receipts, RC SHA, boot output,
route-check output, baseline comparison, and operator go/no-go sign-off.

### 5.1 Cut the RC tag

Only once every §5 criterion (1-12) has passed, the rollback rehearsal is
recorded, and the stage report carries the operator's go sign-off. A rejected
stage pass returns to §4/§5 on a fixed commit and consumes no rc number,
because nothing has been tagged yet to increment:

```bash
git tag -a v0.5.0-rc.9 "$RC_SHA" -m 'v0.5.0-rc.9'
git push origin v0.5.0-rc.9
```

`rc.9` is the next free number on this branch only because `rc.1`-`rc.8`
are already taken by the abandoned `releases-0.6.x` attempt (see the header
note); retire those tags first if you want a lower number. From here, `N`
advances only on a **production postflight** failure (§7) — each new
candidate cut only after ANOTHER full pass through §4/§5 on the patched
commit, never by re-tagging a rejected one.

Because the tag is cut here rather than at §3, `P6.rc-tag` in
`backend/scripts/upgrades/0.4.0-to-0.5.0/steps.ts` requires
`P4.preflight-live` and `P5.rehearsal`, and files after both in manifest
order — so `runbook.ts`'s `NEXT` points at `P3.backup` on a fresh release,
not at the tag step.

## 6. Production cutover

**IRREVERSIBLE FORWARD MIGRATION:** `migrate.ts` has no down path. Do not
start without a verified backup, completed rehearsal, and written rollback
authority. Do not manually edit `schema_migrations` at any point.

1. Reconfirm `RC_SHA`, the §5.1 tag (it must point at `RC_SHA`, and the
   stage gates that authorized it must have run against that same commit),
   production database identity, and the fresh backup.
2. Reconfirm the live preflight receipt is current and passed.
3. Deploy in provider order: the v0.5.0 backend/API first (its boot applies
   `0045`-`0061` via `migrate.ts` before it starts serving — run it with
   `MIGRATE_DATABASE_URL` set to the §4.1 bootstrap login for that run
   only), then every worker lane (with `WORKER_DATABASE_URL` = `rm_worker`
   set, per §4.1), then static frontend last. Do not publish the new SPA
   before its API.
4. Run `bun install --force` at the repository root and
   `bun install --force --cwd backend` in the deployment checkout.
5. Start the backend and workers; wait for `/health` and the normal readiness
   gates.
6. Confirm the migration log records the **fourteen pending** v0.5.0
   migration files (`0049`-`0061`; both `0059` files) exactly once, that
   `0045`-`0048` remain recorded at their 2026-09-08 `applied_at` and are
   NOT re-applied, and that `0039`-`0044` are unchanged — per the
   additive-only contract. All twenty-four (`0039`-`0061`) must be recorded
   when the boot completes.
7. Run static assembly/prerender and publish the frontend only after the API
   is healthy.
8. Do **not** flip `swarm_judge_config.third_party_enabled` during cutover;
   verify it stayed `false` after the API is serving.

**6.1 — Analytics ledger read cutover (operator-run, hours after deploy).**
Issue #979/#988's `analytics_read_mode` ships seeded to `compatibility` (the
mode every current-view consumer has always used), so boot is **not** a
cutover: nothing flips automatically, and the release is fully functional on
the compatibility tables. The dual-write parity evidence
(`analytics_parity_observations`) accrues **automatically** once the worker
is up: the hourly `analytics.parity_sweep` cron row (`backend/src/db/seed.ts`)
calls `POST /api/analytics/parity-sweep` through the API's `rm_app` pool, and
each sweep appends one immutable observation per domain (`raw_indicator_history`,
`regime_snapshots`, `research_signals`, `swarm_briefs`). No operator action
populates it.

Arming ledger-mode reads **is** operator-run, by the cutover gate CLI
(`backend/scripts/analytics-ledger-cutover-gate.ts`), and only after the gate
passes — an unbroken run of `matched=true` observations across every domain
spanning at least 24h and 12 observations, newest within 2h (defaults;
env-tunable via `ANALYTICS_CUTOVER_MIN_WINDOW_MS`,
`ANALYTICS_CUTOVER_MIN_OBSERVATIONS`, `ANALYTICS_CUTOVER_MAX_STALENESS_MS`):

```bash
# Check only — exit 0 iff ledger-mode reads are permitted; prints every reason otherwise:
bun backend/scripts/analytics-ledger-cutover-gate.ts
# Arm ledger-mode reads (REFUSED, exit 1, unless the gate passes):
bun backend/scripts/analytics-ledger-cutover-gate.ts --switch ledger
```

The flip is one `UPDATE` on the single-row switch table and is
non-destructive in both directions: `--switch compatibility` is the always
allowed rollback, never gated, and touches no ledger table
(`backend/src/analytics/cutover/read-mode.ts`). Record the gate output and
the switch in the stage report; the release does not require arming
ledger-mode reads to complete, so a team that wants to hold compatibility
mode longer is fine to — the gate keeps passing and the parity sweep keeps
appending.

## 7. Production postflight

Load and assert the writer `DATABASE_URL` as described in
`rollout-procedure.md`, then run:

```bash
bun backend/scripts/upgrades/0.4.0-to-0.5.0/postflight.ts --emit-receipt=P8.postflight-prod
```

The script performs SELECT-only checks: all twenty-four migration files
recorded (`0039`-`0061`), v0.4.0 runtime tables intact, the nineteen new
tables present and `asset_prices` non-empty, zero drifted `subject_name`
rows, `third_party_enabled = false`, and contract freshness in the deployed
checkout.

**7.1 — Product verification (a SEPARATE question, and a separate process).**
Postflight above asks *did the migration land*. It does not ask whether the
product is doing what it claims, and for most of this release's life nothing
did — which is how a release could be certified on schema shape alone. Run:

```bash
bun run verify:live --tier readonly --emit-receipt=P8.verify-prod
```

It attaches to the already-live origin over HTTP and asserts the swarm
pipeline's invariants, including the one the product rests on: that each
published allocation vector equals the mean of its own published takes
(D42), recomputed by an implementation that deliberately does not import
`meanTakeWeights()`.

**`--tier readonly` is not optional here.** A `full` leg DRIVES the product —
publishes sessions, spends inference, sends mail — and against production it
would manufacture the very history the readonly legs exist to audit. `full`
is for a twin or CI.

Read the result with two rules the schema checks never needed:

- **A WARN is not a pass.** `swarm:vector-recomputable` WARNs when no
  `bucket_weights` session was available to recompute. That is an absence of
  evidence, not a satisfied invariant, and it is EXPECTED on production until
  a `bucket_weights` session publishes after `0051` lands — production's
  history predates it. Do not record the invariant as verified on a WARN.
- **Exit 2 is not exit 1.** `1` means a check FAILED — the product is wrong,
  and §8 applies. `2` means the verifier never reached a live stack and
  asserted NOTHING. Both stop the rollout; only one of them is evidence about
  the product.

**7.2 — Manual confirmations.** Still by hand, because they are deployment
hygiene rather than product invariants and no check covers them:

- the closed-day allocation totals captured in the baseline still match after
  the read path switched to the `asset_prices` join;
- static assembly completed without a contract-freshness error;
- `smoke:archive` is the documented production-shaped smoke command;
- no production automation still invokes `demo:*` or assumes bare `smoke` is
  the archive boot;
- judge mode/config (including `third_party_enabled`), schedules, migration
  records, and key row counts match baseline.

(`/health` and page rendering are no longer listed: §7.1 asserts both, and a
bullet that duplicates an executed check is a bullet that goes stale.)

Any failure is a stop condition. Preserve logs, receipts, and the baseline.

## 8. Rollback and completion

For a contract-freshness or static-assembly failure caught before the API
started serving migrated data, stop publishing and roll back the application
checkout to `v0.4.0`, then run both forced installs before restarting — the
migration already applied is additive and does not block a v0.4.0 boot.
Restart with the SAME v0.5.0 credentials (`DATABASE_URL` = `rm_app`,
`WORKER_DATABASE_URL` = `rm_worker`): 0053 moved `public` objects under
`rm_owner` but left both runtime roles their full data-plane grants (0053
grants `rm_app` SELECT/INSERT/UPDATE/DELETE everywhere; 0054's allow-list
covers the v0.4.0 worker's writes), so a v0.4.0 process boots against the
migrated schema. Do not fall back to pre-cutover credentials. For
an unexpected database or runtime invariant failure (a wrong `asset_prices`
seed, a bad join, a drifted `subject_name`, or anything else postflight
catches), the default remediation is the rehearsed encrypted backup restore,
since `migrate.ts` has no down path; an alternate remediation requires the
operator to record it along with the required second sign-off.

For judge-only degradation (an unexpectedly enabled `third_party_enabled`),
set it back to `false` first — that is the narrow reversible mitigation; a
full restore is for a failed release invariant.

If the candidate needs a fix, patch it, repeat the §4 preflight and §5
rehearsal gates against the corrected commit, and cut the next
`v0.5.0-rc.*` at §5.1 only once they pass — in that order, per §5.1. Deploy
only that new RC. Do not re-tag a rejected commit, and do not move the final
tag onto an unverified one.

After clean production postflight, create `v0.5.0` on the exact commit running
in production—the final tag and the successful RC must point to the same
commit—then file the production rollout report and close the release issue.
