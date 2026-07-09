#!/usr/bin/env bash
# issue #87 AC: the ported bot-analytics pipelines must carry ZERO Supabase
# infrastructure — no supabase-js client, no service-role wiring. This static
# guard fails CI (non-zero exit) if backend/src references any Supabase infra
# marker, so a stray port of verbatim edge-function code can never sneak in.
set -euo pipefail

backend="$(cd "$(dirname "$0")/.." && pwd)"
target="$backend/src"
pattern='supabase-js|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY|@supabase/'

if matches=$(grep -rnE "$pattern" "$target"); then
  echo "check-no-supabase: FAILED — backend/src must not reference Supabase infrastructure:" >&2
  echo "$matches" >&2
  exit 1
fi

echo "check-no-supabase: OK (no Supabase references in backend/src)"
