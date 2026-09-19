#!/usr/bin/env bash
# Human-run production break-glass helper for issue #692.
# It never accepts, prints, writes, or logs a password.  It reads a password-free
# postgres URL from the given .env file (MIGRATE_DATABASE_URL, falling back to
# DATABASE_URL); psql itself prompts on the terminal.  Role passwords are set by
# psql's \password prompt after the taxonomy migration has run.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /path/to/provisioning.env" >&2
  echo "Pass a .env file whose MIGRATE_DATABASE_URL (or DATABASE_URL) is a password-free" >&2
  echo "postgres URL. psql will prompt; do not put a password in the .env file." >&2
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
case "$url" in *://*:*@*) echo "refusing URL containing a password ($source_var)" >&2; exit 64;; esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
echo "Using $source_var from $env_file."
echo "This changes only the database named by that URL after psql confirms its password prompt."
echo "Run from a reviewed checkout; do not paste credentials into this script or shell history."
psql -X -W -v ON_ERROR_STOP=1 "$url" -f "$root/backend/migrations/0053_database_role_taxonomy.sql"
psql -X -W -v ON_ERROR_STOP=1 "$url" -c '\password rm_app'
psql -X -W -v ON_ERROR_STOP=1 "$url" -c '\password rm_worker'
psql -X -W -v ON_ERROR_STOP=1 "$url" -c '\password rm_readonly'
echo "Roles provisioned. Run the ordinary migration command once with MIGRATE_DATABASE_URL set only for that command, then install rm_app/rm_worker URLs on the host."
