#!/usr/bin/env bash
# Doc-correctness check (issue #165): the one CI check every docs-only PR can
# still trigger, since every code-check workflow (e2e, integration) carries a
# `paths-ignore: ['**.md','**.txt']` bypass and therefore never runs on a diff
# that touches only Markdown. Per the CI taxonomy, the `doc-correctness` class
# is the sole exception that MUST run on docs-only PRs — this script is that
# check. It stays intentionally lightweight (no prose linter dependency):
#
#   1. every docs/**/*.md filename (docs/, docs/runbooks/, docs/archive/ —
#      excluding docs/code-review/ point-in-time artifacts) is kebab-case
#      (repo convention, decided 2026-07-10 after SCREAMING_SNAKE/Caps-Dash
#      drift).
#   2. no tracked *.md file contains an unresolved git conflict marker.
#   3. no tracked docs/*.md file is empty.
#   4. the IC swarm docs (issue #187) never regress to the legacy
#      /api/ic/submit design: no reference to /api/ic/submit or the
#      x-ic-key header, per that issue's own acceptance criterion.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

fail=0
err() { echo "FAIL: $*" >&2; fail=1; }

# 1. kebab-case filenames under docs/ (including docs/runbooks/ and
#    docs/archive/; docs/code-review/ is excluded — its files are dated
#    point-in-time review artifacts)
for f in docs/*.md docs/runbooks/*.md docs/archive/*.md; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  if ! [[ "$base" =~ ^[a-z0-9]+(-[a-z0-9]+)*\.md$ ]]; then
    err "$f is not kebab-case (expected lowercase-with-hyphens.md)"
  fi
done

# 2. no unresolved conflict markers in any tracked markdown file
conflict_files="$(git grep -lE '^(<<<<<<<|=======|>>>>>>>)( |$)' -- '*.md' 2>/dev/null || true)"
if [ -n "$conflict_files" ]; then
  while IFS= read -r f; do
    err "$f contains an unresolved git conflict marker"
  done <<<"$conflict_files"
fi

# 3. no empty docs/*.md files
for f in docs/*.md docs/runbooks/*.md docs/archive/*.md; do
  [ -e "$f" ] || continue
  if [ ! -s "$f" ]; then
    err "$f is empty"
  fi
done

# 4. IC swarm docs (issue #187) must never reference the legacy
#    /api/ic/submit endpoint or its x-ic-key header.
ic_docs=(
  "frontend/public/views/docs/investment-swarm/participation.html"
  "frontend/public/views/docs/investment-swarm/api-reference.html"
)
for f in "${ic_docs[@]}"; do
  [ -e "$f" ] || continue
  if grep -qE '/api/ic/submit|x-ic-key' "$f"; then
    err "$f still references the legacy /api/ic/submit endpoint or x-ic-key header (issue #187 AC1)"
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "docs lint OK"
