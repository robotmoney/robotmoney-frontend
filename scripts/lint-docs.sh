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
#   5. no current doc names the retired `rm_migrator` role (issue #1026
#      criterion 3, D47). The only allowed hits are the D46/D47 history in
#      docs/decisions.md and the one "There is no rm_migrator" line in
#      smoke-production-spec.md §3. docs/archive/ is history and is not scanned.
#      scripts/tests/unit/docs-no-rm-migrator.test.ts holds the same rule and
#      its red controls.
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

# 5. `rm_migrator` appears only in D46/D47 history and smoke-production-spec §3.
#    The allowed ranges are found by anchor and heading, not by line number, so
#    an edit above them does not move the goalposts. A missing anchor or heading
#    allows nothing, which fails loudly instead of passing quietly.
decisions="docs/decisions.md"
smoke_spec="docs/technical/smoke-production-spec.md"
d46="$(grep -n '<a id="d46"></a>' "$decisions" 2>/dev/null | head -1 | cut -d: -f1)"
d48="$(grep -n '<a id="d48"></a>' "$decisions" 2>/dev/null | head -1 | cut -d: -f1)"
s3="$(grep -n '^## 3\. ' "$smoke_spec" 2>/dev/null | head -1 | cut -d: -f1)"
s4="$(grep -n '^## 4\. ' "$smoke_spec" 2>/dev/null | head -1 | cut -d: -f1)"
spec_hits=0
migrator_hits="$(git grep -n rm_migrator -- docs ':!docs/archive' 2>/dev/null || true)"
if [ -n "$migrator_hits" ]; then
  while IFS=: read -r f line _; do
    if [ "$f" = "$decisions" ] && [ -n "$d46" ] && [ -n "$d48" ] \
      && [ "$line" -gt "$d46" ] && [ "$line" -lt "$d48" ]; then
      continue
    fi
    if [ "$f" = "$smoke_spec" ] && [ -n "$s3" ] && [ -n "$s4" ] \
      && [ "$line" -gt "$s3" ] && [ "$line" -lt "$s4" ] && [ "$spec_hits" -eq 0 ]; then
      spec_hits=1
      continue
    fi
    err "$f:$line names rm_migrator; only D46/D47 history and smoke-production-spec §3 may (issue #1026)"
  done <<<"$migrator_hits"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "docs lint OK"
