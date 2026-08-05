#!/usr/bin/env bash
# docs/decisions.md D23 / docs/architecture.md §3 L3, enforced.
#
# "Tests and evals may import runtime and shared code; RUNTIME MUST NEVER
# IMPORT TEST OR EVAL CODE; both may import shared." L3 says in so many words
# that this is held by a grep check in the same shape as
# backend/scripts/check-no-ai-overview.sh — the exit code IS the verdict —
# and not by convention alone. This is that check.
#
# Why it matters beyond tidiness: a runtime module that reaches into a test tree
# ships test doubles, fixtures, and `bun:test` imports into the demo/API/agent
# process. It also inverts the dependency arrow, so the cost-class split
# (scripts/tests/{unit,integration}/, contract/tests/{unit,live}/, evals/) stops
# being selectable — CI could no longer run one class without dragging in code
# the other class owns.
#
# Scanned roots are RUNTIME + SHARED trees only. scripts/tests/ is excluded
# because it IS the test tree; scripts/checks/ (this file's own home) is scanned
# like any other, since a CI check is runtime too.
#
# Optional argument: a target root to scan instead of the repo (used by
# scripts/tests/unit/runtime-import-guard.test.ts to prove, with a planted
# violation, that this guard actually bites).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
target_root="${1:-$root}"
status=0

# Runtime + shared trees. Every one must EXIST: a guard that scans zero paths is
# a green that means nothing, so a rename or a bad path here is RED, never a
# silently empty check.
roots=(
  "backend/src"
  "contract/src"
  "frontend/public/assets/js"
  "scripts"
)

# Anchored on the import KEYWORD on purpose. A bare `\.(test|spec)\.` scan
# false-positives on prose — e.g. scripts/demo-frontend-check.ts's comment
# naming spa.spec.ts — and a guard that cries wolf gets deleted.
pattern='(from|import|require)[[:space:]]*\(?[[:space:]]*["'"'"'][^"'"'"']*((tests?|__tests__|__mocks__|evals)/|\.(test|spec)\.)'

scan_paths=()
for rel in "${roots[@]}"; do
  if [ -d "$target_root/$rel" ]; then
    scan_paths+=("$target_root/$rel")
  elif [ $# -eq 0 ]; then
    # Only the REAL tree is required to have all of them; a fixture root passed
    # as $1 exists solely to hold one violating file.
    echo "check-no-test-imports-in-runtime: FAILED — expected $target_root/$rel to exist; a rename must be red, not a silently empty guard" >&2
    status=1
  fi
done

if [ ${#scan_paths[@]} -eq 0 ]; then
  echo "check-no-test-imports-in-runtime: FAILED — no runtime tree to scan under $target_root" >&2
  exit 1
fi

if matches=$(grep -rnE "$pattern" "${scan_paths[@]}" \
  --include='*.ts' --include='*.js' --include='*.mjs' --include='*.tsx' \
  --exclude-dir=tests --exclude-dir=__tests__ --exclude-dir=__mocks__ \
  --exclude-dir=node_modules); then
  echo "check-no-test-imports-in-runtime: FAILED — runtime code must never import test or eval code (D23, architecture.md §3 L3):" >&2
  echo "$matches" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "check-no-test-imports-in-runtime: OK (no runtime tree imports test or eval code)"
fi
exit "$status"
