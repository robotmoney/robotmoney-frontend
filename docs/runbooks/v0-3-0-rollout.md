# v0.3.0 production rollout

Operator runbook for taking production from **v0.2.2** to **v0.3.0**. Written to
be executed top to bottom at 3am. Every command is copy-pasteable. Destructive
and irreversible steps are marked **DESTRUCTIVE** / **IRREVERSIBLE**.

Companion to [deployment.md](./deployment.md) — that document owns the
credential inventory, the compose topologies, and the handle/id namespace
guard's behaviour. Companion to
[v0-2-2-rollout.md](./v0-2-2-rollout.md) — the previous release's runbook, which
this one **cites rather than repeats** for every procedure that has not changed
(the read-only role, the dump-and-encrypt procedure, the `bun smoke` invocation
and its flags, the scheduler-wedge budget). Where this runbook is silent on a
mechanic, v0.2.2's §-numbered treatment of it is still the procedure.

The policy both runbooks implement is
[`docs/technical/release-runbooks.md`](../technical/release-runbooks.md). Read
its §3 (version tags and release candidates) and §4 (the gate workflow) once
before you start; this runbook executes them and does not restate them.

> **Filename note.** This file is `v0-3-0-rollout.md`, not `v0.3.0-rollout.md`.
> `scripts/lint-docs.sh` enforces `^[a-z0-9]+(-[a-z0-9]+)*\.md$` on every
> `docs/runbooks/*.md`, and a dot in the stem fails that check.

> **Verification status of this document.** Every claim below about repository
> content was checked against `main` at **`de41647`** on 2026-08-21 and cites the
> file it came from. **No claim below has been executed against production or
> against a digital twin** — this runbook is written *before* the rehearsal, not
> after it. §7's rehearsal is what converts these from "read from the source" to
> "observed to happen". Sections that cannot be written until the rehearsal runs
> say so explicitly rather than guessing.

---

## 0. Read this first — four facts that change what "upgrade" means here

### 0.1 ⛔ Two prerequisites block starting. Neither is optional.

**(a) The rollout tooling v0.2.2 used does not exist on `main`.** The
receipt-driven rollout machinery was written *during* the v0.2.2 rollout, on
`releases-0.2.x`, and was never backported. `main` has the older, pre-receipt
copies. Verified — present on `v0.2.2`, absent from `main` at `de41647`:

| File | On `v0.2.2` | On `main` |
|---|---|---|
| `backend/scripts/lib/rollout-receipt.ts` | yes | **missing** |
| `backend/scripts/upgrades/0.2.1-to-0.2.2/release.ts` | yes | **missing** |
| `backend/scripts/upgrades/0.2.1-to-0.2.2/steps.ts` | yes | **missing** |
| `backend/scripts/upgrades/0.2.1-to-0.2.2/where.ts` | yes | **missing** |
| `package.json` → `"rollout:where"` | yes | **missing** |

Reproduce:

```bash
git diff --name-status main...v0.2.2
```

Thirteen files differ, and **all thirteen are rollout tooling, tests and docs** —
no `backend/src/`, no `frontend/public/`. That is the reassuring half: the
unbackported work carries **no runtime-code regression**, so shipping v0.3.0
from `main` does not revert anything production is running. The unreassuring
half is that the tooling this runbook wants to reuse has to be brought to `main`
first.

**(b) There is no `backend/scripts/upgrades/0.2.2-to-0.3.0/` and no
`releases-0.3.x` branch.** Verified at `de41647`: `backend/scripts/upgrades/`
contains exactly one entry, `0.2.1-to-0.2.2/`, and
`git branch -r | grep releases-` returns only `origin/releases-0.2.x`.

Both are §4.1 code-readiness work (release-runbooks.md), and both must land
before Gate A below can be evaluated. See §3.0.

### 0.2 The `bun smoke` facts from v0.2.2 all still apply

Nothing in this delta changes them, and they are still the three ways this
rollout goes silently wrong. Do not re-derive them — read
[v0-2-2-rollout.md §0](./v0-2-2-rollout.md) and treat all three as in force:

1. `bun smoke` boots a **demo-shaped** stack, not a production one.
2. **`--external-pg` is mandatory** — without it you boot an empty database and
   serve an empty site while believing the rollout worked.
3. `AUTOMATION_TOKEN`, `ADMIN_TOKEN` and `SWARM_PUBLIC_BASE_URL` cannot be set
   for a `bun smoke` boot; read `ADMIN_TOKEN` out of the container instead.

Re-verify each against the tip you pin in §1 before you rely on it.

### 0.3 This release is mostly *inert on arrival*, and that is deliberate

The largest feature in the delta — the self-healing wallet/AUM gap repair
(#709/#711) — **does nothing until you give it a budget.** `ops.repair_gaps` is
seeded `enabled: true` (`backend/src/db/seed.ts`), but it refuses to dispatch
repair work while `BASE_RPC_MAX_CALLS_PER_SEC` is unset, and unset is the
default. Turning it on is a §5 decision you make deliberately, not a consequence
of the upgrade. The same is true of passkeys: v0.3.0 ships the *fix*, but the
fix is two environment variables you must set (§5.1).

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

| | |
|---|---|
| Currently in production | tag **`v0.2.2`** = `bf63dc6` |
| Target | branch **`releases-0.3.x`** — **does not exist yet**, see §0.1(b) |
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
| **Wallet/AUM self-healing** | `5788ba6` (#711), `c3540a4` (#667), `7664cb1` (#713) | New hourly schedule, **opt-in** (§5.2). Two new migrations. |
| **Analytics/regime** | `d1e769d` (#714), `1bc4e05` (#717), `e88ccf2` (#715), `8e6d4aa` (#712), `c5d5fad` (#716), `ac0bb91` (#718), `6d1042a` (#725) | One migration; changes **existing** schedule behaviour (§4.3). |
| **Admin auth** | `94748a3` (#721) | **Fixes v0.2.2 §10.1.** Requires two new env vars (§5.1). |
| **Swarm** | `64cc1d5` (#722), `bac7273` (#723), `f34c918` (#726), `de41647` (#727) | One migration (new table). |
| **SEO** | `149ba76` (#710) | Frontend-only; affects prerendered output. |
| **Deploy/docs** | `7acf6e7` (#720), `b4a2560` (#719) | Removes a build script — see §2.3. |
| **Worktree noise** | `010bf29`, `d0d16b1` | No production effect. |

### 2.2 🔴 The database delta — four migrations

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

**Lock and downtime profile.** All four are additive DDL. The two `ADD COLUMN`s
are non-rewriting on any supported Postgres — `0032_wallet_*` adds a nullable
column with no default, and `0034`'s `NOT NULL DEFAULT` is instant on PG 11+.
`0034`'s `UPDATE` touches `job_schedules`, which holds single-digit rows.
`0035`'s foreign key is validated against an empty new table, so validation is
trivial — but it does take a lock on `swarm_members` for the duration. Expect
this migration set to complete in well under a second on production-sized data.
**Confirm that on the twin (§7) rather than trusting it here** — §2.2's timings
are read off the DDL, not measured.

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
the same relative order production will see. And no new migration **writes to** a
protected table: `APPEND_ONLY_TABLES` in
`backend/src/db/append-only-guard.ts` lists fourteen tables, and none of
`wallet_balance_samples`, `chain_day_blocks`, `wallet_backfill_state`,
`swarm_member_avatars` or `job_schedules` is among them.

One nuance the list does surface: `swarm_members` **is** protected, and `0035`
declares `member_id … REFERENCES swarm_members(id) ON DELETE CASCADE`. The
cascade is unreachable — the guard refuses every `DELETE` on `swarm_members`, so
it can never fire — but adding the constraint does take a brief lock on that
table. See the lock profile above.

**This pattern has already shipped.** v0.2.2 itself carried two `0029_*` files
(`0029_admin_auth_recovery.sql`, `0029_admin_passkey.sql`) and applied both in
production. The duplicate prefix is untidy, not dangerous.

> **Preflight must still assert it.** "Safe by code reading" is not the same as
> "observed on this database". §6 Check 3 exists for exactly this.

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

All of the following must be true. **Every one of them is currently false** as
of `de41647`.

- [ ] Release tracking issue **#661** is complete — every Phase in its tasklist
      closed. As of 2026-08-21 five Phases are open (#655, #656, #657, #662,
      #675). **A feature freeze that leaves Phases open must record the
      exception, the reason, and operator sign-off on #661** — release-runbooks.md
      §1 permits skipping a gate only that way.
- [ ] The §0.1(a) rollout tooling is backported from `releases-0.2.x` to `main`.
- [ ] `backend/scripts/upgrades/0.2.2-to-0.3.0/` exists with `preflight.ts`,
      `postflight.ts`, `restore-check.ts` and `stage-rehearsal.ts`, adapted from
      the `0.2.1-to-0.2.2/` set.
- [ ] The §0.4 seam-banner decision is recorded on #661, and `main` reflects it.
- [ ] The §2.3 dangling `cloudflare-statics.sh` references are resolved.
- [ ] `releases-0.3.x` is cut from `main` and carries every commit the release
      needs (`git log --oneline v0.2.2..origin/releases-0.3.x`).

### 3.1 Gate C — backup taken, restored, and clean (order 1, run FIRST)

Unchanged from v0.2.2. Follow
[v0-2-2-rollout.md §5](./v0-2-2-rollout.md) verbatim — the dump, the separate
globals dump, the encryption-at-rest step, and the restore verification. The
only thing that changes for v0.3.0 is which migrations the restored twin must
then accept (§7).

🔴 **The dump is a credential store.** v0.2.2 §5.2 is not optional; encrypt at
rest.

### 3.2 Gate B — preflight verdict against the live replica (order 2)

§6. Must exit 0.

### 3.3 Gate D — the `rm_worker` role exists (order 3)

Unchanged from v0.2.2 §2 Gate D. v0.3.0 adds no new role. Note that #692 (the
production role taxonomy) is **out of scope for this release** — production
still connects as `doadmin` and that remains a known, accepted gap (§11.2).

### 3.4 Gate E — no long-running transactions (order 4)

Unchanged from v0.2.2 §2 Gate E. Still worth running even though this
migration set is additive and fast: `0034`'s `ADD COLUMN` takes an
`ACCESS EXCLUSIVE` lock on `job_schedules`, briefly, and a long-lived
transaction holding a conflicting lock will block it.

### 3.5 Gate F — the config decisions in §5 are made and recorded

New for v0.3.0. Two of this release's headline changes are inert until an
operator sets an environment variable (§0.3). Deploying without deciding is not
neutral — it ships a passkey fix that stays broken and a gap repair that never
runs.

- [ ] `WEBAUTHN_ORIGIN` decided (§5.1)
- [ ] `BASE_RPC_MAX_CALLS_PER_SEC` decided — including a deliberate "leave it
      off for this release" (§5.2)

---

## 4. What the upgrade changes about a running system

Beyond the schema. Read this before §5; it is what the config decisions are for.

### 4.1 A new hourly schedule appears

`seed()` inserts `ops.repair_gaps` (`cron: "25 * * * *"`, `enabled: true`). It
will show up in `job_schedules` on the first boot and start being dispatched
hourly at :25. With `BASE_RPC_MAX_CALLS_PER_SEC` unset it declines to do work
and records that in `job_runs` — a visible no-op, not an error. Postflight
verifies this either way (§9 Check 5).

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

Follow [v0-2-2-rollout.md §6](./v0-2-2-rollout.md) for *how* environment reaches
the api container under `bun smoke`, and for the three variables you cannot set
at all. This section covers only what is **new in v0.3.0**.

All new variables are documented in `.env.example` and are **commented out by
default** — the upgrade adds no required configuration. Every one below is a
decision to make, not a step to perform blindly.

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

### 5.2 ⚖ `BASE_RPC_MAX_CALLS_PER_SEC` — the gap-repair opt-in

**Unset (the default) means two things at once:** no RPC pacing anywhere — the
exact behaviour that exists today — **and** the self-healing backfill stays off.
`ops.repair_gaps` is seeded and enabled but refuses to dispatch without a budget.
That refusal *is* the opt-in.

There is deliberately **one** token bucket shared by every chain read in the app
— the per-minute wallet samplers, the vault/buyback readers, and the backfill
alike. `.env.example` records why: the public Base RPC meters per-IP, so a second
independent limiter would sum to 2× against one bucket and 429 both. That is how
the 2026-08-10 storm killed `vault.sample_share_price` (#651).

> ⛔ **Do not copy the number out of the docs.** The ~0.55 calls/s figure in
> `docs/technical/data-self-healing.md` §6.5.3 was measured **from a developer
> IP**. `.env.example` calls it "a starting point, not a value to copy." Measure
> the production host's real limit, or leave the budget unset for this release
> and enable it as a separate, observable change.

**Recommendation: leave it unset for the v0.3.0 cutover.** Ship the code, keep
the behaviour change out of the rollout, and turn the backfill on afterwards
when it can be watched on its own. Record whichever way you decide on #661.

Companion knobs, all optional and all inert while the budget is unset:
`BASE_RPC_RATE_BURST`, `WALLET_BACKFILL_MAX_DAYS_PER_RUN` (default 10),
`WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY` (default 3),
`GECKO_OHLCV_MIN_INTERVAL_MS` (default 3000 — a GeckoTerminal control, unrelated
to the RPC budget).

---

## 6. Preflight

**To be written against `backend/scripts/upgrades/0.2.2-to-0.3.0/preflight.ts`,
which does not exist yet (§0.1(b)).** Port it from
`backend/scripts/upgrades/0.2.1-to-0.2.2/preflight.ts` — the harness, exit-code
contract and output format in
[v0-2-2-rollout.md §4](./v0-2-2-rollout.md) all carry over unchanged.

The checks it must make, derived from §2 and §4 of this document:

| # | Check | Why |
|---|---|---|
| 1 | Connected to the **replica** as the **read-only role** | v0.2.2's rule: every preflight read happens on the replica, never the primary |
| 2 | `schema_migrations` contains the six migrations v0.2.2 introduced | Proves the database really is at v0.2.2 |
| 3 | `schema_migrations` contains **neither** `0032_wallet_…` **nor** `0033_wallet_backfill.sql` | §2.2.1 — proves the duplicate prefixes have not already half-applied |
| 4 | The four new migration files hash to what the pinned rc contains | Proves you are gating the artifact you will ship |
| 5 | `wallet_balance_samples` lacks `strategy_nav_idle_only` | The `ADD COLUMN` has a clean target |
| 6 | `job_schedules` lacks `catchup_policy`, and record the current rows | §4.3 — the baseline the postflight `UPDATE` check compares against |
| 7 | `chain_day_blocks`, `wallet_backfill_state`, `swarm_member_avatars` do not exist | Clean targets for the three `CREATE TABLE`s |
| 8 | The append-only guard is installed and intact | v0.2.2 shipped it; a missing guard means restored-unchecked data |
| 9 | No long-running transactions (Gate E) | §3.4 |

Exit non-zero on any failure. **A preflight that cannot connect is a failure, not
a skip.**

---

## 7. Digital-twin rehearsal (release-runbooks.md §4.4)

Non-negotiable, and for this release it is where every §2 claim gets tested for
the first time. Procedure and container mechanics: follow
[v0-2-2-rollout.md §5.3b and §5.5](./v0-2-2-rollout.md) exactly.

The twin must run the **same rc** you intend to deploy, against a restore of the
**production** dump from Gate C.

What this release specifically requires the twin to prove:

- [ ] All four migrations apply, in one boot, with **no error and no skip**.
      Capture `migrated: <file>` lines for all four.
- [ ] After migration, `schema_migrations` holds **both** `0032_*` names and
      **both** `0033_*` names — the §2.2.1 claim, observed rather than reasoned.
- [ ] `0034`'s `UPDATE` set `catchup_policy = 'collapse-per-bucket'` on exactly
      `wallet.sample_balances` and `wallet.sample_sleeves`, and left every other
      schedule at `'all'`.
- [ ] `ops.repair_gaps` appears in `job_schedules`, enabled.
- [ ] With `BASE_RPC_MAX_CALLS_PER_SEC` unset, `ops.repair_gaps` fires at :25
      and **declines** — recorded in `job_runs`, not an error. (§4.1)
- [ ] **Time the migration set.** Record wall-clock. This is the number that
      sizes the maintenance window; §2.2's "well under a second" is a prediction
      from reading the DDL, not a measurement.
- [ ] Every §9 postflight check runs green against the twin.
- [ ] The §10 rollback procedure is executed at least once on the twin.

### 7.1 Stage rehearsal report (release-runbooks.md §4.5)

The gate passes only when the report exists, all acceptance criteria pass, and
the operator has signed off. Use v0.2.2 §5.6's format.

---

## 8. Cutover

🔴 **IRREVERSIBLE.** The invocation, every flag and the reason for each, the
`BOOT_STATUS` capture, the `CI` must-be-unset check, and the scheduler-downtime
budget are **unchanged from v0.2.2**. Follow
[v0-2-2-rollout.md §7](./v0-2-2-rollout.md) — do not paraphrase it from memory.

The only v0.3.0-specific differences:

1. **Four migrations, not six** (§2.2). The boot log must show four
   `migrated: …` lines and then `migrations up to date`.
2. **`seed()` inserts a new schedule row** — `ops.repair_gaps` (§4.1) — in
   addition to rewriting the `swarm.*` rows v0.2.2 §6.5 describes.
3. **The `.env` from §5 must be in place before the boot**, not after.
   `WEBAUTHN_ORIGIN` is read at request time, so a later restart would pick it
   up — but a passkey ceremony attempted in between will fail, and that is
   indistinguishable from the bug still being present.

⏱ **The scheduler-wedge budget from v0.2.2 §7.3 still binds.** A window longer
than the shortest enabled schedule's cadence wedges it. `wallet.sample_balances`
and `wallet.sample_sleeves` are per-minute, so the practical budget is **about a
minute** — and note the sequencing trap: `0034` is what makes those two
schedules collapse a backlog, and it has not been applied yet while the stack is
down. Plan the window as though the old semantics apply, because during the
cutover they do.

---

## 9. Post-cutover verification

Run [v0-2-2-rollout.md §8](./v0-2-2-rollout.md)'s checks first — they verify the
system is alive and serving, and none of that changed. **Dry-run them before
cutover** (v0.2.2 §8.0) so you know they discriminate.

Then these, specific to v0.3.0. All must pass before `v0.3.0` is tagged.

| # | Check | Expected |
|---|---|---|
| 1 | `SELECT name FROM schema_migrations WHERE name LIKE '003%' ORDER BY name;` | Both `0032_*`, both `0033_*`, `0034_*`, `0035_*` all present |
| 2 | `strategy_nav_idle_only` exists on `wallet_balance_samples` and is `NULL` for every pre-existing row | Additive, nothing backfilled |
| 3 | `SELECT kind, catchup_policy FROM job_schedules ORDER BY kind;` | `collapse-per-bucket` on exactly the two wallet samplers; `all` everywhere else (§4.3) |
| 4 | `chain_day_blocks`, `wallet_backfill_state`, `swarm_member_avatars` exist and are empty | Three clean `CREATE TABLE`s |
| 5 | `ops.repair_gaps` present and enabled; after :25 its `job_runs` row shows a **declined** dispatch (budget unset) or real work (budget set) — matching your §5.2 decision | §4.1 |
| 6 | The append-only guard is still installed on all fourteen protected tables | A guard silently lost during migration is the §11.1 failure mode |
| 7 | **A real passkey ceremony completes** against the public HTTPS origin | The §5.1 fix, verified end-to-end rather than by reading `.env` |
| 8 | Per-minute schedules are not wedged — `next_run_at` is within one cadence of now | v0.2.2 §8.2's check; the cutover window is when this breaks |

> **Check 7 is the release's headline acceptance criterion.** v0.3.0's admin-auth
> claim is that passkeys work behind the tunnel. Reading `WEBAUTHN_ORIGIN` back
> out of the container proves configuration, not function. Do the ceremony.

### Only when every check is clean — tag `v0.3.0`

At the deployed rc's commit, on `releases-0.3.x`, per release-runbooks.md §3.

---

## 10. Rollback

Trigger, procedure and the "what rollback does NOT undo" list are structurally
unchanged from [v0-2-2-rollout.md §9](./v0-2-2-rollout.md). Two v0.3.0-specific
notes:

**None of the four migrations has a down migration.** The runner is forward-only
(`backend/src/db/migrate.ts` header). Rollback means restoring the Gate C dump,
not reversing DDL.

**Rolling back the code without rolling back the database is survivable here,
and that is unusual.** All four migrations are additive: v0.2.2's code does not
know about `strategy_nav_idle_only`, `catchup_policy`, or the three new tables,
and ignores them. The one behavioural residue is `0034`'s `UPDATE` — the
`catchup_policy` values persist, but v0.2.2's scheduler never reads that column,
so it changes nothing. **Verify this on the twin (§7) before relying on it**; it
is a reading of the schema, not an observation.

---

## 11. Known-broken in v0.3.0 — do not try to fix during the rollout

### 11.1 Carried forward from v0.2.2

Re-read [v0-2-2-rollout.md §10](./v0-2-2-rollout.md) and re-check each item
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

Fill in and commit. The release tracking issue closes only after this exists and
the final tag is on `releases-0.3.x`.

### RC deployed

- rc tag: `v0.3.0-rc.___`
- commit: `________`
- deployed at: `________`

### Config decisions taken

- `WEBAUTHN_ORIGIN`: `________`
- `BASE_RPC_MAX_CALLS_PER_SEC`: set to `______` / **left unset** (§5.2)
- Seam banner (§0.4): shipped / removed

### Timeline

- Gate C (backup + restore verified): `________`
- Twin rehearsal report: `________`
- Migration wall-clock on the twin: `______`
- Cutover start / stack up: `________`
- Postflight complete: `________`

### Migration result

- [ ] Four `migrated:` lines observed
- [ ] Both `0032_*` and both `0033_*` in `schema_migrations` (§2.2.1)
- [ ] `catchup_policy` correct on exactly the two wallet samplers (§4.3)

### Postflight result

- [ ] v0.2.2 §8 checks green
- [ ] §9 Checks 1–8 green
- [ ] §9 Check 7 — a real passkey ceremony completed

### Rollback details (if applicable)

### Final version tag

```bash
git tag v0.3.0 <deployed-rc-commit>
git push origin v0.3.0
```

### Backport TODO

Per release-runbooks.md §7 — **not a go/no-go gate**, owed once `v0.3.0` is
tagged. Known debt at the time of writing:

- The §0.1(a) tooling, if it was brought to `main` as a copy rather than a
  cherry-pick.
- `ff8230c` (§0.4), if the decision was to keep the banner removed.
- Any fix made directly on `releases-0.3.x` during this rollout.

### Operator sign-off
