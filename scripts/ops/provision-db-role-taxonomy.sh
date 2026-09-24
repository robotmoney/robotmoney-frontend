#!/usr/bin/env bash
# Human-run production break-glass helper for issue #692.
# The helper never prints, writes, or logs a password.  It takes a FILE on its
# command line, never a URL, and reads the connection out of it: either the
# discrete-token form every other consumer of $HOME/.env uses
# (scripts/lib/env-role.ts, issue #699) or a legacy MIGRATE_DATABASE_URL /
# DATABASE_URL line.
#
# Auth resolves ONCE, in this order: the bootstrap role's own `<role> = <pw>`
# line, then POSTGRES_PASSWORD, then a single interactive prompt -- and reaches
# psql through a 0600 PGPASSFILE rather than a URL on its argv.  A .env that
# embeds the password in the URL is the one legacy shape still passed through
# as-is; see the auth block below for why, and what it costs.
#
# THIS SCRIPT DOES NOT CREATE ACCOUNTS OR CHANGE PASSWORDS.
#
# It used to end with three unconditional `\password` prompts -- rm_app,
# rm_worker, rm_readonly -- so EVERY run silently rotated all three. Nothing
# propagated the new values; the script's own closing message asked the
# operator to hand-copy them into each host's $HOME/.env. That is the direct
# cause of the rm_readonly credential drift traced on 2026-09-21: a
# provisioning run at 01:55Z rotated the password, a host .env written 100
# minutes earlier kept the old one, and `smoke:capture` failed with
# "password authentication failed" on two staging hosts at once.
#
# The trap was that this script must be re-run for reasons that have NOTHING to
# do with passwords -- 0053 has to be applied out-of-band before any migration
# can `SET LOCAL ROLE rm_owner` -- so a routine, correct re-provision broke
# every host's backup.
#
# Provisioning roles is idempotent and safe to repeat. Rotating passwords is
# neither. They are no longer the same command: pass --set-passwords to be
# prompted, and only a first-time bootstrap should need it.
#
# Role CREATION is likewise non-destructive: 0053 guards every CREATE ROLE with
# IF NOT EXISTS, so an existing role keeps its password and its grants.  That
# was true of three roles and not the fourth until 2026-09-21: 0053 only
# RE-ATTRIBUTED rm_worker (0016's role) and never created it, so this script --
# the one path that applies 0053 with no migration having run first -- aborted
# on `role "rm_worker" does not exist` against any cluster that had not already
# been migrated.  0053 now guards all four.
set -euo pipefail

set_passwords=0
# The bootstrap login used to connect. It needs CREATEROLE (to create the
# taxonomy and drop rm_readonly_test) and, after 0053, rm_owner membership.
# On a DigitalOcean managed cluster that is `doadmin`.
admin_role="doadmin"
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --set-passwords) set_passwords=1 ;;
    --role) shift; [[ $# -gt 0 ]] || { echo "--role needs a value" >&2; exit 64; }; admin_role="$1" ;;
    --role=*) admin_role="${1#--role=}" ;;
    -*) echo "unknown option: $1" >&2; exit 64 ;;
    *) args+=("$1") ;;
  esac
  shift
done

if [[ ${#args[@]} -ne 1 ]]; then
  echo "usage: $0 [--set-passwords] [--role <login>] /path/to/provisioning.env" >&2
  echo >&2
  echo "The .env may be in EITHER supported shape:" >&2
  echo "  1. a MIGRATE_DATABASE_URL (or DATABASE_URL) postgres URL; or" >&2
  echo "  2. the discrete-token form (scripts/lib/env-role.ts, issue #699):" >&2
  echo "       host = ...   port = ...   database = ...   sslmode = ..." >&2
  echo "       <role> = <password>      e.g.  doadmin = ..." >&2
  echo "--role names the bootstrap login for form 2 (default: doadmin). It needs" >&2
  echo "CREATEROLE and, after 0053, rm_owner membership." >&2
  echo "Auth, resolved once and passed to psql via a 0600 PGPASSFILE (never on its argv):" >&2
  echo "  the '<role> = <password>' line, else POSTGRES_PASSWORD, else ONE prompt." >&2
  echo "  (A password embedded in a legacy URL is used as-is, and is visible in ps.)" >&2
  echo >&2
  echo "By default this command changes NO password and creates no account -- it is safe to re-run." >&2
  echo "--set-passwords additionally prompts for rm_app, rm_worker and rm_readonly. Every host's" >&2
  echo "\$HOME/.env must then be updated by hand, or its next backup fails to authenticate." >&2
  exit 64
fi

env_file="${args[0]}"
if [[ ! -f "$env_file" || ! -r "$env_file" ]]; then
  echo "cannot read .env file: $env_file" >&2
  exit 64
fi

url=""
source_var=""
for var in MIGRATE_DATABASE_URL DATABASE_URL; do
  if candidate="$(grep -m1 "^${var}=" "$env_file" | cut -d= -f2-)"; then
    if [[ -n "$candidate" ]]; then
      url="$candidate"
      source_var="$var"
      break
    fi
  fi
done
# FALLBACK: the discrete-token form. $HOME/.env on the production and staging
# hosts has carried discrete tokens plus one `role = password` line per role
# since issue #699 -- there is no DATABASE_URL in it at all, which is the whole
# point of that convention (see scripts/lib/env-role.ts: one file, one role per
# connection, no URL to mis-assemble). This script predated the change and
# accepted only a URL, so running it against the real /root/.env failed with
# "no MIGRATE_DATABASE_URL or DATABASE_URL" -- correct, and useless.
discrete_pw=""
if [[ -z "$url" ]]; then
  # The trailing \r strip is not defensive padding. scripts/lib/env-role.ts --
  # the TypeScript resolver for this SAME file -- trims each line, so a `.env`
  # pasted out of the DigitalOcean panel through a Windows clipboard (CRLF)
  # parses correctly for every OTHER consumer in the family and parsed
  # correctly here only up to the carriage return: `host = db.example.com\r`
  # built `postgres://doadmin@db.example.com<CR>:25060<CR>/defaultdb<CR>` and
  # psql failed on a hostname whose corruption is invisible in a terminal.
  # Same input, same file, two readers: they have to agree.
  ev() {
    sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$env_file" \
      | head -1 | tr -d '\r' | sed -E 's/[[:space:]]+$//' | tr -d '\042\047'
  }
  d_host="$(ev host)"; d_port="$(ev port)"; d_db="$(ev database)"; d_ssl="$(ev sslmode)"
  discrete_pw="$(ev "$admin_role")"
  if [[ -n "$d_host" && -n "$d_db" ]]; then
    url="postgres://${admin_role}@${d_host}:${d_port:-25060}/${d_db}?sslmode=${d_ssl:-require}"
    source_var="discrete tokens (role=$admin_role)"
  fi
fi

if [[ -z "$url" ]]; then
  echo "cannot build a connection from $env_file" >&2
  echo "Found neither a MIGRATE_DATABASE_URL/DATABASE_URL line nor the discrete tokens" >&2
  echo "'host' and 'database' (scripts/lib/env-role.ts, issue #699)." >&2
  echo "For the discrete form the file needs, at minimum:" >&2
  echo "    host = <cluster host>" >&2
  echo "    database = <database name>" >&2
  echo "    $admin_role = <password>        # or omit and let psql prompt" >&2
  echo "Pass --role <login> if the bootstrap login is not '$admin_role'." >&2
  exit 64
fi

# Auth resolution, and WHY THE PASSWORD TRAVELS IN THE ENVIRONMENT.
#
# This script used to inject the password into the URL's userinfo and hand the
# result to psql as a positional argument. Two things were wrong with that.
#
#  1. IT PUT THE CREDENTIAL IN argv, where `ps`, `/proc/<pid>/cmdline` and any
#     process accounting on the box can read it for the life of the run. The
#     header above, and deployment.md §4.3.1, both claimed this script "never
#     prints, writes, logs, or accepts credentials as command-line arguments".
#     The second half was true -- it takes a FILE, never a URL, on its own
#     command line -- and the first half was not: it built one and passed it
#     on psql's. A PGPASSFILE is a 0600 file read by libpq and removed on
#     exit -- narrower than PGPASSWORD, which sits in /proc/<pid>/environ.
#
#  2. IT PROMPTED THREE TIMES, or four with --set-passwords. Without a password
#     to inject, every psql invocation carried -W and prompted independently
#     for the SAME bootstrap credential: once for 0053, once for 0062, once for
#     the verification. An operator who typed it correctly twice and fumbled
#     the third got a script that had applied 0053, applied 0062, and then
#     aborted before verifying -- and the only way to tell that apart from a
#     clean run was to have watched the scrollback.
#
# So the password is resolved ONCE, here, into a variable that is never echoed,
# and every psql call goes through run_psql below. The one shape that still
# authenticates from the URL is a .env that embeds the password in the URL
# itself: percent-decoding that back out to re-encode it is a way to corrupt a
# working credential, and it is the legacy form the discrete convention
# replaced. It is passed through unchanged, with its argv caveat intact.
pgpassword=""
case "$url" in
  *://*:*@*)
    echo "authenticating with the password embedded in $source_var" >&2
    echo "NOTE: that URL is passed to psql as an argument and is briefly visible in ps." >&2
    echo "      The discrete-token form (scripts/lib/env-role.ts) avoids this." >&2
    ;;
  *://*@*)
    # A discrete-token file carries the password on the role's own line.
    if [[ -n "$discrete_pw" ]]; then
      pgpassword="$discrete_pw"
      echo "built the connection from the '$admin_role' line in $env_file" >&2
    elif pw="$(grep -m1 '^POSTGRES_PASSWORD=' "$env_file" | cut -d= -f2-)" && [[ -n "$pw" ]]; then
      pgpassword="$pw"
      echo "built the connection with POSTGRES_PASSWORD from $env_file" >&2
    else
      # No credential in the file at all. Ask once, rather than letting each
      # psql ask for itself. A non-interactive caller gets a diagnosis naming
      # the line to add instead of a psql prompt reading from a pipe.
      if [[ ! -t 0 ]]; then
        echo "no password for '$admin_role' in $env_file, and stdin is not a terminal." >&2
        echo "Add a '$admin_role = <password>' line to that file (see .env.example)," >&2
        echo "or run this command interactively." >&2
        exit 64
      fi
      read -rsp "Password for $admin_role (not echoed, not stored): " pgpassword
      echo >&2
      [[ -n "$pgpassword" ]] || { echo "empty password; refusing to continue." >&2; exit 64; }
    fi
    ;;
esac

# ONE CREDENTIAL, ONE PLACE, AND A 0600 FILE RATHER THAN argv OR THE ENVIRONMENT.
#
# Whatever tier above resolved it, the password now reaches psql through a
# PGPASSFILE written here and removed on every exit path. Not argv, which `ps`
# and /proc/<pid>/cmdline expose to any local user for the life of the call --
# that is what the old URL-injection did, while the header claimed the script
# "never ... accepts credentials as command-line arguments". And not
# PGPASSWORD, which is narrower but still sits in /proc/<pid>/environ.
#
# The one shape that still authenticates from the URL is a .env that embeds the
# password in the URL itself: percent-decoding it back out to re-encode it is a
# way to corrupt a working credential, and it is the legacy form the discrete
# convention replaced. It is passed through unchanged, with its argv caveat
# disclosed above rather than denied.
if [[ -n "$pgpassword" ]]; then
  _pgpass="$(mktemp)"
  chmod 600 "$_pgpass"
  trap 'rm -f "$_pgpass"' EXIT INT TERM
  # A pgpass field is colon-separated and backslash-escaped.
  _esc="${pgpassword//\\/\\\\}"
  _esc="${_esc//:/\\:}"
  printf '*:*:*:%s:%s\n' "$admin_role" "$_esc" > "$_pgpass"
  unset _esc
  pgpassword=""
  export PGPASSFILE="$_pgpass"
fi

# Every psql invocation goes through here, so the credential is established in
# exactly one place and cannot drift between the apply steps and the
# verification that is supposed to judge them.
run_psql() {
  psql -X -v ON_ERROR_STOP=1 "$url" "$@"
}

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Using $source_var from $env_file."
echo "This changes only the database that file names, and only once psql authenticates."
echo "Run from a reviewed checkout; do not paste credentials into this script or shell history."
run_psql -f "$root/backend/migrations/0053_database_role_taxonomy.sql"

# 0062 — the role/grant cleanup, applied HERE as well as at boot.
#
# It used to be two inline `-c` statements restoring rm_readonly's sequence
# SELECT. They are now a migration, for two reasons the inline form could not
# satisfy:
#
#  1. A CIRCULAR DEPENDENCY. P3.backup runs pg_dump as rm_readonly, which needs
#     the sequence grant, which needed this script — but the runbook only
#     reaches this script during a cutover, which requires P3.backup. An inline
#     fix repaired one database and left every other environment (a fresh DB, a
#     restored twin, a new staging host) to hit the same wall. As a migration it
#     also lands at boot, so the class is fixed once.
#  2. The DROP of rm_readonly_test needs CREATEROLE, which rm_owner does not
#     have. This script's bootstrap login (doadmin) does. So the file is applied
#     in BOTH paths on purpose: the drop happens here and is skipped with a
#     notice at boot. See 0062's own header.
#
# Applying it here does NOT write schema_migrations — psql never does, migrate.ts
# owns that ledger — so the boot still applies and records it. Expect to see
# 0062 in the migration log even though you ran it here. That is 0053's
# behaviour too (v0-5-0-rollout.md §4.1.3), and it is safe for the same reason:
# every statement in the file is idempotent.
run_psql -f "$root/backend/migrations/0062_rm_readonly_sequence_select.sql"
if [[ "$set_passwords" -eq 1 ]]; then
  echo
  echo "--set-passwords: rotating rm_app, rm_worker and rm_readonly."
  echo "EVERY host that holds these credentials will stop authenticating until its"
  echo "\$HOME/.env is updated by hand. That includes the staging host's backup role,"
  echo "whose only symptom is smoke:capture failing at the NEXT release's first gate."
  run_psql -c '\password rm_app'
  run_psql -c '\password rm_worker'
  run_psql -c '\password rm_readonly'
else
  echo
  echo "Passwords: UNCHANGED (no --set-passwords). Existing credentials keep working."
  echo "A brand-new cluster whose roles have never had a password needs one run with"
  echo "--set-passwords; an existing one almost never does."
fi

# ── VERIFY, because ON_ERROR_STOP is not enough ──────────────────────────────
#
# Every psql above runs with -v ON_ERROR_STOP=1 and the script runs under
# `set -e`, so a hard SQL error aborts. That does NOT mean the work happened.
# Both 0053 and 0062 do part of their work inside DO blocks that catch
# exceptions on purpose -- 0062's rm_readonly_test drop is skipped, with only a
# NOTICE, when the session lacks CREATEROLE or the role holds grants in another
# database. psql exits 0 either way.
#
# So this script used to end by PRINTING that the roles were provisioned and
# the test role cleaned up, having checked neither. The end state is the only
# thing that matters to the caller, and it is cheap to read, so it is read.
# Any failure exits non-zero and names what is wrong.
echo
echo "Verifying the resulting role configuration..."
run_psql <<'VERIFY'
DO $$
DECLARE
  problems text[] := '{}';
  r record;
  n int;
BEGIN
  -- 1. The four roles exist with 0053's attributes. rm_owner is LOGIN: it is
  --    the migration login (spec §3), and 0053 now creates and re-asserts it
  --    that way. It still holds no password until the operator types one
  --    (spec §9.1 step 1). CREATEROLE is checked in 1b.
  FOR r IN SELECT * FROM (VALUES
      ('rm_owner', true), ('rm_app', true), ('rm_worker', true), ('rm_readonly', true)
    ) AS want(rolname, should_login)
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r.rolname) THEN
      problems := problems || format('role %s is ABSENT', r.rolname);
    ELSE
      PERFORM 1 FROM pg_roles
       WHERE rolname = r.rolname AND rolcanlogin = r.should_login AND NOT rolsuper;
      IF NOT FOUND THEN
        problems := problems || format('role %s has wrong attributes (expected LOGIN=%s, NOSUPERUSER)',
                                       r.rolname, r.should_login);
      END IF;
    END IF;
  END LOOP;

  -- 1b. rm_owner never holds CREATEROLE (spec §3). Now that it can log in, a
  --     CREATEROLE on it would let the migration login mint new logins.
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'rm_owner' AND rolcreaterole) THEN
    problems := problems || 'rm_owner holds CREATEROLE — spec §3 forbids it';
  END IF;

  -- 2. A LOGIN role may assume rm_owner; neither runtime role may.
  SELECT count(*) INTO n FROM pg_auth_members am
    JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
   WHERE g.rolname = 'rm_owner' AND m.rolcanlogin;
  IF n = 0 THEN
    problems := problems || 'no LOGIN role is a member of rm_owner — migrations cannot SET ROLE rm_owner';
  END IF;

  -- 2b. …and it must be THIS login. 0053 ends with `GRANT rm_owner TO
  --     current_user`, so the login that runs this script is the one that ends
  --     up holding the membership -- which makes it the login
  --     MIGRATE_DATABASE_URL has to name at the migration step. Provision as
  --     one login and migrate as another and 0054 fails with permission
  --     denied, at deploy time, on a database this script has just called
  --     healthy. v0-5-0-rollout.md §4.1.2 warns about it in prose; checking it
  --     costs one catalog read.
  IF NOT pg_has_role(current_user, 'rm_owner', 'MEMBER') THEN
    problems := problems || format(
      '%s does not hold rm_owner membership — migrate as this login and 0054 fails', current_user);
  END IF;
  FOR r IN SELECT m.rolname FROM pg_auth_members am
      JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
     WHERE g.rolname = 'rm_owner' AND m.rolname IN ('rm_app', 'rm_worker')
  LOOP
    problems := problems || format('%s IS a member of rm_owner — a runtime role must not be able to run DDL', r.rolname);
  END LOOP;

  -- 3. Every reader can read everything. This is what the BACKUP depends on:
  --    pg_dump reads last_value from every sequence as rm_readonly.
  --
  -- MATERIALIZED is load-bearing, not style. Without it the planner may
  -- evaluate has_sequence_privilege() BEFORE the relkind filter and reach a
  -- TOAST relation, which aborts the whole check with
  --   ERROR: "pg_toast_28123" is not a sequence
  -- Observed against production on the first real run of this block. The CTE
  -- forces the filter to happen first.
  FOR r IN SELECT unnest(ARRAY['rm_readonly', 'rm_app', 'rm_worker']) AS role LOOP
    -- Schema USAGE FIRST, because has_table_privilege does not consider it.
    -- 0053 does `REVOKE ALL ON SCHEMA public FROM PUBLIC` and re-grants USAGE
    -- to exactly these three; lose that grant and every table ACL below still
    -- reports true while every actual query dies on "permission denied for
    -- schema public". That is not hypothetical -- it is the state 0062's own
    -- header records rm_readonly_test being left in.
    IF NOT has_schema_privilege(r.role, 'public', 'USAGE') THEN
      problems := problems || format('%s has no USAGE on schema public — every query fails regardless of table grants', r.role);
    END IF;

    -- The same fence backend/tests/migration-0062-grants-effective.test.ts
    -- carries, for the same reason. Reproduced off production too: on an empty
    -- schema the relation it reaches first is `pg_statistic` rather than a
    -- TOAST table, with the identical `is not a sequence` abort.
    WITH t AS MATERIALIZED (
      SELECT c.oid FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
    )
    SELECT count(*) INTO n FROM t WHERE NOT has_table_privilege(r.role, t.oid, 'SELECT');
    IF n > 0 THEN problems := problems || format('%s cannot SELECT %s table(s)', r.role, n); END IF;

    WITH sq AS MATERIALIZED (
      SELECT c.oid FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind = 'S'
    )
    SELECT count(*) INTO n FROM sq WHERE NOT has_sequence_privilege(r.role, sq.oid, 'SELECT');
    IF n > 0 THEN problems := problems || format('%s cannot SELECT %s sequence(s) — pg_dump will refuse', r.role, n); END IF;
  END LOOP;

  -- 4. The sampler tables rm_worker writes (0062 §4 — the production outage).
  --
  --    BY OID, NOT BY NAME. `has_table_privilege('rm_worker', 'public.foo', …)`
  --    makes the CALLER resolve `public.foo`, which needs USAGE on schema
  --    public -- and 0053 revokes that from PUBLIC and re-grants it to exactly
  --    the three runtime roles. The bootstrap login only gets it by INHERITING
  --    it from rm_owner, so this check silently depended on the provisioning
  --    login both holding that membership and having rolinherit set. Where it
  --    did not, the check did not report a problem: it raised `permission
  --    denied for schema public` and aborted the whole verification, taking
  --    every other finding with it -- including the one that would have named
  --    the missing membership as the cause.
  --
  --    The oid therefore comes from a pg_class JOIN and NOT from
  --    `to_regclass('public.' || …)`, which looks friendlier and fails the
  --    same way: regclass input conversion resolves a NAME, so it wants the
  --    same schema USAGE. A catalog join reads rows, and reading pg_class
  --    needs nothing.
  FOR r IN
    SELECT t AS name,
           (SELECT c.oid FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
             WHERE ns.nspname = 'public' AND c.relname = t AND c.relkind IN ('r','p')) AS oid
      FROM unnest(ARRAY['asset_prices', 'asset_price_floors', 'chain_address_floors']) AS t
  LOOP
    -- A NULL oid is a table this database does not have. 0062 §4 skips those
    -- deliberately (they are 0045/0046's, absent on an earlier baseline), so
    -- absence is not a problem to report -- only a present-but-unwritable one.
    CONTINUE WHEN r.oid IS NULL;
    IF NOT (has_table_privilege('rm_worker', r.oid, 'INSERT')
        AND has_table_privilege('rm_worker', r.oid, 'UPDATE')) THEN
      problems := problems || format('rm_worker lacks INSERT/UPDATE on %s — the wallet samplers will fail', r.name);
    END IF;
  END LOOP;

  -- 5. The test fixture must be gone (0062 §3). Its drop is exception-guarded,
  --    so this is the ONLY thing that distinguishes "ran" from "worked".
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'rm_readonly_test') THEN
    problems := problems || 'rm_readonly_test still exists — a LOGIN role whose password is committed to the repository';
  END IF;

  -- 6. The defaults, so a table added by a LATER migration is readable without
  --    that migration naming each role.
  --    Both object types, because the SEQUENCE default is the half 0053
  --    revoked and never restored, and the half whose absence broke the
  --    backup rather than the app. Checking only 'r' would have reported this
  --    configuration healthy on the morning pg_dump refused to run.
  FOR r IN SELECT unnest(ARRAY['rm_readonly', 'rm_app', 'rm_worker']) AS role LOOP
    IF NOT EXISTS (
      SELECT FROM pg_default_acl
       WHERE pg_get_userbyid(defaclrole) = 'rm_owner'
         AND defaclnamespace = 'public'::regnamespace
         AND defaclobjtype = 'r' AND array_to_string(defaclacl, ',') LIKE '%' || r.role || '=r%')
    THEN
      problems := problems || format('no default SELECT on TABLES for %s — the next new table will be unreadable', r.role);
    END IF;
    IF NOT EXISTS (
      SELECT FROM pg_default_acl
       WHERE pg_get_userbyid(defaclrole) = 'rm_owner'
         AND defaclnamespace = 'public'::regnamespace
         AND defaclobjtype = 'S' AND array_to_string(defaclacl, ',') LIKE '%' || r.role || '=r%')
    THEN
      problems := problems || format('no default SELECT on SEQUENCES for %s — the next new sequence breaks pg_dump', r.role);
    END IF;
  END LOOP;

  -- 7. Can the runtime roles actually LOG IN? Every check above is about
  --    privilege, and a role with no password holds all of them while
  --    authenticating for nobody. That is the exact end state of a fresh
  --    cluster provisioned WITHOUT --set-passwords -- which is the documented
  --    default, correct for the re-run case this script mostly serves and
  --    wrong exactly once, at first bootstrap. The old script printed
  --    "provisioned" there and the operator found out from the api's boot.
  --
  --    rolpassword lives in pg_authid, which a non-superuser bootstrap login
  --    (doadmin is rolsuper=false) cannot read. So this REPORTS rather than
  --    asserts when the catalog is closed: an unverifiable check must say it
  --    is unverifiable, not pass quietly.
  BEGIN
    SELECT count(*) INTO n FROM pg_authid
     WHERE rolname IN ('rm_app', 'rm_worker', 'rm_readonly') AND rolpassword IS NULL;
    IF n > 0 THEN
      problems := problems || format(
        '%s runtime role(s) have NO password and cannot authenticate — re-run with --set-passwords', n);
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'passwords NOT VERIFIED: % may not read pg_authid. If this is a first bootstrap, confirm the api and worker can connect.', current_user;
  END;

  IF array_length(problems, 1) IS NULL THEN
    RAISE NOTICE 'role configuration OK: 4 roles, membership correct, all readers can read, samplers writable, no test role';
  ELSE
    RAISE EXCEPTION E'role configuration is WRONG:\n  - %', array_to_string(problems, E'\n  - ');
  END IF;
END
$$;
VERIFY

echo
echo "Roles provisioned and VERIFIED."
# rm_owner is LOGIN now, but this script never gives it a password: spec §3
# keeps that password out of every file, so it is set by hand, once.
echo "Next (spec §9.1 step 1): rm_owner is LOGIN but has no password from this script."
echo "  Through doadmin, run: ALTER ROLE rm_owner LOGIN PASSWORD '<password>';"
echo "  then verify one login as rm_owner. Store the password nowhere on this host."
echo "Then remove any doadmin line from \$HOME/.env and run \`bun run migrate\` from the repo root."
echo "  It prompts for the rm_owner password and refuses a \$HOME/.env that holds a doadmin or rm_owner line."
if [[ "$set_passwords" -eq 1 ]]; then
  echo "You rotated passwords: update each host's \$HOME/.env with a '<role> = <password>' line"
  echo "(see .env.example) or that host's next backup will fail to authenticate."
fi
