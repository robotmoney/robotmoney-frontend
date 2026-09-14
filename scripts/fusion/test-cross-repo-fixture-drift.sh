#!/usr/bin/env bash
# C-21 NEGATIVE SELF-TEST for scripts/fusion/check-cross-repo-fixture-drift.ts.
#
# A guard's exit code is not evidence until the guard has been SEEN to go red.
# The drift check's entire value is that it fails on a one-sided fixture edit,
# and the one thing it must never do is exit 0 over a drifted tree — that is
# literally the failure this whole task exists to close (robotmoney-core was
# green at v0.4.0-rc.3 with eight of nine shared fixtures drifted).
#
# So this script reconstructs a REAL historical drifted state rather than
# inventing one: it copies the fixture directory into a temp dir and overwrites
# it with the bytes robotmoney-core actually carried at tag v0.4.0-rc.3, then
# asserts the check goes RED and names every drifted file. It then asserts the
# check is GREEN on the tree as committed, so a check that is red on everything
# (the other way to pass a negative test vacuously) also fails here.
#
# Requires: a robotmoney-core checkout. Pass it as $1 or set RM_CORE_CHECKOUT.
# Run from CI (.github/workflows/fusion-cross-repo-drift.yml) and by hand.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/fusion/check-cross-repo-fixture-drift.ts"
MANIFEST="$REPO_ROOT/shared-fixtures/vendored/robotmoney-core.manifest.json"
FIXTURES="$REPO_ROOT/contract/src/__fixtures__"
CORE="${1:-${RM_CORE_CHECKOUT:-}}"
DRIFTED_TAG="${RM_CORE_DRIFTED_TAG:-v0.4.0-rc.3}"

fail() { echo "SELF-TEST FAILED: $*" >&2; exit 1; }
pass=0

if [ -z "$CORE" ]; then
  echo "usage: $0 <robotmoney-core checkout>   (or set RM_CORE_CHECKOUT)" >&2
  exit 2
fi
git -C "$CORE" rev-parse "$DRIFTED_TAG" >/dev/null 2>&1 || fail "$CORE has no tag $DRIFTED_TAG"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$FIXTURES" "$TMP/fixtures"

# ── case 1: the tree as committed is GREEN ──────────────────────────────────
echo "=== case 1: check on the committed tree (expect exit 0) ==="
if bun "$CHECK" --fixtures-dir "$FIXTURES" --manifest "$MANIFEST"; then
  echo "  -> exit 0, as required"; pass=$((pass+1))
else
  fail "the check is RED on the committed tree; a check that is red on everything proves nothing"
fi

# ── case 2: the rc.3-era drifted bytes are RED ──────────────────────────────
# Every shared fixture core carried at the drifted tag is restored over the
# temp copy. Files core did not have then (the two new T24/R27 vectors) stay as
# they are, so the red comes only from real historical drift.
echo
echo "=== case 2: rc.3-era core bytes planted over the fixtures (expect exit 1) ==="
planted=()
while read -r name; do
  if git -C "$CORE" show "$DRIFTED_TAG:tests/fixtures/$name" > "$TMP/fixtures/$name" 2>/dev/null; then
    planted+=("$name")
  fi
done < <(python3 -c "
import json,sys
print('\n'.join(r['file'] for r in json.load(open('$MANIFEST'))['files']))")
[ "${#planted[@]}" -gt 0 ] || fail "planted nothing from $DRIFTED_TAG — the reconstruction is vacuous"
echo "  planted ${#planted[@]} fixture(s) from core $DRIFTED_TAG"

# Which of those actually differ from the committed bytes? Only those may be
# reported as DRIFTED, and ALL of them must be: a check that catches some of a
# known-drifted set is the rc.3 failure with a smaller blast radius.
expected_red=()
for name in "${planted[@]}"; do
  cmp -s "$TMP/fixtures/$name" "$FIXTURES/$name" || expected_red+=("$name")
done
[ "${#expected_red[@]}" -gt 0 ] || fail "no planted file differs from the committed bytes — nothing to detect"
echo "  of those, ${#expected_red[@]} differ from the committed bytes: ${expected_red[*]}"

out="$TMP/drifted.out"
if bun "$CHECK" --fixtures-dir "$TMP/fixtures" --manifest "$MANIFEST" > "$out" 2>&1; then
  cat "$out"
  fail "the check exited 0 over the rc.3-era drifted tree — this is exactly the bug it must prevent"
fi
echo "  -> exit 1, as required"; pass=$((pass+1))

echo
echo "=== case 3: every known-drifted file is named DRIFTED in the output ==="
missing=()
for name in "${expected_red[@]}"; do
  grep -qE "^${name//./\\.} +DRIFTED" "$out" || missing+=("$name")
done
if [ "${#missing[@]}" -ne 0 ]; then
  cat "$out"
  fail "the check went red but did not report these known-drifted files: ${missing[*]}"
fi
echo "  -> all ${#expected_red[@]} reported"; pass=$((pass+1))

echo
echo "=== case 4: a DELETED shared fixture is MISSING, not silently ignored ==="
rm -f "$TMP/fixtures/consensus-receipt.envelope.json"
if bun "$CHECK" --fixtures-dir "$TMP/fixtures" --manifest "$MANIFEST" > "$TMP/missing.out" 2>&1; then
  cat "$TMP/missing.out"; fail "a deleted shared fixture exited 0"
fi
grep -q "consensus-receipt.envelope.json .*MISSING" "$TMP/missing.out" || {
  cat "$TMP/missing.out"; fail "a deleted shared fixture was not reported MISSING"; }
echo "  -> exit 1 and reported MISSING"; pass=$((pass+1))

echo
echo "=== case 5: an UNDECLARED extra consensus-receipt.* fixture is EXTRA ==="
rm -rf "$TMP/fixtures"; cp -R "$FIXTURES" "$TMP/fixtures"
printf '{"not":"promoted"}\n' > "$TMP/fixtures/consensus-receipt.smuggled.json"
if bun "$CHECK" --fixtures-dir "$TMP/fixtures" --manifest "$MANIFEST" > "$TMP/extra.out" 2>&1; then
  cat "$TMP/extra.out"; fail "an undeclared extra shared-family fixture exited 0"
fi
grep -q "consensus-receipt.smuggled.json .*EXTRA" "$TMP/extra.out" || {
  cat "$TMP/extra.out"; fail "the undeclared extra fixture was not reported EXTRA"; }
echo "  -> exit 1 and reported EXTRA"; pass=$((pass+1))

echo
echo "self-test: $pass/5 cases passed"
[ "$pass" -eq 5 ] || fail "only $pass/5"
echo "OK — check-cross-repo-fixture-drift.ts has been SEEN to go red on real drift, and green on the tree."
