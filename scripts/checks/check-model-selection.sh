#!/usr/bin/env bash
# docs/decisions.md D22 — rule 1 AS AMENDED 2026-07-28, plus rules 2-4 unchanged;
# docs/architecture.md §11.3 E1 (as amended) and E2. Enforced as a static guard.
#
# Same shape as scripts/checks/check-no-test-imports-in-runtime.sh: the exit
# code IS the verdict. Runs per-PR in .github/workflows/integration.yml —
# milliseconds, no Docker, no network — and is EXECUTED (not merely present) by
# scripts/tests/unit/model-selection-guard.test.ts, which runs it against
# planted fixtures and asserts it goes RED on each rule it claims to enforce.
#
# ── What this replaces, and why the name changed ────────────────────────────
# D22 rule 1 used to mandate a KEYLESS eval with the model as an in-code
# constant. That rule is retired: `opencode/big-pickle`, the free model it
# pinned, is saturated upstream (429 on every probe from CI's host while sibling
# free models answered 200 at the same instant) with zero cost across every
# field and no paid sibling in Zen's catalogue, so no amount of credit reaches
# it. Enforcing "keyless" would now enforce an outage.
#
# But rule 1 was protecting something real: AMBIENT, UNREVIEWABLE model
# selection. That property survives the amendment intact, and is what property 1
# below enforces — model ids live in versioned source, the environment carries
# only a selector, and `resolveAgentModel()` throws on an unknown family rather
# than falling back. This guard is therefore the successor to the
# `check-eval-keyless.sh` proposed on PR #284 (issue #278); that file should be
# dropped in favour of this one rather than both shipping, since its properties
# 1 and 2 assert the retired mandate. Its properties 3 and 4 are preserved here
# in intent — D22 rules 2-4 are untouched by the amendment.
#
# ── Properties ──────────────────────────────────────────────────────────────
#   1. REPO-WIDE: no raw model-id literal outside scripts/lib/model-registry.ts.
#      (D22 rule 1 as amended.)
#   2. REPO-WIDE: none of the retired credential/model knobs reappear.
#   3. evals/ ONLY: no conditional skip — loud-skip-never. (D22 rule 2 / E2.)
#   4. evals/ ONLY: no mock, stub, or injection seam. (D22 rule 2 / E2.)
#   5. The contribution-advisory reviewer resolves its model through
#      keylessModel(), never a literal — it reads untrusted PR diffs and posts
#      output publicly, so it must hold no credential.
#
# ── Deliberately NOT covered ────────────────────────────────────────────────
# scripts/tests/** is excluded from properties 1 and 2. Tests asserting what the
# registry RESOLVES TO must name concrete ids, and must name the retired knobs
# to prove they are stripped; forbidding that would forbid the coverage. The
# rule being enforced is that RUNTIME selection carries no ambient id — not that
# the string never appears anywhere in the repo.
#
# Comment lines are skipped for properties 1 and 2: prose naming a model id is
# documentation, which is the opposite of the ambient-selection problem.
#
# This file excludes ITSELF from properties 1 and 2 — it necessarily spells out
# the very tokens it forbids, and a guard that trips on its own patterns is
# unconditionally red and therefore useless.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
target_root="${1:-$root}"
self="$(basename "$0")"
status=0

fail() {
  echo "check-model-selection: FAILED — $1" >&2
  [ -n "${2:-}" ] && echo "$2" >&2
  status=1
}

# Strip `path:line:` then test whether the content begins a comment (//, #, *).
COMMENT_LINE_RE='^[^:]*:[0-9]+:[[:space:]]*(//|#|\*)'

# scan <pattern> <message> <path>...  — non-comment, non-test matches only.
scan() {
  local pattern="$1" message="$2"
  shift 2
  local paths=() p
  for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
  [ ${#paths[@]} -eq 0 ] && return 0
  local matches
  matches=$(grep -rnE "$pattern" "${paths[@]}" \
    --exclude-dir=node_modules --exclude-dir=tests --exclude-dir=.git \
    --exclude=model-registry.ts --exclude="$self" \
    2>/dev/null | grep -vE "$COMMENT_LINE_RE" || true)
  [ -n "$matches" ] && fail "$message" "$matches"
  return 0
}

# scan_all <pattern> <message> <path>... — every match, comments included.
scan_all() {
  local pattern="$1" message="$2"
  shift 2
  local paths=() p
  for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
  [ ${#paths[@]} -eq 0 ] && return 0
  local matches
  matches=$(grep -rnE "$pattern" "${paths[@]}" \
    --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null || true)
  [ -n "$matches" ] && fail "$message" "$matches"
  return 0
}

registry="$target_root/scripts/lib/model-registry.ts"
evals_dir="$target_root/evals"
advisory="$target_root/scripts/contribution-advisory-reviewer.ts"

# EXISTENCE ANCHOR. A guard over zero paths is a green that means nothing. The
# registry is this repo's single source of model ids and always exists, so
# anchoring here makes a rename or a bad path RED instead of silently empty.
# (evals/ is deliberately NOT an anchor — it does not exist yet; see #278.)
if [ ! -f "$registry" ]; then
  fail "expected the model registry at $registry — a rename must be red, not a silently empty guard" ""
  echo "check-model-selection: aborting; the scan anchor is missing." >&2
  exit 1
fi

# Roots relative to target_root that properties 1 and 2 (raw-model-id-literal,
# retired-knob) scan. scripts/tests/unit/model-selection-guard.test.ts derives
# this exact list from THIS array (its declaredRoots()) and plants one
# violation per root — a root added here with no corresponding
# planted-violation control in that suite goes red via its declared-roots
# meta-assertion, the same shape check-no-test-imports-in-runtime.sh uses.
scan_roots=(
  "scripts"
  ".github/workflows"
  "evals"
)

scan_paths=()
for rel in "${scan_roots[@]}"; do
  scan_paths+=("$target_root/$rel")
done
# docker-compose*.yml is a root-level GLOB, not a directory, so it cannot live
# in scan_roots above (that array assumes one path per entry); it is declared
# and scanned separately, with its own planted-violation control in
# model-selection-guard.test.ts.
for f in "$target_root"/docker-compose*.yml; do [ -e "$f" ] && scan_paths+=("$f"); done

# 1. Raw model-id literals outside the registry (D22 rule 1 as amended).
#    Quote-delimited on BOTH sides, so a release URL such as
#    .../anomalyco/opencode/releases/download/... is not a false positive and a
#    doc mention in `backticks` stays legal prose.
scan "[\"']opencode/[A-Za-z0-9][A-Za-z0-9._-]*[\"']" \
  'model ids belong ONLY in scripts/lib/model-registry.ts — the environment carries a SELECTOR (AGENT_MODEL=deepseek, kimi/k2.6), never a raw id. Use resolveAgentModel()/keylessModel() instead of a literal (D22 rule 1 as amended 2026-07-28).' \
  "${scan_paths[@]}"

# 2. Retired credential/model knobs. OPENCODE_API_KEY is the ONE credential and
#    AGENT_MODEL the ONE selector; these names were removed, not renamed.
scan 'OPENCODE_MODEL|ONBOARDING_EVAL_MODEL|MODEL_API_KEY_ENV_CANDIDATES|use_paid_model|(ANTHROPIC|OPENAI|MOONSHOT)_API_KEY' \
  'retired model/credential knob. OPENCODE_API_KEY is the single OpenCode Zen credential and AGENT_MODEL the single model selector (D22 rule 1 as amended).' \
  "${scan_paths[@]}"

# 5. The advisory reviewer must resolve keylessly, by function, not by literal.
if [ -f "$advisory" ]; then
  grep -q 'keylessModel()' "$advisory" || fail \
    "$advisory must resolve its model via keylessModel() — it feeds UNTRUSTED pull-request diffs to a model and posts the output as a public comment, so it may hold no credential (its workflow's no-secret assertion is the contract)." ""
fi

# 3 + 4. evals/ only — D22 rules 2-4, untouched by the rule-1 amendment.
if [ -d "$evals_dir" ]; then
  scan_all '\.skip\b|skipIf|test\.if|describe\.if|\btodo\(' \
    'evals/ must contain no conditional skip — a missing Docker daemon or missing egress must THROW, never skip (D22 rule 2 / §11.3 E2).' \
    "$evals_dir"
  scan_all 'mock|jest\.fn|spyOn|__mocks__|\brunOnce\b|\bfake[A-Z]|\bstub[A-Z]' \
    'evals/ must contain no mock, stub, or injection seam on the eval path — an eval always makes a real model call (D22 rule 2 / §11.3 E2).' \
    "$evals_dir"
else
  # NOT a silent pass. State precisely what went unscanned, so nobody reads this
  # check's green as covering the eval tree.
  echo "check-model-selection: NOT SCANNED — no evals/ directory under $target_root."
  echo "  Properties 3 (no conditional skip) and 4 (no mock/injection seam) were NOT enforced by this run."
  echo "  They apply to the eval tree that issue #278 introduces; this run covers only properties 1, 2, and 5."
  echo "  Deliberately not an error: evals/ does not exist on main yet. It becomes an anchor when #278 lands."
fi

if [ "$status" -eq 0 ]; then
  echo "check-model-selection: OK (model ids confined to scripts/lib/model-registry.ts; no retired knobs; advisory reviewer keyless)"
fi
exit "$status"
