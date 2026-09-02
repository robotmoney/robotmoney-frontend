# Rollout procedure — the release-independent half

Everything a production rollout does that is **the same every release**: how to
find your position, how the backup is taken and proven, how the stage rehearsal
and digital smoke-twin work, how environment actually reaches the api container, how
the stack is stopped and started, and what rollback does and does not undo.

**This document is not runnable on its own and is not a release plan.** It has
no release identity, no delta, no migration list and no acceptance criteria —
those belong to a per-release runbook under `docs/runbooks/`, which cites this
one. Policy — the gate workflow, the rc numbering, the branch rules — belongs to
[`docs/technical/release-runbooks.md`](../technical/release-runbooks.md), which
governs both.

| Document | Owns |
|---|---|
| `technical/release-runbooks.md` | **Policy.** Gates, rc numbering, branch rules, tracking issue |
| **this document** | **Procedure.** The mechanics that do not change between releases |
| `runbooks/vX-Y-Z-rollout.md` | **This release.** Identity, delta, migrations, config decisions, acceptance criteria, known-broken |
| `runbooks/deployment.md` | **The environment.** Credential inventory, compose topologies |

## Where this came from, and what that means for trusting it

Every section below was **executed against production during the v0.2.2
rollout** and corrected over eleven release candidates. That is the strongest
provenance any of this repo's operational docs has, and it is the reason the
detail is preserved verbatim rather than summarised: the warnings are here
because something went wrong once.

It also bounds the claim. This was proven for **one** upgrade, on **one**
topology. Where a step's correctness depended on something specific to v0.2.2,
this document says so and tells the per-release runbook to redo the analysis
rather than inherit the conclusion — see §10's two boxed questions for the
clearest example. The archived
[`docs/archive/v0-2-2-rollout.md`](../archive/v0-2-2-rollout.md) is the original,
kept whole as the historical record.

## Conventions

Two placeholders appear throughout. A per-release runbook resolves both.

| Placeholder | Means |
|---|---|
| `<FROM>-to-<TO>` | The upgrade's script directory, e.g. `backend/scripts/upgrades/0.2.1-to-0.2.2/` |
| `$RM_BACKUP_DIR` | The release's backup directory, e.g. `~/rm-backup-v022`. Export it before you start. |

```bash
export RM_BACKUP_DIR=~/rm-backup-v0XY
```

---

## 1. Where am I? — run this before reading anything else

```bash
bun run rollout:where            # human-readable
bun run rollout:where -- --json  # same state, for an agent
```

**This document does not record your position. The probe derives it, every
time.** Nothing here is a status field, and no per-release runbook should add one. The
v0.2.2 runbook carried two dead status paragraphs, each true for about a day,
and kept them only as a record of what stale looked like. A rollout that spans
sessions, hosts and release candidates cannot be tracked in prose.

What the probe derives, and from what:

| It tells you | Derived from | Never from |
|---|---|---|
| Which host you are on and what it can do | repo-root `.env` (§7.5), `.env.readonly` (§4) | a hostname you typed |
| Which release you are at | `git rev-parse HEAD`, `git tag --points-at HEAD` | a SHA written in this file |
| Which steps are done | one receipt per step, written by that step's own script | a checked box |
| Whether those still **count** | the three axes below | when it feels recent |

### The three axes — why "we cut a new rc" is not "start over"

A completed step stops counting for exactly three reasons, and they are
independent:

1. **Host** — the cutover and everything after it need the writer
   `DATABASE_URL` that only lives in the
   repo-root `.env` file (§7.5). A box without that file cannot run them at
   all; the probe marks them ⛔ rather than letting you try.
2. **Code** — each step declares the paths it actually executes (`depends-on`
   in its step block). A commit invalidates a step only if it lands on that
   step's own inputs. This is what release-runbooks.md §4.4's *"the smoke-twin must
   use the same release candidate that is planned for production"* means in
   practice: a docs-only commit invalidates nothing, a change to `preflight.ts`
   invalidates Gate C **and** Gate B (Gate C runs preflight's checks —
   `restore-check.ts:33`), and a change to `backend/src/**` invalidates the
   boot rehearsal while leaving the gates alone.
3. **Clock** — Gate E goes stale by the minute, the baseline and dump go
   stale as production moves. Expiry is amber, not red: an expired step was
   right when it ran. Code drift is red.

### Receipts

Every scripted step writes one JSON receipt to
`$RM_BACKUP_DIR/receipts/<step>.json` when passed `--emit-receipt`, recording
its exit code, verdict, the SHA and rc tag it ran at, the host, the **database
identity** it actually connected to (§3.1's assertion, captured instead of read
and forgotten), and the SHA-256 of every artifact it produced. Steps a person
performs by hand are attested with
`bun run rollout:where -- --record <step> --note "..."`, and are displayed as
attested — somebody's word, not a program's exit code.

Receipts hold **no secrets**: database identity, never a credential. That is
why they can sit unencrypted beside an encrypted credential dump (§5.2).

**A receipt is evidence, not authority.** The probe re-hashes the artifacts,
re-runs the diff and re-derives the host before it believes one. If a receipt
and the filesystem disagree, the filesystem wins. Delete the receipts directory
and you have lost bookkeeping, not safety — every gate can be re-run, and a
step with no receipt is simply not done.

Each step also has a machine-readable block (```` ```yaml step ````) carrying
what a program has to know: its id, artifacts, TTL and `verify:` command. Those
blocks live in the **per-release** runbook, not here — every field in one names
that release's own scripts and backup directory, so a shared copy would be the
"fact with two homes" the manifest exists to prevent. Each release's
`backend/scripts/upgrades/<FROM>-to-<TO>/steps.ts` is their single source, and
that release's rollout-steps test fails if manifest and prose drift apart.

Prose is the authority on *how* and *why*, in both documents.

---

## 2. Read this first — three facts that change what "upgrade" means here

Each was first verified at `ccf983f` and re-verified on 2026-08-17 against
`origin/releases-0.2.x` (`d852329`) — every file cited below is unchanged
between the two — and each invalidates something an operator would otherwise
assume. Re-check them against the tip you pin in §1 before you rely on them.

1. **`bun smoke` boots a smoke-shaped stack, not a production one.** It always
   appends `docker-compose.smoke.yml` (`scripts/lib/smoke-main.ts:284-288`, which
   never consults smoke mode), which sets `RM_ALLOW_INSECURE: "1"`
   (`docker-compose.smoke.yml:35`) and pins `SWARM_SCHEDULES_ENABLED: "0"`
   (`:72`). deployment.md §4.3 says this out loud about the pinned-port origin:
   *"a pinned-port origin serves a **smoke** stack (`RM_ALLOW_INSECURE=1`,
   explicit smoke schedules…), not a production one."* You are running the smoke
   composition against production data. Nothing below can change that — it is a
   property of the workflow, not a setting.
2. **Without `--db external`, `bun smoke` builds a brand-new empty database
   every single boot and your production data is not touched.** The compose
   project name is `rm_smoke_stack_<10 hex>` where the hex is
   `shortHash(crypto.randomUUID())` (`scripts/stack/naming.ts:138`, `:149-151`)
   — **random per boot** outside GitHub Actions. A new project means a new
   `<project>_pgdata` volume. The previous boot's volume is orphaned, not
   deleted. **`--db external` is mandatory for this rollout** (`--external-pg` is the
   older spelling of the same mode and still works).
3. **You cannot set `AUTOMATION_TOKEN`, `ADMIN_TOKEN` or
   `SWARM_PUBLIC_BASE_URL` for a `bun smoke` boot.** See §7 — this is the single
   biggest departure from the established plan, and two of the three are code
   defects rather than operator steps.

---

## 3. Connecting to the database

### 3.1 Establish `DATABASE_URL` before any `psql` in this document

⚠ **`DATABASE_URL` is not in your shell, and nothing in this workflow puts it
there.** `--db external` reads it out of the repo-root `.env` **file** —
`loadEnvFile()` is `readFileSync` (`scripts/lib/smoke-external-pg.ts:163-165`),
called at `:294`, and the value is taken at `:303` — and `process.env` is never
consulted (§7.5).

So every `psql "$DATABASE_URL"` in this document — the admin-credential check
below, §5.4, and the cutover and post-restore shells — expands to `psql ""`
unless you load it yourself.
**`psql ""` is not an error.** libpq falls back to its own defaults (`PGHOST`
or the local socket, `PGUSER`, database named after the user), so on any host
that happens to run a local postgres it connects **successfully, to the wrong
database**. The admin-credential check then reports "unclaimed" about a
database that is not production, and every §9.1 check grades the wrong server.

Load it once, then **prove** what you loaded:

```bash
cd <checkout>
export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
[ -n "$DATABASE_URL" ] || { echo "no DATABASE_URL in $PWD/.env — see §7.5"; exit 1; }

# Identity assertion. Run it, read it, do not skip it.
psql "$DATABASE_URL" -Atc \
  "SELECT current_database(), current_user, inet_server_addr(), inet_server_port();"
```

`cut -d= -f2-` keeps `=` characters inside the password. If your `.env` quotes
the value, strip the quotes — a literal `"` inside the URI breaks it.

The result must name the managed cluster from §4: database `defaultdb`, port
**25060**. A `127.0.0.1`/`::1` address, or port `5432`, is a local postgres — and
so is an **empty** address field, which is what `inet_server_addr()` returns over
a Unix socket, the single most likely wrong answer here. Any of those and **every
gate below is void**. `DATABASE_URL` does not survive into a new
terminal — re-export and re-assert in each one, including the shells you use
for the cutover and for any post-restore work.

## 4. Provision the read-only role — on the primary, used only via the replica

The pre-flight and the dump must both run as a role that **cannot write**.
Production has a dedicated **read-only replica node** (a separate DO Managed
Postgres resource, its own hostname, streaming from the primary) — that
replica, not the primary, is what `.env.readonly` points at and what every
`rm_readonly` connection in this runbook actually uses.

> 🔴 **`.env.readonly` must never name the primary's host.** This is enforced
> by policy, not by a technical block: Postgres roles are cluster-wide catalog
> objects, replicated from the primary to the replica byte-for-byte — there is
> only ONE `rm_readonly`, and it is created via the primary (below) because
> that is the only place `CREATE ROLE` can run at all (the replica is
> structurally read-only, at the WAL-replay level, for every write INCLUDING
> `CREATE ROLE` — this holds even for `doadmin`, which is not a true
> superuser on DO's replica either way). The same credentials therefore *would*
> still authenticate against the primary if you pointed them there. Nothing
> stops that technically; the process stops it by never doing it. Always take
> the replica's hostname from DO's dashboard/API for the read-only node
> specifically, and confirm the `target:` line `backend/scripts/upgrades/<FROM>-to-<TO>/preflight.ts`
> prints (§4) names the replica before trusting anything downstream of it.

Provisioning is still a **write**, so it still runs as `doadmin` against the
primary, once ([[no-agent-writes-to-primary-db]] applies — this is an
operator action, not something to hand an agent execute-and-forget):

> 🔴 **Restrict the password's alphabet to `[A-Za-z0-9._~-]`** for the manual
> `psql` spot-check below and for §5's dump commands, both of which build or
> pass a connection string by hand. `@ : / ? # [ ] %` and space are reserved
> delimiters there, not password characters — a `@` truncates the userinfo and
> libpq reports a host that does not exist; a `%` starts a percent-escape and
> either mangles the password silently or errors; `#` and `?` silently
> truncate the rest of the URI. **§4 is the one exception**: the pre-flight
> script takes this password from a discrete `password=` key in
> `.env.readonly`, not a pasted URI, and URI-escapes it itself
> (`encodeURIComponent`) before building the connection string — so the
> restriction does not apply there. Take the length from a longer password,
> not from a wider alphabet, since you need one alphabet that works
> everywhere this password is used:
>
> ```bash
> LC_ALL=C tr -dc 'A-Za-z0-9._~-' </dev/urandom | head -c 40; echo
> ```

```sql
CREATE ROLE rm_readonly LOGIN PASSWORD '<generate a strong one>';

GRANT CONNECT ON DATABASE defaultdb TO rm_readonly;
GRANT USAGE ON SCHEMA public TO rm_readonly;

-- Belt: make every transaction on this role read-only at the server.
ALTER ROLE rm_readonly SET default_transaction_read_only = on;
```

> 🔴 **`GRANT pg_read_all_data TO rm_readonly;` does NOT work here — verified
> 2026-08-17.** That is the textbook PG14+ recipe (see the box below for why
> it would be preferable), but `doadmin` on DO Managed Postgres is not a true
> superuser and does not hold `ADMIN OPTION` on the predefined
> `pg_read_all_data` role, so granting it fails: `42501: permission denied to
> grant role "pg_read_all_data" — Only roles with the ADMIN option on role
> "pg_read_all_data" may grant this role.` Use the explicit-grant fallback
> instead, immediately after the block above:
>
> ```sql
> GRANT SELECT ON ALL TABLES IN SCHEMA public TO rm_readonly;
> GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_readonly;
> ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO rm_readonly;
> ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rm_readonly;
> ```

> **Why `pg_read_all_data` would be preferable, if `doadmin` could grant it,
> and never `GRANT SELECT ON ALL TABLES IN SCHEMA public` alone.** `ON ALL
> TABLES` is a **one-shot expansion**: Postgres resolves it to the tables that
> exist at that instant and writes individual grants. Every table a future
> migration creates is invisible to that role — and it fails **silently**,
> because `pg_dump` simply omits what it cannot read. You get a dump that
> restores cleanly and is missing tables. `pg_read_all_data` is a role
> membership evaluated at query time, so it covers tables that do not exist
> yet; the `ALTER DEFAULT PRIVILEGES` pair above is the next-best substitute —
> it covers tables *this role's future self* would have created, which is not
> the same guarantee, but is the closest `doadmin` can actually grant. Re-run
> the grant block above after any migration that a normal role (not
> `doadmin`) creates new tables under, to be safe.

Verify the role is genuinely read-only before trusting it — against the
**replica's** hostname:

```bash
psql "postgres://rm_readonly:<pw>@<replica-host>:25060/defaultdb?sslmode=require" \
  -c "SHOW transaction_read_only;" \
  -c "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = current_user;"
```

Expect `on`, then five `f`. Anything else and §4 will refuse to run anyway.
`transaction_read_only = on` here is doubly guaranteed on the replica — the
role's own `ALTER ROLE ... SET default_transaction_read_only = on` above, AND
the replica's structural inability to accept writes regardless of role. Belt
and suspenders: keep the role-level setting anyway, since §4's checks (and
this same role) may in principle be pointed at a non-replica target by
mistake, and the role-level belt is what catches that.

> **Port 25060, never 25061.** `25060` is DigitalOcean's direct session port.
> `25061` is PgBouncer in **transaction** pooling mode, which does not hold a
> session across statements — that breaks `pg_dump`'s repeatable-read snapshot
> and can produce a torn dump. Use `25060` for everything in §4, §4 and §5,
> on whichever node (primary for provisioning, replica for everything else).
>
> **CONTRADICTS deployment.md §4.3**, which says *"For the HA cluster, prefer the
> **connection-pool** URI (PgBouncer) if enabled. Migrations (D9) run with this
> credential."* For the application's own `DATABASE_URL` that preference is out
> of scope here — but do **not** follow it for the pre-flight or the dump.

---

## 5. Backup — the dump, its encryption, and the proof it restores

Gate C in every per-release runbook. Run it FIRST, before anything reads the
live database: the dump is what rollback depends on, so it is proven before the
upgrade is allowed to touch anything.

### 5.1 The dump

> **Manifest step `P3.backup`.** The machine-readable block for this step —
> its id, artifacts, TTL and `verify:` command — lives in the **per-release**
> runbook, because every one of those fields names that release's own scripts
> and backup directory. This document describes the mechanic; the release binds
> it. See `backend/scripts/upgrades/<FROM>-to-<TO>/steps.ts`.

> 🔴 **`cd` out of the checkout first.** §4 left you in `<checkout>/backend`, and
> these commands write to the **current directory**. Writing a plaintext
> credential dump (§5.2) inside the git checkout puts it where §5.2 forbids: in
> the tree, and inside `./_static` / repo-root reach of a compose bind mount.
> Pick a directory outside the repo on a filesystem you control.

> **One role, one password, one host.** Both commands below run as
> `rm_readonly` against the replica (the globals dump too — see the ✅ box
> after them). An earlier revision needed `doadmin` against the primary for
> the second command and warned at length that `PGPASSWORD` does not follow
> `--username`; that hazard is gone with the second credential. Still scope
> the variable to each command (a per-command assignment, never `export`) or
> use `~/.pgpass`, so the password does not leak into unrelated child
> processes.

```bash
mkdir -p $RM_BACKUP_DIR && cd $RM_BACKUP_DIR   # OUTSIDE the checkout (§5.2)
set -o pipefail                          # MANDATORY — see the box below
umask 077                                # the file is a credential store

STAMP="$(TZ=UTC date +%Y%m%dT%H%M%SZ)"
echo "$STAMP" > .last-stamp              # restore-check.ts (§5.3) reads this

# rm_readonly's password, scoped to THIS command only.
# <replica-host>: the read-only replica from §4, NEVER the primary — the dump
# is a read, and the replica is where every read in this runbook happens.
PGPASSWORD='<rm_readonly password>' pg_dump \
  --host=<replica-host> --port=25060 --username=rm_readonly --dbname=defaultdb \
  --format=custom --compress=9 --no-owner --no-privileges \
  --file="rm-preupgrade-${STAMP}.dump"
echo "pg_dump exit=$?"

# Roles are NOT in the dump above. This is a separate, required artifact.
# SAME role, SAME replica, SAME password as the pg_dump above — no doadmin,
# no primary. VERIFIED 2026-08-17 (see the box below): rm_readonly against
# the replica produces a complete globals dump, because --globals-only with
# --no-role-passwords is a pure catalog READ of pg_roles (NOT pg_authid,
# which is what would need superuser).
PGPASSWORD='<rm_readonly password>' pg_dumpall \
  --host=<replica-host> --port=25060 --username=rm_readonly --database=defaultdb \
  --globals-only --no-role-passwords \
  --file="rm-globals-${STAMP}.sql"
echo "pg_dumpall exit=$?"
```

> **`--database=defaultdb`, not the default `template1`.** DO Managed
> Postgres's `pg_hba.conf` rejects connections to `template1` from outside
> its own network path — verified 2026-08-17: omitting this flag fails with
> `FATAL: pg_hba.conf rejects connection for host ..., user "doadmin",
> database "template1"`. `pg_dumpall`'s `-l`/`--database` flag picks the
> database it connects through to enumerate globals; it does not change what
> gets dumped (globals are cluster-wide either way).
>
> ✅ **`rm_readonly` against the replica is enough for the globals dump —
> verified 2026-08-17, resolving what an earlier revision left open.** The
> run exited `0` and produced all 11 cluster roles, including the two
> anything downstream actually needs (`rm_readonly` and `rm_worker`, with
> their `ALTER ROLE` attribute lines), terminated by `PostgreSQL database
> cluster dump complete`. `restore-check.ts` then consumed it and reached
> `PASS rm-worker-role` off exactly this file. **So this runbook's entire
> backup path — data and roles — runs as one non-superuser role against the
> replica, and `doadmin` and the primary are not touched at all.**
>
> Why it works, so you can predict when it would stop: `--no-role-passwords`
> makes `pg_dumpall` read **`pg_roles`** (a world-readable catalog view)
> instead of **`pg_authid`** (superuser-only, because it holds the password
> hashes). Drop `--no-role-passwords` and it reverts to `pg_authid` and
> fails for a non-superuser — which is fine, because you do not want a
> plaintext-equivalent role-password dump in this artifact anyway (§5.2).
> **Verify the output rather than trusting the exit code**, since a role you
> cannot read is omitted silently, exactly as §4's box warns for tables:
>
> ```bash
> grep -cE '^CREATE ROLE' "rm-globals-${STAMP}.sql"          # expect the cluster's role count
> grep -E '^(CREATE|ALTER) ROLE (rm_readonly|rm_worker)\b' "rm-globals-${STAMP}.sql"
> tail -3 "rm-globals-${STAMP}.sql" | grep -c 'dump complete'  # must be 1 (PG 18 appends a trailing blank line)
> ```

The `~/.pgpass` alternative, if you prefer no secrets on the command line —
`chmod 600` it or libpq ignores the file silently:

```
<replica-host>:25060:defaultdb:rm_readonly:<rm_readonly password>
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
>
> **Concretely: production is PostgreSQL 18 (18.6, confirmed by Gate B on
> 2026-08-17), and no current distro ships an 18 client by default** —
> Ubuntu 24.04's `postgresql-client` is 16, which fails here with
> `server version mismatch`. Installing the distro package and discovering
> that at 3am is a bad trade for two minutes now, so check first and add
> PGDG if needed:
>
> ```bash
> pg_dump --version        # must be >= the server major (18)
>
> # If it is older, add the PostgreSQL APT repo (Debian/Ubuntu):
> sudo install -d /usr/share/postgresql-common/pgdg
> sudo curl -sSf -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
>   https://www.postgresql.org/media/keys/ACCC4CF8.asc
> . /etc/os-release && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
>   https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
>   | sudo tee /etc/apt/sources.list.d/pgdg.list
> sudo apt-get update && sudo apt-get install -y postgresql-client-18
> pg_dump --version        # re-check: PGDG's postinst repoints /usr/bin
> ```
>
> `restore-check.ts` restores into `postgres:18` (`restore-container.ts`'s
> `IMAGE`) precisely so the restore target matches production's major — a
> client older than 18 cannot produce a dump that container will accept
> either, so this is one requirement, not two.

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

**Use a passphrase FILE, not gpg's interactive prompt.** `restore-check.ts`
and `stage-rehearsal.ts` decrypt non-interactively with
`gpg --batch --passphrase-file <backupDir>/.backup-passphrase`
(`scripts/lib/restore-container.ts`), and `resolveBackupFiles()`
refuses to start without that exact file. An earlier revision of this
section showed a bare `gpg --symmetric`, which prompts and writes no such
file — follow that literally and §5.3 exits `2` before it restores anything,
so **Gate C could not pass as written.** Generate the passphrase first and
hand it to both `gpg` calls:

```bash
umask 077
# The passphrase itself. Same alphabet rule as §4 — this one is also typed
# by hand during a recovery, so keep it shell-safe.
LC_ALL=C tr -dc 'A-Za-z0-9._~-' </dev/urandom | head -c 48 > .backup-passphrase
echo >> .backup-passphrase

gpg --batch --yes --passphrase-file .backup-passphrase \
    --symmetric --cipher-algo AES256 "rm-preupgrade-${STAMP}.dump"
shred -u "rm-preupgrade-${STAMP}.dump"       # or: rm -P on macOS
gpg --batch --yes --passphrase-file .backup-passphrase \
    --symmetric --cipher-algo AES256 "rm-globals-${STAMP}.sql"
shred -u "rm-globals-${STAMP}.sql"
```

> 🔴 **The passphrase file must not stay next to the dumps at rest.** The
> tooling requires it *inside* `backupDir` while it runs, which means that
> for the duration of §5.3/§6 the key and the ciphertext sit in one
> directory — copy that directory anywhere and the encryption has bought you
> nothing. That co-location is an execution-time requirement, not a storage
> layout. **When the Gate C run is done, move `.backup-passphrase` somewhere
> the dumps are not** (a password manager, a separate host), and restore it
> to `backupDir` only for the minutes a later run needs it. Verify what you
> are about to archive:
>
> ```bash
> ls -a $RM_BACKUP_DIR     # .backup-passphrase must NOT travel with the .gpg files
> ```

Do not put either file in the checkout, in `.agents/`, or anywhere a compose
bind mount can reach.

### 5.3 The verification that PROVES it restores — and that it is safe to upgrade

> **Manifest step `P3.gate-c`.** The machine-readable block for this step —
> its id, artifacts, TTL and `verify:` command — lives in the **per-release**
> runbook, because every one of those fields names that release's own scripts
> and backup directory. This document describes the mechanic; the release binds
> it. See `backend/scripts/upgrades/<FROM>-to-<TO>/steps.ts`.

A dump you have not restored is a hypothesis. And a dump that restores but
was never checked against this release's migrations is only half proven.

```bash
cd <checkout>/backend
bun scripts/upgrades/<FROM>-to-<TO>/restore-check.ts $RM_BACKUP_DIR
```

This is `restore-check.ts` (docs above it in the file explain the full
mechanism). What it does, entirely with Docker and your own encrypted files —
**no `doadmin`, no primary, no production connection of any kind**:

1. Starts a throwaway local `postgres:18` container (matching production's
   major version) with its own freshly generated, local-only superuser —
   nothing borrowed from `.env`/`.env.readonly`, and no production credential
   anywhere in the path (§6.3 T1, T4).
2. Decrypts and loads just the `rm_readonly`/`rm_worker` role definitions out
   of `rm-globals-<STAMP>.sql.gpg` (the rest of a real globals dump is DO
   Managed Postgres's own internal cluster role graph — `_doadmin_*`,
   `_dodb*`, `avn_*` GUCs — which a vanilla container can't replicate and
   which nothing here needs).
3. Decrypts and `pg_restore`s `rm-preupgrade-<STAMP>.dump.gpg`.
4. Prints row counts for the tables that matter (`swarm_recommendations` is
   the SIGNED take table — payload `jsonb NOT NULL`, signature `text NOT
   NULL`, `0004_committee.sql:38-40`, renamed `0025:70`) and the
   handle/id-namespace invariant, column-existence-checked first — a
   pre-cutover backup correctly reports `swarm_members.handle absent`
   (migration `0030` has not applied to this data yet) rather than throwing.
5. **Then runs this release's full preflight checks** (the same
   `runChecks` §4 runs, imported directly) **against the restored copy** —
   this is what makes Gate C a real preflight pass, not just a structural
   restore check.
6. Tears the container down (`docker rm -f`), win or lose.

Exit `0` means both the restore and the dump-based preflight are clean —
**only then is Gate C green**, and only then does §4 run against the live
replica. Exit `1` means a verification query or a preflight check found a
real problem; exit `2` means it could not run at all (missing files, Docker
failure). Nothing here is destructive and nothing needs manual cleanup — the
throwaway container is gone whether the run succeeds or fails.

### 5.4 🔴 IRREVERSIBLE — capture the swarm schedule rows, which no restore returns

> **Manifest step `P3.schedules`.** The machine-readable block for this step —
> its id, artifacts, TTL and `verify:` command — lives in the **per-release**
> runbook, because every one of those fields names that release's own scripts
> and backup directory. This document describes the mechanic; the release binds
> it. See `backend/scripts/upgrades/<FROM>-to-<TO>/steps.ts`.

The `.dump` restores them, but **nothing in §10's rollback does**, and the very
next boot overwrites them again. `seedSwarmSchedules()`
(`backend/src/db/seed.ts:137-152`) issues an unconditional `UPDATE
job_schedules SET cron, enabled, payload, timezone WHERE kind = …` for each of
the five `swarm.*` definitions, and `seed()` is called unconditionally from
`backend/src/db/migrate.ts:61` on **every** boot — the incoming release's boot and, after a rollback (§10), the outgoing
release's boot too. Any operator toggle you have made to those five rows is
**IRREVERSIBLE** through rollback: rolling the code back rewrites them a second
time (§10, §7.5).

The prior values are therefore an evidence artifact, not a curiosity. Take it
now, with the rest of the backup. This is a pure `SELECT`, so it runs as
`rm_readonly` against the **replica** like every other pre-cutover read in
this runbook — **not** as the application's writer. An earlier revision used
`psql "$DATABASE_URL"` here, which is the one production write credential,
reached for at the one point in preflight where nothing needs it; the standing rule
is that preflight never touches the primary and never uses the writer.

```bash
# Same connection §4's role uses, read out of .env.readonly. One helper, so a
# password containing '=' survives (only the FIRST '=' separates key/value).
rokey() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" <checkout>/.env.readonly | head -1; }

export PGHOST="$(rokey host)"       PGPORT="$(rokey port)"
export PGUSER="$(rokey username)"   PGPASSWORD="$(rokey password)"
export PGDATABASE="$(rokey database)" PGSSLMODE=require

# Prove it is the replica and the read-only role before trusting the output.
psql -X -Atc "SELECT current_user, inet_server_addr(), current_database();"

psql -X -c \
  "SELECT kind, cron, enabled, timezone, payload, next_run_at, last_enqueued_at FROM job_schedules WHERE kind LIKE 'swarm.%' ORDER BY 1;" \
  | tee "rm-swarm-schedules-${STAMP}.txt"
```

Expect one row per `swarm.*` schedule definition. Capture `next_run_at` and
`last_enqueued_at` per row as well — those are the wedge-detection fields
preflight and §9.2 both read.

> **v0.2.2's reading, for shape only:** five rows, all `enabled = f`, `payload`
> `{}` except `swarm.publish_brief`'s `{"windowMinutes": 60}`. Do not treat those
> values as the expected answer for a later release — take your own.

This file is the **only** record of what the boot is about to clobber;
restoring those values afterwards is a manual `UPDATE` per row, and you
cannot write it without this output. Keep it with the dump (it holds no
credentials, so it does not need §5.2's encryption).

---

## 6. The stage rehearsal — mandatory, not optional

> **Manifest step `P5.rehearsal-boot`.** The machine-readable block for this step —
> its id, artifacts, TTL and `verify:` command — lives in the **per-release**
> runbook, because every one of those fields names that release's own scripts
> and backup directory. This document describes the mechanic; the release binds
> it. See `backend/scripts/upgrades/<FROM>-to-<TO>/steps.ts`.

> **Corrected 2026-08-20 — this section used to be headed "Optional but
> recommended".** It is not optional and never was: §6.4 opens *"⛔ This is a
> blocking gate. Do not proceed to §7 until the smoke-twin run exits 0"*, and
> release-runbooks.md §4.4 makes the digital-smoke-twin rehearsal part of the
> foundational workflow with *"any failure, warning, or unexpected state change
> discovered on the smoke-twin is a blocking issue."* Two places said required, one
> said optional, and the optional one was the heading an operator reads first.

`restore-check.ts` proves the dump restores and that static SQL checks pass
against it. It does **not** prove this release's actual migration code path
runs cleanly, or that the app boots and serves pages against production-shaped
data — a migration can pass every static check above and still fail for
reasons only a real run surfaces (lock timing under a live boot, a seed()
interaction, a route that 500s against real data shapes). `stage-rehearsal.ts`
closes that gap:

```bash
cd <checkout>/backend
bun scripts/upgrades/<FROM>-to-<TO>/stage-rehearsal.ts $RM_BACKUP_DIR
```

⛔ **Staging host only (§2) — this does a real Docker image build.** Expect
several minutes: image build/pull, the real `migrate.ts` run against the
restored data, `seed()`, and a full health-wait.

> 💳 **This runs the production model on a funded key, and that is the
> point.** `OPENCODE_API_KEY` must be set — in your shell, or in the
> checkout's **`.env.readonly`**, and deliberately **not** `.env`. On a staging
> host `.env` holds the application's writer `DATABASE_URL`, and this whole
> family of commands (`smoke:capture`, `smoke:smoke-twin --once`, `stage-rehearsal.ts`,
> preflight) is defined by not needing that credential; reading `.env` for the
> key would have made them depend on the one file they exist to stay away from,
> and made "which key did that run use?" a question with two answers. It
> **refuses to start** without one rather than quietly downgrading.
>
> An earlier version pinned `AGENT_MODEL=free` to avoid the spend. That made
> the rehearsal cheaper and less meaningful: `scripts/lib/swarm/inference.ts`
> documents that **model choice is not neutral** for swarm authorship — some
> Zen families refuse the persona task outright or break format, so a green
> `free` run does not predict a production boot. A rehearsal that does not
> use production's model is not rehearsing production.
>
> If you genuinely want the cheap structural check instead, that is §5.3's
> `restore-check.ts`, which needs no inference at all. Do not reach for
> `AGENT_MODEL=free` here to make this step cheaper — it converts a
> production rehearsal into a different test while still reporting exit `0`.

What it does:

1. Restores the backup into a throwaway local Postgres (same mechanism as
   §5.3), bound to the Docker bridge gateway rather than `127.0.0.1` — the
   app containers it boots next need to reach it from inside their own
   network namespace, and the gateway address is reachable from sibling
   containers without being internet-routable the way `0.0.0.0` would be
   (Docker's own iptables rules can expose a `0.0.0.0` bind past a firewall
   that looks like it blocks the port — verified 2026-08-17, this is not
   hypothetical).
2. Boots the real stack against it with `bun scripts/smoke.ts --smoke --db
   smoke-twin --no-tui`, `CI` unset, a scoped `SMOKE_PROJECT` (lowercased — Compose
   project names reject the uppercase `T`/`Z` in the backup's own timestamp).
   The funded **`OPENCODE_API_KEY`** is passed in the child's environment, and
   **no `AGENT_MODEL`** is set, so the model resolves to `DEFAULT_AGENT_MODEL`
   — the one production runs. See the box below: this rehearsal spends real
   credit, on purpose.
3. **Supervises** that boot rather than waiting for it to exit (G2 — it never
   would), polling `.agents/smoke-state.json` for the api's published port and
   `GET /health` on it until both answer, against G3's deadline. A boot that
   exits at all fails the run immediately, since a healthy `CI`-unset boot runs
   forever.
4. Once ready, runs `scripts/smoke-frontend-check.ts` against that port — the
   same route/content checks CI runs on every boot, not a bespoke probe.
5. Then, **while the smoke-twin is still up**, runs this release's `postflight.ts`
   against it (G8, §6.1 step 3). This is the step that emits
   `P5.postflight-smoke-twin`.
6. Tears down on **every** exit path (G6): stops the supervised boot first,
   then `smoke-down.ts` with an explicit `SMOKE_PROJECT`, the `member_home_*`
   volumes `smoke-down` deliberately keeps, and the smoke-twin's own volume — which
   `smoke-down` keeps by contract but which, for a rehearsal, is pure litter
   holding production-derived data.

> **The isolated `git worktree` is gone, and so is the throwaway `.env`.**
> Earlier revisions of this step checked out a detached worktree, symlinked
> `node_modules` into it and wrote it a private `.env`, for exactly one reason:
> `--external-pg` reads `DATABASE_URL` from the repo-root `.env` **file**, and
> on a staging host that file holds a real credential. `--db smoke-twin` builds its
> URL in-process and writes no file at all, so the whole apparatus was
> insurance against a risk the mode no longer takes. What it was protecting is
> now asserted rather than arranged — see G7.

Exit `0` means the migration ran for real, the stack came up healthy, the
frontend checks passed against production-shaped data, and this release's
postflight is clean against the migrated smoke-twin.

#### 6.1 ⛔ The rehearsal runs preflight AND POSTFLIGHT against the smoke-twin

**A rehearsal that only proves the stack boots has not rehearsed the
release.** Run **both** halves against the digital smoke-twin, in the same order
production will see them, before production is touched at all:

1. **Preflight** — §5.3's `restore-check.ts` (Gate C), then the release's own
   `preflight.ts` checks.
2. **Cutover** — §6's boot, which applies this release's migrations to the
   restored production rows for real.
3. **Postflight** — **every check the release's postflight runs, and every acceptance criterion the per-release runbook states**,
   against the migrated smoke-twin.

Step 3 is the one that was missing, and its absence is exactly how a real
defect reached rc.5 while every script reported success: the boot exited `0`,
the frontend checks passed, and **two members still ended up with the wrong
public handle** (`robot-money` instead of `robotmoney`, `woon-2` instead of
`woon`) — the per-release runbook's acceptance criteria. A green mechanism is
not a met objective, and only those criteria
distinguishes them.

The smoke-twin is the right place for this and the only place it is free: it holds
real production rows, so the ACs are evaluated against the data that will
actually be migrated, and a failure costs a rerun rather than a rollback.
**Treat an AC failure on the smoke-twin exactly as an AC failure in production** —
patch, cut the next rc, rehearse again. Do not carry a known-failing AC into
a cutover on the theory that production will behave differently; it is the
same data.

#### 6.2 Contract — what a correct rehearsal run does

This is the **specification**, written so the tool can be judged against it.
It is normative: where `stage-rehearsal.ts` and this section disagree, this
section states the intent and the script is what gets fixed.

| # | Guarantee | Why it is load-bearing |
|---|---|---|
| **G1** | **It terminates on its own, always.** A run reaches one of the exit codes below without an operator interrupting it. "Still going" after the deadline is a **failure**, not patience. | This is the last gate before a production cutover, often at 3am. A step that can hang indefinitely cannot be sequenced, cannot be timed, and silently converts "rehearsal passed" into "nobody waited long enough to find out." |
| **G2** | **It boots what §8.2 boots, and supervises it.** Same scenario (`--smoke`), same `--no-tui`, same `CI`-unset supervision, same compose topology — the one difference is the data path: `--db smoke-twin` here, `--db external` at cutover. Those two modes take the *identical* structural path through the boot (`smoke-db-mode.ts` generates one overlay for both: no postgres service, no volume, no `depends_on`); they differ only in who resolves `DATABASE_URL`, and `--db smoke-twin` additionally *asserts* the answer (G7). Before the mode enum existed the rehearsal borrowed `--external-pg` to get byte-identical flags, and paid for it with the worktree apparatus above. | With `CI` unset the boot **never self-terminates by design**: it falls past smoke-main's CI-gated exits (`scripts/lib/smoke-main.ts:1175`, `:1212`) into the LIVE steady-state loop and cycles sessions forever. That is correct for §8.2, where the stack must stay up serving production. A rehearsal that `await`s that process therefore waits forever — the two requirements are only compatible if the rehearsal supervises. Setting `CI` to escape this is **not** an acceptable fix: a truthy `CI` tears the stack down regardless of exit code (§8.2), so the frontend checks would have nothing left to hit, and the boot would no longer be the one §8.2 runs. |
| **G3** | **Readiness is polled, with a deadline.** Ready ⇔ `.agents/smoke-state.json` exists **and** `/health` on its `apiPort` answers `200`. Not reached within the deadline ⇒ exit `1`. | Readiness is the only honest signal that migration + seed + serve all succeeded, and a deadline is what turns G1 from an intention into a property. Allow generously for a cold image build (a first build pulls base images and compiles); this is minutes, not seconds. |
| **G4** | **Verification runs against the booted stack**: `scripts/smoke-frontend-check.ts` on the published port — the same route/content checks CI runs, never a bespoke probe. | A stack that boots but serves the home-page shell for every route is a failed cutover that `/health` alone reports as green (§9.1's check table). |
| **G5** | **Spend is bounded, and the bound is explicit.** The boot runs production's model on a **funded** key, and the steady-state loop authors real swarm takes on a timer. The rehearsal must stop the stack as soon as its checks finish — pass or fail — and must never let the loop cycle unattended. Where a release's checks genuinely need longer than seconds (watching a scheduler tick, waiting on a paced backfill), the window is **bounded by `RehearsalOptions.checkDeadlineMs`**, default 45 minutes, enforced by the driver as a race against the `onReady` hook. A check that cannot bound its own wait must say so rather than hold a metered stack open. | Cost here is unbounded and grows with wall-clock, so a hang is not merely slow, it is expensive. Verified 2026-08-17: a hung run reached 5 analytics cycles and 3 live swarm sessions before it was killed by hand. **And verified again 2026-08-22, against the assumption that `--smoke` makes this cheap: it does not.** A smoke boot does suppress the scripted-newcomer narrative (`smoke-mode.ts`'s `runsNewcomerOnboarding: false`) and the `swarm.*` schedules (`docker-compose.smoke.yml` pins `SWARM_SCHEDULES_ENABLED: "0"`), but the steady-state session loop still ran and authored verified memos throughout a ~20-minute observation window. Budget the window deliberately; do not assume smoke mode makes it free. |
| **G6** | **Cleanup is unconditional.** The compose stack, the smoke-twin container and the smoke-twin's volume are all removed on **every** exit path — success, assertion failure, readiness timeout, and an unhandled throw. The volume is explicit: a `--db smoke-twin` boot *keeps* it by contract (`smoke:clean` reclaims it), which is right for an operator looking at a smoke-twin and wrong for an unattended rehearsal, where it is production-derived data nobody asked to keep. | Leftovers from this script are not inert: a surviving container holds a full copy of production data (§6.3), and a surviving stack keeps spending under G5. |
| **G7** | **Isolation is absolute, and asserted rather than arranged.** No file is written — not the real repo-root `.env`, not a throwaway one; the smoke-twin's port is bound to a non-routable address; and `assertSmokeTwinIsTarget()` refuses the boot outright unless the compose environment's `DATABASE_URL` **is** the smoke-twin's. | The rehearsal's whole claim is that it cannot touch production. Compose auto-loads the repo-root `.env`, so "the stack config wins over that file" is a precedence *argument*; this is a check. A rehearsal that silently ran against production would be the worst outcome this repo has. See §6.3. |
| **G8** | **Postflight runs against the smoke-twin, inside the same run** — this release's postflight checks *and* its acceptance criteria, via `postflight.ts --emit-receipt=P5.postflight-smoke-twin`, after G4 and before teardown. A failure is exit `1`. **So is being unable to run it at all**: a rehearsal that cannot reach the smoke-twin to grade it must not report the boot's green as the gate's green. | §6.1 step 3 and §6.4 both require it, and the smoke-twin exists only between readiness and teardown. Until this was part of the contract there was no supported way to obey them: the rc.6 rehearsal satisfied step 3 by racing a watcher against teardown from a second terminal, which is not a procedure anyone should have to invent at 3am. The shared driver (`scripts/lib/smoke-twin-rehearsal.ts`) cannot know a release's checks, so it hands the window back through an `onReady` hook and the release's own `stage-rehearsal.ts` fills it. |

**Exit codes.**

| Code | Meaning |
|---|---|
| `0` | Migrations applied for real, the stack came up healthy, and the frontend checks passed against production-shaped data. |
| `1` | The rehearsal ran and the release failed it: the boot died, readiness was not reached within the deadline (G3), a frontend check failed, or postflight failed against the smoke-twin (G8). |
| `2` | Could not run at all — missing/undecryptable backup files, no `OPENCODE_API_KEY` (§6's box), Docker/git failure. Says nothing about the release. |

✅ **Conformant as of 2026-08-17, and executed end to end for the first
time.** The contract above was written against a script that could not
satisfy it: `stage-rehearsal.ts` `await`ed the boot instead of supervising it
(G2), so against a `CI`-unset boot it **hung forever** — never reaching its
`/health` check, its frontend checks, or its teardown, while the stack kept
cycling sessions on a funded key. Observed directly: 7+ minutes with no
progress past `booting:`, 5 analytics cycles, 3 live swarm sessions, killed
and torn down by hand. That is why §6's own text used to say the rehearsal
had never completed — it could not have.

The script now supervises the boot and polls `smoke-state.json` + `/health`
against G3's deadline, fails fast if the boot exits at all (with `CI` unset a
healthy boot never does), and tears down the stack, the leftover volumes,
the worktree and the container on every exit path. First clean run:

```
ready after 10s: project=… api=http://127.0.0.1:32771 (/health OK)
VERDICT: migrated and booted clean, frontend checks pass
EXIT=0
```

with zero containers, volumes, worktrees or processes surviving. All four
migrations applied to production-shaped data, and the release's postflight checks pass
against the resulting database (trigger `tgenabled = A`, zero null handles,
zero namespace violations, `swarm_recommendations` above its pre-upgrade
baseline).

> ⛔ **A clean `EXIT=0` here does NOT mean the release passed.** This contract
> is about the rehearsal *mechanism* — G1–G7 describe a run that terminates,
> verifies and cleans up. It says nothing about whether the release achieved
> its objective. On 2026-08-17 this script exited `0` with every check above
> green while **two members ended up with the wrong public handle** — the
> defect the acceptance criteria exist to catch. Always follow a green run with
> §6.1 step 3: the release's postflight checks *and* its acceptance criteria,
> against the same smoke-twin.

> **Reading a run.** "Still running" is only ever legitimate *before*
> readiness, and only up to G3's deadline — a cold first build genuinely
> takes minutes. After `ready after …s` the remaining steps are fast. A run
> that prints nothing past `booting:` for longer than a cold build should
> take is hung, not working; that is now a bug to report, not a state to
> wait out.

#### 6.3 Contract — the digital smoke-twin is production data, and must be treated that way

Both §5.3 and §6 restore the dump into a throwaway local Postgres. Nothing
about "throwaway" makes its **contents** low-value: the smoke-twin holds a complete
copy of production, including `admin_credential` hashes, `admin_session`
tokens, member access keys and every stored email address — the same inventory
§5.2 encrypts the dump for. The container is disposable; the data in it is not.

| # | Guarantee | Why |
|---|---|---|
| **T1** | **No production credential is used or needed.** The smoke-twin's superuser is created by the container from `POSTGRES_USER`, borrowed from nothing — not `.env`, not `.env.readonly`, not `doadmin`. | This is what lets migrations run *for real* with no production secret in play. It is also why `doadmin` is irrelevant to §5.3/§6: the migrations apply to the smoke-twin, and at real cutover (§8) they apply as the application's writer from `DATABASE_URL` — `doadmin` applies migrations at no point in this runbook. |
| **T2** | **The smoke-twin's superuser is a true superuser, and that is fine.** It holds more Postgres privilege than `doadmin` does (DO withholds real superuser — §4's `pg_read_all_data` box is that limit in action), yet near-zero risk: it reaches one disposable container and dies with it. | Privilege and blast radius are independent. Do not reason about this credential by its power; reason about the state it can reach. |
| **T3** | **The published port must bind a non-routable address** — `127.0.0.1`, or the Docker bridge gateway when sibling containers must reach it (§6). **Never `0.0.0.0`.** | Docker inserts its own iptables rules ahead of ufw/firewalld, so a `0.0.0.0` bind can be reachable from outside the host *even when the firewall looks closed* (verified 2026-08-17). Given T4, the bind address is the only thing standing between a production-data copy and the internet. |
| **T4** | **The smoke-twin's password must be generated per run, not a constant.** | A predictable password is acceptable *only* while T3 holds perfectly; making it unpredictable removes the dependence of one control on another and costs nothing. **Conformant as of 2026-08-17.** `restore-container.ts` previously hardcoded `LOCAL_PASSWORD = "throwaway-local-only"` while §5.3's prose claimed the superuser was "freshly generated" — it was not. It now is: generated per run, never logged, passed to callers on `RestoredContainer`. |

### 6.4 Digital-smoke-twin rehearsal

> **Manifest step `P5.postflight-smoke-twin`.** The machine-readable block for this step —
> its id, artifacts, TTL and `verify:` command — lives in the **per-release**
> runbook, because every one of those fields names that release's own scripts
> and backup directory. This document describes the mechanic; the release binds
> it. See `backend/scripts/upgrades/<FROM>-to-<TO>/steps.ts`.

⛔ **This is a blocking gate.** Do not proceed to §7 until the smoke-twin run exits
`0` and every acceptance criterion in §6.5 is met.

Restore the backup (§5.3's `restore-check.ts`, then §6's
`stage-rehearsal.ts`) into a local Postgres container and run the full runbook
against it in sequence:

1. **Preflight** — run `restore-check.ts` (Gate C) first, then the release's live
   checks against the restored smoke-twin. Any failure is blocking. Follow the fix
   loop: patch, cut the next rc, restore a fresh dump, rehearse again.
2. **Cutover** — run `stage-rehearsal.ts`, which boots the §8.2 stack
   (`--smoke`, `--no-tui`, `CI` unset; see G2 on the one flag that differs)
   against the migrated smoke-twin. Any failure is blocking.
3. **Postflight** — every check the release's postflight runs **and** every
   acceptance criterion the per-release runbook states
   against the smoke-twin, after readiness and before teardown. **`stage-rehearsal.ts`
   runs this for you** (G8) — it is not a command you issue afterwards, because
   the smoke-twin does not survive step 2. Any failure is blocking; do not carry a
   known-failing AC into a production cutover on the theory that production will
   behave differently.

The smoke-twin holds real production rows. An AC failure on the smoke-twin is an AC failure
in production; it is the same data. Treat a failing smoke-twin the same as a failing
production cutover: diagnose, patch, cut the next rc, re-rehearse from step 1.

```bash
cd <checkout>/backend
# Step 1 — preflight against the smoke-twin
bun scripts/upgrades/<FROM>-to-<TO>/restore-check.ts $RM_BACKUP_DIR

# Steps 2+3 — cutover AND postflight, in one run, against the same smoke-twin
bun scripts/upgrades/<FROM>-to-<TO>/stage-rehearsal.ts $RM_BACKUP_DIR --emit-receipt
```

### 6.5 Stage rehearsal report

> **Manifest step `P6.report`.** The machine-readable block for this step —
> its id, artifacts, TTL and `verify:` command — lives in the **per-release**
> runbook, because every one of those fields names that release's own scripts
> and backup directory. This document describes the mechanic; the release binds
> it. See `backend/scripts/upgrades/<FROM>-to-<TO>/steps.ts`.

⛔ **Gate: do not proceed to §7 until this report exists and all criteria pass.**

Produce a written report covering the smoke-twin rehearsal just completed. Save it to
a file alongside the backup artifacts (e.g.
`stage-rehearsal-report-<STAMP>.md`). The report must include:

**1. Twin setup**
- RC tag and SHA deployed to the smoke-twin
- Backup stamp used (`rm-preupgrade-<STAMP>.dump.gpg`)
- `restore-check.ts` exit code and any notable output

**2. Preflight results (on the smoke-twin)**
- Every gate the per-release runbook defines, in its stated execution order,
  with pass / fail / note for each. Gate letters are stable NAMES, not an
  order, and which letters exist is the release's business — v0.3.0 defines
  A through F. **Do not assume a gate is absent because this document does not
  mention it**; an earlier revision of this line denied the existence of a gate
  that §8.2 below required to be green and that the per-release manifest carried
  all along.
- Exit code of `restore-check.ts`

**3. Cutover results (on the smoke-twin)**
- `stage-rehearsal.ts` exit code
- Time to readiness (`ready after …s`)
- Frontend check verdict

**4. Postflight results (§8 on the smoke-twin)**
- A result for **every check the release's `postflight.ts` records** — the count
  is whatever `runChecks` runs, not a fixed number (v0.2.2 ran twelve; v0.3.0
  runs seven plus one manual). The per-release runbook's postflight table is the
  authority.
- Every acceptance criterion in the per-release runbook explicitly ticked or
  failed

**5. Acceptance criteria** (mark each PASS or FAIL with evidence)
- Every item in the release tracking issue's Objective is present and working
- No unexpected schema drift — **exactly the migrations this release ships, and
  no others.** Do not look for the list here: it lives in
  `THIS_RELEASE_MIGRATIONS` in `backend/scripts/upgrades/<FROM>-to-<TO>/release.ts`,
  and `preflight.ts`, `postflight.ts` and the per-release runbook's postflight
  table all read that one copy.

  > ⚠ **This bullet used to enumerate literal filenames** — the outgoing
  > release's — in the same breath as saying the list has one home. It was wrong
  > for every release after the one it was written for, and would have had an
  > operator grade the release in front of them against a release that had
  > already shipped. A release-independent document must not name a release's
  > facts; that is what the per-release runbook and `release.ts` are for.
- Row counts after migration match the per-release runbook's pre-upgrade baseline
- Every release-specific acceptance criterion in the per-release runbook's
  post-cutover section

**6. Issues found**
List any failures, unexpected output, or observations encountered during the
rehearsal. For each: description, disposition (fixed before proceed / carry to
§10 known-broken / blocking).

**7. Go/no-go**
State explicitly: **GO** or **NO-GO**, with reason.

**8. Operator sign-off**
> Rehearsal completed by: __________ Date: __________ Sign-off: __________

---

## 7. Config before cutover — and what you CANNOT configure

This section replaces the "set `AUTOMATION_TOKEN` and `SWARM_PUBLIC_BASE_URL`
before cutover" plan. **Both of those steps are impossible through the operator's
workflow.** Verified by tracing the spawn environment, not assumed — first at
`ccf983f`, re-verified 2026-08-17 against `origin/releases-0.2.x` (`d852329`),
where `scripts/stack/stack.ts`, `scripts/stack/config.ts`,
`scripts/lib/smoke-main.ts` and `docker-compose.yml` are all byte-identical to
`ccf983f`. The mechanism is structural, not a commit-local accident.

### 7.1 Why: how environment reaches the api container under `bun smoke`

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
  (`scripts/lib/smoke-main.ts:427-444`).
- A repo-root `.env` **is** auto-loaded by Compose for `${VAR}` interpolation
  (no `--env-file` or `--project-directory` is passed anywhere; the child's cwd
  is the repo root, `scripts/stack/stack.ts:216`) — but process env beats `.env`,
  so anything `buildComposeEnv` emits still wins.

### 7.2 ❌ `AUTOMATION_TOKEN` — cannot be set, and does not need to be

`buildComposeEnv` sets `AUTOMATION_TOKEN: cfg.credentials.automationToken`
(`scripts/stack/config.ts:220`), minted fresh **every boot** by
`generateStackCredentials()` (`:162-168`, called at
`scripts/lib/smoke-main.ts:381-383`). Putting it in `.env` or exporting it in your
shell changes nothing — the generated value overrides both.

So the established finding that `AUTOMATION_TOKEN` is *"absent from `.env.example`
and fail-closed, therefore must be set"* **does not hold for this workflow.** It
is absent from `.env.example` (confirmed — zero occurrences), and
`backend/src/api/auth.ts:70-76` does fall through to `allowInsecure` rather than
`false` when unset — but under `bun smoke` it is never unset, because the stack
mints it. **No action required. Do not try to set it.**

### 7.3 ❌ `SWARM_PUBLIC_BASE_URL` — cannot reach the container at all

It appears in **no compose file**: not in `docker-compose.yml`'s api
`environment:` block (`:171-223`), not in `docker-compose.smoke.yml`'s (`:34-72`),
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

**Effect, every release:** the api always computes the **compiled-in default**
for whatever tag you deploy, so every swarm application-receipt and activation
email links to that default — not to anything you put in `.env`.

**What the per-release runbook must do:** read the default out of the tag you
are about to deploy and confirm it is the host you intend, *before* cutover.
v0.2.2 is the cautionary case: at `ccf983f` the compiled-in default was still
`https://robotmoney.net`, the old domain, so receipts and activation emails
pointed at the retired host until `7b1abbf` corrected it. Nothing in `.env`
would have saved it.

```bash
# The default the tag you are deploying will actually use.
git show <rc-tag>:backend/src/config.ts | grep -n "robotmoney\." | head
```

### 7.4 ⚠ `ADMIN_TOKEN` is also minted per boot — read it from the container

Same mechanism: `buildComposeEnv` sets `ADMIN_TOKEN:
cfg.credentials.adminToken` (`scripts/stack/config.ts:219`), a fresh random
20-character value per launch (`:164`). It is **never logged, never written to
`.agents/smoke-state.json`, and never printed in the plain non-TUI READY block**
(`scripts/lib/smoke-main.ts:374-378`; the block itself is `:1407-1421`, whose
Admin line at `:1413` prints only `(password shown in the interactive TUI
only)`). The TUI renders it at `:964`, and only while the credential is
unclaimed.

> **There is no `--no-tui` trap.** An earlier revision of this runbook said
> `--no-tui` costs you the token and told you to give up the exit code for it.
> That was wrong, and it contradicted §8.2's own requirement. The value is an
> ordinary environment variable **inside the running api container** —
> `docker-compose.yml:192` delivers it as `ADMIN_TOKEN: ${ADMIN_TOKEN:-}` — so
> it is readable from a boot that has no TUI at all. **§7.4 is the command.**
> Keep `--no-tui`; you lose nothing.

### 7.5 ✅ What you actually set, and where

The only supported configuration surface for this workflow is the **repo-root
`.env` file** in the checkout you run `bun smoke` from. There is no deploy
pipeline and no droplet-env injection step here.

```bash
cd <checkout>
cat .env      # must contain, at minimum:
# DATABASE_URL=postgres://<app-user>:<pw>@<host>:25060/defaultdb?sslmode=require
```

`--db external` reads `DATABASE_URL` from **that file directly**
(`scripts/lib/smoke-external-pg.ts:288-305`), not from `process.env`. A missing or
unreadable `.env` is a fatal exit 1 before anything starts.

Optional, and genuinely honoured because they are in `DEMO_COMPOSE_PASSTHROUGH`.
**`scripts/lib/smoke-main.ts:427-444` is the authoritative list** — read it there,
not here, before concluding anything is unconfigurable. Reproduced verbatim at
`origin/releases-0.2.x` (`d852329`, 2026-08-17) — sixteen names, unchanged
since `ccf983f`. Re-derive on your tag rather than trusting this block:
`git show <the §1 tip>:scripts/lib/smoke-main.ts | sed -n '427,444p'`.

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
(ports, credentials, `DATABASE_URL`, `POSTGRES_*`, `SMOKE_PROJECT`) are
deliberately **not** on the list and cannot be shadowed (§7.1, §7.2, §7.4).
Passthrough reads your **shell** environment, and an empty string counts as
unset (`smokePassthroughEnv`, `:446-453`).

> ⚠ **`SWARM_SCHEDULES_ENABLED` is on the list and still loses.**
> `docker-compose.smoke.yml:72` pins it to `"0"` in the overlay regardless of what
> you pass, and `seedSwarmSchedules()` (`backend/src/db/seed.ts:137-152`)
> rewrites all five `swarm.*` rows' `cron`/`enabled`/`payload`/`timezone` on
> **every** boot — `seed()` is called unconditionally from
> `backend/src/db/migrate.ts:61`. So every `bun smoke` boot **disables all five
> swarm schedules in production**, clobbering any operator toggle, and §10's
> rollback boot does it again. **IRREVERSIBLE** through rollback — §5.4 captures
> the prior values, and it is the only record of them. Plan for the swarm to be
> manually driven after cutover.

---

## 8. Cutover mechanics

🔴 **IRREVERSIBLE.** The per-release runbook owns *what* the cutover applies —
its migrations, its config, its acceptance criteria. This section owns *how* the
stack is stopped and started, which has not changed across releases.

### 8.1 Stop the current stack, cleanly

```bash
cd <checkout>
bun run smoke:status          # prints project=<name>; confirm it is the live one
bun run smoke:down            # keeps the data; does NOT delete volumes
docker compose ls            # confirm no rm_smoke_stack_* project is still up
```

If `docker compose ls` shows leftovers from earlier boots, tear each down
explicitly, **naming the same compose files that boot used** — see the
note in deployment.md on why a bare `docker compose -p …`
command resolves a different topology than the one running:

```bash
docker compose -p <that project> \
  -f docker-compose.yml -f docker-compose.smoke.yml \
  down --remove-orphans
```

The stakes are lower here than during a post-restore rebuild — `down` removes by project label,
so it cannot start anything — but without the overlay Compose does not know the
smoke-only services and leaves them behind as orphans, which is exactly the
leftover you came here to clear. `--remove-orphans` covers the gap. See
deployment.md §2.1, "FIRST: find the project name".

### 8.2 The invocation

> **Manifest step `P7.cutover`.** The machine-readable block for this step —
> its id, artifacts, TTL and `verify:` command — lives in the **per-release**
> runbook, because every one of those fields names that release's own scripts
> and backup directory. This document describes the mechanic; the release binds
> it. See `backend/scripts/upgrades/<FROM>-to-<TO>/steps.ts`.

> 🔴 **IRREVERSIBLE.** This command is not a dry run and there is no "boot and
> look first" mode. It writes to production three times before you can inspect
> anything: this release's migrations, `seed()` rewriting the five `swarm.*`
> schedule rows (§5.4), and the **archive initializer** — `prod-bootstrap.ts`
> run as `docker compose run --rm … api bun run scripts/prod-bootstrap.ts
> --already-migrated` (`scripts/lib/smoke-main.ts:1136-1140`) — which adopts and
> writes archive rows into the live database (§9.1's check table). None of it has
> a down migration (§7 header). Do not run this before Gates B, D, E, C and A
> are all green.

> ⏱ **Downtime budget for the scheduler.** Every job in `job_schedules` that
> is enabled records the last moment it was supposed to fire in `next_run_at`.
> If the stack is down for longer than the schedule's cadence, `next_run_at`
> falls behind wall-clock time and the schedule becomes wedged — it will not
> self-fire when the stack comes back up. The risk window by cadence:
>
> | Schedule cadence | Wedge threshold |
> |---|---|
> | Per-minute (`* * * * *`) | > ~1 minute of downtime |
> | Hourly (`0 * * * *`) | > ~1 hour of downtime |
> | Daily | > ~1 day of downtime |
>
> In practice, a worker down for > ~16h40m will wedge every per-minute
> schedule for the next ~41 days without a manual `UPDATE job_schedules SET
> next_run_at = now() - <one cadence> WHERE ...` — note the subtraction: the
> scheduler anchors its cron iterator at `next_run_at - 1s` and stops at the
> first FUTURE slot, so setting it to a bare `now()` fires **nothing**, resumes
> at the next slot up to a full cadence away, and silently drops the missed
> backlog. Plan for a maintenance window shorter than
> the shortest enabled schedule's cadence, or run §9.2 immediately after boot
> to detect and repair any wedge.

```bash
cd <checkout>
SMOKE_PROJECT=rm_prod bun smoke -- --db external --no-tui
BOOT_STATUS=$?                # capture it HERE — §9.1's check 1 reads this
echo "boot exit=$BOOT_STATUS" # MUST be 0
```

⚠ **Capture the status on the same line-group as the boot.** `$?` holds only the
*previous* command's status, and §8 opens with two commands of its own
(`export RM_PROJECT=…`, `bun run smoke:status`) before its first check. By then
`$?` reports `smoke:status`, not the boot. `BOOT_STATUS` survives that; `$?` does
not.

**Each flag, justified:**

| Flag / var | Why it is here | What happens without it |
|---|---|---|
| `--db external` | **MANDATORY.** Starts no postgres container and points the stack at the managed server via `DATABASE_URL` from repo-root `.env` (`scripts/lib/smoke-external-pg.ts:288-305`). One enum flag names the data path — `ephemeral \| external \| smoke-twin` — and `external` is the only one that means "a server this boot did not create and cannot reclaim". The older `--external-pg` spelling still works and prints a deprecation notice; runbooks written before the enum use it throughout. | The stack boots its own empty postgres in a fresh volume. **Your production data is not touched and not served** — you get an empty site and think it worked. This is failure mode #2 in §2. Since the enum landed an unknown flag is also a hard error rather than a silent default, so a typo'd data path stops the boot instead of quietly picking `ephemeral`. |
| `SMOKE_PROJECT=rm_prod` | **MANDATORY.** Pins the compose project name (`scripts/lib/smoke-main.ts:261`). Without it the name is `rm_smoke_stack_<random>` per boot (`scripts/stack/naming.ts:138`). | Every restart leaves an orphaned project. `docker compose -p …` commands in deployment.md address the wrong stack. Note: `--db external` does **not** by itself stabilise the project name — only `SMOKE_PROJECT` does. |
| `--no-tui` | On a TTY a **failed boot renders a pane and never exits non-zero**; Ctrl-C then exits `0` (`scripts/lib/smoke-main.ts:1911-1918`, which returns without `process.exit`). `--no-tui` gives a real `exit 1` (`:1920-1928`). | You cannot tell success from failure by exit code. **Always pass it.** Needing the per-boot `ADMIN_TOKEN` — the expected unclaimed case (§2) — is *not* a reason to omit it: read the token out of the container instead (§7.4). |
| **`CI` must be UNSET** | ⛔ With any truthy `CI` the boot runs a bounded scenario and then **tears the whole stack down**. Under smoke the branch taken is `CI && smokeMode` (`scripts/lib/smoke-main.ts:1175`): it runs one live swarm session against production and then `scripts/smoke-e2e-assert.ts` (`:1206`). The swarm-session *driver* at `:1212` is the **other** branch, `CI && !smokeMode`, and never runs here. Either way control reaches `if (process.env.CI)` at `:1390`, which calls `cleanup()` — a full `compose down` (`:697`, `:711-715`) — then `cleanCiVolume()` (`:1393`) and `process.exit(0)` (`:1394`). `cleanCiVolume()` also runs on the failure path (`:1893`), issuing `docker volume rm <project>_pgdata` (`scripts/lib/smoke-volumes.ts:105`). | The volume removal is harmless under `--db external` (no volume exists), but the teardown is not. Success exits `0` (`:1394`) and failure exits `1` (`:1894`) — the exit code still works — yet **either way the stack is torn down**, so the site does not stay up and there is nothing left to inspect or verify in §8. Check with `echo "CI=[$CI]"` before you start. It must print `CI=[]`. |

```bash
echo "CI=[$CI]"     # MUST be empty
```

## 9. Verification mechanics

The per-release runbook owns *which* checks a release must pass. This section
owns two things that are true of every release: prove the checks discriminate
before you trust them, and confirm the scheduler actually survived the window.

### 9.1 Dry-run the checks before cutover — prove the checks discriminate

> **Manifest step `P4.postflight-dryrun`.** The machine-readable block for this step —
> its id, artifacts, TTL and `verify:` command — lives in the **per-release**
> runbook, because every one of those fields names that release's own scripts
> and backup directory. This document describes the mechanic; the release binds
> it. See `backend/scripts/upgrades/<FROM>-to-<TO>/steps.ts`.

**Do this once, read-only, against production while it is still on the
OUTGOING release, before the cutover runs — not a spot check, a self-test of
the checks themselves.** The point is exactly what
the admin-credential check's own history already proves the hard way (§2): a
check that
*looks* like it answers the right question can instead throw an error that
gets misread as a pass, or silently return an empty result that means
nothing yet. Run every SQL-shaped check from §8's table now, as `rm_readonly`
(§4's read-only role — this is safe, it cannot write), and confirm what you see
matches what is documented here — verified 2026-08-17 against production:

| # | Check | Result running TODAY, pre-upgrade | What it means |
|---|---|---|---|
| 2 | migrations recorded | `0 rows` | Correct negative signal — none of the **six** (steps.ts's `THIS_RELEASE_MIGRATIONS`) are applied yet. An earlier revision said "four", from when this release shipped four. |
| 4 | handle namespace violation | `ERROR: column a.handle does not exist` (`42703`) | **Expected.** `handle` does not exist until `0030` applies. This is not a bug in the query and not something to "fix" pre-upgrade — running it today MUST error this way. If it instead returns `0 rows` today, you are pointed at an already-migrated database (wrong tag, or production has already been cut over) — treat that the way §3.1 treats a `psql ""` false pass: stop and re-verify what you are connected to. |
| 5 | namespace trigger `ENABLE ALWAYS` | `0 rows` | Correct — the trigger does not exist until `0031`. A `pg_trigger` lookup by name degrades gracefully to empty, unlike a column reference. |
| 6 | members missing handle | `ERROR: column "handle" does not exist` (`42703`) | **Expected**, same reason as check 4. |
| 7 | unsaveable handles | `ERROR: column "handle" does not exist` (`42703`) | **Expected**, same reason as check 4. |
| 8 | `swarm_recommendations` baseline | `557` rows (2026-08-17, measured by `restore-check.ts` against that day's dump; it read `547` earlier the same day — the table grows continuously, so this is a point-in-time count, **not** a constant, and yours will differ) | This is the number check 8 compares against post-upgrade (`≥` this). Take it from **your own** Gate C run, which prints it: `restore-check.ts` logs `swarm_recommendations: <n>` off the dump you are actually shipping with. You cannot recover it from a rolled-back or already-upgraded database. |
| 9 | `admin_credential` untouched | `ERROR: column "recovery_hash" does not exist` (`42703`) | **Expected — and previously undocumented here.** This is the exact same landmine §2's admin-credential check already documents at length (*"Do not name `recovery_hash` in this query"*) — `0029_admin_auth_recovery.sql` has not applied yet, so the column does not exist. Check 9 as written names it directly and WILL throw pre-upgrade. Do not read this error as a release failure; it is the correct pre-upgrade state. Re-run check 9 verbatim only after §7.4's migrations have applied — post-upgrade it must return rows, not an error. |
| 12 | swarm schedules baseline | five rows, all `enabled = f` (2026-08-17) | This is exactly what §5.4 asks you to capture — do it here too, so you have it recorded in two places before the boot in §7 can clobber it. |

Checks 1, 3, 10, 11 are not dry-runnable this way: 1 depends on the boot's own
exit code, 3 and 11 hit the running api's HTTP surface (whose `/health` shape
and prerendered routes are §8's post-upgrade behavior, not something that
exists to check pre-upgrade), and 10 depends on the admin-credential check's
result, already established separately in §2.

**If any check above does not match its documented result** — in particular,
if check 4/6/7/9 do *not* error, or check 2 is not empty — stop. You are not
looking at the pre-upgrade database this runbook assumes, and every check
number in §8's table below needs re-deriving before you trust it after
cutover.

Discover the project first — you pinned it, so it is `rm_prod`. `DATABASE_URL`
must be loaded and asserted in **this** shell too, or every `psql` below grades
the wrong database (§3.1):

```bash
export RM_PROJECT=rm_prod
[ -n "${DATABASE_URL:-}" ] || { echo "re-do §3.1 in this shell"; exit 1; }
psql "$DATABASE_URL" -Atc "SELECT current_database(), inet_server_addr(), inet_server_port();"
bun run smoke:status
```

⚠ Every command in that block overwrites `$?`. Check 1 therefore reads
`$BOOT_STATUS` — the variable §8.2 captured on the boot's own command line —
and never `$?`.

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Boot exited clean | `echo "$BOOT_STATUS"` — the variable captured on §8.2's own command line. **Not `echo $?`**: by the time you reach §8 that reports `smoke:status`, not the boot, and it will read `0` after a failed cutover. | `0`. On a TTY without `--no-tui` this proves nothing (§8.2). If `BOOT_STATUS` is unset you did not capture it; you cannot recover it, so re-run §8.2 (it is idempotent — migrations resume, seed and adopt are idempotent) rather than assume. |
| 2 | Every migration this release ships is recorded | The release's own `postflight.ts` (`migrations-applied`), which reads `THIS_RELEASE_MIGRATIONS` from `release.ts`. **Do not hand-write a `LIKE '0029%' OR '003%'` query** — this row used to carry one, hardcoded to v0.2.2's six names, and against a v0.3.0 database it returns ten rows and grades nothing. | Every name in `THIS_RELEASE_MIGRATIONS`, under its FULL filename. The per-release runbook's postflight table states the count for that release. |
| 3 | Namespace guard ran and was clean | `curl -s "http://127.0.0.1:$(docker compose -p "$RM_PROJECT" port api 8787 \| cut -d: -f2)/health"` | `"handle_namespace":"clean"`. **`"unchecked"` means the guard could not run — this boot proves nothing.** `"overridden"` means you are serving a violation. |
| 4 | No violation in the data | `psql "$DATABASE_URL" -c "SELECT a.id, a.handle, b.id FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id;"` | 0 rows |
| 5 | Namespace trigger is `ENABLE ALWAYS` | `psql "$DATABASE_URL" -c "SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger';"` | `A`. `O` means a `DISABLE`/`ENABLE` cycle downgraded it and the replica-role bypass `0031` closes is open again. |
| 6 | Every member has a handle | `psql "$DATABASE_URL" -c "SELECT count(*) FROM swarm_members WHERE handle IS NULL;"` | `0` (`SET NOT NULL` guarantees it; this catches a partial apply) |
| 7 | Handles are saveable | `psql "$DATABASE_URL" -c "SELECT id, handle FROM swarm_members WHERE handle !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(handle) > 80;"` | 0 rows. Any row here is a member the admin surface can never re-save (§4, `handle-shape`). Fix with `UPDATE swarm_members SET handle = '<kebab-case>' WHERE id = '<id>';` — **move the handle, never the id.** |
| 8 | Archive data was adopted, not overwritten | `psql "$DATABASE_URL" -c "SELECT count(*) FROM swarm_recommendations;"` | ≥ the pre-upgrade count from §5.3. The archive initializer **adopts**: `classifyDatabase` returns `mode: "adopt"` for the archive initializer on populated data (`backend/scripts/db-preflight.ts:158`) — insert-if-missing, fill only `NULL` columns, else report drift. Existing rows win; the signed `payload`/`signature` columns are never rewritten. |
| 9 | `admin_credential` untouched by the boot | `psql "$DATABASE_URL" -c "SELECT count(*) AS rows, count(*) FILTER (WHERE recovery_hash IS NOT NULL) AS with_recovery FROM admin_credential;"` | `rows = 0` and `with_recovery = 0`, matching §2's pre-cutover check. **Use this form, not `GROUP BY`** — see the box below. (This is the first point in the runbook where `recovery_hash` is a legal thing to select: the column exists only after `0029` applied.) **No seed path ever writes this table.** |
| 10 | Admin surface reachable, and claimed | This is the expected path: the pre-cutover check found `rows = 0`, so **claim the admin credential now — prompt the operator to claim it.** This is a mandatory step, not a spot check: until it runs, the one-time claim is open to whoever reaches the surface first. (Unexpected path: if that pre-cutover check found `rows = 1` — it should not have — stop and investigate; this runbook does not carry a remedy for it.) | `/api/admin/is-claimed` returns `{"claimed":true}` and you hold both the password and a recovery code. |
| 11 | Site serves prerendered HTML | `curl -s http://127.0.0.1:<port>/swarm/ \| grep -o '<title>[^<]*'` | Not the home page's title. **"Assembly did not run" is not a possible cause here** — see the diagnosis below. |
| 12 | Swarm schedules state | `psql "$DATABASE_URL" -c "SELECT kind, enabled FROM job_schedules WHERE kind LIKE 'swarm.%' ORDER BY 1;"` | five rows, **all `enabled = f`** — expected under the smoke composition (§7.5). Compare against §5.4's capture: the difference is what this boot clobbered, and it is not coming back on its own. Drive sessions manually. |

### 9.2 Scheduler and producer liveness

> **This check addresses issue #644.** §9.1 confirms the schema and data are
> correct; this check confirms the scheduler fired and a producer wrote output
> after the new code booted. A green `/health`, a clean `/api/admin/overview`,
> and a continuous-looking `/performance` chart are **not** evidence these
> passed — they can all be green while every sampler is permanently frozen.

#### Check 13 — job_runs drained after boot

Wait at least 2 minutes after the boot exit, then:

```sql
-- Run against the read-only replica via rm_readonly
SELECT
  j.kind,
  j.next_run_at,
  j.last_enqueued_at,
  MAX(r.started_at) AS last_run_at,
  COUNT(r.*) AS run_count_last_10m
FROM job_schedules j
LEFT JOIN job_runs r
  ON r.kind = j.kind
  AND r.started_at > NOW() - INTERVAL '10 minutes'
WHERE j.enabled = true
GROUP BY j.kind, j.next_run_at, j.last_enqueued_at
ORDER BY j.kind;
```

**Expect:** every enabled `kind` shows `next_run_at` in the **future**. That,
not the 10-minute run count, is the liveness signal on this deployment.

> **Corrected 2026-08-20 — `run_count_last_10m` cannot be read as a pass/fail.**
> The first revision of this check expected *"every enabled `kind` row shows at
> least one `last_run_at` within the last 10 minutes."* Run against production,
> **all twelve** enabled schedules report `run_count_last_10m = 0`, including
> the ten that are perfectly healthy — because every schedule here is hourly or
> daily cron (`projects.discover` next fires 02:00 tomorrow), not per-minute.
> A 10-minute window is empty for almost all of them almost always, so the
> check as written fails a healthy system. Use `next_run_at` for the verdict
> and read `last_run_at`/`run_count_last_10m` as context.

A `next_run_at` in the past by more than the schedule's own cadence is the
wedge signal — the same condition preflight's `wedged-schedules` check reports.

**Wedge detection:** if `next_run_at` is more than 1 minute in the past for a
per-minute schedule, it is already wedged. Repair:

```sql
-- As a privileged user (not rm_readonly) — this is a write
UPDATE job_schedules
SET next_run_at = NOW()
WHERE enabled = true
  AND next_run_at < NOW() - INTERVAL '5 minutes';
```

Re-run the detection query after 2 minutes and confirm all rows now show
`run_count_last_10m > 0`.

#### Check 14 — wallet_balance_samples written today

```sql
-- Run against the read-only replica via rm_readonly
SELECT
  MAX(sample_date) AS latest_sample,
  COUNT(*) FILTER (WHERE sample_date = CURRENT_DATE) AS samples_today,
  COUNT(*) FILTER (WHERE sample_date = CURRENT_DATE - 1) AS samples_yesterday
FROM wallet_balance_samples;
```

**Expect:** `latest_sample` = today's date, `samples_today > 0`. A
`samples_today = 0` with a `latest_sample` of yesterday or earlier means the
wallet balance sampler has not run since the new code booted — the sampler is
wedged or the worker container is not running.

If this is a fresh database (e.g. the smoke-twin), `samples_today` may legitimately be
`0` if the sampler has not fired yet. Wait the full schedule cadence and re-check.

> ⚠ **Check 14 ALREADY FAILS on production, and not because of this release.**
> Measured 2026-08-20 against the replica, pre-cutover: `latest_sample` =
> **2026-08-10**, `samples_today = 0`, `samples_yesterday = 0`. Both wallet
> samplers stopped ten days ago — `wallet.sample_balances` and
> `wallet.sample_sleeves` last succeeded on 2026-08-10 (`job_runs`) and their
> `next_run_at` has been frozen at `2026-08-09 16:32+00` ever since, which is
> exactly what preflight's `wedged-schedules` WARN reports. Every other enabled
> schedule is healthy.
>
> So a post-cutover `samples_today = 0` here is the **pre-existing** wedge, not
> damage this upgrade did, and it must not be read as a postflight failure or a
> rollback trigger — the same treatment #660 already gives #649 and #648. Take
> the pre-cutover measurement above as the baseline, apply this section's repair
> `UPDATE` after the boot, and confirm the sampler recovers. If it does not, that
> is a separate production defect to file, not a reason to hold the release.

> **Note on §5.4's preflight wedge warning.** If preflight's `wedged-schedules` WARN
> flagged any rows, cross-check them here: if those same rows now show
> `run_count_last_10m > 0`, the warning can be marked resolved. If they still
> show no runs, the wedge persisted through the upgrade and needs the repair
> `UPDATE` above.

## 10. Rollback

> **Default rollback policy** (per `docs/technical/release-runbooks.md §4.8`):
> a postflight failure on production defaults to full rollback by restoring the
> pre-upgrade dump from §5.1. The operator makes the final call, but full
> rollback is the standard procedure. An operator may choose an alternate
> remediation only by recording the override reason, the alternate plan, and a
> second sign-off in the per-release runbook's production rollout report.

### Triggers — roll back if any of these are true

- Verification 3 reports `overridden`, or 4 returns rows you cannot repair now.
- Verification 2 shows fewer than **all** of this release's migrations
  (`THIS_RELEASE_MIGRATIONS` in `release.ts` — the count is the release's, not a
  constant; this line used to say "six", which was v0.2.2's) **and** the boot is
  failing.
- The admin surface is unreachable post-cutover because `admin_credential` is
  claimed and nobody holds the password — most likely the claim window
  was raced, or the password was lost immediately after claiming. Roll back
  to regain access (`v0.2.1` still honours `ADMIN_TOKEN` against a claimed
  credential — see "What rollback does NOT undo" below), then resolve the
  credential before re-attempting cutover.
- The api is restart-looping (`docker compose -p rm_prod ps` shows repeated
  restarts) for any reason you cannot diagnose in 15 minutes.

### Procedure

**Roll back to the last artifact that was actually deployed and running** — not
to "the target release minus the bug", which does not exist as a deployed thing.
On a first attempt at a release that is the *previous version tag*. If an earlier
`vA.B.C-rc.<N-1>` was deployed and healthy before this attempt, that rc is the
last known-good artifact and is what you check out instead.

**Rolling back never cuts or moves a tag.** The way forward is still the rc loop
in release-runbooks.md §3: patch, cut the next rc, preflight again.

> ⚠ **Two things the per-release runbook MUST establish before the cutover, and
> record here.** Neither is general — both were decisive during v0.2.2:
>
> 1. **Is the outgoing code safe against the incoming schema?** Rollback leaves
>    the new schema in place, so the old code runs against it. v0.2.2 could
>    answer yes only because `0030`'s `BEFORE INSERT` trigger defaults
>    `handle := id` and every `INSERT INTO swarm_members` site omitted `handle`,
>    so the new `NOT NULL` could not bite. **Do that analysis per release;
>    additive-only DDL usually makes it yes, but "usually" is not the standard.**
> 2. **Does rolling back change who can authenticate?** v0.2.2's rollback
>    *restored* `ADMIN_TOKEN` access to a claimed credential, because v0.2.1's
>    `isPrivileged()` fell back to the env token and v0.2.2's is a bare
>    `return false`. That made rollback itself the remedy for an admin lockout —
>    a property worth knowing before you need it, and one that does not carry
>    forward automatically.

```bash
cd <checkout>
bun run smoke:down
git checkout <last-deployed-healthy-tag>   # previous version tag, or vA.B.C-rc.<N-1>
git rev-parse HEAD                         # MUST print that target's SHA
echo "CI=[$CI]"                            # MUST be empty
SMOKE_PROJECT=rm_prod bun smoke -- --external-pg --no-tui
BOOT_STATUS=$?; echo "rollback boot exit=$BOOT_STATUS"   # capture it here (§8.2)
```

> ⚠ **`--external-pg` here, not `--db external` — deliberately.** You have just
> checked out an OLDER tag, and the `--db` enum does not exist in every tag you
> might roll back to. `--external-pg` is understood by both: by old code as the
> only spelling, and by new code as the deprecated alias for `--db external`. It
> is the one form that boots whatever you land on. Since the enum landed, an
> unrecognised flag is a hard error rather than a silent default — which is the
> right behaviour everywhere else and exactly the wrong thing to discover
> mid-rollback.

Then re-run the per-release runbook's post-cutover checks against the rolled-back
stack. A rollback that is not verified is not a rollback.

### ⚠ What rollback does NOT undo

These four are properties of the system, not of any one release. A per-release
runbook adds to this list; it never shortens it.

- **The schema stays where the migration left it.** The runner is forward-only
  (`backend/src/db/migrate.ts`) and there are no down migrations. Every table,
  column, index and trigger the cutover added is still there afterwards.
- **`seed()` rewrites schedule rows on EVERY boot, including the rollback boot
  — IRREVERSIBLE.** `backend/src/db/seed.ts` runs from
  `backend/src/db/migrate.ts` on the way up, so the old code's boot rewrites
  them again rather than restoring what was there before. The only route back to
  the prior `cron`/`enabled`/`timezone`/`payload` values is a manual `UPDATE`
  per row, written from the pre-cutover capture — which is why capturing those
  rows is part of the backup evidence set (§5) and not an optional nicety.
- **Anything an operator edited during triage stays edited**, and some of those
  edits repoint published URLs.
- **Data written while the new release was live stays.** Rolling the code back is
  not a point-in-time restore. If you need one, that is §5's dump or the
  provider's PITR, and it is a separate, **DESTRUCTIVE** decision.

---
