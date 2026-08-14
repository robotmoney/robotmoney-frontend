# v0.2.2 production rollout

Operator runbook for taking production from **v0.2.1** to **v0.2.2**. Written to
be executed top to bottom at 3am. Every command is copy-pasteable. Destructive
and irreversible steps are marked **DESTRUCTIVE** / **IRREVERSIBLE**.

Companion to [deployment.md](./deployment.md) — that document owns the
credential inventory (§3–§5), the compose topologies, and the handle/id
namespace guard's full behaviour (§2.1). **This runbook does not repeat it; it
cites it.** Where the two disagree, the contradiction is called out inline under
**CONTRADICTS deployment.md**.

> **Filename note.** This file is `v0-2-2-rollout.md`, not `v0.2.2-rollout.md`.
> `scripts/lint-docs.sh:32` enforces `^[a-z0-9]+(-[a-z0-9]+)*\.md$` on every
> `docs/runbooks/*.md`, and a dot in the stem fails that check.

---

## 0. Read this first — three facts that change what "upgrade" means here

Each is verified at `ccf983f`, and each invalidates something an operator would
otherwise assume.

1. **`bun smoke` boots a DEMO-shaped stack, not a production one.** It always
   appends `docker-compose.demo.yml` (`scripts/lib/demo-main.ts:284-288`, which
   never consults smoke mode), which sets `RM_ALLOW_INSECURE: "1"`
   (`docker-compose.demo.yml:35`) and pins `SWARM_SCHEDULES_ENABLED: "0"`
   (`:72`). deployment.md §3.3 says this out loud about the pinned-port origin:
   *"a pinned-port origin serves a **demo** stack (`RM_ALLOW_INSECURE=1`,
   explicit demo schedules…), not a production one."* You are running the demo
   composition against production data. Nothing below can change that — it is a
   property of the workflow, not a setting.
2. **Without `--external-pg`, `bun smoke` builds a brand-new empty database
   every single boot and your production data is not touched.** The compose
   project name is `rm_demo_stack_<10 hex>` where the hex is
   `shortHash(crypto.randomUUID())` (`scripts/stack/naming.ts:138`, `:149-151`)
   — **random per boot** outside GitHub Actions. A new project means a new
   `<project>_pgdata` volume. The previous boot's volume is orphaned, not
   deleted. **`--external-pg` is mandatory for this rollout.**
3. **You cannot set `AUTOMATION_TOKEN`, `ADMIN_TOKEN` or
   `SWARM_PUBLIC_BASE_URL` for a `bun smoke` boot.** See §6 — this is the single
   biggest departure from the established plan, and two of the three are code
   defects rather than operator steps.

---

## 1. Release identity

| | |
|---|---|
| Currently in production | tag **`v0.2.1`** = `5970f2d` |
| Target | **`main @ ccf983f`**, to be tagged **`v0.2.2`** |
| Delta | **14 commits** (`git rev-list --count v0.2.1..ccf983f` → `14`) |

```bash
git fetch --tags origin
git log --oneline v0.2.1..ccf983f      # expect exactly 14 lines
```

### What is in the delta

```
ccf983f feat(swarm): derive a member's handle from its name at acceptance…      (#612)
56de8e9 fix(ops): the handle/id namespace re-check runs only on --external-pg…  (#610)
bc9f20f fix(seo): the new domain told every crawler its canonical identity…     (#603)
741f39d fix(contract): AdminMember understates what the admin members route…    (#609)
c754753 fix(seo): three stub routes served the home page's metadata…            (#592)
c29e523 fix(swarm): a renamed member that is later deactivated gets two…        (#605)
3a7163f fix(swarm): the handle-addresses-one-member invariant is application…   (#601)
6c78917 fix(swarm): addMemberAdmin/registerMember probe only the id namespace…  (#600)
8d14c88 fix(swarm): the member profile reads the static archive before the API… (#599)
0d7144e feat(swarm): separate member identity and public handle                 (#594)
fdfd9ee feat: admin auth: passkey integration                                   (#589)
f26dca6 feat: admin auth: password management and recovery                      (#590)
0c43a37 feat: admin auth: frontend claim and login surface                      (#591)
f51a8fe feat: admin auth: segregate automation and strict setup token           (#588)
```

### ⚠ THE VERSION NUMBER UNDERSTATES THIS RELEASE

`v0.2.1 → v0.2.2` reads as a patch. It is not.

- **BREAKING auth change.** Four commits (`f51a8fe`, `0c43a37`, `f26dca6`,
  `fdfd9ee`) replace the admin auth model. Once `admin_credential` holds a
  claimed row, `isPrivileged()` **stops honouring `ADMIN_TOKEN` entirely** —
  `backend/src/api/auth.ts:59-64` returns `false` from inside the claimed
  branch rather than falling through to the token check at `:66`. See §2 Gate A;
  this is the one gate that can make the release unrecoverable.
- **Domain change.** `bc9f20f` (#603) moved the canonical origin to
  `https://robotmoney.network` (`scripts/prerender.ts:5`,
  `frontend/public/assets/js/app/seo.js:16`). `backend/src/config.ts:438` still
  defaults to the **old** `https://robotmoney.net`, and nothing can override it
  in this deployment (§6, §10).
- **New identity column with a unique index and two new triggers** on
  `swarm_members` (`0030`, `0031`).

Treat this as a minor release with a manual auth migration attached.

---

## 2. Go/no-go gates

Run these **before** touching anything. Each has a single decision. Gate A first
— it is the only one that can strand you permanently.

Get a psql session against production first (deployment.md §2.1, "Getting a SQL
session"):

```bash
psql "$DATABASE_URL"
```

### Gate A — admin lockout ⛔ THE BLOCKER

```sql
SELECT count(*) AS rows, (recovery_hash IS NULL) AS no_recovery
FROM admin_credential
GROUP BY 2;
```

If `admin_credential` does not exist yet, that is the **unclaimed** case — treat
it as `rows = 0`.

| Result | Meaning | Decision |
|---|---|---|
| **0 rows** (or table absent) | The one-time claim is **unarmed**. After the upgrade the first party to reach the admin surface takes it. `ADMIN_TOKEN` still works (`auth.ts:66`) — but see the trap in §6. | **GO**, and claim the credential immediately after cutover. |
| **1 row, `no_recovery = false`** | Claimed, and a recovery code exists. | **GO.** |
| **1 row, `no_recovery = true`** | Claimed, **no recovery code**. `0029_admin_auth_recovery.sql:1-3` leaves already-claimed rows NULL by design — a migration cannot mint a code and disclose it safely. | **STOP unless somebody can produce the durable admin password right now.** |

**Why Gate A is fatal and not merely annoying.** After the upgrade, with a
claimed row present, `auth.ts:59-64` compares the presented `X-Admin-Token`
against `admin_credential.pass_hash` and `return false` on mismatch. It never
reaches the `ADMIN_TOKEN` fallback at `:66`. With `recovery_hash` NULL there is
no recovery route either. The admin surface is then reachable **only** by
someone holding the password chosen when the credential was claimed.

**If nobody holds the password, do not upgrade. Re-arm the claim first.**

> **DESTRUCTIVE / IRREVERSIBLE.** This deletes the existing admin credential,
> including any passkeys bound to it. It re-arms the one-time claim, so the next
> party to reach the admin surface takes ownership — make sure that is you, and
> that the admin surface is not publicly reachable in the meantime.
> Documented as the intended recovery at `0028_admin_credential.sql:11-13`.

```sql
-- Take the backup in §5 FIRST. Then:
BEGIN;
SELECT * FROM admin_credential;   -- record what you are destroying
DELETE FROM admin_credential;
COMMIT;
```

Then re-claim through the admin surface immediately after cutover, and **change
the password once** — the authenticated password-change route
(`backend/src/api/routes/admin.ts:210-241`, rotating `recovery_hash` at `:227`)
is the only thing that mints a recovery code.

### Gate B — pre-flight verdict

Run §4. **`VERDICT: BLOCKED` is a no-go.** Warnings are a go with your eyes open.

### Gate C — backup proven restorable

Run §5 including the verification. **A dump you have not restored is not a
backup.** No-go until the restore check passes.

### Gate D — the `rm_worker` role exists

```sql
SELECT rolname FROM pg_roles WHERE rolname = 'rm_worker';
```

Zero rows is a **no-go until repaired**. `0029_admin_passkey.sql:26-28` is three
unconditional `REVOKE ALL ON … FROM rm_worker` statements with no existence
guard, and `REVOKE` against a missing role raises `42704`. Because
`backend/src/db/migrate.ts:50-53` wraps each file in one transaction, that aborts
migration `0029_admin_passkey.sql` and the boot fails. Repair:

```sql
CREATE ROLE rm_worker LOGIN;
-- then re-apply 0016's grants verbatim (backend/migrations/0016_worker_role.sql:25-42)
GRANT USAGE ON SCHEMA public TO rm_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rm_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rm_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rm_worker;
REVOKE INSERT, UPDATE, DELETE ON raw_indicator_history, regime_snapshots, research_signals FROM rm_worker;
```

### Gate E — no long-running transactions

Covered by the pre-flight's `blocking-xacts` check (§4). A transaction older than
60s queues in front of `0030`'s `ACCESS EXCLUSIVE` lock, and every reader
arriving after that queues behind **both**.

---

## 3. Provision the read-only role

The pre-flight and the dump must both run as a role that **cannot write**. Do
this once, as `doadmin`, against the production cluster.

```sql
CREATE ROLE rm_readonly LOGIN PASSWORD '<generate a strong one>';

-- PG14+. Use THIS, not GRANT SELECT ON ALL TABLES.
GRANT pg_read_all_data TO rm_readonly;

GRANT CONNECT ON DATABASE defaultdb TO rm_readonly;
GRANT USAGE ON SCHEMA public TO rm_readonly;

-- Belt: make every transaction on this role read-only at the server.
ALTER ROLE rm_readonly SET default_transaction_read_only = on;
```

> **Why `pg_read_all_data` and never `GRANT SELECT ON ALL TABLES IN SCHEMA
> public`.** `ON ALL TABLES` is a **one-shot expansion**: Postgres resolves it to
> the tables that exist at that instant and writes individual grants. Every table
> a future migration creates is invisible to that role — and it fails
> **silently**, because `pg_dump` simply omits what it cannot read. You get a
> dump that restores cleanly and is missing tables. `pg_read_all_data` is a role
> membership evaluated at query time, so it covers tables that do not exist yet.

Verify the role is genuinely read-only before trusting it:

```bash
psql "postgres://rm_readonly:<pw>@<host>:25060/defaultdb?sslmode=require" \
  -c "SHOW transaction_read_only;" \
  -c "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = current_user;"
```

Expect `on`, then five `f`. Anything else and §4 will refuse to run anyway.

> **Port 25060, never 25061.** `25060` is DigitalOcean's direct session port.
> `25061` is PgBouncer in **transaction** pooling mode, which does not hold a
> session across statements — that breaks `pg_dump`'s repeatable-read snapshot
> and can produce a torn dump. Use `25060` for everything in §3, §4 and §5.
>
> **CONTRADICTS deployment.md §4.3**, which says *"For the HA cluster, prefer the
> **connection-pool** URI (PgBouncer) if enabled. Migrations (D9) run with this
> credential."* For the application's own `DATABASE_URL` that preference is out
> of scope here — but do **not** follow it for the pre-flight or the dump.

---

## 4. Pre-flight: `backend/scripts/preflight-upgrade.ts`

A read-only dry run against **live production**, executed by `rm_readonly`,
before you pull anything. It refuses to run on a session it cannot prove is
read-only, and every query in it is a `SELECT`.

### Run it

```bash
cd <checkout>/backend
bun install                      # the script imports `postgres` from backend/package.json

PREFLIGHT_DATABASE_URL='postgres://rm_readonly:<pw>@<host>:25060/defaultdb?sslmode=require' \
  bun scripts/preflight-upgrade.ts
```

**Run it from a checkout at `ccf983f`.** The script compares
`backend/migrations/` on disk against `schema_migrations` in the database; run
from the wrong tag and the pending list is wrong.

`PREFLIGHT_DATABASE_URL` is a deliberately separate variable — the script exits
`2` if it equals `DATABASE_URL`, and never reads `DATABASE_URL` itself.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | `SAFE TO UPGRADE` (possibly with warnings — read them) |
| `1` | `BLOCKED` — at least one FAIL, or the session is not provably read-only |
| `2` | Could not run (no URL, cannot connect, a check threw) |

### Reading the output

Three gate checks run first and abort everything on failure:
`session-read-only`, `role-privileges`, `role-write-grants`. If you are running
as `doadmin` before `rm_readonly` exists, `PREFLIGHT_ALLOW_PRIVILEGED=1`
downgrades the last two to warnings — **do not make that the normal path.**

| Check | `FAIL` means | Do this |
|---|---|---|
| `session-read-only` | The connection can write. Nothing else was queried. | Use port `25060` and the `rm_readonly` URL. Never `PREFLIGHT_ALLOW_PRIVILEGED` for this one — it does not downgrade it. |
| `role-privileges` / `role-write-grants` | The role is a superuser, or holds write grants / table ownership. | Provision §3's role and re-run. |
| `server-version` | Server is < PG 11, where `0030`'s `ADD COLUMN` rewrites the table under `ACCESS EXCLUSIVE`. | Upgrade the cluster. (A **WARN** here just means "not 17"; the suite targets 17.) |
| `extensions` | `pgcrypto` absent; `0001_backends.sql:4` needs `gen_random_uuid()`. | `CREATE EXTENSION IF NOT EXISTS pgcrypto;` as `doadmin`. |
| `schema-migrations` | Either no `schema_migrations` at all (wrong database), or **orphans**: files recorded in the database that are absent from `backend/migrations/`. | Orphans mean the **database is ahead of the checkout** — you are on the wrong tag. Stop and check out `ccf983f`. |
| `rm-worker-role` | `rm_worker` missing and `0029_admin_passkey.sql` pending. | Gate D above. |
| `handle-namespace` | One member's `handle` is another member's `id`. | Run **one printed statement per line, all of them**. Each moves the **HOLDER** — the member named *first* on the line. Updating the shadowed member reports `UPDATE 1` and fixes nothing (`backend/src/db/handle-namespace.ts:113-123`). A mutual collision prints two lines and needs two updates. |
| `blocking-xacts` | A transaction older than 60s is open. | `SELECT pg_terminate_backend(<pid>);` and re-run. Stop the worker first. |
| `admin-credential` | `recovery_hash` already exists but `0029_admin_auth_recovery.sql` is not recorded — its bare `ADD COLUMN` (no `IF NOT EXISTS`, `0029_admin_auth_recovery.sql:4`) will raise `42701`. | `INSERT INTO schema_migrations (name) VALUES ('0029_admin_auth_recovery.sql');` |

Warnings worth stopping to read even though they exit `0`:

- `admin-credential` **WARN** with `no_recovery > 0` — this is Gate A. The
  pre-flight only warns; **the gate decision is yours.**
- `handle-shape` — member ids that are not valid handles. `0030` backfills
  `handle = id` with no `CHECK`, so those handles can never be saved again
  through the admin surface (validated against `MEMBER_HANDLE_RE`,
  `backend/src/api/validation.ts:446`, 80-char bound at `:481`). Fix after
  cutover, per §8.
- `swarm-members-size` — above 50 000 rows, `0030` is a stall, not a blip.

### On the reconciliation

The script was authored at `bc9f20f`. Its inlined namespace relation is
**byte-identical** to `HANDLE_NAMESPACE_CONFLICT_RELATION`
(`backend/src/db/handle-namespace.ts:62-63`) and to `0031`'s DO block
(`0031_swarm_member_handle_namespace.sql:91-92`) — only the *citations* were
stale, and they have been corrected in place. The relation itself never drifted.

---

## 5. Backup

Production is DigitalOcean Managed Postgres, which has PITR. **PITR is not
sufficient here** — it recovers the cluster, not a file you can inspect, diff, or
restore into a scratch database to prove the release is reversible. Take a local
dump as well.

### 5.1 The dump

```bash
set -o pipefail                          # MANDATORY — see the box below
umask 077                                # the file is a credential store

export PGPASSWORD='<rm_readonly password>'
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

pg_dump \
  --host=<host> --port=25060 --username=rm_readonly --dbname=defaultdb \
  --format=custom --compress=9 --no-owner --no-privileges \
  --file="rm-preupgrade-${STAMP}.dump"
echo "pg_dump exit=$?"

# Roles are NOT in the dump above. This is a separate, required artifact.
pg_dumpall \
  --host=<host> --port=25060 --username=doadmin \
  --globals-only --no-role-passwords \
  --file="rm-globals-${STAMP}.sql"
echo "pg_dumpall exit=$?"
```

> **`--file=`, not `>`, and `set -o pipefail`.** `pg_dump … | gzip > out.gz`
> reports the exit status of `gzip`, not of `pg_dump`, so a dump that failed
> halfway produces a valid-looking compressed file and a `0` exit. `--file=`
> removes the pipe entirely; `set -o pipefail` covers any pipe you add anyway.
> Check the printed exit codes — both must be `0`.

> **`pg_dumpall --globals-only` is not optional.** `pg_dump` does **not** dump
> roles. A cluster rebuilt from the `.dump` alone has `schema_migrations`
> claiming `0016_worker_role.sql` is applied while `rm_worker` does not exist —
> and then `0029_admin_passkey.sql:26-28`'s unguarded `REVOKE`s abort migration
> `0029` with `42704` on the very first boot. This is exactly the trap Gate D
> checks for, arriving via your own restore.

> **Match the client major version to the server.** `pg_dump` refuses a server
> newer than itself. The pre-flight's `server-version` check prints the server
> version; use a `pg_dump` of at least that major.

### 5.2 🔴 The dump is a credential store — encrypt it at rest

**IRREVERSIBLE if leaked.** The dump contains, in plaintext or trivially
reversible form:

- `admin_credential.pass_hash` and `recovery_hash` — **unsalted, single-round
  SHA-256 hex** (`backend/src/lib/keys.ts:5-7`), with a 12-character minimum
  password (`backend/src/api/routes/admin.ts:190`). That is offline-crackable
  with commodity hardware.
- `admin_session` tokens and `admin_passkey` credentials.
- `admin_webauthn_challenge` — live claim challenges.
- Swarm member access keys, and every stored email address.

```bash
gpg --symmetric --cipher-algo AES256 "rm-preupgrade-${STAMP}.dump"
shred -u "rm-preupgrade-${STAMP}.dump"       # or: rm -P on macOS
gpg --symmetric --cipher-algo AES256 "rm-globals-${STAMP}.sql"
shred -u "rm-globals-${STAMP}.sql"
```

Do not put either file in the checkout, in `.agents/`, or anywhere a compose
bind mount can reach.

### 5.3 The verification that PROVES it restores

A dump you have not restored is a hypothesis.

```bash
# Scratch database on the SAME cluster (or a local PG of the same major).
createdb --host=<host> --port=25060 --username=doadmin rm_restore_check

# Roles first — the restore needs them to exist.
psql --host=<host> --port=25060 --username=doadmin --dbname=rm_restore_check \
     --set ON_ERROR_STOP=on -f "rm-globals-${STAMP}.sql"

pg_restore --host=<host> --port=25060 --username=doadmin --dbname=rm_restore_check \
           --no-owner --no-privileges --exit-on-error \
           "rm-preupgrade-${STAMP}.dump"
echo "pg_restore exit=$?"     # MUST be 0
```

Then prove the contents, not just the exit code:

```sql
\c rm_restore_check

-- 1. Row counts match production for the tables that matter.
--    swarm_recommendations is the SIGNED take table (payload jsonb NOT NULL,
--    signature text NOT NULL — 0004_committee.sql:38-40, renamed 0025:70).
SELECT 'swarm_members' t, count(*) FROM swarm_members
UNION ALL SELECT 'swarm_recommendations', count(*) FROM swarm_recommendations
UNION ALL SELECT 'swarm_sessions', count(*) FROM swarm_sessions
UNION ALL SELECT 'admin_credential', count(*) FROM admin_credential
UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations;

-- 2. Roles survived the globals restore.
SELECT rolname FROM pg_roles WHERE rolname IN ('rm_worker', 'rm_readonly');

-- 3. The namespace invariant holds in the restored copy.
SELECT a.id AS holder, a.handle, b.id AS shadowed
FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id;
-- expect 0 rows
```

Run the same three against production and compare. Only then is Gate C green.

> **DESTRUCTIVE.** Drop the scratch database when done — it is a second
> plaintext copy of every credential above.
> `dropdb --host=<host> --port=25060 --username=doadmin rm_restore_check`

---

## 6. Config before cutover — and what you CANNOT configure

This section replaces the "set `AUTOMATION_TOKEN` and `SWARM_PUBLIC_BASE_URL`
before cutover" plan. **Both of those steps are impossible through the operator's
workflow at `ccf983f`.** Verified by tracing the spawn environment, not assumed.

### 6.1 Why: how environment reaches the api container under `bun smoke`

`bun smoke` boots through `scripts/stack/stack.ts`'s `up()`. That spawns
`docker compose` with `env: spawnEnv` — a **replacement** map, not a merge with
your shell (`scripts/stack/stack.ts:224-233`). `buildSpawnEnv`
(`scripts/stack/config.ts:264-271`) copies only `DOCKER_CLIENT_ENV_ALLOWLIST`
(`:241-259` — `PATH`, `DOCKER_HOST`, proxies, nothing application-shaped) from
your shell, then overlays `buildComposeEnv(cfg)` **last**, so a stack-owned name
can never be sourced from anywhere else.

Two consequences:

- Your exported shell variable is **dropped** unless it is in
  `DOCKER_CLIENT_ENV_ALLOWLIST` or in `DEMO_COMPOSE_PASSTHROUGH`
  (`scripts/lib/demo-main.ts:427-444`).
- A repo-root `.env` **is** auto-loaded by Compose for `${VAR}` interpolation
  (no `--env-file` or `--project-directory` is passed anywhere; the child's cwd
  is the repo root, `scripts/stack/stack.ts:216`) — but process env beats `.env`,
  so anything `buildComposeEnv` emits still wins.

### 6.2 ❌ `AUTOMATION_TOKEN` — cannot be set, and does not need to be

`buildComposeEnv` sets `AUTOMATION_TOKEN: cfg.credentials.automationToken`
(`scripts/stack/config.ts:220`), minted fresh **every boot** by
`generateStackCredentials()` (`:162-168`, called at
`scripts/lib/demo-main.ts:381-383`). Putting it in `.env` or exporting it in your
shell changes nothing — the generated value overrides both.

So the established finding that `AUTOMATION_TOKEN` is *"absent from `.env.example`
and fail-closed, therefore must be set"* **does not hold for this workflow.** It
is absent from `.env.example` (confirmed — zero occurrences), and
`backend/src/api/auth.ts:70-76` does fall through to `allowInsecure` rather than
`false` when unset — but under `bun smoke` it is never unset, because the stack
mints it. **No action required. Do not try to set it.**

### 6.3 ❌ `SWARM_PUBLIC_BASE_URL` — cannot reach the container at all

It appears in **no compose file**: not in `docker-compose.yml`'s api
`environment:` block (`:171-223`), not in `docker-compose.demo.yml`'s (`:34-72`),
not in `docker-compose.stage.yml`, not in the `x-worker-env` anchor
(`docker-compose.yml:109-137`). There is no `env_file:` in any compose file and
`backend/Dockerfile` sets no `ENV`, so an unlisted name is simply never
delivered — the same allowlist property deployment.md §2.1 documents for
`RM_ALLOW_HANDLE_NAMESPACE_VIOLATION`. Note the contrast, because it is easy to
read that cross-reference the wrong way: `RM_ALLOW_HANDLE_NAMESPACE_VIOLATION`
**is** named by the api `environment:` block (`docker-compose.yml:184`) and so
*can* be delivered — but on **this** workflow only out of the repo-root `.env`,
never out of your shell, and even then it cannot rescue the boot. See §7.5.

`.env.example:138` documents it as if it were configurable. It is not.

**Effect in v0.2.2:** the api always computes
`backend/src/config.ts:438`'s default, `https://robotmoney.net` — the **old**
domain that `bc9f20f` (#603) just moved away from. Every swarm
application-receipt and activation email links to the old host. **File an issue;
do not attempt to fix it during the rollout.** See §10.

### 6.4 ⚠ `ADMIN_TOKEN` is also minted per boot — and only shown in the TUI

Same mechanism: `buildComposeEnv` sets `ADMIN_TOKEN:
cfg.credentials.adminToken` (`scripts/stack/config.ts:219`), a fresh random
20-character value per launch. It is **never logged, never written to
`.agents/demo-state.json`, and never printed in the plain non-TUI READY block**
(`scripts/lib/demo-main.ts:374-378`) — it is rendered only in the interactive
TUI.

> **The `--no-tui` trap.** §7 recommends `--no-tui` because it is the only way to
> get a real non-zero exit code. But `--no-tui` also means **you never see the
> generated `ADMIN_TOKEN`.** That only matters if `admin_credential` is
> **unclaimed** (Gate A row 1), where the token is your one way into the admin
> surface to make the claim. If you are in that case, boot **with** the TUI for
> the cutover, read the token off the pane, and accept that you must read the
> pane rather than an exit code.

### 6.5 ✅ What you actually set, and where

The only supported configuration surface for this workflow is the **repo-root
`.env` file** in the checkout you run `bun smoke` from. There is no deploy
pipeline and no droplet-env injection step here.

```bash
cd <checkout>
cat .env      # must contain, at minimum:
# DATABASE_URL=postgres://<app-user>:<pw>@<host>:25060/defaultdb?sslmode=require
```

`--external-pg` reads `DATABASE_URL` from **that file directly**
(`scripts/lib/demo-external-pg.ts:288-305`), not from `process.env`. A missing or
unreadable `.env` is a fatal exit 1 before anything starts.

Optional, and genuinely honoured because they are in `DEMO_COMPOSE_PASSTHROUGH`:
`PROJECTS_SOURCE`, `RM_ENV`, `SWARM_SCHEDULES_ENABLED`, `SWARM_*_CRON`,
`SWARM_WINDOW_MINUTES`, `BASE_RPC_URL`.

> ⚠ **`SWARM_SCHEDULES_ENABLED` is overridden regardless.**
> `docker-compose.demo.yml:72` pins it to `"0"`, and `seedSwarmSchedules()`
> (`backend/src/db/seed.ts:137-151`) rewrites all five `swarm.*` rows'
> `cron`/`enabled`/`payload`/`timezone` on **every** boot — `seed()` is called
> unconditionally from `backend/src/db/migrate.ts:61`. So every `bun smoke` boot
> **disables all five swarm schedules in production**, clobbering any operator
> toggle. This is a property of running the demo composition; plan for the swarm
> to be manually driven after cutover.

---

## 7. Cutover

> **IRREVERSIBLE from here.** The migrations have no down files (verified: 39
> `.sql` files under `backend/migrations/`, none matching
> `down|rollback|revert|undo`). Rollback is code-only — see §9.

### 7.1 Stop the current stack, cleanly

```bash
cd <checkout>
bun run demo:status          # prints project=<name>; confirm it is the live one
bun run demo:down            # keeps the data; does NOT delete volumes
docker compose ls            # confirm no rm_demo_stack_* project is still up
```

If `docker compose ls` shows leftovers from earlier boots, tear each down
explicitly — `docker compose -p <that project> down` — before continuing. See
deployment.md §2.1, "FIRST: find the project name".

### 7.2 Pull the tag

```bash
git fetch --tags origin
git checkout v0.2.2          # after it is cut at ccf983f
git rev-parse HEAD           # MUST print ccf983f…
```

### 7.3 The invocation

```bash
cd <checkout>
DEMO_PROJECT=rm_prod bun smoke -- --external-pg --no-tui
```

**Each flag, justified:**

| Flag / var | Why it is here | What happens without it |
|---|---|---|
| `--external-pg` | **MANDATORY.** Starts no postgres container and points the stack at the managed server via `DATABASE_URL` from repo-root `.env` (`scripts/lib/demo-external-pg.ts:288-305`). | The stack boots its own empty postgres in a fresh volume. **Your production data is not touched and not served** — you get an empty site and think it worked. This is failure mode #2 in §0. |
| `DEMO_PROJECT=rm_prod` | **MANDATORY.** Pins the compose project name (`scripts/lib/demo-main.ts:261`). Without it the name is `rm_demo_stack_<random>` per boot (`scripts/stack/naming.ts:138`). | Every restart leaves an orphaned project. `docker compose -p …` commands in deployment.md address the wrong stack. Note: `--external-pg` does **not** by itself stabilise the project name — only `DEMO_PROJECT` does. |
| `--no-tui` | On a TTY a **failed boot renders a pane and never exits non-zero**; Ctrl-C then exits `0` (`scripts/lib/demo-main.ts:1911-1918`, which returns without `process.exit`). `--no-tui` gives a real `exit 1` (`:1920-1928`). | You cannot tell success from failure by exit code. **Omit this flag only if Gate A left you unclaimed and you need to read `ADMIN_TOKEN` off the pane** (§6.4). |
| **`CI` must be UNSET** | ⛔ With any truthy `CI`, `cleanCiVolume()` runs on **both** the success path (`scripts/lib/demo-main.ts:1393`) and the failure path (`:1893`), issuing `docker volume rm <project>_pgdata` (`scripts/lib/demo-volumes.ts:105`). It also publishes a real swarm session and exits. Harmless to the *data* under `--external-pg` (no volume exists) — but it still publishes and exits, so the site does not stay up. | Check with `echo "CI=[$CI]"` before you start. It must print `CI=[]`. |

```bash
echo "CI=[$CI]"     # MUST be empty
```

### 7.4 What the boot does, in order

Asserted by `scripts/tests/unit/stack-lifecycle-order.test.ts:83-93`:

```
docker preflight → build → postgres → [db preflight, --external-pg only]
  → migrate (scripts/stack/stack.ts:388) → services (:394) → ports → /health → initialize
```

**No service of the new stack starts if `migrate` fails** — services are step 6,
migrate is step 5. The four new migrations apply here:

| File | Effect | Why it cannot fail |
|---|---|---|
| `0029_admin_auth_recovery.sql` | `ADD COLUMN recovery_hash text` | Additive. Bare `ADD COLUMN` (`:4`) — only fails if the column already exists unrecorded (pre-flight checks this). |
| `0029_admin_passkey.sql` | passkey/session/challenge tables + 3 `REVOKE`s | Additive. **Requires `rm_worker`** — Gate D. |
| `0030_swarm_member_handle.sql` | `ADD COLUMN IF NOT EXISTS handle` (`:24`), backfill `handle = id` (`:28`), `SET NOT NULL` (`:30`), default-handle `BEFORE INSERT` trigger (`:47-49`), `CREATE UNIQUE INDEX` (`:53`) | The unique index **cannot** collide: the backfill sets `handle = id`, and `id` is the primary key. |
| `0031_swarm_member_handle_namespace.sql` | namespace `DO` block (`:84-98`) + `BEFORE INSERT OR UPDATE` trigger (`:182-184`), then `ENABLE ALWAYS` (`:195`) | On a clean v0.2.1 jump the `DO` block **cannot fire**: immediately after `0030` every row has `handle = id`, so `b.id = a.handle AND b.id <> a.id` is unsatisfiable. |

**Both `0029` files apply.** The runner keys on the **full filename**
(`schema_migrations(name text PRIMARY KEY)`, `backend/src/db/migrate.ts:34`;
`applied.has(file)` at `:48`), not on a numeric high-water mark. Order is
filename-lexicographic (`:39-41`), so `…auth_recovery` runs before `…passkey`.

**Each file is one transaction together with its `schema_migrations` insert**
(`backend/src/db/migrate.ts:50-53`). There is no half-applied file, and
re-running after a failure resumes at the file that failed.

> Note: `seed()` at `backend/src/db/migrate.ts:61` runs **outside** any
> per-file transaction, after all migrations. It is the step that rewrites the
> five `swarm.*` schedules (§6.5).

### 7.5 The new refusal you may hit — #610

`56de8e9` (#610) moved the handle/id namespace re-check out of the
`--external-pg`-only path. It now runs from **two** places that matter here, in
this order:

1. **`backend/src/api/index.ts:59`, before `Bun.serve` binds a port.** On a
   violation the api prints `[api] REFUSING the boot: …` naming both members and
   calls `process.exit(1)`. Because `docker-compose.yml:265` sets `restart:
   unless-stopped` on the api — and `docker-compose.demo.yml`'s only `restart:
   "no"` is on the unrelated `member-agent` service (`:146`) — the container
   **restart-loops until the data is repaired.**
2. **`backend/scripts/prod-bootstrap.ts:86-113`, step 0, before it writes
   anything.** Under smoke this is the archive initializer, run as `docker
   compose run --rm … api bun run scripts/prod-bootstrap.ts --already-migrated`
   (`scripts/lib/demo-main.ts:1136-1140`). The precheck leads **both** step
   shapes, `--already-migrated` included (`stepsFor`, `:272-275`), and is the
   only step marked `haltOnFailure` (`:266-270`). It refuses and writes nothing.

#### ⛔ The §2.1 override CANNOT rescue a `bun smoke` boot

`RM_ALLOW_HANDLE_NAMESPACE_VIOLATION=1` is read in exactly one place:
`backend/src/db/handle-namespace.ts:476`, inside the **api** guard
(`HANDLE_NAMESPACE_OVERRIDE_ENV`, `:373`). `prod-bootstrap.ts`'s step 0 reads no
environment at all — it calls `checkHandleNamespace` and returns `failing` on any
violation. And a failing initializer is a failing boot: `composeAsync` throws on
a non-zero child (`scripts/stack/stack.ts:248-251`). **There is no value of any
variable that gets `bun smoke` to completion against a violating database.**
(Tracked as OPS-610-012 in issue #611.)

Two further traps if you try it anyway:

- **Exporting the variable in your shell is a no-op on this workflow.**
  `stack.up()` spawns compose with `env: spawnEnv` — a **replacement** map, not a
  merge (`scripts/stack/stack.ts:214-232`) — and `buildSpawnEnv` copies only
  `DOCKER_CLIENT_ENV_ALLOWLIST` before overlaying `buildComposeEnv`
  (`scripts/stack/config.ts:241-271`). Neither
  `RM_ALLOW_HANDLE_NAMESPACE_VIOLATION` nor `PG_NAMESPACE_GUARD_TIMEOUT_MS` is on
  that allowlist, in `buildComposeEnv`, or in `DEMO_COMPOSE_PASSTHROUGH`
  (`scripts/lib/demo-main.ts:427-444`), so the export is dropped before `docker`
  is invoked. This is the **opposite** of the droplet topology deployment.md §2.1
  describes, where CI runs `docker compose up -d` directly and the ambient
  environment *is* the interpolation source. Being in the api `environment:`
  allowlist (`docker-compose.yml:184-185`) is necessary but not sufficient: the
  value still has to reach the compose *process*.
- **The repo-root `.env` does deliver it — and still does not help.** Compose
  auto-loads `.env` from the project directory, the compose child's cwd is the
  repo root, and nothing passes `--env-file` or `--project-directory`
  (`scripts/stack/stack.ts:216`, `:226`; §6.1), so
  `${RM_ALLOW_HANDLE_NAMESPACE_VIOLATION:-}` at `docker-compose.yml:184` does
  resolve from it. What that buys is an api container that boots loudly and
  reports `handle_namespace: "overridden"` at `/health` — and a boot that still
  exits 1 at the archive initializer. With `CI` unset (which §7.3 requires) the
  failure path deliberately leaves the stack **up** for inspection
  (`scripts/lib/demo-main.ts:1897-1909`), so the site answers and looks alive.
  **That is not a completed cutover:** the archive/EDGAR initializer never ran,
  smoke's archive-continuity assertion never ran, and you have no evidence the
  release is good. Do not sign off on it, and do not leave it running as "the
  new production".

**The only remedy on this workflow is to repair the data.** §4's
`handle-namespace` check is what stops you reaching this at all; if you skipped
it, run it now against the same database. Then follow deployment.md §2.1's repair
— **one statement per printed line, all of them, each moving the HOLDER** — and
re-run §7.3. If you cannot repair inside your maintenance window, the exit is §9
rollback, not the override.

---

## 8. Post-cutover verification

Discover the project first — you pinned it, so it is `rm_prod`:

```bash
export RM_PROJECT=rm_prod
bun run demo:status
```

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Boot exited clean | `echo $?` right after §7.3 | `0`. On a TTY without `--no-tui` this proves nothing (§7.3). |
| 2 | All four migrations recorded | `psql "$DATABASE_URL" -c "SELECT name FROM schema_migrations WHERE name LIKE '0029%' OR name LIKE '003%' ORDER BY 1;"` | four rows: `0029_admin_auth_recovery.sql`, `0029_admin_passkey.sql`, `0030_swarm_member_handle.sql`, `0031_swarm_member_handle_namespace.sql` |
| 3 | Namespace guard ran and was clean | `curl -s "http://127.0.0.1:$(docker compose -p "$RM_PROJECT" port api 8787 \| cut -d: -f2)/health"` | `"handle_namespace":"clean"`. **`"unchecked"` means the guard could not run — this boot proves nothing.** `"overridden"` means you are serving a violation. |
| 4 | No violation in the data | `psql "$DATABASE_URL" -c "SELECT a.id, a.handle, b.id FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id;"` | 0 rows |
| 5 | Namespace trigger is `ENABLE ALWAYS` | `psql "$DATABASE_URL" -c "SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger';"` | `A`. `O` means a `DISABLE`/`ENABLE` cycle downgraded it and the replica-role bypass `0031` closes is open again. |
| 6 | Every member has a handle | `psql "$DATABASE_URL" -c "SELECT count(*) FROM swarm_members WHERE handle IS NULL;"` | `0` (`SET NOT NULL` guarantees it; this catches a partial apply) |
| 7 | Handles are saveable | `psql "$DATABASE_URL" -c "SELECT id, handle FROM swarm_members WHERE handle !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(handle) > 80;"` | 0 rows. Any row here is a member the admin surface can never re-save (§4, `handle-shape`). Fix with `UPDATE swarm_members SET handle = '<kebab-case>' WHERE id = '<id>';` — **move the handle, never the id.** |
| 8 | Archive data was adopted, not overwritten | `psql "$DATABASE_URL" -c "SELECT count(*) FROM swarm_recommendations;"` | ≥ the pre-upgrade count from §5.3. The archive initializer **adopts**: `classifyDatabase` returns `mode: "adopt"` for the archive initializer on populated data (`backend/scripts/db-preflight.ts:158`) — insert-if-missing, fill only `NULL` columns, else report drift. Existing rows win; the signed `payload`/`signature` columns are never rewritten. |
| 9 | `admin_credential` untouched by the boot | `psql "$DATABASE_URL" -c "SELECT count(*), (recovery_hash IS NULL) FROM admin_credential GROUP BY 2;"` | identical to Gate A's result. **No seed path ever writes this table.** |
| 10 | Admin surface reachable | Sign in. If unclaimed, claim now. | Then **change the password once** — that is the only thing that mints `recovery_hash` (`backend/src/api/routes/admin.ts:227`). |
| 11 | Site serves prerendered HTML | `curl -s http://127.0.0.1:<port>/swarm/ \| grep -o '<title>[^<]*'` | Not the home page's title. If it is, `bun run static:assemble` did not run (deployment.md §2.1). |
| 12 | Swarm schedules state | `psql "$DATABASE_URL" -c "SELECT kind, enabled FROM job_schedules WHERE kind LIKE 'swarm.%' ORDER BY 1;"` | five rows, **all `enabled = f`** — expected under the demo composition (§6.5). Drive sessions manually. |

---

## 9. Rollback

### Triggers — roll back if any of these are true

- Verification 3 reports `overridden`, or 4 returns rows you cannot repair now.
- Verification 2 shows fewer than four migrations **and** the boot is failing.
- The admin surface is unreachable and Gate A said `no_recovery = true`.
- The api is restart-looping (`docker compose -p rm_prod ps` shows repeated
  restarts) for any reason you cannot diagnose in 15 minutes.

### Procedure

**Code rollback is safe against the new schema.** `0030`'s `BEFORE INSERT`
trigger defaults `handle := id` (`0030_swarm_member_handle.sql:41`), and all six
`INSERT INTO swarm_members` sites omit `handle` — `backend/src/demo/e2e.ts:58`,
`backend/src/swarm/roster-seed.ts:117`, `backend/src/swarm/admin.ts:277`,
`backend/src/swarm/domain.ts:834` and `:1189`, and
`backend/scripts/v0-seed-bootstrap.ts:237`. So v0.2.1 code writing to a v0.2.2
schema produces valid rows, and the `NOT NULL` on `handle` cannot bite.

```bash
cd <checkout>
bun run demo:down
git checkout v0.2.1
git rev-parse HEAD                     # MUST print 5970f2d…
echo "CI=[$CI]"                        # MUST be empty
DEMO_PROJECT=rm_prod bun smoke -- --external-pg --no-tui
```

Re-run verification 3, 4 and 11.

### ⚠ What rollback does NOT undo

- **The schema stays at 0031.** There are no down migrations. `recovery_hash`,
  `admin_passkey`, `admin_session`, `admin_webauthn_challenge`,
  `swarm_members.handle`, its unique index and both triggers all remain.
- **`admin_credential` stays claimed.** If you claimed during v0.2.2, v0.2.1's
  `isPrivileged()` behaviour differs but the row is still there. Rolling back
  does not restore `ADMIN_TOKEN` access to a claimed credential; only
  `DELETE FROM admin_credential` does (§2 Gate A, **DESTRUCTIVE**).
- **The five `swarm.*` schedules stay disabled.** `seed()` rewrote them on the
  v0.2.2 boot and rewrites them again on the v0.2.1 boot (§6.5).
- **Any handle you edited during triage stays edited** — and each edit repointed
  a published URL.
- **Data written while v0.2.2 was live stays.** Rolling the code back is not a
  point-in-time restore. If you need one, that is §5's dump or DO's PITR, and it
  is a separate, **DESTRUCTIVE** decision.

---

## 10. Known-broken in v0.2.2 — do not try to fix during the rollout

### 10.1 Passkeys cannot work behind the TLS tunnel 🔴

`backend/src/api/routes/admin-webauthn.ts:23-27` derives both the relying-party
id and the expected origin from the **request URL**:

```
const expectedOrigin = process.env.WEBAUTHN_ORIGIN || url.origin;
const rpID = process.env.WEBAUTHN_RP_ID || new URL(expectedOrigin).hostname;
```

`url` is `new URL(req.url)` (`backend/src/api/index.ts:64`), and the server is
plain HTTP — `Bun.serve` is configured with no `tls:` key (`:61-63`), and
`X-Forwarded-*` is consulted only for the client IP (`:76`), never for the
scheme. Behind the Cloudflare tunnel the browser is on `https://…` while the api
computes `http://…`, so registration and authentication both fail origin
verification (`admin-webauthn.ts:127-128`, `:197-199`).

The two override variables exist but are **in no compose file at all** — repo-wide
they appear only at `admin-webauthn.ts:24-25`. With no `env_file:` and no `ENV`
in `backend/Dockerfile`, they cannot be delivered.

**Use password auth for the admin surface in v0.2.2.** Passkeys are a
known-broken feature, not a rollout step.

### 10.2 The api advertises the old domain

`backend/src/config.ts:438` defaults `SWARM_PUBLIC_BASE_URL` to
`https://robotmoney.net` while the canonical origin is now
`https://robotmoney.network` (`scripts/prerender.ts:5`,
`frontend/public/assets/js/app/seo.js:16`). Not overridable — §6.3. Swarm emails
link to the old host until this is fixed in code.

**CONTRADICTS deployment.md §2**, whose host table still lists
`robotmoney.net` / `swarm.robotmoney.net` / `app.robotmoney.net`, and
`cloudflared.config.example.yml:43`. Those are stale at `ccf983f` and are not
this runbook's to fix.

### 10.3 CSP headers — issue #607

Tracked separately. No rollout action; note it if a browser console shows
policy violations after cutover so it is not mistaken for a regression of this
release.

### 10.4 `bun smoke` has no CI coverage at `ccf983f`

No workflow under `.github/workflows/` invokes `bun smoke` or `--smoke`. The
smoke boot path is exercised by unit tests
(`scripts/tests/unit/smoke-mode.test.ts`) but not end-to-end in CI. Treat the
cutover as the first real execution of this path for this release, and keep §9
within reach.

---

## 11. Post-restore checklist

Run this **only** if you restored from §5's dump (or DO PITR) rather than simply
rolling code back. A restored database is the one population path the schema
cannot stand in front of.

1. **Roles first — before anything connects.** `pg_dump` does not carry them.
   ```sql
   SELECT rolname FROM pg_roles WHERE rolname IN ('rm_worker', 'rm_readonly');
   ```
   Missing `rm_worker` → apply the globals dump, or re-run Gate D's `CREATE
   ROLE` + `0016_worker_role.sql:25-42` grants. Without it, the next boot's
   `0029_admin_passkey.sql:26-28` aborts with `42704`.

2. **Trigger state — `ENABLE ALWAYS`, not plain `ENABLE`.**
   ```sql
   SELECT tgname, tgenabled FROM pg_trigger
   WHERE tgname IN ('swarm_members_handle_namespace_trigger',
                    'swarm_members_default_handle_trigger');
   ```
   `swarm_members_handle_namespace_trigger` **must** be `A`. A restore, or any
   `DISABLE`/`ENABLE` cycle, silently downgrades it to `O` — which reopens the
   `session_replication_role = replica` bypass `0031` exists to close
   (`0031_swarm_member_handle_namespace.sql:186-194`). Repair:
   ```sql
   ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger;
   ```

3. **The namespace query — a restore loads rows behind the trigger's back.**
   `pg_restore` emits `CREATE TRIGGER` in the post-data section, so the `COPY`
   that loads the rows runs before the trigger exists; and a dump from a
   post-0031 database already carries `0031_swarm_member_handle_namespace.sql`
   in `schema_migrations`, so the migration is skipped and its `DO` block never
   re-runs.
   ```sql
   SELECT a.id AS holder, a.handle, b.id AS shadowed
   FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id
   ORDER BY a.id;
   ```
   Any row here will make the api refuse to boot. Repair each: **one statement
   per row, moving the HOLDER.**

4. **`ANALYZE`** — a restore leaves no statistics, and the first queries against
   `swarm_members` will pick bad plans.
   ```sql
   ANALYZE;
   ```
   Or, if the database is large and you only need the hot tables now:
   ```sql
   ANALYZE swarm_members; ANALYZE swarm_recommendations; ANALYZE swarm_sessions; ANALYZE job_schedules;
   ```

5. **`pgcrypto`.**
   ```sql
   SELECT extname FROM pg_extension WHERE extname = 'pgcrypto';
   ```
   Absent → `CREATE EXTENSION IF NOT EXISTS pgcrypto;` as `doadmin`.
   `0001_backends.sql:4` needs it for `gen_random_uuid()` defaults.

6. **Restart the api — with `up -d`, not `restart`.** The namespace guard is a
   boot-time snapshot; nothing re-checks a database that changed underneath a
   live process (`backend/src/db/handle-namespace.ts:450-458`).
   ```bash
   docker compose -p rm_prod up -d api
   ```
   Then confirm `"handle_namespace":"clean"` at `/health` (verification 3).

7. **Re-run §4's pre-flight** against the restored database. It is the cheapest
   way to find out that something in this list was missed.
