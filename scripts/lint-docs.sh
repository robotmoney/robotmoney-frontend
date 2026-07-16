#!/usr/bin/env bash
# Doc-correctness check (issue #165): the one CI check every docs-only PR can
# still trigger, since every code-check workflow (e2e, integration) carries a
# `paths-ignore: ['**.md','**.txt']` bypass and therefore never runs on a diff
# that touches only Markdown. Per the CI taxonomy, the `doc-correctness` class
# is the sole exception that MUST run on docs-only PRs — this script is that
# check. It stays intentionally lightweight (no prose linter dependency):
#
#   1. every docs/*.md filename is kebab-case (repo convention, decided
#      2026-07-10 after SCREAMING_SNAKE/Caps-Dash drift).
#   2. no tracked *.md file contains an unresolved git conflict marker.
#   3. no tracked docs/*.md file is empty.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

fail=0
err() { echo "FAIL: $*" >&2; fail=1; }

# 1. kebab-case filenames under docs/
for f in docs/*.md; do
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
for f in docs/*.md; do
  [ -e "$f" ] || continue
  if [ ! -s "$f" ]; then
    err "$f is empty"
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "docs lint OK"
