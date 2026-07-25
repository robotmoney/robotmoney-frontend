#!/usr/bin/env bash
# docs/decisions.md D22 rules 1-2 / docs/architecture.md §11.3 E1-E2, enforced.
# Same shape as backend/scripts/check-no-supabase.sh: the exit code IS the
# verdict. Runs per-PR in .github/workflows/integration.yml — milliseconds, no
# Docker, no network — and is EXECUTED (not just present) by
# scripts/tests/unit/evals-guard.test.ts, which also proves it fails on a fixture
# that violates each rule.
#
# Four properties, on the eval path only:
#   1. No provider key / paid-model / sweep knob token, anywhere.
#   2. No environment read under evals/ — the model is an in-code constant, and
#      an eval must have NO configuration surface at all.
#   3. No conditional skip under evals/ — loud-skip-never.
#   4. No mock or injection seam under evals/ — an eval always makes a real
#      model call.
#
# Deliberately NOT covered: scripts/tests/** (inference-off RAILS checks, which
# legitimately mock and inject precisely because they do not claim to be evals)
# and scripts/lib/committee/** (the take-authoring surface, which resolves its
# own model). Widening this to them would be scope creep, not enforcement.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
target_root="${1:-$root}"
status=0

fail() {
  echo "check-eval-keyless: FAILED — $1" >&2
  echo "$2" >&2
  status=1
}

scan() { # <pattern> <message> <path>...
  local pattern="$1" message="$2"
  shift 2
  local paths=()
  for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
  [ ${#paths[@]} -eq 0 ] && return 0
  local matches
  if matches=$(grep -rnE "$pattern" "${paths[@]}"); then
    fail "$message" "$matches"
  fi
  return 0
}

evals_dir="$target_root/evals"
agent_dir="$target_root/scripts/agent"

# A guard over zero paths is a green that means nothing: a scanned tree with no
# evals/ at all is RED, so a rename or a bad path can never silently empty this
# check. (scripts/agent/ is required only of the REAL tree — a fixture root
# passed as $1 exists solely to hold one violating file.)
[ -d "$evals_dir" ] || fail "expected an evals/ directory under $target_root — a rename must be red, not a silently empty guard" ""
if [ $# -eq 0 ]; then
  [ -d "$agent_dir" ] || fail "expected $agent_dir to exist — a rename must be red, not a silently empty guard" ""
fi

# 1. Keys, paid models, and the retired sweep/opt-in knobs (E1).
scan '(ANTHROPIC|OPENAI|MOONSHOT|RM_MODEL)_API_KEY|OPENCODE_MODEL|ONBOARDING_EVAL_MODEL|ONBOARDING_SWEEP|use_paid_model|secrets\.' \
  'no API key, provider secret, paid model, or opt-in override may appear on an eval path (D22 rule 1)' \
  "$evals_dir" "$agent_dir"

# 2. Any environment read at all under evals/ (E1: no configuration surface).
scan 'process\.env|Bun\.env' \
  'evals/ must contain NO environment read — the model id is an in-code constant and an eval has no configuration surface (§11.3 E1)' \
  "$evals_dir"

# 3. Conditional skips (E2 / loud-skip-never).
scan '\.skip\b|skipIf|test\.if|describe\.if|\btodo\(' \
  'evals/ must contain no conditional skip — missing Docker or egress must THROW, never skip (§11.3 E2)' \
  "$evals_dir"

# 4. Mocks and injection seams (E2 — an eval always makes a real model call).
scan 'mock|jest\.fn|spyOn|__mocks__|\brunOnce\b|\bfake[A-Z]|\bstub[A-Z]' \
  'evals/ must contain no mock, stub, or injection seam on the eval path (§11.3 E2)' \
  "$evals_dir"

if [ "$status" -eq 0 ]; then
  echo "check-eval-keyless: OK (evals are keyless, env-free, skip-free, and mock-free)"
fi
exit "$status"
