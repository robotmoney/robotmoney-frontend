#!/usr/bin/env bash
# Human-run production break-glass helper for issue #692.
# The helper never prints, writes, or logs a password.  It reads a postgres URL
# from the given .env file (MIGRATE_DATABASE_URL, falling back to DATABASE_URL).
# Auth resolves in three tiers: a password embedded in the URL authenticates
# directly; a URL without one is completed from the .env's own POSTGRES_PASSWORD
# key when present; otherwise psql's --password flag prompts interactively.
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
# IF NOT EXISTS, so an existing role keeps its password and its grants.
set -euo pipefail

set_passwords=0
args=()
for arg in "$@"; do
  case "$arg" in
    --set-passwords) set_passwords=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 64 ;;
    *) args+=("$arg") ;;
  esac
done

if [[ ${#args[@]} -ne 1 ]]; then
  echo "usage: $0 [--set-passwords] /path/to/provisioning.env" >&2
  echo "Pass a .env file holding a MIGRATE_DATABASE_URL (or DATABASE_URL) postgres URL." >&2
  echo "Auth: URL-embedded password, else POSTGRES_PASSWORD from the .env, else psql prompts interactively." >&2
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
if [[ -z "$url" ]]; then
  echo "no MIGRATE_DATABASE_URL or DATABASE_URL in $env_file" >&2
  exit 64
fi

# Inject :password into the URL's userinfo, percent-encoding anything outside
# the unreserved set so the value cannot corrupt the URL. Never printed.
url_with_password() {
  local base="$1" pw="$2" scheme rest userinfo hostpart out="" s c enc
  scheme="${base%%://*}"
  rest="${base#*://}"
  userinfo="${rest%%@*}"
  hostpart="${rest#*@}"
  s="$pw"
  while [[ -n "$s" ]]; do
    c="${s:0:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out+="$c" ;;
      *) printf -v enc '%%%02X' "'$c"; out+="$enc" ;;
    esac
    s="${s:1}"
  done
  printf '%s://%s:%s@%s' "$scheme" "$userinfo" "$out" "$hostpart"
}

# Auth resolution: a password embedded in the URL authenticates directly; a
# URL without one is completed from the .env's own POSTGRES_PASSWORD key when
# present; otherwise psql --password prompts interactively for the credential.
password_flag=(-W)
case "$url" in
  *://*:*@*)
    password_flag=()
    echo "authenticating with the password embedded in $source_var" >&2
    ;;
  *://*@*)
    if pw="$(grep -m1 '^POSTGRES_PASSWORD=' "$env_file" | cut -d= -f2-)"; then
      if [[ -n "$pw" ]]; then
        url="$(url_with_password "$url" "$pw")"
        password_flag=()
        echo "built the connection with POSTGRES_PASSWORD from $env_file" >&2
      fi
    fi
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
echo "Using $source_var from $env_file."
echo "This changes only the database named by that URL after psql confirms its password prompt."
echo "Run from a reviewed checkout; do not paste credentials into this script or shell history."
psql -X "${password_flag[@]}" -v ON_ERROR_STOP=1 "$url" -f "$root/backend/migrations/0053_database_role_taxonomy.sql"

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
psql -X "${password_flag[@]}" -v ON_ERROR_STOP=1 "$url" -f "$root/backend/migrations/0062_rm_readonly_sequence_select.sql"
if [[ "$set_passwords" -eq 1 ]]; then
  echo
  echo "--set-passwords: rotating rm_app, rm_worker and rm_readonly."
  echo "EVERY host that holds these credentials will stop authenticating until its"
  echo "\$HOME/.env is updated by hand. That includes the staging host's backup role,"
  echo "whose only symptom is smoke:capture failing at the NEXT release's first gate."
  psql -X "${password_flag[@]}" -v ON_ERROR_STOP=1 "$url" -c '\password rm_app'
  psql -X "${password_flag[@]}" -v ON_ERROR_STOP=1 "$url" -c '\password rm_worker'
  psql -X "${password_flag[@]}" -v ON_ERROR_STOP=1 "$url" -c '\password rm_readonly'
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
psql -X "${password_flag[@]}" -v ON_ERROR_STOP=1 "$url" <<'VERIFY'
DO $$
DECLARE
  problems text[] := '{}';
  r record;
  n int;
BEGIN
  -- 1. The four roles exist with 0053's attributes.
  FOR r IN SELECT * FROM (VALUES
      ('rm_owner', false), ('rm_app', true), ('rm_worker', true), ('rm_readonly', true)
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

  -- 2. A LOGIN role may assume rm_owner; neither runtime role may.
  SELECT count(*) INTO n FROM pg_auth_members am
    JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
   WHERE g.rolname = 'rm_owner' AND m.rolcanlogin;
  IF n = 0 THEN
    problems := problems || 'no LOGIN role is a member of rm_owner — migrations cannot SET ROLE rm_owner';
  END IF;
  FOR r IN SELECT m.rolname FROM pg_auth_members am
      JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
     WHERE g.rolname = 'rm_owner' AND m.rolname IN ('rm_app', 'rm_worker')
  LOOP
    problems := problems || format('%s IS a member of rm_owner — a runtime role must not be able to run DDL', r.rolname);
  END LOOP;

  -- 3. Every reader can read everything. This is what the BACKUP depends on:
  --    pg_dump reads last_value from every sequence as rm_readonly.
  FOR r IN SELECT unnest(ARRAY['rm_readonly', 'rm_app', 'rm_worker']) AS role LOOP
    SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND NOT has_table_privilege(r.role, c.oid, 'SELECT');
    IF n > 0 THEN problems := problems || format('%s cannot SELECT %s table(s)', r.role, n); END IF;

    SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind = 'S'
       AND NOT has_sequence_privilege(r.role, c.oid, 'SELECT');
    IF n > 0 THEN problems := problems || format('%s cannot SELECT %s sequence(s) — pg_dump will refuse', r.role, n); END IF;
  END LOOP;

  -- 4. The sampler tables rm_worker writes (0062 §4 — the production outage).
  FOR r IN SELECT unnest(ARRAY['asset_prices', 'asset_price_floors', 'chain_address_floors']) AS t LOOP
    IF EXISTS (SELECT FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                WHERE ns.nspname = 'public' AND c.relname = r.t AND c.relkind IN ('r','p'))
       AND NOT (has_table_privilege('rm_worker', format('public.%I', r.t), 'INSERT')
            AND has_table_privilege('rm_worker', format('public.%I', r.t), 'UPDATE'))
    THEN
      problems := problems || format('rm_worker lacks INSERT/UPDATE on %s — the wallet samplers will fail', r.t);
    END IF;
  END LOOP;

  -- 5. The test fixture must be gone (0062 §3). Its drop is exception-guarded,
  --    so this is the ONLY thing that distinguishes "ran" from "worked".
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'rm_readonly_test') THEN
    problems := problems || 'rm_readonly_test still exists — a LOGIN role whose password is committed to the repository';
  END IF;

  -- 6. The defaults, so a table added by a LATER migration is readable without
  --    that migration naming each role.
  FOR r IN SELECT unnest(ARRAY['rm_readonly', 'rm_app', 'rm_worker']) AS role LOOP
    IF NOT EXISTS (
      SELECT FROM pg_default_acl
       WHERE pg_get_userbyid(defaclrole) = 'rm_owner'
         AND defaclnamespace = 'public'::regnamespace
         AND defaclobjtype = 'r' AND array_to_string(defaclacl, ',') LIKE '%' || r.role || '=r%')
    THEN
      problems := problems || format('no default SELECT on TABLES for %s — the next new table will be unreadable', r.role);
    END IF;
  END LOOP;

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
echo "Next: run the ordinary migration command once with MIGRATE_DATABASE_URL set for that command only."
if [[ "$set_passwords" -eq 1 ]]; then
  echo "You rotated passwords: update each host's \$HOME/.env with a '<role> = <password>' line"
  echo "(see .env.example) or that host's next backup will fail to authenticate."
fi
