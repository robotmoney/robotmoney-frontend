#!/usr/bin/env bash
# Human-run production break-glass helper for issue #692.
# The helper never prints, writes, or logs a password.  It reads a postgres URL
# from the given .env file (MIGRATE_DATABASE_URL, falling back to DATABASE_URL).
# Auth resolves in three tiers: a password embedded in the URL authenticates
# directly; a URL without one is completed from the .env's own POSTGRES_PASSWORD
# key when present; otherwise psql's --password flag prompts interactively.
# Role passwords are set by psql's \password prompt after the taxonomy
# migration has run.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /path/to/provisioning.env" >&2
  echo "Pass a .env file holding a MIGRATE_DATABASE_URL (or DATABASE_URL) postgres URL." >&2
  echo "Auth: URL-embedded password, else POSTGRES_PASSWORD from the .env, else psql prompts interactively." >&2
  exit 64
fi

env_file="$1"
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
# 0053 grants rm_readonly SELECT on TABLES only; pg_dump (smoke:capture §4.2)
# must also read sequence state, and 0053 revoked ALL on sequences from
# rm_readonly. Restore read-only sequence access here — this is the manual
# offline command's job, deliberately NOT a migration (the operator runs it
# against the primary; the grants replicate to the replica).
psql -X "${password_flag[@]}" -v ON_ERROR_STOP=1 "$url" \
  -c "GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_readonly" \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO rm_readonly"
psql -X "${password_flag[@]}" -v ON_ERROR_STOP=1 "$url" -c '\password rm_app'
psql -X "${password_flag[@]}" -v ON_ERROR_STOP=1 "$url" -c '\password rm_worker'
psql -X "${password_flag[@]}" -v ON_ERROR_STOP=1 "$url" -c '\password rm_readonly'
echo "Roles provisioned, including rm_readonly's sequence SELECT (pg_dump needs it for smoke:capture). Run the ordinary migration command once with MIGRATE_DATABASE_URL set only for that command, then write each role's password into the host's $HOME/.env as a '<role> = <password>' line (see .env.example: discrete tokens + one role line per role)."
