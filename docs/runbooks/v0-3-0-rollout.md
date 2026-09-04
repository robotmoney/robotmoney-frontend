# v0.3.0 production rollout

Operator runbook for taking production from **v0.2.2** to **v0.3.0**. Written to
be executed top to bottom at 3am. Every command is copy-pasteable. Destructive
and irreversible steps are marked **DESTRUCTIVE** / **IRREVERSIBLE**.

Companion to [rollout-procedure.md](./rollout-procedure.md) — the
release-independent half of every rollout, which this runbook **cites rather
than repeats**: the read-only role, the dump-and-encrypt procedure, the stage
rehearsal, the `bun smoke` invocation and its flags, and the scheduler-wedge
budget all live there. Where this runbook is silent on a mechanic, that document
is the procedure. Companion to [deployment.md](./deployment.md) for the
credential inventory, the compose topologies, and the handle/id namespace
guard's behaviour.

The policy both runbooks implement is
[`docs/technical/release-runbooks.md`](../technical/release-runbooks.md). Read
its §3 (version tags and release candidates) and §4 (the gate workflow) once
before you start; this runbook executes them and does not restate them.

> **Filename note.** This file is `v0-3-0-rollout.md`, not `v0.3.0-rollout.md`.
> `scripts/lint-docs.sh` enforces `^[a-z0-9]+(-[a-z0-9]+)*\.md$` on every
> `docs/runbooks/*.md`, and a dot in the stem fails that check.

> **Verification status of this document.** Every claim below about repository
> content was checked against `main` at **`de41647`** on 2026-08-21 and cites the
> file it came from. **Nothing below has been executed against production.**
>
> A first §7 rehearsal ran on 2026-08-22 against `v0.3.0-rc.0` (`9a6958f`), on
> the `20260822T014613Z` dump. It confirmed the migration set, `schema_migrations`
> holding both `0032_*` and both `0033_*`, `catchup_policy` on exactly the two
> wallet samplers, the seeded `ops.repair_gaps` row, and a clean postflight —
> and it measured the migration set: **18 ms** of DDL (the spread across the four
> `schema_migrations.applied_at` rows), inside a **973 ms** migrate step whose
> remainder is the one-shot container's own startup. §2.2's "well under a second"
> holds on both readings; the second is the one that sizes a maintenance window.
> It did **not** cover §7's
> remaining three requirements (repair dispatch, the rollback, the passkey
> ceremony), which had no tooling at the time; those are §7.1–§7.3 now. Claims
> still marked as read-from-the-source below have not been observed.

---

## 0. Read this first — four facts that change what "upgrade" means here

### 0.1 ⛔ One prerequisite still blocks starting

**RESOLVED — the v0.2.2 rollout tooling is now on `main`.** It was written
*during* that rollout, on `releases-0.2.x`, and had never been backported;
`main` carried the older, pre-receipt copies and lacked `rollout-receipt.ts`,
`release.ts`, `steps.ts`, `where.ts` and the `rollout:where` script entirely.
All thirteen differing files were brought across in one path-level
fast-forward — `main` had not touched any of them since the fork point, so
there was nothing to merge.

That backport also settled the question an operator would ask next: **all
thirteen were rollout tooling, tests and docs.** No `backend/src/`, no
`frontend/public/`. Shipping v0.3.0 from `main` reverts nothing production is
running. Confirm it still holds before you start:

```bash
git diff --name-status main...v0.2.2    # expect: only the frontend seam-banner
                                        # files from §0.4, if anything
```

**RESOLVED — `backend/scripts/upgrades/0.2.2-to-0.3.0/` now exists.** It carries
`preflight.ts`, `postflight.ts`, `restore-check.ts`, `stage-rehearsal.ts`,
`steps.ts`, `where.ts` and `release.ts`, adapted from the `0.2.1-to-0.2.2/` set
beside them. `bun run rollout:where` points at this release;
`bun run rollout:where:v022` still reaches v0.2.2's probe.
`backend/tests/rollout-steps-0-3-0.test.ts` holds this manifest and this
runbook's `yaml step` blocks in agreement.

**⛔ STILL BLOCKING: Gate A's remaining items (§3.0).** The tracking issue's
Phases are open under the feature freeze and need the recorded exception, and
the §0.4 seam-banner decision is unmade. **`releases-0.3.x` is cut** — it
carries `v0.3.0-rc.0` and 28 commits past `v0.2.2`.

**⛔ ALSO BLOCKING: the AUM price correctness preconditions (T0.1).** The gap
repair this release ships wrote a WETH holding at ~$60,000 — a BTC price —
because its price request named a POOL and never named the TOKEN it meant.
Three tasks from
[the review](../code-review/20260823-review-data-integrity-aum-correctness.md)
are preconditions of §8, not follow-ups to it, because §0.3 makes the repair
live on arrival: the first boot after cutover starts writing prices.

| Task | What it is | State |
|---|---|---|
| **T1.1** | Every OHLCV request names its token (`&token=…&currency=usd`), at both pool-addressed call sites | ✅ `de5cf06` |
| **T1.2** | The response's `meta.base` is asserted against the requested token; a mismatch throws instead of pricing | ✅ `de5cf06` |
| **T0.2** | Every row the OLD path already wrote is quarantined and served as absent | ✅ migration `0036` (§2.2) |

T1.1 and T1.2 fix the WRITER; they cannot fix what it already wrote, which is
what `0036` is for. **Verify the rc you are cutting over actually contains all
three** — `v0.3.0-rc.5` and everything before it predate `de5cf06` and still
price WETH as cbBTC:

```bash
git merge-base --is-ancestor de5cf06 "$RC_TAG" && echo "T1.1/T1.2 present" || echo "⛔ STOP: this rc has the pool-addressed price bug"
git tag --contains de5cf06 | tail -1
```

### 0.2 The `bun smoke` facts from v0.2.2 all still apply

Nothing in this delta changes them, and they are still the three ways this
rollout goes silently wrong. Do not re-derive them — read
[rollout-procedure.md §2](./rollout-procedure.md) and treat all three as in force:

1. `bun smoke` boots a **smoke-shaped** stack, not a production one.
2. **`--db external` is mandatory** — without it you boot an empty database and
   serve an empty site while believing the rollout worked. (v0.2.2 spelled this
   `--external-pg`; that spelling still works and now prints a deprecation
   notice. The data path is one enum flag —
   `--db ephemeral|external|smoke-twin` — and this cutover is `external`.)
3. `AUTOMATION_TOKEN`, `ADMIN_TOKEN` and `SWARM_PUBLIC_BASE_URL` cannot be set
   for a `bun smoke` boot; read `ADMIN_TOKEN` out of the container instead.

Re-verify each against the tip you pin in §1 before you rely on it.

### 0.3 The gap repair is LIVE on arrival; the passkey fix is not

⚠ **This section was inverted on 2026-08-22 — re-read it even if you read this
runbook before.** The largest feature in the delta, the self-healing wallet/AUM
gap repair (#709/#711), used to do nothing until an operator set a measured RPC
budget, and "unset" was the default — so the release shipped its headline
feature inert. That gate is gone. `chain/base-rpc-client.ts` now paces every
chain read from a built-in **0.25 calls/s** default (burst 5), and
`ops.repair_gaps` — seeded `enabled: true` in `backend/src/db/seed.ts` —
therefore **starts dispatching repair work on the first boot, with no
configuration from you.** See decisions.md's PD6 amendment for why.

What that means for this rollout:

- **The wallet AUM and sleeve gaps start closing by themselves**, ten days per
  five-minute run (`WALLET_BACKFILL_MAX_DAYS_PER_RUN`), converging in minutes
  to hours. That
  is the point of the release; it is no longer something you opt into.
- **Every chain read in the app is now paced**, including the request path.
  A `/api/dashboards/vault-economics` cache miss (30s TTL) costs 3 core reads
  plus one per configured adapter, and while a repair sweep is drawing on the
  same bucket those reads queue. This is the shared-bucket contention PD6 names;
  the answer to it is a keyed provider, not a second limiter. Watch dashboard
  latency in §9.
- **§5.2 is now an opt-OUT decision, not an opt-in one.**

Passkeys are the opposite and unchanged: v0.3.0 ships the *fix*, but the fix is
an environment variable you must set (§5.1). Deploy without it and passkeys stay
broken.

### 0.4 One user-visible divergence is unresolved between the branches

`releases-0.2.x` carries **`ff8230c`** — *"fix(ui): remove seed/live seam
disclosure banner from wallet performance"* — cut **after** the `v0.2.2` tag. So
it is **not in production** and **not on `main`**. `main` still has the banner,
and in fact deliberately extended it: `7664cb1` (#713) *added* the SP500 seam
mark that the banner renders.

Verified at `de41647` — `seedShare` / `seamDate` / `seamMessage()` are all still
present in `frontend/public/assets/js/app/alpine/views/wallet-perf.js`.

**This is a product decision, not a merge conflict**, and it must be made before
the release branch is cut, because the two branches disagree about whether that
banner should exist. Record the decision in the tracking issue (§3.0, Gate A).
Doing nothing means v0.3.0 ships the banner.

---

## 1. Release identity

```yaml step
id:          P2.rc-tag
phase:       P2 release identity
section:     §1
host-role:   any
actor:       operator
requires:
  - P1.phases-closed
verify:      git tag -a v0.3.0-rc.<N> <sha> -m 'v0.3.0 release candidate <N>' && git push origin v0.3.0-rc.<N>
```

| | |
|---|---|
| Currently in production | tag **`v0.2.2`** = `bf63dc6` |
| Target | branch **`releases-0.3.x`** — cut it from `main` before preflight (§0.1) |
| What you cut and deploy | **`v0.3.0-rc.N`** at that branch's tip |
| `v0.3.0` | cut only after §9's postflight is clean, at the deployed rc's commit |
| Delta | **resolve it yourself, below.** No count in this file is authoritative |

**The bare `v0.3.0` tag does not exist while you are executing this runbook, and
cannot.** A version tag records what has been proven in production, so it is cut
after both preflight and postflight — release-runbooks.md §3 owns that policy
end to end, including what happens when either fails.

Which `N`: check both before you cut. A previous attempt that failed preflight
or postflight will have consumed rc numbers, and yours is the highest existing
`N` plus one. v0.2.2 consumed **eleven** (`v0.2.2-rc.0` … `v0.2.2-rc.10`) —
budget for more than one.

```bash
git fetch --tags origin
git tag -l 'v0.3.0*'
git ls-remote --tags origin | grep v0.3.0
```

Resolve the tip and the delta at execution time — never from this file:

```bash
git rev-parse origin/releases-0.3.x                  # ← the tip you will tag
git rev-list --count v0.2.2..origin/releases-0.3.x   # ← the delta count
git log --oneline v0.2.2..origin/releases-0.3.x      # ← the delta itself
```

Write down the SHA `git rev-parse` printed and use **that one SHA** for the whole
rollout. If the branch moves mid-rollout you are gating one commit and shipping
another.

---

## 2. What is in the delta

Snapshot taken at `main` = **`de41647`**, 2026-08-21. **Twenty** commits since
`v0.2.2`. Re-resolve against your pinned tip; this table is orientation, not
authority.

### 2.1 The commits

```bash
git log --oneline v0.2.2..main
```

Grouped by what they mean for an operator:

| Group | Commits | Operator impact |
|---|---|---|
| **Wallet/AUM self-healing** | `5788ba6` (#711), `c3540a4` (#667), `7664cb1` (#713) | New five-minute schedule, **opt-out** — it dispatches on arrival (§5.2). Two new migrations. |
| **Analytics/regime** | `d1e769d` (#714), `1bc4e05` (#717), `e88ccf2` (#715), `8e6d4aa` (#712), `c5d5fad` (#716), `ac0bb91` (#718), `6d1042a` (#725) | One migration; changes **existing** schedule behaviour (§4.3). |
| **Admin auth** | `94748a3` (#721) | **Fixes the v0.2.2 known-broken passkey item.** Requires two new env vars (§5.1). |
| **Swarm** | `64cc1d5` (#722), `bac7273` (#723), `f34c918` (#726), `de41647` (#727) | One migration (new table). |
| **SEO** | `149ba76` (#710) | Frontend-only; affects prerendered output. |
| **Deploy/docs** | `7acf6e7` (#720), `b4a2560` (#719) | Removes a build script — see §2.3. |
| **Worktree noise** | `010bf29`, `d0d16b1` | No production effect. |

### 2.2 🔴 The database delta — thirteen migrations

**This is the part of the upgrade that cannot be rolled back by restarting.**

```bash
git diff --name-only v0.2.2 main -- backend/migrations/
```

| Migration | What it does | Shape |
|---|---|---|
| `0032_wallet_balance_samples_strategy_nav_idle_only.sql` | `ALTER TABLE wallet_balance_samples ADD COLUMN strategy_nav_idle_only boolean;` + a `COMMENT` | Additive, nullable, **no default** |
| `0033_wallet_backfill.sql` | `CREATE TABLE chain_day_blocks`, `CREATE TABLE wallet_backfill_state`, one index | Additive, new tables |
| `0034_job_schedules_catchup_policy.sql` | `ADD COLUMN catchup_policy text NOT NULL DEFAULT 'all'` + **an `UPDATE` of live rows** | Additive **plus a data write** |
| `0035_swarm_member_avatar_bytes.sql` | `CREATE TABLE swarm_member_avatars (… bytes bytea …)` | Additive, new table |
| `0036_quarantine_backfilled_samples.sql` | `UPDATE` every `provenance='backfilled'` row in `wallet_balance_samples` / `wallet_sleeve_samples` to `'backfilled-quarantined'`; `DELETE` the `exhausted` rows from `wallet_backfill_state` | **No DDL — a pure data write** |
| `0037_aum_repairable_quarantine.sql` | Create immutable balance/sleeve evidence tables; archive every row on a quarantined date; delete that date from the active tables so verified repair can reuse every natural key | Additive DDL **plus evidence-preserving data writes** |
| `0038_wallet_aum_snapshot_foundation.sql` | Create immutable AUM snapshot-run headers; add nullable snapshot/observation identity to active and evidence rows; enforce canonical exact sets, atomic finalization and published-constituent immutability; add closing/next-block proof to the day-block cache | Additive identity foundation with validated constraints/triggers; legacy rows remain unverified |
| `0039_swarm_judge.sql` | Swap `swarm_sessions`' state CHECK to admit `'judged'`; `CREATE TABLE swarm_judge_config` (one operator-switch row, seeded `mode='off'`) and `CREATE TABLE swarm_session_judgements` + index | Additive new tables **plus one constraint swap on a protected table** |
| `0040_swarm_judgements_append_only.sql` | Install the statement- and row-level `rm_append_only_guard()` triggers on `swarm_session_judgements`; `REVOKE INSERT/UPDATE/DELETE` from `rm_worker` on it and on `swarm_judge_config` | Triggers + grants on a table created earlier in **this same release** |
| `0041_swarm_judgement_soak_record.sql` | `ADD COLUMN applied / applied_skipped_reason / dropped_positions / dropped_disagreements` on `swarm_session_judgements`, with three CHECK constraints | Additive columns with constant defaults; **no historical row is rewritten** |
| `0042_swarm_consensus_receipts.sql` | `CREATE TABLE swarm_consensus_receipts` (one published receipt per session, keyed on `session_id`, with foreign keys to `swarm_sessions` and `swarm_session_judgements`); install the `rm_append_only_guard()` pair on it; install a second `rm_consensus_receipt_immutable()` pair refusing **UPDATE**; `REVOKE INSERT/UPDATE/DELETE` from `rm_worker` | Additive new table, seeded with nothing; **the only table in the set that refuses UPDATE as well as DELETE** |
| `0043_swarm_member_judges.sql` | Add `swarm_members.role` (`member` or `judge`); add `judged_by` and optional `judged_by_member_id` to `swarm_session_judgements`, with an attribution CHECK and the latter's foreign key to `swarm_members` | Additive role and attribution columns; historical worker judgements explicitly remain `robotmoney-in-house` |
| `0044_wallet_backfill_leg_terminal.sql` | Widen `wallet_backfill_state.status`'s CHECK to admit `'blocked'` (`DROP CONSTRAINT` + `ADD CONSTRAINT`); `ADD COLUMN defer_leg text`, `defer_streak int NOT NULL DEFAULT 0`, `defer_leg_at timestamptz` | Additive columns with constant defaults **plus a constraint swap on a table this same release creates (`0033`)** |

**Lock and downtime profile.** The first four are additive DDL. The two `ADD COLUMN`s
are non-rewriting on any supported Postgres — `0032_wallet_*` adds a nullable
column with no default, and `0034`'s `NOT NULL DEFAULT` is instant on PG 11+.
`0034`'s `UPDATE` touches `job_schedules`, which holds single-digit rows.
`0035`'s foreign key is validated against an empty new table, so validation is
trivial — but it does take a lock on `swarm_members` for the duration. Expect
`0037` creates two evidence tables and scans the wallet sample tables for the
quarantined cohort; on an rc-upgraded database it copies and deletes every row
for each affected date in one migration transaction. It takes
`SHARE ROW EXCLUSIVE` on both wallet sample tables so an old draining sampler
cannot insert a row between evidence copy and deletion; reads remain available,
while sample writes wait for the transaction. On a production database
upgrading directly from v0.2.2 that cohort is expected to be empty. Expect the
migration set to complete in well under a second there, but size and time the rc
cohort separately.
`0038` creates one empty append-only header table, adds nullable columns and
indexes, validates all-or-none observation-identity constraints on the four
active/evidence tables, and installs finalization/immutability triggers. Those
constraint validations scan the affected tables under the migration's normal
DDL locks; size them on the smoke-twin rather than assuming a catalog-only change. It
does not backfill snapshot IDs or observation timestamps, and
it leaves old `chain_day_blocks` proof columns NULL so the resolver must
re-resolve them. Published runs require an explicit `AUM_PRODUCER_REVISION`;
unset or blank is recorded as unavailable, never replaced with an invented
revision.
`0039` creates two empty tables and seeds one row into `swarm_judge_config`, but
it also swaps `swarm_sessions`' state CHECK constraint: `DROP CONSTRAINT` +
`ADD CONSTRAINT` takes `ACCESS EXCLUSIVE` on that table and validates the new
predicate against every existing row. Sessions are a low-cardinality table, so
expect this to be brief — but it is the second lock in this set taken on a
table the append-only guard protects (see §2.2.1). `0040` installs four triggers
on the table `0039` just created and issues two `REVOKE`s; `0041` adds four
columns to it with constant defaults, which is catalog-only on PG 11+, plus
three CHECK constraints validated against a table that is empty on a database
coming directly from v0.2.2. `0042` creates one more empty table and declares
two foreign keys — one on `swarm_sessions`, one on `swarm_session_judgements` —
each validated against an empty child table, so validation is trivial, but each
does take a brief lock on its parent for the duration (the same shape as
`0035`'s foreign key on `swarm_members`). It seeds no row: a consensus receipt
exists only once an operator publishes one, which is a post-cutover action and
not part of this delta. `0043` then adds the member-role and judgement-attribution
columns with constant defaults and validates its member foreign key / attribution
CHECK; it writes no historical identity and takes only the normal brief DDL locks.
`0044` swaps `wallet_backfill_state`'s status CHECK — the same `DROP`/`ADD
CONSTRAINT` shape as `0039`'s, so it takes `ACCESS EXCLUSIVE` on that table and
validates the new predicate against every existing row — then adds three
columns with constant defaults, catalog-only on PG 11+. On a production database
upgrading directly from v0.2.2 the table is unpopulated (`0033` ships in this
same release, see below), so the validation scan is against zero rows; size it
separately on an rc-upgraded smoke-twin, where the backfill has had rows to
write.
**Confirm that on the smoke-twin (§7) rather than trusting it here** — §2.2's timings
are read off the DDL, not measured.

`0036` and `0037` are the exceptions to "additive DDL", and on **production they are expected to
touch zero rows**. They process rows the wallet backfill wrote, and the backfill
(`0033`, #709/#711) ships in THIS release — a database at v0.2.2 has never run
it, so there is nothing tagged `provenance='backfilled'` for `0036` to find and
`wallet_backfill_state` does not yet exist as a populated table. It matters on
any database that has already run a `v0.3.0-rc.*`: **every smoke-twin**, and any stack
an rc was ever deployed to. Confirm which side you are on before the cutover:

```bash
psql "$DATABASE_URL" -c "SELECT provenance, count(*) FROM wallet_balance_samples GROUP BY 1 ORDER BY 1;"
```

A row count against `backfilled` on production would mean an rc reached it, and
that is a different conversation from this runbook — stop and establish how
before continuing. On a smoke-twin, expect the count to move to
`backfilled-quarantined` and the served AUM history to lose exactly those days.

### 2.2.1 ⚠ Two migrations reuse a number already applied in production

`0032` and `0033` each now name **two different files**, one of which production
already applied during v0.2.2:

| Prefix | Already in production | New in this release |
|---|---|---|
| `0032` | `0032_append_only_history.sql` | `0032_wallet_balance_samples_strategy_nav_idle_only.sql` |
| `0033` | `0033_swarm_member_uuid_ids.sql` | `0033_wallet_backfill.sql` |

**This is safe, and here is the evidence rather than the reassurance.**

`backend/src/db/migrate.ts` keys the ledger on the **full filename**, not the
numeric prefix:

- the table is `schema_migrations (name text PRIMARY KEY, …)`,
- the skip test is `if (applied.has(file)) continue;` where `file` is the whole
  basename,
- the insert is `INSERT INTO schema_migrations (name) VALUES (${file})`.

So `0032_wallet_…sql` is a distinct ledger entry from `0032_append_only_history.sql`
and **will** be applied. There is no silent skip.

Ordering is also safe. Files run in `.sort()` filename order, and `_append` sorts
before `_wallet`, `_swarm` before `_wallet` — so on a fresh database the
append-only guard is installed *before* the new wallet migrations run, which is
the same relative order production will see. And no new migration **removes a
row from** a protected table: `APPEND_ONLY_TABLES` in
`backend/src/db/append-only-guard.ts` lists sixteen tables, and none of
`wallet_balance_samples`, `chain_day_blocks`, `wallet_backfill_state`,
`swarm_member_avatars`, `swarm_judge_config` or `job_schedules` is among them.
`swarm_session_judgements` **is** on that list, but `0039` creates it and `0040`
protects it inside this very release — it does not exist on the v0.2.2 database
the guard is being read against, and `0041`'s `ADD COLUMN … DEFAULT` rewrites no
row and deletes none. `swarm_consensus_receipts` is the same shape one migration
later: `0042` creates it AND protects it in the same file, so it likewise does
not exist on the database the guard is being read against.

Three nuances the list does surface, and all of them are LOCKS rather than
writes:

- `swarm_members` **is** protected, and `0035` declares
  `member_id … REFERENCES swarm_members(id) ON DELETE CASCADE`. The cascade is
  unreachable — the guard refuses every `DELETE` on `swarm_members`, so it can
  never fire — but adding the constraint does take a brief lock on that table.
- `swarm_sessions` **is** protected, and `0039` swaps its state CHECK constraint
  to admit `'judged'`. `ALTER TABLE … DROP/ADD CONSTRAINT` removes no row, and
  `rm_append_only_guard()` fires `BEFORE DELETE OR TRUNCATE` only, so it cannot
  fire here either — but the validation does take `ACCESS EXCLUSIVE` on the
  table for the duration.
- `swarm_sessions` and `swarm_session_judgements` are both protected, and `0042`
  declares a foreign key to each from the new `swarm_consensus_receipts`.
  Neither key cascades, both are validated against an empty child table, and
  adding a constraint removes no row — so again a lock, briefly, and never a
  guard trip.
- `swarm_members` and `swarm_session_judgements` are protected, and `0043`
  adds role / attribution columns plus a foreign key and CHECK constraint. The
  migration alters metadata and validates constraints; it neither deletes nor
  rewrites a protected history row.

All of them appear in `MIGRATION_TOUCHED_TABLES`, because that constant means
"creates, alters, locks, or writes" — it is the roster of the release's SCOPE,
and it stays complete. **`append-only-safety` does not read it to decide risk.** The check
scans each migration's own SQL for the statements the guard actually refuses —
`DELETE FROM`, `TRUNCATE`, `DROP TABLE` against a protected table — plus any
statement that disables, drops or replaces an immutability guard, which is the
one destructive change the row trigger structurally cannot see happen to itself.
A lock is therefore not a collision, and **`append-only-safety` PASSes for 0035,
0039, 0042 and 0043** (issue #815). It names those tables in its PASS detail, as locked
and not written, so the distinction stays visible rather than silent.

**Installing a guard is not removing one.** 0032, 0040 and 0042 all install
idempotently with `DROP TRIGGER IF EXISTS x; CREATE TRIGGER x …`, and 0042 opens
with `CREATE OR REPLACE FUNCTION rm_consensus_receipt_immutable()` to define its
own new guard. Reading either as tampering would block the release for *adding*
protection, so the check exempts exactly two narrow cases, and it reports both
rather than hiding them:

- a guard trigger dropped by a migration that also **contains** a **static**
  `CREATE [OR REPLACE] TRIGGER <guard-name> … ON <that same table>`. *Contains*,
  not *executes*: the check reads text and does not evaluate control flow, so a
  correctly-named re-creation inside `IF false THEN … END IF` would exempt the
  drop. A dynamically-built re-creation does not qualify — and does not need to,
  because the matching drop in those migrations is built the same way and is
  invisible to the scan;
- a `CREATE OR REPLACE FUNCTION` naming a guard function that exists neither on
  the database nor in an earlier migration of this release.

The limit is that neither compares definitions, so a migration that reinstalled a
*weaker* guard would read like one that reinstalled the same guard — §2.2's table
is where you check that. What the exemption will **not** do is take a migration's
word for it: a drop whose table is merely *named* nearby, without a re-creation
targeting it, still fails.

**"Protected" is not one set, and not only the append-only roster.** Three
kinds of guard are in play, and the check reads all three: `rm_append_only_guard()`
via `APPEND_ONLY_TABLES`, the table-specific pairs 0037/0038 install via
`AUM_GUARD_TRIGGERS`, and whatever the live database's own trigger catalog
reports. It also matters *when*: 0037 archives and then **deletes** rows from
`wallet_balance_samples` and `wallet_sleeve_samples`, and **0038 guards those
same tables afterwards**. That delete is correct — the guard does not exist yet
when it runs — and the same delete in a later migration would abort the boot. So
the check reads each migration's guard installations out of the files and grades
a removal against the protection in force *at the point that migration applies*.
The ordering this release depends on is therefore computed and re-checked on
every run, not assumed.

> **Read the PASS, do not skim it.** The check reports what it FOUND, in three
> buckets, and the bucket is the claim:
>
> - *removals against tables no guard covers, before or after this release* —
>   `wallet_backfill_state` (0036), an operational ledger by design;
> - *removals that run **before** this release installs the guard for their
>   table* — 0037's two sample-table deletes, each naming `0038_…` as the file
>   that guards it afterwards. **These are correct only in this migration
>   order.** If the set is reordered or extended, re-read this list against §2.2;
> - *protected tables locked or altered but **not** written* — `swarm_members`,
>   `swarm_sessions`, `swarm_consensus_receipts` and the rest;
> - *guard triggers dropped where the same migration also contains a re-creation
>   for that table* — 0042's immutability pair, the idempotent install idiom,
>   reported so you can see the drops were seen. The line says "presence is what
>   is checked, not execution" because that is what it means: it is not proof the
>   trigger is back.
>
> A PASS that lists zero statements on a release that clearly deletes something
> is a signal that the scan is not seeing the file, not a clean bill of health.

**What the check cannot see, and you therefore still read here.** It matches text
in the migration files, so a removal built with dynamic SQL
(`EXECUTE format('DELETE FROM %I', t)`) is invisible to it — 0040 legitimately
rebuilds its append-only triggers that way. Its other limits (indirect removals
via view/rule/cascade, bare-name table matching, statement splitting) all err
towards flagging a safe release rather than passing an unsafe one, and every one
of them is enumerated in the header block above `scanMigrationSql()` in
`backend/scripts/upgrades/0.2.2-to-0.3.0/preflight.ts`. So: §2.2's migration
table is still the thing you read; the check is what stops that reading from
going stale.

**This pattern has already shipped.** v0.2.2 itself carried two `0029_*` files
(`0029_admin_auth_recovery.sql`, `0029_admin_passkey.sql`) and applied both in
production. The duplicate prefix is untidy, not dangerous.

> **Preflight must still assert it.** "Safe by code reading" is not the same as
> "observed on this database". §6.1's `append-only-safety` check exists for exactly this.

### 2.3 A dangling reference introduced by this delta

`7acf6e7` (#720) **deleted `scripts/cloudflare-statics.sh`**, but
`docs/runbooks/deployment.md:103` still cites it by path as though it runs. That
is a stale reference in the deployment runbook this document names as its
companion. Verified at `de41647`: the file does not exist, the citation does.

It is documentation-only and blocks nothing, but fix it before the release
branch is cut so the shipped docs do not describe a script that is gone. Same
for `docs/architecture.md:388,394` and `docs/decisions.md:577,1579` — check
whether each reads as history (fine) or as instruction (not fine).

---

## 3. Go/no-go gates

Each gate is blocking. Run them in the stated order — the order is the point:
the dump is proven before anything reads the live database, and the live replica
is read before the primary is touched at all.

These map one-to-one onto release-runbooks.md §4. Mirror them as checkboxes on
the v0.3.0 tracking issue (#661) per §6 of that policy.

### 3.0 Gate A — code readiness (release-runbooks.md §4.1)

```yaml step
id:          P1.phases-closed
phase:       P1 authorize
section:     §3.0
gate:        A
host-role:   any
actor:       agent
ttl:         24h
verify:      gh issue view 661 --json body -q .body   # then: where.ts --record P1.phases-closed
```

All of the following must be true. **Tick them on #661, not here** — this
runbook states the requirement; release-runbooks.md §6 puts the checkbox on the
tracking issue, which is why no runbook in this repo carries tickable state.

- Release tracking issue **#661** is complete — every Phase in its tasklist
      closed. As of 2026-08-21 five Phases are open (#655, #656, #657, #662,
      #675). **A feature freeze that leaves Phases open must record the
      exception, the reason, and operator sign-off on #661** — release-runbooks.md
      §1 permits skipping a gate only that way.
- **DONE.** The v0.2.2 rollout tooling is backported from `releases-0.2.x` to `main`
      (done — see §0.1).
- **DONE.** `backend/scripts/upgrades/0.2.2-to-0.3.0/` exists with
      `preflight.ts`, `postflight.ts`, `restore-check.ts`, `stage-rehearsal.ts`,
      `steps.ts`, `where.ts` and `release.ts` (see §0.1).
- The §0.4 seam-banner decision is recorded on #661, and `main` reflects it.
- The §2.3 dangling `cloudflare-statics.sh` references are resolved.
- `releases-0.3.x` is cut from `main` and carries every commit the release
      needs (`git log --oneline v0.2.2..origin/releases-0.3.x`).

### 3.1 Gate C — backup taken, restored, and clean (order 1, run FIRST)

```yaml step
id:          P3.baseline
phase:       P3 backup
section:     §3.1
host-role:   stage
actor:       agent
artifacts:
  - pre-upgrade-baseline-*.txt
ttl:         48h
verify:      rollout-procedure.md §5's baseline capture, then: where.ts --record P3.baseline
```

```yaml step
id:          P3.backup
phase:       P3 backup
section:     §3.1
host-role:   stage
actor:       agent
artifacts:
  - rm-preupgrade-<STAMP>.dump.gpg
  - rm-globals-<STAMP>.sql.gpg
ttl:         48h
verify:      rollout-procedure.md §5.1 + §5.2, then: where.ts --record P3.backup
```

```yaml step
id:          P3.schedules
phase:       P3 backup
section:     §3.1
host-role:   stage
actor:       agent
artifacts:
  - rm-swarm-schedules-*.txt
verify:      rollout-procedure.md §5.4's psql block, then: where.ts --record P3.schedules
```

```yaml step
id:          P3.gate-c
phase:       P3 backup
section:     §3.1
gate:        C
host-role:   stage
actor:       script
requires:
  - P3.backup
depends-on:
  - backend/scripts/upgrades/0.2.2-to-0.3.0/preflight.ts
  - backend/scripts/upgrades/0.2.2-to-0.3.0/release.ts
  - backend/scripts/lib/preflight-utils.ts
  - backend/scripts/lib/checks.ts
  - backend/migrations/**
  - scripts/lib/restore-container.ts
  - scripts/lib/postgres-image.ts
  - backend/scripts/upgrades/0.2.2-to-0.3.0/restore-check.ts
ttl:         48h
verify:      bun scripts/upgrades/0.2.2-to-0.3.0/restore-check.ts $RM_BACKUP_DIR --emit-receipt
```

Unchanged from v0.2.2. Follow
[rollout-procedure.md §5](./rollout-procedure.md) verbatim — the dump, the separate
globals dump, the encryption-at-rest step, and the restore verification. The
only thing that changes for v0.3.0 is which migrations the restored smoke-twin must
then accept (§7).

🔴 **The dump is a credential store.** rollout-procedure.md §5.2 is not optional; encrypt at
rest.

### 3.2 Gate B — preflight verdict against the live replica (order 2)

§6. Must exit 0.

### 3.3 Gate D — the `rm_worker` role exists (order 3)

Unchanged from the archived v0.2.2 runbook's Gate D. v0.3.0 adds no new role. Note that #692 (the
production role taxonomy) is **out of scope for this release** — production
still connects as `doadmin` and that remains a known, accepted gap (§11.2).

> **Gate D has no manifest step for this release, by decision.** It asserts
> nothing v0.3.0 changes, and a step that always passes trains an operator to
> skim the ones that do not. Record it on #661 instead. If #692 lands, this
> becomes a step. Stated here because `bun run rollout:where` cannot show a gate
> that is not in the manifest, and a gate silently absent from the probe is
> worse than one deliberately kept out of it.

### 3.4 Gate E — no long-running transactions (order 4)

Unchanged from the archived v0.2.2 runbook's Gate E. Still worth running even though this
migration set is additive and fast: `0034`'s `ADD COLUMN` takes an
`ACCESS EXCLUSIVE` lock on `job_schedules`, briefly, and a long-lived
transaction holding a conflicting lock will block it.

> **Gate E has no manifest step either — it is a check inside Gate B.**
> `P4.preflight-live` runs `blocking-xacts` ("no transaction older than 60s"),
> and that IS this gate. A second step would give one fact two homes, which is
> the bug the manifest exists to prevent.
>
> This is why `P4.preflight-live` carries a **2h TTL** rather than the 12h it
> used to: a long-running transaction is a condition that goes stale by the
> minute, so a preflight that was Gate-E-clean this morning says nothing about
> tonight. `P7.cutover` now requires `P4.preflight-live`, so that short TTL is
> what forces a fresh preflight immediately before the irreversible step — which
> is what Gate E has always actually meant.

### 3.5 Gate F — the config decisions in §5 are made and recorded

```yaml step
id:          P1.config-decided
phase:       P1 authorize
section:     §3.5
gate:        F
host-role:   any
actor:       operator
verify:      record all three decisions on the tracking issue, then: where.ts --record P1.config-decided
```

New for v0.3.0. The runtime variables fail in OPPOSITE directions, and the
build identity determines whether a future snapshot can be published, which is
why this is one config gate (§0.3). Deploying without deciding is not neutral:
an unset `WEBAUTHN_ORIGIN` ships a passkey fix that stays broken, while an unset
`BASE_RPC_MAX_CALLS_PER_SEC` ships a gap repair that starts sweeping on its own.

- `WEBAUTHN_ORIGIN` decided (§5.1)
- `BASE_RPC_MAX_CALLS_PER_SEC` decided — including a deliberate "leave it
      unset and let the built-in default heal" (§5.2)
- `AUM_PRODUCER_REVISION` set to the exact commit being built (§5.3)

---

## 4. What the upgrade changes about a running system

Beyond the schema. Read this before §5; it is what the config decisions are for.

### 4.1 A new gap-repair schedule appears

`seed()` inserts `ops.repair_gaps` (`cron: "*/5 * * * *"`, `enabled: true`). It
will show up in `job_schedules` on the first boot and start being dispatched
every five minutes. (An earlier cut of this release seeded it hourly at `25 *
* * *`; `seed()` now deletes that superseded row, so a re-seeded deployment
carries exactly one.) Unless you set `BASE_RPC_MAX_CALLS_PER_SEC=0`, each run **detects
gaps and enqueues ONE `wallet.backfill_window` job carrying up to ten days**,
and its `job_runs` output names the days dispatched, deferred, retrying and
exhausted. (It was one job per day until #739 (`79063ab`) batched on the axis
the provider meters; `wallet.backfill_day` survives only as a registered handler
so rows a pre-upgrade dispatcher left in the queue still drain.) At `0` it
declines instead and records the refusal — a visible no-op, not an error.
Postflight verifies whichever world you are in (§9 Check 5).

### 4.2 Passkey verification changes behaviour

`94748a3` makes `relyingParty()` in
`backend/src/api/routes/admin-webauthn.ts` prefer `WEBAUTHN_ORIGIN` /
`WEBAUTHN_RP_ID` when set, falling back to the request's own `url.origin`.
`docker-compose.yml` now forwards both. Unset, behaviour is exactly v0.2.2's —
which is to say still broken behind cloudflared. Set, passkeys work.

### 4.3 ⚠ Existing schedules change catch-up semantics

`0034` does not only add a column — it **writes to live rows**:

```sql
UPDATE job_schedules
   SET catchup_policy = 'collapse-per-bucket'
 WHERE kind IN ('wallet.sample_balances', 'wallet.sample_sleeves');
```

Both are per-minute schedules. After the upgrade, a backlog of missed same-day
firings collapses to one read instead of replaying every one. That is the
intended fix (#717) and it interacts directly with v0.2.2's scheduler-wedge
warning: a long maintenance window used to mean a per-minute schedule replaying
hours of reads against a metered RPC. **Record `catchup_policy` for both rows in
the §7 baseline** so postflight can prove the `UPDATE` landed.

### 4.4 Avatar bytes now live in the database

`0035` stores uploaded avatars as `bytea` in `swarm_member_avatars`. Empty on
arrival, so no immediate effect — but it means **future database dumps grow with
uploaded image data**. Worth knowing before the next backup-size surprise.

---

## 5. Config before cutover

Follow [rollout-procedure.md §7](./rollout-procedure.md) for *how* environment reaches
the api container under `bun smoke`, and for the three variables you cannot set
at all. This section covers only what is **new in v0.3.0**.

All new variables are documented in `.env.example` and are **commented out by
default**. The two runtime controls remain explicit operator decisions;
`AUM_PRODUCER_REVISION` must be set to the commit being built so a future
publisher can prove its producer. None may be filled with a guessed fallback.

### 5.1 ✅ `WEBAUTHN_ORIGIN` — set this, or passkeys stay broken

This is the whole of the fix for v0.2.2's §10.1 known-broken item. cloudflared
terminates TLS in front of the plain-HTTP Bun server, so the request's own
`url.origin` is `http://…` while the browser's real origin is `https://…`;
WebAuthn compares origin including scheme, so every ceremony fails.

In repo-root `.env` on the production host:

```sh
WEBAUTHN_ORIGIN=https://robotmoney.network
# WEBAUTHN_RP_ID — leave UNSET unless the relying party's hostname must differ
# from that origin's hostname. .env.example says so explicitly.
```

⚠ **Do not derive this from a request header.** The PR message for `94748a3`
records why: trusting a forwarded header would let any caller pick the
relying-party origin.

### 5.2 ⚖ `BASE_RPC_MAX_CALLS_PER_SEC` — the gap-repair opt-OUT

⚠ **This section previously recommended leaving the budget unset, on the
reading that unset meant "ship the code, change no behaviour". That is no longer
what unset does.** Since 2026-08-22 the transport paces from a built-in default
and the backfill runs on it. Rehearse §7 against the *current* behaviour, not a
remembered reading of this section.

| value | pacing | gap repair |
|---|---|---|
| **unset** (the default) | 0.25 calls/s, burst 5 | **ON** |
| a positive number | that rate | ON |
| `0` | none — the pre-v0.3.0 transport | OFF (declines each run) |
| unreadable (a typo) | the 0.25 default | ON |

There is deliberately **one** token bucket shared by every chain read in the app
— the per-minute wallet samplers, the vault/buyback readers, and the backfill
alike. `.env.example` records why: the public Base RPC meters per-IP, so a second
independent limiter would sum to 2× against one bucket and 429 both. That is how
the 2026-08-10 storm killed `vault.sample_share_price` (#651).

**Where the 0.25 came from, and why it is not a vendor figure.** Base publishes
no rate limit for `https://mainnet.base.org` — its docs say only that the public
endpoints are "rate-limited and not suitable for production traffic". The
measured figures in `docs/technical/markets-asset-pricing-ingest.md` §3.4 (~5-token
bucket, ~0.55 calls/s) came **from a developer IP**, and the default is half of
that, leaving margin for this droplet's IP being worse. A guess that is too low
costs throughput, not 429s, and a 429 or `-32016` drains the bucket so the
limiter corrects itself downward.

**Recommendation: leave it unset.** The gap repair is the point of this release
(§0.3) and a measurement that never happened is what kept it switched off. Two
things to watch instead of a value to set:

1. **Dashboard latency during the first sweep.** The repair draws on the same
   bucket as the request path; a `/api/dashboards/vault-economics` cache miss
   needs 3 + N adapter reads. If it degrades unacceptably, raise the rate rather
   than turning repair off — the contention is PD6's, and the real fix is a
   keyed provider on its own bucket.
2. **`GET /api/admin/gaps` draining.** That is the whole deliverable. If it does
   not shrink over the first few hours, the repair is not working and the
   `job_runs` output for `ops.repair_gaps` says why.

Set `0` only if you need the pre-v0.3.0 transport back. Record whichever way you
decide on #661.

Companion knobs: `BASE_RPC_RATE_BURST` (default 5, the measured bucket depth),
`WALLET_BACKFILL_MAX_DAYS_PER_RUN` (default 10),
`WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY` (default 3),
`GECKO_OHLCV_MIN_INTERVAL_MS` (default 3000 — a GeckoTerminal control, unrelated
to the RPC budget).

### 5.3 ✅ `AUM_PRODUCER_REVISION` — exact build identity, no fallback

Set this in the repo-root `.env` to the full commit being built:

```sh
AUM_PRODUCER_REVISION=<full git rev-parse HEAD output>
```

Every backend Compose build passes that value as a Docker build argument, and
`backend/Dockerfile` exposes the exact bytes to the container. This is a build
identity: changing `.env` without rebuilding the image does not change it.
Blank or unset deliberately stays blank, and future snapshot code records the
run as producer-revision unavailable; it must not substitute a package version,
branch, timestamp, or `unknown`. Before cutover, compare the value to
`git rev-parse HEAD` and rebuild through the normal §8 command.

---

## 6. Preflight

```yaml step
id:          P4.preflight-live
phase:       P4 preflight
section:     §6
gate:        B
host-role:   stage
actor:       script
requires:
  - P3.gate-c
depends-on:
  - backend/scripts/upgrades/0.2.2-to-0.3.0/preflight.ts
  - backend/scripts/upgrades/0.2.2-to-0.3.0/release.ts
  - backend/scripts/lib/preflight-utils.ts
  - backend/scripts/lib/checks.ts
  - backend/migrations/**
ttl:         2h
verify:      bun scripts/upgrades/0.2.2-to-0.3.0/preflight.ts --emit-receipt
```

Run it from anywhere in the checkout — the `.env.readonly` path resolves off the
script's own location, not the cwd.

```bash
export RM_BACKUP_DIR=~/rm-backup-v030
bun scripts/upgrades/0.2.2-to-0.3.0/preflight.ts --emit-receipt
```

Exit codes: **0** = SAFE TO UPGRADE, **1** = BLOCKED, **2** = could not run.
A preflight that cannot connect is a **failure, not a skip** — exit 2 is not a
pass. The harness, receipt format and verdict wording are
[rollout-procedure.md §1](./rollout-procedure.md)'s and are unchanged.

### 6.1 What it checks, and why each one is here

| Check | Asserts | Why this release needs it |
|---|---|---|
| `server-version` | PG 11+ | 0034's `NOT NULL DEFAULT` is instant on 11+ and a full table REWRITE before it (§2.2) |
| `schema-migrations` | pending set is **exactly** this release's twelve; none already applied; no orphans | Catches a half-applied release, and a checkout that is not the rc you think |
| `prior-release` | all six v0.2.2 migrations present | The upgrade's premise. A miss means `.env.readonly` points somewhere else |
| `append-only-safety` | guard installed, and **no statement** in this release removes a row from a table protected *at the point that migration runs*, or disables a guard | §2.2.1 — this is what makes the out-of-order warning harmless |
| `clean-targets` | the 9 tables and 29 columns do not exist yet | A target that already exists means an out-of-band change |
| `catchup-baseline` | records `job_schedules` as it stands now | §4.3 — 0034 OVERWRITES these rows; §9 check 3 grades against this |
| `wallet-samples-size` | row count + table size | Informational, for §7's wall-clock measurement |
| `blocking-xacts` | nothing older than 60s | Would queue in front of 0034/0035/0037's locks. Goes stale by the minute |
| `wedged-schedules` | which schedules are ALREADY late | So postflight does not blame the cutover for a pre-existing wedge |

### 6.2 ⚠ Expect exactly one warning, and read it rather than skimming it

`schema-migrations` returns **WARN**, not PASS, and that is the correct output
for this release:

```
[WARN] schema-migrations  13 migration(s) will be applied on the next boot:
         0032_wallet_balance_samples_strategy_nav_idle_only.sql
         0033_wallet_backfill.sql
         0034_job_schedules_catchup_policy.sql
         0035_swarm_member_avatar_bytes.sql
         0036_quarantine_backfilled_samples.sql
         0037_aum_repairable_quarantine.sql
         0038_wallet_aum_snapshot_foundation.sql
         0039_swarm_judge.sql
         0040_swarm_judgements_append_only.sql
         0041_swarm_judgement_soak_record.sql
         0042_swarm_consensus_receipts.sql
         0043_swarm_member_judges.sql
         0044_wallet_backfill_leg_terminal.sql
       NOTE: 1 of these sort BEFORE the newest applied file
             (0033_swarm_member_uuid_ids.sql):
         0032_wallet_balance_samples_strategy_nav_idle_only.sql
```

`0032_wallet_…` sorts before an already-applied `0033_`, so the runner will
apply it "out of order" relative to a fresh database. **`append-only-safety` is
the check that makes that harmless** — on a fresh database the DDL it would have
run after is the append-only guard, the guard is already installed here, and no
migration in this set removes a row from a protected table.

> **So: a WARN on `schema-migrations` is the expected shape of a clean v0.3.0
> preflight.** It is the only warning THIS RELEASE'S MIGRATION SET produces by
> design; `blocking-xacts`, `wedged-schedules` and `catchup-baseline` may also
> WARN, but each of those is a statement about the database you are pointed at
> right now, not about the release, and each says what to do about it.
>
> **`append-only-safety` must be PASS.** If it FAILs, stop — it names the exact
> file and statement it objects to, and that line is a migration removing
> protected history or turning a guard off. There is no known-benign failure of
> this check to read past.

## 7. Digital-smoke-twin rehearsal (release-runbooks.md §4.4)

```yaml step
id:          P5.rehearsal-boot
phase:       P5 rehearsal
section:     §7
host-role:   stage
actor:       script
requires:
  - P3.gate-c
  - P1.config-decided
depends-on:
  - backend/src/**
  - backend/migrations/**
  - backend/Dockerfile
  - frontend/**
  - scripts/**
  - docker-compose.yml
  - docker-compose.smoke.yml
  - package.json
  - bun.lock
  - backend/scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts
ttl:         48h
verify:      bun scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts $RM_BACKUP_DIR --emit-receipt
```

```yaml step
id:          P5.postflight-smoke-twin
phase:       P5 rehearsal
section:     §7
host-role:   stage
actor:       script
requires:
  - P5.rehearsal-boot
depends-on:
  - backend/scripts/upgrades/0.2.2-to-0.3.0/postflight.ts
  - backend/scripts/upgrades/0.2.2-to-0.3.0/release.ts
  - backend/scripts/lib/postflight-utils.ts
  - backend/scripts/lib/checks.ts
  - backend/src/db/seed.ts
  - backend/migrations/**
  - backend/scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts
ttl:         48h
verify:      bun scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts $RM_BACKUP_DIR --emit-receipt   # runs this step
```

Non-negotiable, and for this release it is where every §2 claim gets tested for
the first time. Procedure and container mechanics: follow
[rollout-procedure.md §6](./rollout-procedure.md) exactly.

The smoke-twin must run the **same rc** you intend to deploy, against a restore of the
**production** dump from Gate C.

### 7.1 The graded sequence

**The rehearsal runs a graded SEQUENCE inside one smoke-twin window**, not a single
check. `stage-rehearsal.ts` holds the smoke-twin up for the whole sequence — the
duration of its `onReady` hook *is* the smoke-twin's lifetime — under a 45-minute
ceiling enforced by the driver, because G1 says a rehearsal terminates on its
own and G5 says spend is bounded. Expect **5–30 minutes** depending on how many
wallet days the dump is missing, against ~1 minute before the sequence existed.

| # | Check | Blocking | Proves |
|---|---|---|---|
| 1 | `postflight` | **yes** | Every §9 check against the migrated smoke-twin, including the migration wall-clock. §6.4: a smoke-twin that fails postflight is a failed cutover, so the sequence stops here. |
| 2 | `repair-dispatch` | no (FAIL still fails the run) | §4.1 — `ops.repair_gaps` fires and **dispatches**: `job_runs` names the days enqueued, deferred, retrying and exhausted, and **exactly one** `wallet.backfill_window` job carries **exactly** those days. A run that dispatched nothing while days were missing FAILs rather than passing vacuously, and N single-date windows FAIL — that is the un-batching regression #739 exists to prevent. |
| 3 | `repair-completion` | no — **WARN only** | One dispatched day writes rows carrying `provenance='backfilled'`, in **either** backfilled series (`wallet_balance_samples` or `wallet_sleeve_samples`). |

> **Why check 3 can only WARN.** Completing a day means real reads against
> `mainnet.base.org` paced at 0.25 calls/s, plus historical prices from a
> third-party free tier. A hard failure there would make whether v0.3.0 ships
> depend on a provider's mood on rehearsal day. The path this release *changed*
> is the dispatch, and check 2 grades that hard.

> **Check 2 does not wait for the next wall-clock slot, and no longer needs to cheat
> to avoid it.** `db/seed.ts` enqueues a cold-start `ops.repair_gaps` job on
> every boot, so the first run happens within a worker tick of readiness — the
> same first run production gets. The observation simply watches for it.
>
> It used to rewind `next_run_at` by one cadence instead. That was not
> idempotent within an hour (the scheduler dedupes the re-enqueue on
> `dedupe_key`, so a second observation in the same cadence reported "the work
> never ran" and blamed the analytics lane), and it observed a run production
> would never make.

What this release requires the smoke-twin to prove, and what now proves it. Record
each result in the stage rehearsal report (§7.4):

| Requirement | Proven by |
|---|---|
| All twelve migrations apply in one boot, no error, no skip | boot log's twelve `migrated:` lines, then postflight's `migrations-applied` |
| `schema_migrations` holds **both** `0032_*` and **both** `0033_*` — §2.2.1 observed rather than reasoned | postflight `migrations-applied` |
| `0034`'s `UPDATE` hit exactly the two wallet samplers, everything else left `'all'` | postflight `catchup-policy` |
| `ops.repair_gaps` present, enabled, **exactly one row** | postflight `repair-schedule` |
| It **dispatches** with the budget unset; `job_runs` names enqueued and deferred days; a `wallet.backfill_window` job covers every one of them | check 2 `repair-dispatch` |
| One day completes and writes `provenance='backfilled'` | check 3 `repair-completion` |
| **The migration set's wall-clock** — the number that sizes the maintenance window | postflight `migrations-applied` reports it from `schema_migrations.applied_at`, which nothing used to read. §2.2's "well under a second" is no longer a prediction |
| Every §9 postflight check green against the smoke-twin | check 1 |
| The §10 rollback procedure executed at least once on the smoke-twin | **§7.2 — a separate command**, not part of this sequence |
| A real passkey ceremony (§9 Check 7) | **§7.3 — a separate command**, and it does not substitute for `P8.acceptance` |

### 7.2 Rollback rehearsal — §10, executed on the smoke-twin

```yaml step
id:          P5.rollback-smoke-twin
phase:       P5 rehearsal
section:     §7.2
host-role:   stage
actor:       operator
requires:
  - P5.postflight-smoke-twin
ttl:         48h
verify:      execute §10 against a migrated smoke-twin per the procedure below, then: where.ts --record P5.rollback-smoke-twin
```

⚠ **Nothing has ever executed this, for any release.** There is no rollback
driver in the repo, no down migrations, and the word "rollback" appears in none
of the three v0.2.2 rehearsal reports. §10 asserts the rollback is survivable
because the migrations are additive — and then says, correctly, that this is *"a
reading of the schema, not an observation."* This step is where it stops being a
reading. It is a **manual procedure with a manifest step** rather than a script,
so that the requirement is at least tracked; automating it is open work.

Run it against a smoke-twin that has **already been migrated by the rc**, because that
is the state a real rollback starts from. Rehearsing against an unmigrated
database rehearses nothing.

1. Restore a smoke-twin and boot the rc against it so the twelve migrations apply
   (`bun run smoke-twin:rehearse` does the restore-and-migrate half).
2. Capture `job_schedules` **before** rolling back — kind, cron, enabled,
   timezone, payload, next_run_at, catchup_policy. This is the *before* side of
   rollout-procedure.md §10's IRREVERSIBLE seed-clobber warning.
3. Stop the rc's stack, then follow
   [rollout-procedure.md §10](./rollout-procedure.md)'s commands against the
   surviving smoke-twin — **`--external-pg`, never `--db external`**, because the tag
   you check out predates the enum.
4. Record each of the following. Every one is a claim this runbook currently
   makes on the strength of reading the schema:

   | Observation | The claim it discharges |
   |---|---|
   | All twelve v0.3.0 migrations still in `schema_migrations` | §10: "the schema stays where the migration left it" |
   | v0.2.2 boots and serves against the new schema; `job_runs` advances | §10: additive DDL is survivable — rollout-procedure.md §10's mandatory question 1 |
   | `job_schedules` diffed against step 2's capture | The seed clobber, observed for the first time; it is why `P3.schedules` is an evidence artifact |
   | What happens to the surviving `ops.repair_gaps` row | **Expect trouble.** v0.2.2's `seed()` has never heard of this kind, so the row survives *still enabled* and the old scheduler keeps enqueuing a job its worker has no handler for. Record what actually happens — if it retry-loops, §10 needs a new bullet telling operators to disable it after a rollback. |
   | `DELETE FROM schema_migrations WHERE name = '0034_…'` inside a transaction is **refused** | `0032_append_only_history.sql` protects the ledger itself, so a true ledger rewind would require dropping the guard. Expect SQLSTATE `0A000`, then `ROLLBACK`. **Do not drop the trigger.** |
   | Whether passkey sign-in still works | rollout-procedure.md §10's mandatory question 2. §10 already states the expected answer — no — so this confirms it rather than discovers it. |

### 7.3 Passkey ceremony on a tunnel-published smoke-twin

```yaml step
id:          P5.passkey-smoke-twin
phase:       P5 rehearsal
section:     §7.3
host-role:   stage
actor:       operator
requires:
  - P5.postflight-smoke-twin
  - P1.config-decided
ttl:         48h
verify:      complete a passkey ceremony against the tunnel-published smoke-twin, then: where.ts --record P5.passkey-smoke-twin
```

§9 Check 7 — a real passkey ceremony against a public HTTPS origin — is this
release's headline acceptance criterion, and without this step its **first real
test is production, after the irreversible cutover.** That is avoidable:
`WEBAUTHN_ORIGIN` is plumbed to the api container
(`docker-compose.yml`, `${WEBAUTHN_ORIGIN:-}`), unlike `AUTOMATION_TOKEN` and
`SWARM_PUBLIC_BASE_URL` which §0.2 says cannot be set — so a smoke-twin published on
the stage tunnel can run the real ceremony.

```sh
WEBAUTHN_ORIGIN=https://stage.robotmoney-labs.dev   bun run smoke-twin --reuse --backup-dir $RM_BACKUP_DIR
```

🔴 **Claim the admin credential as your very first action — before you open the
public URL, before anything else.** `scripts/smoke-twin.ts`'s own banner spells out
why: the restored `admin_credential` is typically *empty*, and on the tunnel
whoever reaches the admin surface first claims admin over a database of **real
member data**. This is not a footnote to the procedure; it is step one of it.

Then register a passkey and sign in with it. The proof is a stored credential
plus a verified assertion — the bug being fixed is an origin mismatch, which
fails the assertion, so a completed sign-in *is* the fix working.

When you are done: tear the stack down and `bun run smoke:clean` immediately. The
smoke-twin volume holds password hashes, session tokens and member emails.

⚠ **This does not substitute for `P8.acceptance`.** It proves the fix works
behind a cloudflared TLS tunnel — which is the exact v0.2.2 failure mode — but
at origin `stage.robotmoney-labs.dev`, not `robotmoney.network`. It cannot prove
the production origin string is right. §9 Check 7 remains the production
confirmation, for the same reason `postflight.ts` refuses to guess which
database it graded.

### 7.4 Stage rehearsal report (release-runbooks.md §4.5)

```yaml step
id:          P6.report
phase:       P6 sign-off
section:     §7.4
host-role:   any
actor:       operator
requires:
  - P5.postflight-smoke-twin
  - P4.postflight-dryrun
  - P5.rollback-smoke-twin
  - P5.passkey-smoke-twin
artifacts:
  - stage-rehearsal-report-*.md
verify:      write the report per rollout-procedure.md §6.5, then: where.ts --record P6.report
```

The gate passes only when the report exists, all acceptance criteria pass, and
the operator has signed off. Use rollout-procedure.md §6.5's format.

---

## 8. Cutover

```yaml step
id:          P7.cutover
phase:       P7 cutover
section:     §8
host-role:   cutover
actor:       agent
requires:
  - P6.report
  - P4.preflight-live
  - P1.config-decided
depends-on:
  - backend/src/**
  - backend/migrations/**
  - backend/Dockerfile
  - frontend/**
  - scripts/**
  - docker-compose.yml
  - docker-compose.smoke.yml
  - package.json
  - bun.lock
verify:      SMOKE_PROJECT=rm_prod bun smoke -- --db external --no-tui   # then: where.ts --record P7.cutover
```

⛔ **Preconditions specific to this release, beyond the `requires:` above.**
**T1.1**, **T1.2** and **T0.2** (§0.1) must all be in the rc being deployed. The
first two are `de5cf06`; the third is migration `0036`, which this boot applies.
An rc missing them writes prices that may describe a different asset, starting
at the first boot (§0.3) — and §9's checks do not grade a number, so nothing
downstream will catch it. Run §0.1's `git merge-base` check against the tag you
are about to deploy.

🔴 **IRREVERSIBLE.** The invocation, every flag and the reason for each, the
`BOOT_STATUS` capture, the `CI` must-be-unset check, and the scheduler-downtime
budget are **unchanged from v0.2.2**. Follow
[rollout-procedure.md §8](./rollout-procedure.md) — do not paraphrase it from memory.

The only v0.3.0-specific differences:

1. **Ten migrations** (§2.2). The boot log must show ten
   `migrated: …` lines and then `migrations up to date`. `0036` is a
   data write rather than DDL, and on production it is expected to change
   nothing — see §2.2 for why, and for the check that confirms it.
2. **`seed()` inserts a new schedule row** — `ops.repair_gaps` (§4.1) — in
   addition to rewriting the `swarm.*` rows rollout-procedure.md §5.4 describes.
3. **The `.env` from §5 must be in place before the boot**, not after.
   `WEBAUTHN_ORIGIN` is read at request time, so a later restart would pick it
   up — but a passkey ceremony attempted in between will fail, and that is
   indistinguishable from the bug still being present.
4. **`AUM_PRODUCER_REVISION` must equal the deployed commit before the image is
   built.** A restart cannot repair an image built with an empty or stale value.

⏱ **The scheduler-wedge budget from rollout-procedure.md §8.2 still binds.** A window longer
than the shortest enabled schedule's cadence wedges it. `wallet.sample_balances`
and `wallet.sample_sleeves` are per-minute, so the practical budget is **about a
minute** — and note the sequencing trap: `0034` is what makes those two
schedules collapse a backlog, and it has not been applied yet while the stack is
down. Plan the window as though the old semantics apply, because during the
cutover they do.

---

## 9. Post-cutover verification

```yaml step
id:          P4.postflight-dryrun
phase:       P4 preflight
section:     §9
host-role:   stage
actor:       agent
requires:
  - P4.preflight-live
depends-on:
  - backend/scripts/upgrades/0.2.2-to-0.3.0/postflight.ts
  - backend/scripts/upgrades/0.2.2-to-0.3.0/release.ts
  - backend/scripts/lib/postflight-utils.ts
  - backend/scripts/lib/checks.ts
  - backend/src/db/seed.ts
  - backend/migrations/**
ttl:         2h
verify:      run §9's checks as rm_readonly against the replica, then: where.ts --record P4.postflight-dryrun
```

```yaml step
id:          P8.postflight-prod
phase:       P8 verify
section:     §9
host-role:   cutover
actor:       script
requires:
  - P7.cutover
depends-on:
  - backend/scripts/upgrades/0.2.2-to-0.3.0/postflight.ts
  - backend/scripts/upgrades/0.2.2-to-0.3.0/release.ts
  - backend/scripts/lib/postflight-utils.ts
  - backend/scripts/lib/checks.ts
  - backend/src/db/seed.ts
  - backend/migrations/**
verify:      bun scripts/upgrades/0.2.2-to-0.3.0/postflight.ts --emit-receipt=P8.postflight-prod
```

```yaml step
id:          P8.acceptance
phase:       P8 verify
section:     §9
host-role:   any
actor:       operator
requires:
  - P8.postflight-prod
verify:      complete a passkey sign-in at the public origin, then: where.ts --record P8.acceptance
```

```yaml step
id:          P9.tag
phase:       P9 close
section:     §9
host-role:   any
actor:       operator
requires:
  - P8.acceptance
verify:      git tag v0.3.0 <deployed-rc-commit> && git push origin v0.3.0
```

Run [rollout-procedure.md §9](./rollout-procedure.md)'s mechanics first — they verify the
system is alive and serving, and none of that changed. **Dry-run them before
cutover** (rollout-procedure.md §9.1) so you know they discriminate.

Then these, specific to v0.3.0. **Checks 1–6 and 8 are what
`postflight.ts` runs** — one row per `record()` in the script, and
`rollout-steps-0-3-0.test.ts` fails if this table and the script stop naming the
same set. Check 7 is the one no script can do.

```bash
bun scripts/upgrades/0.2.2-to-0.3.0/postflight.ts --emit-receipt=P8.postflight-prod
```

All must pass before `v0.3.0` is tagged.

| # | Check id | Asserts | Expected |
|---|---|---|---|
| 1 | `migrations-applied` | all twelve names in `schema_migrations` | Both `0032_*`, both `0033_*`, and `0034_*` through `0043_*` present — the check that would catch a runner keyed on the numeric prefix or an omitted migration |
| 2 | `strategy-nav-column` | the column exists and **the migration populated nothing** | `NULL` on every row untouched since `0032_wallet_*` applied. Rows written or re-upserted afterwards carry values legitimately — that is the sampler working. (This row used to expect `NULL` on *every* row, which postflight can never see: it runs after readiness, so the per-minute sampler has always written by then, and the check WARNed on every clean run.) |
| 3 | `catchup-policy` | 0034's `UPDATE` hit exactly the intended rows | `collapse-per-bucket` on exactly the two wallet samplers; `all` everywhere else (§4.3). This grades the schedule-policy write; `0036`/`0037` separately quarantine and archive wallet samples |
| 4 | `new-tables` | all nine new tables and all 29 new columns exist | The two operational tables may already hold repair rows after cold-start dispatch; the two evidence tables may already hold an rc-era quarantined cohort archived by `0037`; snapshot-run headers remain empty until a P1 publisher lands; **`swarm_judge_config` is never empty — `0039` seeds its single operator-switch row**. A WARN reports counts for reconciliation; empty is only the fresh direct-from-v0.2.2 expectation |
| 5 | `repair-schedule` | the new schedule is seeded, exactly once, enabled, on the cron `release.ts` names — and what the DEPLOYMENT reports it actually did | Read from the latest `ops.repair_gaps` `job_runs` row: dispatched, or declined and why. It used to infer this from `BASE_RPC_MAX_CALLS_PER_SEC` **in postflight's own process**, which is not where the app reads it — an operator taking §5.2's opt-out via `.env` was told the backfill "WILL dispatch" while production had it off. **Confirm it is the world you chose** (§5.2) |
| 6 | `append-only-intact` | every shared and AUM-specific guard survived the migration | **Both** shared triggers live and enabled on all sixteen protected tables, plus all eleven exact P0/P1 evidence, constituent-immutability, header-immutability and finalization triggers present with `ENABLE ALWAYS`. A missing, disabled, or replication-bypassable guard fails postflight |
| 7 | ⛔ **manual — no script** | a real passkey ceremony completes against the public HTTPS origin | The §5.1 fix, verified end-to-end. Step `P8.acceptance`; reading `WEBAUTHN_ORIGIN` back out of the container proves configuration, not function |
| 8 | `no-wedge` | the cutover window did not wedge a schedule | `next_run_at` within one cadence of now. Compare against preflight's `wedged-schedules` baseline — a pre-existing wedge is not this release's damage |

> **Check 7 is the release's headline acceptance criterion.** v0.3.0's admin-auth
> claim is that passkeys work behind the tunnel. Reading `WEBAUTHN_ORIGIN` back
> out of the container proves configuration, not function. Do the ceremony.

### Only when every check is clean — tag `v0.3.0`

At the deployed rc's commit, on `releases-0.3.x`, per release-runbooks.md §3.

---

## 10. Rollback

Trigger, procedure and the "what rollback does NOT undo" list are structurally
unchanged from [rollout-procedure.md §10](./rollout-procedure.md). Two v0.3.0-specific
notes:

**None of the twelve migrations has a down migration.** The runner is forward-only
(`backend/src/db/migrate.ts` header). Rollback means restoring the Gate C dump,
not reversing DDL.

⚠ **Use `--external-pg`, not `--db external`, in the rollback boot.** The tag you
check out is v0.2.2, whose argv parser predates the `--db` enum *and* silently
ignored flags it did not recognise — so `--db external` there boots an empty
ephemeral database while looking like it worked. `--external-pg` is understood by
both. rollout-procedure.md §10 carries the same warning.

**Rolling back the code without rolling back the database is survivable here,
and that is unusual.** The new schema objects and columns are backward-compatible:
v0.2.2's code does not
know about `strategy_nav_idle_only`, `catchup_policy`, snapshot identity, or the nine new tables,
and ignores them. The data-write residues are `0034`'s schedule-policy update
and `0036`/`0037` moving suspect rc-era samples out of the active tables into
immutable evidence. v0.2.2 never reads `catchup_policy`, while archived suspect
rows remain intentionally unserved. **Verify this on the smoke-twin (§7.2) before relying on it**;
until that step runs it is a reading of the schema, not an observation. This is
[rollout-procedure.md §10](./rollout-procedure.md)'s mandatory question 1, and
that is its answer.

🔴 **Question 2 — rolling back DOES change who can authenticate.** rollout-procedure.md
§10 requires this release to answer it, and the answer is not the reassuring one.
v0.3.0's headline fix is `WEBAUTHN_ORIGIN` (§5.1); v0.2.2 does not have it, so
**rolling back re-breaks passkey sign-in behind the tunnel** — v0.2.2's own
§10.1 known-broken item, returning. Two consequences:

- A rollback taken to recover from a bad cutover **also costs you passkey
  access**, at the moment you are least able to absorb a second problem. Confirm
  another route to the admin surface is available *before* you trigger one.
- An admin lockout is therefore **not** a reason to roll back in this release —
  unlike v0.2.2, where rollback restored `ADMIN_TOKEN` access and was itself the
  remedy. That property does not carry forward.

---

## 11. Known-broken in v0.3.0 — do not try to fix during the rollout

### 11.1 Carried forward from v0.2.2

Re-read [the archived v0.2.2 runbook's §10](../archive/v0-2-2-rollout.md) and re-check each item
against the pinned rc. **§10.1 (passkeys behind the TLS tunnel) is FIXED in this
release** — that is what §5.1 and §9 Check 7 are for. Do not carry it forward
without re-testing.

### 11.2 `doadmin` is still the runtime credential

Issue **#692**, open and **deliberately out of scope** for v0.3.0 (feature
freeze, 2026-08-21). Production connects as the managed-Postgres superuser,
which owns the tables — so the append-only guard shipped in v0.2.2 protects
against honest mistakes made through the application and nothing else. A role
with table ownership can `ALTER TABLE … DISABLE TRIGGER` or `DROP TABLE`
outright; that was verified against a live database during the PR #686 security
review. **Accepted risk for this release. Do not attempt a role split during the
cutover.**

### 11.3 A signed take stops verifying after its author's key rotates

Issue **#697**, open and out of scope. Re-registration hard-deletes the old key
row, and the read path publishes the member's *currently active* key rather than
the one that signed the take. Retention is guaranteed by v0.2.2's append-only
guard; verifiability is not. **Nothing in this rollout makes it worse, and
nothing in this rollout fixes it.**

### 11.4 Images are still built from source on the host

Issue **#680**, open and out of scope. Nothing builds or publishes a tagged
image, so "deploy the rc" still means moving a checkout and building on the
droplet — the deployed artifact is identified by a checkout, not by a tag. This
runbook's §1 insistence on pinning one SHA for the whole rollout is the
compensating control.

### 11.5 The seam-banner divergence

§0.4. If Gate A was signed off without resolving it, record here which way
v0.3.0 shipped, so the next release does not rediscover it.

---

## 12. Production rollout report (release-runbooks.md §4.9)

```yaml step
id:          P9.report
phase:       P9 close
section:     §12
host-role:   any
actor:       operator
requires:
  - P9.tag
artifacts:
  - rollout-report-*.md
verify:      fill in §12, then: where.ts --record P9.report
```



Fill in and commit. The release tracking issue closes only after this exists and
the final tag is on `releases-0.3.x`. Items below are stated as claims to
confirm in prose — the tickable copy lives on #661.

### RC deployed

- rc tag: `v0.3.0-rc.___`
- commit: `________`
- deployed at: `________`

### Config decisions taken

- `WEBAUTHN_ORIGIN`: `________`
- `BASE_RPC_MAX_CALLS_PER_SEC`: set to `______` / **left unset — repair runs
  on the 0.25 calls/s default** / **set to 0 — repair off** (§5.2)
- Seam banner (§0.4): shipped / removed

### Timeline

- Gate C (backup + restore verified): `________`
- Twin rehearsal report: `________`
- Migration wall-clock on the smoke-twin: `______`
- Cutover start / stack up: `________`
- Postflight complete: `________`

### Migration result

- Four `migrated:` lines observed
- Both `0032_*` and both `0033_*` in `schema_migrations` (§2.2.1)
- `catchup_policy` correct on exactly the two wallet samplers (§4.3)

### Postflight result

- rollout-procedure.md §9 mechanics green
- §9 Checks 1–8 green
- §9 Check 7 — a real passkey ceremony completed

### Rollback details (if applicable)

### Final version tag

```bash
git tag v0.3.0 <deployed-rc-commit>
git push origin v0.3.0
```

### Backport TODO

Per release-runbooks.md §7 — **not a go/no-go gate**, owed once `v0.3.0` is
tagged. Known debt at the time of writing:

- Any correction made to the backported rollout tooling during this rollout —
  it now lives on `main`, so a fix made on `releases-0.3.x` owes a trip back.
- `ff8230c` (§0.4), if the decision was to keep the banner removed.
- Any fix made directly on `releases-0.3.x` during this rollout.

### Operator sign-off
