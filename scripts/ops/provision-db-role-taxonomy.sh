#!/usr/bin/env bash
# Human-run production break-glass helper for issue #692.
# It never accepts, prints, writes, or logs a password.  Supply a password-free
# postgres URL; psql itself prompts on the terminal.  Role passwords are set by
# psql's \password prompt after the taxonomy migration has run.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 postgres://bootstrap-user@host:port/database?sslmode=require" >&2
  echo "Pass a password-free URL. psql will prompt; do not put a password in this command." >&2
  exit 64
fi
case "$1" in *://*:*@*) echo "refusing URL containing a password" >&2; exit 64;; esac

url="$1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
echo "This changes only the database named by the URL after psql confirms its password prompt."
echo "Run from a reviewed checkout; do not paste credentials into this script or shell history."
psql -X -W -v ON_ERROR_STOP=1 "$url" -f "$root/backend/migrations/0053_database_role_taxonomy.sql"
psql -X -W -v ON_ERROR_STOP=1 "$url" -c '\password rm_app'
psql -X -W -v ON_ERROR_STOP=1 "$url" -c '\password rm_worker'
psql -X -W -v ON_ERROR_STOP=1 "$url" -c '\password rm_readonly'
echo "Roles provisioned. Run the ordinary migration command once with MIGRATE_DATABASE_URL set only for that command, then install rm_app/rm_worker URLs on the host."
