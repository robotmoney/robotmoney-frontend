#!/usr/bin/env bash
# Docs <-> package.json consistency guard for the frozen (offline single-file) build.
#
# Keeps the canonical docs and the `frozen*` npm scripts from drifting apart:
#
#   1. A canonical doc must actually document the frozen build — it must mention
#      `bun run frozen` AND the output path `dist/frozen/index.html`. If the
#      feature is undocumented (the exact regression that motivated issue #23),
#      this fails.
#   2. Every `frozen*` script referenced in the docs as `bun run <name>` must
#      exist under `.scripts` in package.json (a doc naming a removed/renamed
#      command fails).
#   3. Every `frozen*` script defined in package.json must be documented in a
#      canonical doc (a new frozen command shipped without docs fails).
#
# It runs in CI (see .github/workflows/integration.yml) and gates the job — exit
# non-zero on any mismatch. No silent skips.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PKG="package.json"
# Canonical docs that may document the frozen build. The primary doc must satisfy
# the grep gate; command cross-checks scan all of them.
DOCS=("README.md" "docs/DEPLOYMENT.md" "docs/ARCHITECTURE.md")

fail() { echo "check-docs-frozen: FAIL: $*" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || fail "jq is required but not installed"
[ -f "$PKG" ] || fail "$PKG not found (run from repo root)"

# ── 1. The frozen build must be documented in at least one canonical doc ───────
documented_doc=""
for d in "${DOCS[@]}"; do
  [ -f "$d" ] || continue
  if grep -q 'bun run frozen' "$d" && grep -q 'dist/frozen/index.html' "$d"; then
    documented_doc="$d"
    break
  fi
done
[ -n "$documented_doc" ] || fail \
  "no canonical doc (${DOCS[*]}) mentions both 'bun run frozen' and 'dist/frozen/index.html' — document the frozen build"
echo "check-docs-frozen: frozen build documented in $documented_doc"

# Concatenate the existing docs once for the cross-checks below.
doc_text="$(for d in "${DOCS[@]}"; do [ -f "$d" ] && cat "$d"; done)"

# ── 2. Every `bun run frozen*` in the docs must be a real package.json script ──
docs_cmds="$(printf '%s\n' "$doc_text" \
  | grep -oE 'bun run frozen[A-Za-z0-9:_-]*' \
  | sed 's/^bun run //' | sort -u || true)"
[ -n "$docs_cmds" ] || fail "no 'bun run frozen*' command found in the docs"
while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  if [ "$(jq -r --arg k "$cmd" '.scripts | has($k)' "$PKG")" != "true" ]; then
    fail "docs reference 'bun run $cmd' but package.json has no such script"
  fi
  echo "check-docs-frozen: doc command 'bun run $cmd' present in package.json"
done <<< "$docs_cmds"

# ── 3. Every `frozen*` package.json script must be documented ──────────────────
pkg_cmds="$(jq -r '.scripts | keys[] | select(startswith("frozen"))' "$PKG" | sort -u)"
[ -n "$pkg_cmds" ] || fail "package.json defines no 'frozen*' scripts"
while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  if ! printf '%s\n' "$doc_text" | grep -qF "bun run $cmd"; then
    fail "package.json script 'frozen*' '$cmd' is not documented (expected 'bun run $cmd' in ${DOCS[*]})"
  fi
  echo "check-docs-frozen: package.json script 'bun run $cmd' is documented"
done <<< "$pkg_cmds"

echo "check-docs-frozen: OK — docs and package.json frozen commands are in sync"
