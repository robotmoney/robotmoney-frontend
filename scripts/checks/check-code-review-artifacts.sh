#!/usr/bin/env bash
# Enforces that committed code-review artifacts pin a reachable commit.
# docs/code-review artifacts for merged history pin the merged SHA ('commit').
# docs/code-review artifacts for in-flight work record a rebase-stable identity ('pull_request').

set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
target_root="${1:-$root}"
status=0

shopt -s nullglob
for file in "$target_root"/docs/code-review/*.json; do
  [ -e "$file" ] || continue
  
  commit=$(jq -r '.commit // empty' "$file")
  pull_request=$(jq -r '.pull_request // empty' "$file")
  
  if [ -n "$commit" ]; then
    if ! git -C "$root" merge-base --is-ancestor "$commit" HEAD 2>/dev/null; then
      echo "check-code-review-artifacts: FAILED — $file pins commit $commit, which is not an ancestor of HEAD." >&2
      status=1
    fi
  elif [ -n "$pull_request" ]; then
    # In-flight review artifact uses pull_request, which is rebase-stable
    :
  else
    echo "check-code-review-artifacts: FAILED — $file missing both 'commit' and 'pull_request'." >&2
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "check-code-review-artifacts: OK"
fi
exit "$status"
