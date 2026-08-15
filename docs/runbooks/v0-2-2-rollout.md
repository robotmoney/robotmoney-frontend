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
  branch rather than falling through to the token check at `:66` — where
  `v0.2.1` returned the token comparison instead. Claiming the credential is a
  **mandatory human step of this release**, not an optional hardening pass. See
  §2 Gate A for the decision and §12 for the two procedures that carry it out.
- **Domain change.** `bc9f20f` (#603) moved the canonical origin to
  `https://robotmoney.network` (`scripts/prerender.ts:5`,
  `frontend/public/assets/js/app/seo.js:16`). **At `ccf983f` the api did not
  follow**: `backend/src/config.ts:438` defaulted to the old
  `https://robotmoney.net`, and nothing can override it in this deployment (§6,
  §10). ⚠ **Check this before you cut the tag** — commit `969bc2e` moves that
  default to `SWARM_PUBLIC_BASE_URL_DEFAULT = "https://robotmoney.network"`
  (`backend/src/config.ts:448`, resolved at `:450-454`), but it is **not on
  this runbook's branch**: it was extracted out to issue #627 / PR #628 (not
  yet merged as of this writing). If the tag you cut includes that fix (check
  #627/#628's status), §10.2 is not a defect of your release; if it is cut
  without it, it is. Verify with
  `git show <tag>:backend/src/config.ts | grep -n 'robotmoney\.net"'` — keep the
  closing quote, or the pattern also matches `robotmoney.network` and always
  hits (the same half-match that once broke `scripts/prerender.ts:25-29`).
- **New identity column with a unique index and two new triggers** on
  `swarm_members` (`0030`, `0031`).

Treat this as a minor release with a manual auth migration attached.

---

## 2. Go/no-go gates

Five gates. **They are printed in execution order, and that order is not the
alphabet** — the letters are stable names the rest of this document cites,
nothing more. Each gate needs the section before it to have run, and the admin
gate is **last**: it is the only one whose remedy is destructive, and the only
one that requires §5's backup to already exist.

| Order | Gate | Cannot be answered until | Where the answer comes from |
|---|---|---|---|
| 1 | **Gate B** — pre-flight verdict | §3 (the read-only role) and §4 | `backend/scripts/preflight-upgrade.ts` exit code |
| 2 | **Gate D** — the `rm_worker` role exists | §4 | the pre-flight's `rm-worker-role` check |
| 3 | **Gate E** — no long-running transactions | §4 | the pre-flight's `blocking-xacts` check |
| 4 | **Gate C** — backup proven restorable | §5, including §5.3's restore | §5.3 |
| 5 | **Gate A** — admin lockout ⛔ | §5's backup exists (it is the undo for Gate A's remedy) | the query in this section |

Gate A is still the one that can strand you permanently. It is last anyway,
because its only forward path for a lost password is a **write** to
`admin_credential` (§12.2) and you must not take that write without the backup.

### 2.0 Establish `DATABASE_URL` before any `psql` in this document

⚠ **`DATABASE_URL` is not in your shell, and nothing in this workflow puts it
there.** `--external-pg` reads it out of the repo-root `.env` **file** —
`loadEnvFile()` is `readFileSync` (`scripts/lib/demo-external-pg.ts:163-165`),
called at `:294`, and the value is taken at `:303` — and `process.env` is never
consulted (§6.5).

So every `psql "$DATABASE_URL"` in this document — Gate A below, §5.4, §8 and
§11 — expands to `psql ""` unless you load it yourself. **`psql ""` is not an error.**
libpq falls back to its own defaults (`PGHOST` or the local socket, `PGUSER`,
database named after the user), so on any host that happens to run a local
postgres it connects **successfully, to the wrong database**. Gate A then
reports "unclaimed" about a database that is not production, and every §8 check
grades the wrong server.

Load it once, then **prove** what you loaded:

```bash
cd <checkout>
export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
[ -n "$DATABASE_URL" ] || { echo "no DATABASE_URL in $PWD/.env — see §6.5"; exit 1; }

# Identity assertion. Run it, read it, do not skip it.
psql "$DATABASE_URL" -Atc \
  "SELECT current_database(), current_user, inet_server_addr(), inet_server_port();"
```

`cut -d= -f2-` keeps `=` characters inside the password. If your `.env` quotes
the value, strip the quotes — a literal `"` inside the URI breaks it.

The result must name the managed cluster from §3: database `defaultdb`, port
**25060**. A `127.0.0.1`/`::1` address, or port `5432`, is a local postgres — and
so is an **empty** address field, which is what `inet_server_addr()` returns over
a Unix socket, the single most likely wrong answer here. Any of those and **every
gate below is void**. `DATABASE_URL` does not survive into a new
terminal — re-export and re-assert in each one, including the shells you use
for §8 and §11.

### Gate B — pre-flight verdict (order 1)

Run §3, then §4. **`VERDICT: BLOCKED` is a no-go.** Warnings are a go with your
eyes open.

### Gate D — the `rm_worker` role exists (order 2)

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

These are **writes**: run them as `doadmin`, not as `rm_readonly`. Then re-run
§4 so Gate B is green against the repaired cluster.

### Gate E — no long-running transactions (order 3)

Covered by the pre-flight's `blocking-xacts` check (§4). A transaction older than
60s queues in front of `0030`'s `ACCESS EXCLUSIVE` lock, and every reader
arriving after that queues behind **both**. This one goes stale: re-run §4's
pre-flight immediately before §7.3, not only at the top of the window.

### Gate C — backup proven restorable (order 4)

Run §5 including §5.3's verification. **A dump you have not restored is not a
backup.** No-go until the restore check passes. Gate A's remedy has no undo
without it.

### Gate A — admin lockout ⛔ THE BLOCKER (order 5, run LAST)

⚠ **Do not name `recovery_hash` in this query.** That column does not exist on
the database you are about to query: `0029_admin_auth_recovery.sql:4` adds it,
and that migration is **pending** — it applies during this upgrade (§7.4).
Against production at `v0.2.1` a query naming it fails with `42703: column
"recovery_hash" does not exist`. An earlier revision of this runbook printed
such a query *and* offered a table row that invited you to read the resulting
error as the "unclaimed" case, so the failure mode was to record **GO** when the
truth was **STOP**.

The pre-upgrade query is exactly this, and nothing more:

```sql
SELECT count(*) AS rows FROM admin_credential;
```

`admin_credential` **does** exist at `v0.2.1`: `0028_admin_credential.sql` is not
in this delta (§1). So `42P01: relation "admin_credential" does not exist` here
does **not** mean unclaimed — it means you are pointed at the wrong database.
Go back to §2.0.

There is no recovery state to branch on before the upgrade, and there will not
be one afterwards either for a row that already exists: `0029` adds the column
**nullable and backfills nothing**, deliberately
(`0029_admin_auth_recovery.sql:1-3` — a migration cannot mint a recovery code
and disclose it safely). So `rows = 1` always means *claimed, and its
`recovery_hash` will be NULL after cutover*. The only open question is whether
anyone can still produce the password.

**Every branch of this gate has a forward path.** None of them is "stop".

| `rows` | Can anyone produce the password? | Meaning | Decision |
|---|---|---|---|
| **0** | n/a | The one-time claim is **unarmed**. After the upgrade the first party to reach the admin surface takes it. `ADMIN_TOKEN` still works (`auth.ts:66`). | **GO.** Claiming is then a **mandatory** post-cutover step: **§12.1 Procedure A**, executed at §8 verification 10. |
| **1** | yes | Claimed. After cutover it has **no recovery code** (`0029` backfills nothing). | **GO.** After cutover, sign in and run `POST /api/admin/password-change` **once** — it is the only thing that mints a `recovery_hash` for a row claimed before `0029` (`backend/src/api/routes/admin.ts:223`, `:227`). It is **not** available before cutover: that route arrives in this delta (`f26dca6`, #590) and does not exist at `v0.2.1`. Note it also deletes every `admin_passkey` and `admin_session` row in the same transaction (`:234-235`). |
| **1** | no | Claimed, no password, and no recovery code will exist. **This is the lockout.** | **GO only after §12.2 Procedure B**, executed before cutover — with §5's backup already taken, which is why this gate is last. |

**Why the last row is the dangerous one.** After the upgrade, with a claimed row
present, `auth.ts:59-64` compares the presented `X-Admin-Token` against
`admin_credential.pass_hash` and `return false` on mismatch. It never reaches
the `ADMIN_TOKEN` fallback at `:66`. With `recovery_hash` NULL there is no
recovery route either. The admin surface is then reachable **only** by someone
holding the password chosen when the credential was claimed.

**You are not locked out yet, though.** `v0.2.1` — what production is running
right now — falls back to `ADMIN_TOKEN` from *inside* the claimed branch:

```bash
git show v0.2.1:backend/src/api/auth.ts | sed -n '58,63p'
#   if (claimed.length > 0) {
#     …timingSafeEqual… return true;
#     return cfg.adminToken ? secretEq(presented, cfg.adminToken) : false;   // :62
#   }
```

At `ccf983f` that line is a bare `return false` (`auth.ts:64`). So the current
boot's `ADMIN_TOKEN` (§12.0) still reaches the admin surface today, and the
upgrade is what takes it away. That access is not a fix — `v0.2.1` has neither
`/api/admin/password-change` nor `/api/admin/password-recover` (both arrive in
this delta) — but it means you are triaging, not stranded. §12.2 is the fix.

---

## 3. Provision the read-only role

The pre-flight and the dump must both run as a role that **cannot write**. Do
this once, as `doadmin`, against the production cluster.

> 🔴 **Restrict the password's alphabet to `[A-Za-z0-9._~-]`.** §4 pastes it
> into a **URI** —
> `PREFLIGHT_DATABASE_URL='postgres://rm_readonly:<pw>@<host>:25060/…'` — where
> `@ : / ? # [ ] %` and space are reserved delimiters, not password characters.
> A `@` truncates the userinfo and libpq reports a host that does not exist; a
> `%` starts a percent-escape and either mangles the password silently or errors;
> `#` and `?` silently truncate the rest of the URI. Those are the unreserved
> URI characters, so nothing in that set needs escaping anywhere in §3, §4 or
> §5. Take the length from a longer password, not from a wider alphabet:
>
> ```bash
> LC_ALL=C tr -dc 'A-Za-z0-9._~-' </dev/urandom | head -c 40; echo
> ```

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

`PREFLIGHT_DATABASE_URL` is a deliberately separate variable. The script reads
`DATABASE_URL` for exactly one purpose — the equality guard at
`backend/scripts/preflight-upgrade.ts:673`, `if (process.env.DATABASE_URL &&
process.env.DATABASE_URL === url)` → exit `2`. It reads it nowhere else, opens
no pool on it, and never falls back to it (`:666-672` exits `2` when
`PREFLIGHT_DATABASE_URL` is unset). What it does **not** do is import anything
from `src/` — that is the point of the file's standalone shape
(`preflight-upgrade.ts:15-22`).

> **The guard is live or dead depending on where you stand.** It only fires when
> `DATABASE_URL` is in the process environment. Two things put it there:
> §2.0's `export`, and **`bun` auto-loading `.env` from the cwd** — so running
> the script from the repo root rather than from `backend/` makes the guard
> active off the repo-root `.env` alone. That is the state you want: it is a
> real safety check. If it exits `2` with *"identical to DATABASE_URL"*, you
> pasted the application's writer URL — fix the URL, do not unset
> `DATABASE_URL` to silence it.

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
  pre-flight only warns; **the gate decision is yours.** Note this is the one
  safe way to ask about `recovery_hash` before the upgrade: the script checks
  `information_schema.columns` first and switches query shape on the answer
  (`backend/scripts/preflight-upgrade.ts:485-507`), so it never raises `42703`.
  Your own Gate A query must not name the column at all — see Gate A.
- `handle-shape` — member ids that are not valid handles. `0030` backfills
  `handle = id` with no `CHECK`, so those handles can never be saved again
  through the admin surface (validated against `MEMBER_HANDLE_RE`,
  `backend/src/api/validation.ts:446`, 80-char bound at `:482`). Fix after
  cutover, per §8.
- `swarm-members-size` — above 50 000 rows, `0030` is a stall, not a blip.

### On the reconciliation

The script was authored at `bc9f20f`. Its inlined namespace relation
(`backend/scripts/preflight-upgrade.ts:92`) is byte-identical to
`HANDLE_NAMESPACE_CONFLICT_RELATION` (`backend/src/db/handle-namespace.ts:63`),
and both agree with `0031`'s DO block
(`0031_swarm_member_handle_namespace.sql:91-92`, where the same relation is
wrapped across two lines).

**Verified today, guarded by nothing — re-grep before each use.** The script
keeps a **copy, not an import**, on purpose, and its own header says so
(`preflight-upgrade.ts:39-44`): importing the canonical module would drag in
`src/config.ts`'s module-load `required("DATABASE_URL")` and the shared pool,
destroying the standalone/zero-write-risk property this file exists for. The
executed parity test that does exist
(`backend/tests/handle-namespace-predicate-parity.test.ts`) parses `0031`'s DO
block and compares it to the exported constant — it **never reads
`preflight-upgrade.ts`**. So the migration/runtime pair is guarded and the
pre-flight's copy is not: nothing in CI fails if it drifts.

```bash
# The two TypeScript copies must print the identical string.
grep -n 'FROM swarm_members a JOIN swarm_members b' \
  backend/src/db/handle-namespace.ts backend/scripts/preflight-upgrade.ts
# expect handle-namespace.ts:63 and preflight-upgrade.ts:92, same predicate:
#   FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id
```

If those two ever disagree, §4's `handle-namespace` check is no longer telling
you what §7.5's refusal will decide, and a green pre-flight means nothing.

---

## 5. Backup

Production is DigitalOcean Managed Postgres, which has PITR. **PITR is not
sufficient here** — it recovers the cluster, not a file you can inspect, diff, or
restore into a scratch database to prove the release is reversible. Take a local
dump as well.

### 5.1 The dump

> 🔴 **`cd` out of the checkout first.** §4 left you in `<checkout>/backend`, and
> these commands write to the **current directory**. Writing a plaintext
> credential dump (§5.2) inside the git checkout puts it where §5.2 forbids: in
> the tree, and inside `./_static` / repo-root reach of a compose bind mount.
> Pick a directory outside the repo on a filesystem you control.

> 🔴 **Two roles, two passwords — `PGPASSWORD` does not follow `--username`.**
> libpq reads `PGPASSWORD` from the process environment for **every**
> connection, whatever `--username` says. Exporting `rm_readonly`'s password and
> then running `pg_dumpall --username=doadmin` sends `rm_readonly`'s password as
> `doadmin`'s: the server rejects it, or — if the terminal is interactive —
> `pg_dumpall` blocks on a password prompt, which at 3am inside a script reads
> as a hang. Scope the variable to the one command that needs it (a per-command
> assignment, never `export`), or put both roles in `~/.pgpass` and set no
> `PGPASSWORD` at all.

```bash
mkdir -p ~/rm-backup-v022 && cd ~/rm-backup-v022   # OUTSIDE the checkout (§5.2)
set -o pipefail                          # MANDATORY — see the box below
umask 077                                # the file is a credential store

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# rm_readonly's password, scoped to THIS command only.
PGPASSWORD='<rm_readonly password>' pg_dump \
  --host=<host> --port=25060 --username=rm_readonly --dbname=defaultdb \
  --format=custom --compress=9 --no-owner --no-privileges \
  --file="rm-preupgrade-${STAMP}.dump"
echo "pg_dump exit=$?"

# Roles are NOT in the dump above. This is a separate, required artifact —
# and a DIFFERENT role, so a DIFFERENT password.
PGPASSWORD='<doadmin password>' pg_dumpall \
  --host=<host> --port=25060 --username=doadmin \
  --globals-only --no-role-passwords \
  --file="rm-globals-${STAMP}.sql"
echo "pg_dumpall exit=$?"
```

The `~/.pgpass` alternative, if you prefer no secrets on the command line —
`chmod 600` it or libpq ignores the file silently:

```
<host>:25060:defaultdb:rm_readonly:<rm_readonly password>
<host>:25060:*:doadmin:<doadmin password>
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

Every command here is `doadmin`. **Use `doadmin`'s password, not
`rm_readonly`'s** — §5.1's box explains why the distinction is invisible until
it hangs. Set it once for this block only:

```bash
export PGPASSWORD='<doadmin password>'   # unset it again at the end of §5.3
```

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
>
> Then `unset PGPASSWORD` — it is `doadmin`'s, and §5.1's box explains what it
> does to the next command that meant to use a different role. §5.4 below uses
> `DATABASE_URL` (§2.0) instead.

### 5.4 🔴 IRREVERSIBLE — capture the swarm schedule rows, which no restore returns

The `.dump` restores them, but **nothing in §9's rollback does**, and the very
next boot overwrites them again. `seedSwarmSchedules()`
(`backend/src/db/seed.ts:137-152`) issues an unconditional `UPDATE
job_schedules SET cron, enabled, payload, timezone WHERE kind = …` for each of
the five `swarm.*` definitions, and `seed()` is called unconditionally from
`backend/src/db/migrate.ts:61` on **every** boot — v0.2.2's and, after §9,
v0.2.1's too. Any operator toggle you have made to those five rows is
**IRREVERSIBLE** through rollback: rolling the code back rewrites them a second
time (§9, §6.5).

The prior values are therefore an evidence artifact, not a curiosity. Take it
now, with the rest of the backup, against production:

```bash
psql "$DATABASE_URL" -c \
  "SELECT kind, cron, enabled, timezone, payload FROM job_schedules WHERE kind LIKE 'swarm.%' ORDER BY 1;" \
  | tee "rm-swarm-schedules-${STAMP}.txt"
```

Expect five rows. This file is the **only** record of what the boot is about to
clobber; restoring those values afterwards is a manual `UPDATE` per row, and you
cannot write it without this output. Keep it with the dump (it holds no
credentials, so it does not need §5.2's encryption).

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

**Effect in v0.2.2:** the api always computes the **compiled-in default**,
whatever that is in the tag you deploy. At `ccf983f` that is
`backend/src/config.ts:438`'s `https://robotmoney.net` — the **old** domain that
`bc9f20f` (#603) just moved away from — so every swarm application-receipt and
activation email links to the old host. `969bc2e` changes it to
`https://robotmoney.network` (`SWARM_PUBLIC_BASE_URL_DEFAULT`,
`backend/src/config.ts:448`, resolved at `:450-454`) — but that commit is
**not on this runbook's branch**; it is tracked separately as issue #627 / PR
#628 (not yet merged as of this writing). **Confirm which one is in your tag
(§1); do not attempt to change it during the rollout** — it is unreachable
from `.env` and from your shell either way. See §10.

### 6.4 ⚠ `ADMIN_TOKEN` is also minted per boot — read it from the container

Same mechanism: `buildComposeEnv` sets `ADMIN_TOKEN:
cfg.credentials.adminToken` (`scripts/stack/config.ts:219`), a fresh random
20-character value per launch (`:164`). It is **never logged, never written to
`.agents/demo-state.json`, and never printed in the plain non-TUI READY block**
(`scripts/lib/demo-main.ts:374-378`; the block itself is `:1407-1421`, whose
Admin line at `:1413` prints only `(password shown in the interactive TUI
only)`). The TUI renders it at `:964`, and only while the credential is
unclaimed.

> **There is no `--no-tui` trap.** An earlier revision of this runbook said
> `--no-tui` costs you the token and told you to give up the exit code for it.
> That was wrong, and it contradicted §7.3's own requirement. The value is an
> ordinary environment variable **inside the running api container** —
> `docker-compose.yml:192` delivers it as `ADMIN_TOKEN: ${ADMIN_TOKEN:-}` — so
> it is readable from a boot that has no TUI at all. **§12.0 is the command.**
> Keep `--no-tui`; you lose nothing.

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

Optional, and genuinely honoured because they are in `DEMO_COMPOSE_PASSTHROUGH`.
**`scripts/lib/demo-main.ts:427-444` is the authoritative list** — read it there,
not here, before concluding anything is unconfigurable. Reproduced verbatim at
`ccf983f`, all sixteen names:

```
BASE_RPC_URL
SWARM_AGGREGATE_CRON
SWARM_CLOSE_WINDOW_CRON
SWARM_NOTIFICATION_EMAIL_FROM
SWARM_NOTIFICATION_EMAIL_TRANSPORT_TOKEN
SWARM_NOTIFICATION_EMAIL_TRANSPORT_URL
SWARM_OPEN_SESSION_CRON
SWARM_PUBLISH_BRIEF_CRON
SWARM_PUBLISH_CRON
SWARM_SCHEDULES_ENABLED
SWARM_WINDOW_MINUTES
FETCH_CACHE_DIR
FLOOR_SEED_PATH
PROJECTS_SOURCE
RM_ENV
WORKER_DATABASE_URL
```

An earlier revision of this runbook listed six of these and glossed the crons as
`SWARM_*_CRON`. Read as exhaustive, that omission says swarm **mail transport is
unconfigurable** on this workflow — it is not: the three
`SWARM_NOTIFICATION_EMAIL_*` names pass through, and so do `FETCH_CACHE_DIR`,
`FLOOR_SEED_PATH` and `WORKER_DATABASE_URL`. Values `buildComposeEnv()` owns
(ports, credentials, `DATABASE_URL`, `POSTGRES_*`, `DEMO_PROJECT`) are
deliberately **not** on the list and cannot be shadowed (§6.1, §6.2, §6.4).
Passthrough reads your **shell** environment, and an empty string counts as
unset (`demoPassthroughEnv`, `:446-453`).

> ⚠ **`SWARM_SCHEDULES_ENABLED` is on the list and still loses.**
> `docker-compose.demo.yml:72` pins it to `"0"` in the overlay regardless of what
> you pass, and `seedSwarmSchedules()` (`backend/src/db/seed.ts:137-152`)
> rewrites all five `swarm.*` rows' `cron`/`enabled`/`payload`/`timezone` on
> **every** boot — `seed()` is called unconditionally from
> `backend/src/db/migrate.ts:61`. So every `bun smoke` boot **disables all five
> swarm schedules in production**, clobbering any operator toggle, and §9's
> rollback boot does it again. **IRREVERSIBLE** through rollback — §5.4 captures
> the prior values, and it is the only record of them. Plan for the swarm to be
> manually driven after cutover.

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
explicitly, **naming the same compose files that boot used** — see the
`-f`-less-compose box under §11 step 6 for why a bare `docker compose -p …`
command resolves a different topology than the one running:

```bash
docker compose -p <that project> \
  -f docker-compose.yml -f docker-compose.demo.yml \
  down --remove-orphans
```

The stakes are lower here than at §11 step 6 — `down` removes by project label,
so it cannot start anything — but without the overlay Compose does not know the
demo-only services and leaves them behind as orphans, which is exactly the
leftover you came here to clear. `--remove-orphans` covers the gap. See
deployment.md §2.1, "FIRST: find the project name".

### 7.2 Pull the tag

```bash
git fetch --tags origin
git checkout v0.2.2          # after it is cut at ccf983f
git rev-parse HEAD           # MUST print ccf983f…
```

### 7.3 The invocation

> 🔴 **IRREVERSIBLE.** This command is not a dry run and there is no "boot and
> look first" mode. It writes to production three times before you can inspect
> anything: the four migrations (§7.4), `seed()` rewriting the five `swarm.*`
> schedule rows (§6.5, §5.4), and the **archive initializer** — `prod-bootstrap.ts`
> run as `docker compose run --rm … api bun run scripts/prod-bootstrap.ts
> --already-migrated` (`scripts/lib/demo-main.ts:1136-1140`) — which adopts and
> writes archive rows into the live database (§8 verification 8). None of it has
> a down migration (§7 header). Do not run this before Gates B, D, E, C and A
> are all green.

```bash
cd <checkout>
DEMO_PROJECT=rm_prod bun smoke -- --external-pg --no-tui
BOOT_STATUS=$?                # capture it HERE — §8 verification 1 reads this
echo "boot exit=$BOOT_STATUS" # MUST be 0
```

⚠ **Capture the status on the same line-group as the boot.** `$?` holds only the
*previous* command's status, and §8 opens with two commands of its own
(`export RM_PROJECT=…`, `bun run demo:status`) before its first check. By then
`$?` reports `demo:status`, not the boot. `BOOT_STATUS` survives that; `$?` does
not.

**Each flag, justified:**

| Flag / var | Why it is here | What happens without it |
|---|---|---|
| `--external-pg` | **MANDATORY.** Starts no postgres container and points the stack at the managed server via `DATABASE_URL` from repo-root `.env` (`scripts/lib/demo-external-pg.ts:288-305`). | The stack boots its own empty postgres in a fresh volume. **Your production data is not touched and not served** — you get an empty site and think it worked. This is failure mode #2 in §0. |
| `DEMO_PROJECT=rm_prod` | **MANDATORY.** Pins the compose project name (`scripts/lib/demo-main.ts:261`). Without it the name is `rm_demo_stack_<random>` per boot (`scripts/stack/naming.ts:138`). | Every restart leaves an orphaned project. `docker compose -p …` commands in deployment.md address the wrong stack. Note: `--external-pg` does **not** by itself stabilise the project name — only `DEMO_PROJECT` does. |
| `--no-tui` | On a TTY a **failed boot renders a pane and never exits non-zero**; Ctrl-C then exits `0` (`scripts/lib/demo-main.ts:1911-1918`, which returns without `process.exit`). `--no-tui` gives a real `exit 1` (`:1920-1928`). | You cannot tell success from failure by exit code. **Always pass it.** Needing the per-boot `ADMIN_TOKEN` — Gate A row 1 (`rows = 0`), or anyone who took §12.2's re-arm — is *not* a reason to omit it: read the token out of the container instead (§12.0). |
| **`CI` must be UNSET** | ⛔ With any truthy `CI` the boot runs a bounded scenario and then **tears the whole stack down**. Under smoke the branch taken is `CI && smokeMode` (`scripts/lib/demo-main.ts:1175`): it runs one live swarm session against production and then `scripts/smoke-e2e-assert.ts` (`:1206`). The swarm-session *driver* at `:1212` is the **other** branch, `CI && !smokeMode`, and never runs here. Either way control reaches `if (process.env.CI)` at `:1390`, which calls `cleanup()` — a full `compose down` (`:697`, `:711-715`) — then `cleanCiVolume()` (`:1393`) and `process.exit(0)` (`:1394`). `cleanCiVolume()` also runs on the failure path (`:1893`), issuing `docker volume rm <project>_pgdata` (`scripts/lib/demo-volumes.ts:105`). | The volume removal is harmless under `--external-pg` (no volume exists), but the teardown is not. Success exits `0` (`:1394`) and failure exits `1` (`:1894`) — the exit code still works — yet **either way the stack is torn down**, so the site does not stay up and there is nothing left to inspect or verify in §8. Check with `echo "CI=[$CI]"` before you start. It must print `CI=[]`. |

```bash
echo "CI=[$CI]"     # MUST be empty
```

### 7.4 What the boot does, in order

```
docker preflight → build → postgres → [db preflight, --external-pg only]
  → migrate (scripts/stack/stack.ts:388) → services (:394) → ports → /health → initialize
```

⚠ **The bracketed step is the one part of this diagram no test asserts.**
`scripts/tests/unit/stack-lifecycle-order.test.ts:83-93` asserts the order, but
the array it compares against is exactly eight elements —
`docker-preflight, build, postgres, migrate, services, ports, health,
initialize` — with **no `db preflight` step in it**. The test runs `up()` without
an `upOpts.preflight` callback, so the `--external-pg` classification hook at
`scripts/stack/stack.ts:386` is never invoked and its position is uncovered.
Read from source, not from the test: `up()` calls `preflight()` at `:386`,
between the postgres phase and `migrate()` at `:388`, with the comment *"Refuse
before the first write, not after it"*. Everything else in the diagram is
test-asserted; that element is asserted by reading.

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

Discover the project first — you pinned it, so it is `rm_prod`. `DATABASE_URL`
must be loaded and asserted in **this** shell too, or every `psql` below grades
the wrong database (§2.0):

```bash
export RM_PROJECT=rm_prod
[ -n "${DATABASE_URL:-}" ] || { echo "re-do §2.0 in this shell"; exit 1; }
psql "$DATABASE_URL" -Atc "SELECT current_database(), inet_server_addr(), inet_server_port();"
bun run demo:status
```

⚠ Every command in that block overwrites `$?`. Check 1 therefore reads
`$BOOT_STATUS` — the variable §7.3 captured on the boot's own command line —
and never `$?`.

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Boot exited clean | `echo "$BOOT_STATUS"` — the variable captured on §7.3's own command line. **Not `echo $?`**: by the time you reach §8 that reports `demo:status`, not the boot, and it will read `0` after a failed cutover. | `0`. On a TTY without `--no-tui` this proves nothing (§7.3). If `BOOT_STATUS` is unset you did not capture it; you cannot recover it, so re-run §7.3 (it is idempotent — migrations resume, seed and adopt are idempotent) rather than assume. |
| 2 | All four migrations recorded | `psql "$DATABASE_URL" -c "SELECT name FROM schema_migrations WHERE name LIKE '0029%' OR name LIKE '003%' ORDER BY 1;"` | four rows: `0029_admin_auth_recovery.sql`, `0029_admin_passkey.sql`, `0030_swarm_member_handle.sql`, `0031_swarm_member_handle_namespace.sql` |
| 3 | Namespace guard ran and was clean | `curl -s "http://127.0.0.1:$(docker compose -p "$RM_PROJECT" port api 8787 \| cut -d: -f2)/health"` | `"handle_namespace":"clean"`. **`"unchecked"` means the guard could not run — this boot proves nothing.** `"overridden"` means you are serving a violation. |
| 4 | No violation in the data | `psql "$DATABASE_URL" -c "SELECT a.id, a.handle, b.id FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id;"` | 0 rows |
| 5 | Namespace trigger is `ENABLE ALWAYS` | `psql "$DATABASE_URL" -c "SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger';"` | `A`. `O` means a `DISABLE`/`ENABLE` cycle downgraded it and the replica-role bypass `0031` closes is open again. |
| 6 | Every member has a handle | `psql "$DATABASE_URL" -c "SELECT count(*) FROM swarm_members WHERE handle IS NULL;"` | `0` (`SET NOT NULL` guarantees it; this catches a partial apply) |
| 7 | Handles are saveable | `psql "$DATABASE_URL" -c "SELECT id, handle FROM swarm_members WHERE handle !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(handle) > 80;"` | 0 rows. Any row here is a member the admin surface can never re-save (§4, `handle-shape`). Fix with `UPDATE swarm_members SET handle = '<kebab-case>' WHERE id = '<id>';` — **move the handle, never the id.** |
| 8 | Archive data was adopted, not overwritten | `psql "$DATABASE_URL" -c "SELECT count(*) FROM swarm_recommendations;"` | ≥ the pre-upgrade count from §5.3. The archive initializer **adopts**: `classifyDatabase` returns `mode: "adopt"` for the archive initializer on populated data (`backend/scripts/db-preflight.ts:158`) — insert-if-missing, fill only `NULL` columns, else report drift. Existing rows win; the signed `payload`/`signature` columns are never rewritten. |
| 9 | `admin_credential` untouched by the boot | `psql "$DATABASE_URL" -c "SELECT count(*), (recovery_hash IS NULL) FROM admin_credential GROUP BY 2;"` | The **count** must equal Gate A's `rows`. `recovery_hash IS NULL` must be `t` for any row that existed at Gate A — `0029` adds the column and backfills nothing, so the upgrade cannot have minted one. (This is the first point in the runbook where `recovery_hash` is a legal thing to select: the column exists only after `0029` applied. See Gate A.) **No seed path ever writes this table.** |
| 10 | Admin surface reachable, and claimed | If Gate A returned `rows = 0` (row 1) — or you took §12.2's re-arm — **run §12.1 Procedure A now.** This is a mandatory step, not a spot check: until it runs, the one-time claim is open to whoever reaches the surface first. If Gate A returned `rows = 1` and somebody has the password (row 2), sign in and run `POST /api/admin/password-change` once instead — that is the only way this row ever gets a `recovery_hash`. | `/api/admin/is-claimed` returns `{"claimed":true}` and you hold both the password and a recovery code. |
| 11 | Site serves prerendered HTML | `curl -s http://127.0.0.1:<port>/swarm/ \| grep -o '<title>[^<]*'` | Not the home page's title. **"Assembly did not run" is not a possible cause here** — see the diagnosis below. |
| 12 | Swarm schedules state | `psql "$DATABASE_URL" -c "SELECT kind, enabled FROM job_schedules WHERE kind LIKE 'swarm.%' ORDER BY 1;"` | five rows, **all `enabled = f`** — expected under the demo composition (§6.5). Compare against §5.4's capture: the difference is what this boot clobbered, and it is not coming back on its own. Drive sessions manually. |

### Diagnosing check 11

The old remedy — *"`bun run static:assemble` did not run"* — is **unreachable on
this workflow.** `up()` calls `assembleStaticDir()` at
`scripts/stack/stack.ts:368`, before `build()` and long before any container
starts, and it **throws** on a non-zero `scripts/static-assembly.sh`
(`:287-288`), which aborts the bring-up. A boot that reached §8 at all ran
assembly successfully. Silently skipping it is not a state this stack has.

Work the real causes instead, in this order:

```bash
# a. Did the assembled tree actually get the route? (Empty = cause b or c.)
ls -l _static/swarm/index.html
docker compose -p "$RM_PROJECT" exec -T api ls -l /srv/frontend/swarm/index.html
```

- **The api is serving a different `_static`.** `docker-compose.yml:259` binds
  `./_static:/srv/frontend:ro`, resolved against the **compose project
  directory** — the repo root of the checkout the boot ran from
  (`scripts/stack/stack.ts:216`). Present on the host but absent in the
  container means the container was started from a different directory, or
  outside §7.3 entirely (§11 step 6 / a hand-run `docker compose up`, where
  nothing runs assembly and Docker will happily create an **empty** bind
  directory).
- **The route is not in the sitemap.** `scripts/prerender.ts:31-32` derives its
  entire route list from `frontend/public/sitemap.xml`'s `<loc>` entries that
  match `ORIGIN` (`prerender.ts:5`, `https://robotmoney.network`) and writes
  `<route>/index.html` for each. A route missing from the sitemap is silently
  never prerendered, assembly still exits `0`, and the api falls back to the
  home-page shell. Confirm with
  `grep -c '<loc>' frontend/public/sitemap.xml` (expect 37 at `ccf983f`) and
  `grep -o '<loc>[^<]*' frontend/public/sitemap.xml | grep '/swarm'`.
- **A stale container.** The api container predates this checkout's assembly —
  `docker compose -p "$RM_PROJECT" ps` and compare `CREATED` against the boot.
  The fix is §7.3 again, never `docker compose restart` (§11 step 6's box).

---

## 9. Rollback

### Triggers — roll back if any of these are true

- Verification 3 reports `overridden`, or 4 returns rows you cannot repair now.
- Verification 2 shows fewer than four migrations **and** the boot is failing.
- The admin surface is unreachable and Gate A returned a claimed row (`rows = 1`). Roll
  back to regain access (`v0.2.1` still honours `ADMIN_TOKEN` against a claimed
  credential — see "What rollback does NOT undo" below), then apply §12.2.
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
BOOT_STATUS=$?; echo "rollback boot exit=$BOOT_STATUS"   # capture it here (§7.3)
```

Re-run verification 3, 4 and 11.

### ⚠ What rollback does NOT undo

- **The schema stays at 0031.** There are no down migrations. `recovery_hash`,
  `admin_passkey`, `admin_session`, `admin_webauthn_challenge`,
  `swarm_members.handle`, its unique index and both triggers all remain.
- **`admin_credential` stays claimed** — but rolling back *does* restore
  `ADMIN_TOKEN` access to it, non-destructively. `v0.2.1`'s `isPrivileged()`
  falls back to the env token from inside the claimed branch
  (`git show v0.2.1:backend/src/api/auth.ts`, line 62); `ccf983f`'s is a bare
  `return false` (`auth.ts:64`). So a rollback is itself a remedy for an admin
  lockout discovered after cutover — read the new boot's token with §12.0 and
  sign in. It buys triage time; it does not give you a durable v0.2.2
  credential, which still needs §12.2. A rollback is **not** a Gate A remedy:
  at Gate A you are already on `v0.2.1`.
- **The five `swarm.*` schedules stay disabled — IRREVERSIBLE.** `seed()`
  rewrote them on the v0.2.2 boot and rewrites them again on the v0.2.1 boot
  (`backend/src/db/seed.ts:137-152`, called from
  `backend/src/db/migrate.ts:61`, §6.5). Rollback restores **nothing** here.
  The only route back to the prior `cron`/`enabled`/`timezone`/`payload` values
  is a manual `UPDATE` per row, written from §5.4's capture — which is why §5.4
  is part of the backup evidence set and not an optional nicety.
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

### 10.2 The api advertises the old domain — **only if you tag at `ccf983f`**

At `ccf983f`, `backend/src/config.ts:438` defaults `SWARM_PUBLIC_BASE_URL` to
`https://robotmoney.net` while the canonical origin is
`https://robotmoney.network` (`scripts/prerender.ts:5`,
`frontend/public/assets/js/app/seo.js:16`). Not overridable — §6.3. Swarm emails
then link to the old host.

⚠ **This fix is NOT carried by this runbook's branch.** It was originally
bundled here as `969bc2e`, extracting the default to
`SWARM_PUBLIC_BASE_URL_DEFAULT = "https://robotmoney.network"`
(`backend/src/config.ts:448`, resolved at `:450-454`) and pinning it with a
new executed test on that PR's branch (a `swarm-public-base-url.test.ts` file
under `backend/tests/`, not present here). A compliance review found that
unrelated to the v0.2.2 rollout scope, so it was extracted into its own
issue/PR (#627 / #628) and reverted out of this branch. Whether this section
applies to your release depends on whether #627 / #628 have landed on `main`
by the time you cut the tag — not on anything in this runbook's branch. Check
their status, then verify empirically regardless:

```bash
git show <the tag you cut>:backend/src/config.ts | grep -n 'robotmoney\.net"'
# a hit  → this section applies; emails link to the retired host
# no hit → the default is robotmoney.network; nothing to do
```

Decide it before cutover and record the answer, because it changes nothing you
*do* — it changes only what you tell people to expect in their inbox.

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

**Open a session against the restored database first, and prove which one it
is.** These steps are written as bare SQL, so they need a `psql` session — and
nothing in this workflow puts `DATABASE_URL` in your shell (§2.0). If you
restored into a *different* database than production, `.env`'s value is the
wrong one; use that database's own URI instead.

```bash
psql "$DATABASE_URL"      # or the explicit URI of the database you restored
```

Then, at the `psql` prompt, before anything else:

```
\conninfo
```

It must name the database you restored. If it names production, or a local
socket, stop — you are about to "repair" the wrong server.

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

   > 🔴 **Do NOT run a bare `docker compose -p rm_prod up -d api`.** An earlier
   > revision of this runbook printed exactly that, and on the post-restore path
   > it is the worst command in the document.
   >
   > A `bun smoke --external-pg` stack is **three** compose files, not one:
   > `docker-compose.yml` + `docker-compose.demo.yml`
   > (`scripts/lib/demo-main.ts:284-288`) + a **generated** overlay written to
   > `.agents/demo-<project>-external-pg.yml` (`:299-304`), which is what removes
   > the `postgres` service and drops every `depends_on: postgres` so a
   > dependency edge cannot pull the container back in. Compose learns that list
   > from `COMPOSE_FILE` in the boot's own environment (`:463`), never from the
   > project name.
   >
   > With no `-f` and no `COMPOSE_FILE`, Compose resolves `docker-compose.yml`
   > **alone** — where the api still declares `depends_on: postgres: condition:
   > service_healthy` (`docker-compose.yml:262-264`). So Compose starts a **new
   > `postgres` container and a fresh `rm_prod_pgdata` volume**, waits for it to
   > become healthy, and brings the api up against a stack that now contains an
   > empty database. On the one path in this document where you have just
   > restored production data and have not yet verified it, that is how you end
   > up serving an empty site and reporting a successful restore.

   **Re-run the boot.** It is the only form that reconstructs the full topology,
   and it is the form §12.2's closing warning also requires (the hand-run api
   gets **no** `ADMIN_TOKEN`, which opens `/api/admin/claim` to anyone who can
   reach the port):

   ```bash
   cd <checkout>
   echo "CI=[$CI]"                       # MUST be empty
   DEMO_PROJECT=rm_prod bun smoke -- --external-pg --no-tui
   BOOT_STATUS=$?; echo "boot exit=$BOOT_STATUS"
   ```

   If you must drive Compose directly, pass the **exact** file list this boot
   used. `.agents/demo-state.json` does record a `composeFiles` field
   (`scripts/lib/demo-main.ts:778`) — but ⚠ **do not use it verbatim**: it
   stores `composeFilesBase`, deliberately **without** the generated
   `--external-pg` overlay, because `demo:down`/`demo:status` act by project and
   do not need it (`:752-756`). That value reintroduces the entire defect above.
   Append the overlay yourself. For this rollout (`DEMO_PROJECT=rm_prod`, no
   `--stage`) the full list is:

   ```bash
   cd <checkout>
   ls -l .agents/demo-rm_prod-external-pg.yml   # must exist — no file, no boot to repair
   COMPOSE_FILE="docker-compose.yml:docker-compose.demo.yml:.agents/demo-rm_prod-external-pg.yml" \
     docker compose -p rm_prod up -d api
   ```

   Cross-check the first two names against `.agents/demo-state.json`'s
   `composeFiles` before running it; if that field lists a third file
   (`docker-compose.stage.yml`), keep it and append the overlay after it.

   Then confirm `"handle_namespace":"clean"` at `/health` (verification 3), and
   `docker compose -p rm_prod ps` shows **no `postgres` service**. One appearing
   there means the overlay was not applied and the api is on an empty database —
   tear the stack down and re-run the boot.

7. **Re-run §4's pre-flight** against the restored database. It is the cheapest
   way to find out that something in this list was missed.

---

## 12. Admin credential procedures

Two walkable procedures, plus the one command both depend on. They are here at
the end because they are dispatched *from* the flow rather than read in
sequence:

- **§12.1 Procedure A — claim the credential.** Dispatched from Gate A row 1 (`rows = 0`)
  and executed at **§8 verification 10**, after cutover. Mandatory whenever the
  credential is unclaimed.
- **§12.2 Procedure B — re-arm a claimed credential whose password is lost.**
  Dispatched from Gate A row 3 (`rows = 1`, password lost) and executed
  **before cutover**.

Do not read these as background. Gate A tells you which one you are running.

### 12.0 Reading the current boot's `ADMIN_TOKEN`

```bash
export RM_PROJECT=rm_prod
docker compose -p "$RM_PROJECT" exec -T api printenv ADMIN_TOKEN
```

Verified against Compose v2.40: exits `0`, prints the 20-character value on one
line, and resolves the container from the project label alone — the working
directory does not need a compose file. `-T` suppresses TTY allocation so the
output is clean enough to assign to a variable.

Why this works: `generateStackCredentials()` mints `adminToken` as
`crypto.randomUUID()` stripped to 20 characters
(`scripts/stack/config.ts:164`); `buildComposeEnv` emits it (`:219`);
`docker-compose.yml:192` declares `ADMIN_TOKEN: ${ADMIN_TOKEN:-}` on the api
service, and `backend/Dockerfile`'s `oven/bun:1.3.5` base carries `printenv`.
The same three facts hold at `v0.2.1` (`scripts/stack/config.ts:163`, `:217`;
`docker-compose.yml:179`), so this also works on a stack you rolled back (§9).

> ⚠ **The token dies at the next boot.** It is minted per launch, so a restart
> between reading it and using it mints a *different* one and the value you
> copied is dead. Read it, use it, and if anything restarts, read it again.
> This is also why an unclaimed credential cannot simply be left for tomorrow:
> tomorrow's token is not today's.

To use it in the commands below:

```bash
ADMIN_SETUP_TOKEN="$(docker compose -p "$RM_PROJECT" exec -T api printenv ADMIN_TOKEN | tr -d '\r\n')"
API_PORT="$(docker compose -p "$RM_PROJECT" port api 8787 | cut -d: -f2)"
```

### 12.1 Procedure A — claim the credential (production is UNCLAIMED)

**Mandatory. Run it at §8 verification 10, immediately after a clean cutover.**
Until it runs, the one-time claim is armed and the first party to reach `/admin`
takes permanent ownership of the instance.

**1. Confirm the state you think you are in.**

```bash
curl -s "http://127.0.0.1:$API_PORT/api/admin/is-claimed"    # expect {"claimed":false}
```

That probe is public and returns booleans only, never the hash
(`backend/src/api/routes/admin.ts:174-177`).

**2. Read this boot's setup token** — §12.0.

**3. Open `/admin`. The claim form is the only thing there.** This is enforced,
not convention: the claim gate renders on `isClaimed === false`
(`frontend/public/views/admin.html:34`), the sign-in gate requires
`isClaimed === true` (`:61`), and the dashboard requires `authed` (`:109`).
There is no other control to press, and no way to skip the claim.

**4. Fill both fields.** *Setup token* is the §12.0 value; it authorizes the
claim as `X-Admin-Token` (`admin.ts:187` runs `isPrivileged` before anything
else). *New durable password* must be **at least 12 characters after trimming**
(`admin.ts:189-190`). Pick one with no leading or trailing whitespace —
`hashKey()` trims before hashing (`backend/src/lib/keys.ts:5-7`), so a password
with edge whitespace is not the password you think you set.

Equivalent, if the browser is awkward at 3am — this prints the recovery code
straight to the terminal:

```bash
curl -s -X POST "http://127.0.0.1:$API_PORT/api/admin/claim" \
  -H "X-Admin-Token: $ADMIN_SETUP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"password":"<at least 12 characters>"}'
```

**5. 🔴 RECORD THE RECOVERY CODE. IT IS SHOWN EXACTLY ONCE.** The claim mints it
and returns it in the same response (`admin.ts:191`, inserted at `:194`,
returned at `:206`). The UI prints it under "Save this code immediately. It will
not be shown again." (`admin.html:49-56`) and `finishClaim()` clears it from the
component the moment you press Continue. Only its hash is stored — nothing can
redisplay it. Store it where §5.2 says to store the dump: offline, encrypted,
outside the checkout and outside any compose bind mount. Losing it puts you back
in Gate A row 3 the next time the password goes missing.

**6. Understand what just changed.** From this moment `ADMIN_TOKEN` no longer
authenticates: `isPrivileged()` takes the claimed branch and returns `false` on
a mismatch instead of falling through to the env-token check
(`backend/src/api/auth.ts:59-64`). The password is the only credential.
`RM_ALLOW_INSECURE` does not reopen the gate either — the claimed branch never
consults `allowInsecure`. Do **not** plan on passkeys as a second factor: they
are known-broken behind the tunnel (§10.1).

**7. Do not run a password change afterwards.** The claim already minted the
recovery code. `POST /api/admin/password-change` is for Gate A row 2 — a row
claimed *before* `0029`, whose `recovery_hash` is NULL. Running it here would
rotate a working credential for nothing and would delete every `admin_passkey`
and `admin_session` row (`admin.ts:234-235`).

**8. Verify.** `/api/admin/is-claimed` now returns `{"claimed":true}`; you can
sign in with the password; and — now that `0029` has applied, so the column
exists — `SELECT count(*), (recovery_hash IS NULL) FROM admin_credential GROUP
BY 2;` returns one row with `false`. Re-running the claim returns `409` — the `id = 1` primary
key makes it one-time (`0028_admin_credential.sql:3-4`, `admin.ts:201-203`).

### 12.2 Procedure B — re-arm a claimed credential (password is LOST)

**Run this before cutover.** It is Gate A row 3's forward path. Both remedies
below are **writes**, so the §3 `rm_readonly` role cannot perform them — it holds
`pg_read_all_data` and `default_transaction_read_only = on`. Use `doadmin` on
port **25060** (§3's port note applies unchanged). Take §5's backup first: it is
the undo for B1 and the only record of what B2 destroys.

Two remedies, in order of preference. **B1 first.**

#### B1 — reset the hash in place (PREFERRED: reversible, never re-arms the claim)

`hashKey()` is a plain unsalted single-round SHA-256 of the trimmed input
(`backend/src/lib/keys.ts:5-7`) — the same property §5.2 warns about — so the
stored credential can be set to a password you choose, in place, without
deleting the row.

```sql
BEGIN;
-- RECORD THIS. The old pass_hash is your undo.
SELECT id, pass_hash, recovery_hash, claimed_at FROM admin_credential;

UPDATE admin_credential
   SET pass_hash = encode(sha256(convert_to('<new password, 12+ chars, no edge spaces>', 'UTF8')), 'hex')
 WHERE id = 1;
COMMIT;
```

`sha256(bytea)` is a PostgreSQL 11+ builtin and needs no extension; §4's
`server-version` check already fails below 11.

Undo, exactly:

```sql
UPDATE admin_credential SET pass_hash = '<the hex you recorded>' WHERE id = 1;
```

Then cut over (§7), sign in with that password, and run
`POST /api/admin/password-change` **once**. That one call is what makes the
credential whole: in a single transaction it rotates `pass_hash`, mints and
returns a `recovery_hash` (`admin.ts:223`, `:227`), deletes every
`admin_passkey` and `admin_session` row (`:234-235`), and writes an audit record
(`:236`). Record the returned recovery code the same way §12.1 step 5 says to.

> **Honest caveat.** B1 is not the recovery the schema documents — that is B2
> (`0028_admin_credential.sql:11-13`). B1 hand-writes a credential hash, and it
> writes no audit row of its own. It is preferred anyway because it never
> re-arms the one-time claim, so it has no window in which a third party can
> take ownership of the instance.

#### B2 — delete and re-arm the one-time claim

> **DESTRUCTIVE / IRREVERSIBLE.** It discards the existing credential
> permanently. There is no undo short of restoring §5's dump. It re-arms the
> one-time claim, so the next party to reach the admin surface takes ownership —
> make sure that is you. Documented as the intended recovery at
> `backend/migrations/0028_admin_credential.sql:11-13`.

**What else is lost — and what is NOT.** Verified against the schema, and it
corrects what an earlier revision of this runbook asserted: `0029_admin_passkey.sql`
creates `admin_passkey` (`:2-9`), `admin_webauthn_challenge` (`:13-17`) and
`admin_session` (`:20-24`) with **no foreign key to `admin_credential` and no
`ON DELETE` cascade** — the string `REFERENCES admin_credential` does not appear
anywhere under `backend/migrations/`. Deleting the credential leaves all three
tables fully intact, and both of the survivors are load-bearing:

- **A surviving `admin_session` row keeps full admin authority.**
  `isPrivileged()` checks `admin_session` **first** (`backend/src/api/auth.ts:55-57`)
  and returns `true` on a hit before it ever reads `admin_credential`.
- **A surviving passkey keeps minting new sessions.**
  `POST /api/admin/webauthn/auth/verify` requires no prior authorization, and its
  `SELECT id FROM admin_credential WHERE id = 1 FOR UPDATE`
  (`backend/src/api/routes/admin-webauthn.ts:218`) never asserts that a row came
  back — `FOR UPDATE` over zero rows is a no-op, not an error — so it proceeds to
  issue a fresh 24-hour session at `:234`.

That holder could take the re-armed claim instead of you. So **after cutover**,
delete all four together:

```sql
-- v0.2.2 schema (0029_admin_passkey.sql applied). Take §5's backup FIRST.
BEGIN;
SELECT * FROM admin_credential;                      -- record what you are destroying
SELECT count(*) AS live_sessions FROM admin_session WHERE expires_at > now();
SELECT count(*) AS passkeys FROM admin_passkey;
DELETE FROM admin_session;
DELETE FROM admin_passkey;
DELETE FROM admin_webauthn_challenge;
DELETE FROM admin_credential;
COMMIT;
```

**Before cutover, on `v0.2.1`, run the single statement instead.** Only
`admin_credential` exists there — `0029_admin_passkey.sql` is in this delta
(`fdfd9ee`, #589) — so the other three `DELETE`s raise `42P01` and abort the
whole transaction:

```sql
BEGIN;
SELECT * FROM admin_credential;
DELETE FROM admin_credential;
COMMIT;
```

**Then run §12.1 Procedure A immediately after cutover.** Not "soon" — the
instance is unowned until you do.

#### When to run Procedure B

**Before the upgrade, right after Gate C's backup.** Reasoning:

- Gate A is the one gate the cutover makes worse. The migrations are
  **IRREVERSIBLE** (§7), and while a rollback does restore `ADMIN_TOKEN` access
  to a claimed credential (§9), spending it costs you the release and a second
  maintenance window. Settle the credential while that is still a contingency
  rather than the plan.
- Neither remedy can conflict with the upgrade. No migration in this delta
  writes `admin_credential` — `0029_admin_auth_recovery.sql:4` only adds a
  nullable column — and no seed path touches the table either (§8
  verification 9).
- §5's dump is B1's undo, and you want it taken first regardless.

**Exception: do not *claim* before cutover.** A claim executed against `v0.2.1`
writes a row whose `recovery_hash` is NULL, because that column does not exist
until `0029_admin_auth_recovery.sql` runs during this upgrade. That is precisely
the Gate A row 2/3 shape you just paid a destructive delete to escape. **Re-arm
or reset before; claim after** (§12.1, at §8 verification 10).

#### Security in the window between the delete and the claim

Between B2's `DELETE` and the claim, the per-boot `ADMIN_TOKEN` is the **only**
gate on `POST /api/admin/claim` (`admin.ts:187`).

It is a real gate, and the demo overlay does **not** widen it. `buildComposeEnv`
always sets `ADMIN_TOKEN` (`scripts/stack/config.ts:219`), so
`config.adminToken` is always non-null (`backend/src/config.ts:497`), so
`isPrivileged()`'s unclaimed branch takes the `secretEq` comparison at
`auth.ts:66` and **never evaluates `cfg.allowInsecure`**. `RM_ALLOW_INSECURE: "1"`
from `docker-compose.demo.yml:35` (§0 fact 1) is therefore inert for this gate.
That is the honest finding; it is not a reassurance about the overlay generally.

It stops being inert the moment `ADMIN_TOKEN` reaches the container **empty**.
`backend/src/config.ts:497` is `process.env.ADMIN_TOKEN || null`, and an empty
string is falsy — then `allowInsecure` decides, and it is `true` whenever the
demo overlay is in the composition (`backend/src/config.ts:485`). In that state
`/api/admin/claim` accepts **anyone who can reach the port**, with no credential
at all. You produce it by starting the api outside `bun smoke`, where nothing
runs `buildComposeEnv` and `docker-compose.yml:192`'s `${ADMIN_TOKEN:-}`
resolves to empty:

- with the demo overlay (`-f docker-compose.yml -f docker-compose.demo.yml`) →
  **claim wide open**;
- without it → `RM_ENV` falls to `demo` (`docker-compose.yml:171`),
  `allowInsecure` is `false`, `adminToken` is null, and the admin surface `403`s
  every request including your own claim — locked out until a proper boot.

**So while the claim is armed, bring the stack up only through §7.3.** In
particular do not reach for a hand-run `docker compose … up -d api` during this
window — §11 step 6 spells out the other half of why that command is wrong here
(it also starts a rogue postgres), but this half is worse: the api it starts has
an **empty** `ADMIN_TOKEN`, which is exactly the state described above. Keep the window minutes long, and keep §10.1 in view: this
surface is reachable through the public tunnel.
