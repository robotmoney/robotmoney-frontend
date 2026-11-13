#!/usr/bin/env bash
# Red control for the route and header table (issue 1624). For each mutation,
# copy website-server/ to a scratch directory, change one rule in its
# nginx.conf, and run website-server-routes.test.ts against an image built from
# the copy. The test must exit non-zero and name the row that caught it. Any
# mutation that leaves the test green, or fails it for another reason, makes
# this script exit non-zero.
#
#   bash scripts/tests/support/website-routes-red-control.sh
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
test_file="scripts/tests/integration/website-server-routes.test.ts"

# name | text in nginx.conf | replacement | row that must fail
mutations=(
  'cache-header|add_header Cache-Control "public, max-age=300" always;|add_header Cache-Control "public, max-age=301" always;|FAIL cache-asset-js'
  'fallback|try_files $uri $uri/index.html /_shell.html /index.html;|try_files $uri $uri/index.html /index.html;|FAIL fallback-client-route'
  'missing-asset-404|try_files $uri =404;|try_files $uri /_shell.html;|FAIL missing-asset-js'
)

status=0
for m in "${mutations[@]}"; do
  IFS='|' read -r name from to want <<<"$m"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/rm-routes-red-XXXXXX")"
  cp -r "$repo/website-server" "$scratch/"
  conf="$scratch/website-server/nginx.conf"
  FROM="$from" TO="$to" bun -e '
    const f = process.argv[1]; const s = await Bun.file(f).text();
    if (s.split(process.env.FROM).length !== 2) { console.error("mutation text must occur exactly once: " + process.env.FROM); process.exit(3); }
    await Bun.write(f, s.replace(process.env.FROM, process.env.TO));' "$conf"
  if cmp -s "$repo/website-server/nginx.conf" "$conf"; then
    echo "::error::red control $name changed nothing"; status=1; rm -rf "$scratch"; continue
  fi
  log="$scratch/test.log"
  set +e
  (cd "$repo" && ROUTES_SERVER_DIR="$scratch/website-server" bun test "$test_file") >"$log" 2>&1
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    echo "::error::red control $name: the table passed against a changed nginx.conf"; status=1
  elif ! grep -qF "$want" "$log"; then
    echo "::error::red control $name: exit $code, but no '$want' row in the output"; tail -40 "$log"; status=1
  else
    echo "red control $name: exit $code, $(grep -F "$want" "$log" | head -1)"
  fi
  rm -rf "$scratch"
done
exit "$status"
