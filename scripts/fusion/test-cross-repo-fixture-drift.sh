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
# NO CROSS-REPO TOKEN IS REQUIRED. Those rc.3-era bytes are vendored into
# scripts/fusion/testdata/rc3-drifted/ (see its README for provenance), so every
# case below runs on a bare checkout of THIS repo and therefore always runs in
# CI. Previously the whole self-test was gated on a robotmoney-core checkout and
# in CI on secrets.RM_CORE_RO_TOKEN, which is not configured on this repository —
# so it silently skipped on every run and the guard was never seen red in CI.
#
# OPTIONAL EXTRA: pass a robotmoney-core checkout as $1 (or set RM_CORE_CHECKOUT)
# and case 0 additionally proves the vendored bytes are still exactly what core
# carries at the tag, i.e. that the vendored copy has not been quietly tuned.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/fusion/check-cross-repo-fixture-drift.ts"
MANIFEST="$REPO_ROOT/shared-fixtures/vendored/robotmoney-core.manifest.json"
FIXTURES="$REPO_ROOT/contract/src/__fixtures__"
DRIFTED="$REPO_ROOT/scripts/fusion/testdata/rc3-drifted"
CORE="${1:-${RM_CORE_CHECKOUT:-}}"
DRIFTED_TAG="${RM_CORE_DRIFTED_TAG:-v0.4.0-rc.3}"
CASES=8

fail() { echo "SELF-TEST FAILED: $*" >&2; exit 1; }
pass=0

[ -d "$DRIFTED" ] || fail "vendored rc.3-era bytes are missing: $DRIFTED"

manifest_files() {
  python3 -c "
import json,sys
print('\n'.join(r['file'] for r in json.load(open(sys.argv[1]))['files']))" "$1"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$FIXTURES" "$TMP/fixtures"

# ── case 0: the vendored bytes still equal core's, when core is available ────
echo "=== case 0: vendored rc.3 bytes vs robotmoney-core $DRIFTED_TAG ==="
if [ -n "$CORE" ]; then
  git -C "$CORE" rev-parse "$DRIFTED_TAG" >/dev/null 2>&1 || fail "$CORE has no tag $DRIFTED_TAG"
  checked=0
  for path in "$DRIFTED"/consensus-receipt.*; do
    name="$(basename "$path")"
    git -C "$CORE" show "$DRIFTED_TAG:tests/fixtures/$name" > "$TMP/core-blob" 2>/dev/null \
      || fail "$name is vendored under testdata/rc3-drifted but core has no such file at $DRIFTED_TAG"
    cmp -s "$TMP/core-blob" "$path" || fail "vendored $name differs from core @ $DRIFTED_TAG — the vendored copy was edited"
    checked=$((checked+1))
  done
  [ "$checked" -gt 0 ] || fail "vendored nothing to compare"
  echo "  -> $checked vendored file(s) byte-identical to core @ $DRIFTED_TAG"
else
  echo "  -> no core checkout given; skipped (the vendored bytes are the source of truth for the rest)"
fi
pass=$((pass+1))

# ── case 1: the tree as committed is GREEN ──────────────────────────────────
echo
echo "=== case 1: check on the committed tree (expect exit 0) ==="
if bun "$CHECK" --fixtures-dir "$FIXTURES" --manifest "$MANIFEST"; then
  echo "  -> exit 0, as required"; pass=$((pass+1))
else
  fail "the check is RED on the committed tree; a check that is red on everything proves nothing"
fi

# ── case 2: the rc.3-era drifted bytes are RED ──────────────────────────────
# Every shared fixture core carried at the drifted tag is restored over the
# temp copy. Files core did not have then (the two new T24/R27 vectors) have no
# vendored counterpart and are LEFT ALONE, so the red comes only from real
# historical drift. (The previous `git show ... > "$TMP/fixtures/$name"` created
# and truncated the target to 0 bytes before git could fail, silently turning
# every absent-at-tag fixture into fake drift; case 4 is the control for that.)
echo
echo "=== case 2: rc.3-era core bytes planted over the fixtures (expect exit 1) ==="
planted=()
absent=()
while read -r name; do
  [ -n "$name" ] || continue
  if [ -f "$DRIFTED/$name" ]; then
    cp "$DRIFTED/$name" "$TMP/fixtures/$name"
    planted+=("$name")
  else
    absent+=("$name")
  fi
done < <(manifest_files "$MANIFEST")
[ "${#planted[@]}" -gt 0 ] || fail "planted nothing from $DRIFTED_TAG — the reconstruction is vacuous"
echo "  planted ${#planted[@]} fixture(s) from core $DRIFTED_TAG; ${#absent[@]} did not exist then: ${absent[*]:-none}"

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

# ── case 4: CONTROL for the absent-at-tag fixtures ──────────────────────────
# A fixture core did not have at the drifted tag must be left exactly as
# committed and must NOT appear in the red. If planting ever truncates or
# deletes it, it turns up here as a non-zero size delta or as an extra DRIFTED
# row, and the self-test's "8 of 9" arithmetic stops being a real measurement.
echo
echo "=== case 4: fixtures absent at $DRIFTED_TAG are untouched, not truncated ==="
[ "${#absent[@]}" -gt 0 ] || fail "expected at least one manifest fixture absent at $DRIFTED_TAG; found none"
for name in "${absent[@]}"; do
  [ -s "$TMP/fixtures/$name" ] || fail "$name was truncated to 0 bytes by the planting step"
  cmp -s "$TMP/fixtures/$name" "$FIXTURES/$name" || fail "$name was modified by the planting step but core had no such file at $DRIFTED_TAG"
  grep -qE "^${name//./\\.} +(DRIFTED|MISSING)" "$out" && fail "$name is reported red, but it is byte-identical to the committed tree — fake drift"
done
echo "  -> ${#absent[@]} absent-at-tag fixture(s) intact and absent from the red: ${absent[*]}"; pass=$((pass+1))

echo
echo "=== case 5: a DELETED shared fixture is MISSING, not silently ignored ==="
rm -f "$TMP/fixtures/consensus-receipt.envelope.json"
if bun "$CHECK" --fixtures-dir "$TMP/fixtures" --manifest "$MANIFEST" > "$TMP/missing.out" 2>&1; then
  cat "$TMP/missing.out"; fail "a deleted shared fixture exited 0"
fi
grep -q "consensus-receipt.envelope.json .*MISSING" "$TMP/missing.out" || {
  cat "$TMP/missing.out"; fail "a deleted shared fixture was not reported MISSING"; }
echo "  -> exit 1 and reported MISSING"; pass=$((pass+1))

echo
echo "=== case 6: an UNDECLARED extra consensus-receipt.* fixture is EXTRA ==="
rm -rf "$TMP/fixtures"; cp -R "$FIXTURES" "$TMP/fixtures"
printf '{"not":"promoted"}\n' > "$TMP/fixtures/consensus-receipt.smuggled.json"
if bun "$CHECK" --fixtures-dir "$TMP/fixtures" --manifest "$MANIFEST" > "$TMP/extra.out" 2>&1; then
  cat "$TMP/extra.out"; fail "an undeclared extra shared-family fixture exited 0"
fi
grep -q "consensus-receipt.smuggled.json .*EXTRA" "$TMP/extra.out" || {
  cat "$TMP/extra.out"; fail "the undeclared extra fixture was not reported EXTRA"; }
echo "  -> exit 1 and reported EXTRA"; pass=$((pass+1))

# ── case 7: the OMITTED arm, with its negative control ──────────────────────
# The failure this arm exists for: robotmoney-core adds a shared fixture and the
# frontend never copies it. Nothing on this repo's disk changes, so MISSING /
# DRIFTED / EXTRA all stay quiet. Simulated by adding a name to the pinned
# core_shared_inventory that is in neither files[] nor core_only_not_shared.
echo
echo "=== case 7: a core fixture the manifest omits is OMITTED (+ negative control) ==="
rm -rf "$TMP/fixtures"; cp -R "$FIXTURES" "$TMP/fixtures"
NEWCORE="consensus-receipt.core-added-later.json"
python3 -c "
import json,sys
m=json.load(open(sys.argv[1]))
m['core_shared_inventory']=sorted(set(m['core_shared_inventory'])|{sys.argv[3]})
json.dump(m,open(sys.argv[2],'w'),indent=2)
" "$MANIFEST" "$TMP/omitted.manifest.json" "$NEWCORE"
if bun "$CHECK" --fixtures-dir "$TMP/fixtures" --manifest "$TMP/omitted.manifest.json" > "$TMP/omitted.out" 2>&1; then
  cat "$TMP/omitted.out"
  fail "core carries a shared fixture this manifest omits and the check exited 0 — the pin silently covers less than the shared set"
fi
grep -q "$NEWCORE .*OMITTED" "$TMP/omitted.out" || {
  cat "$TMP/omitted.out"; fail "the omitted core fixture was not reported OMITTED"; }
grep -q "core has a shared fixture this manifest omits" "$TMP/omitted.out" || {
  cat "$TMP/omitted.out"; fail "the OMITTED failure did not explain itself"; }

# NEGATIVE CONTROL: the same inventory entry, explicitly declared core-only, is
# green. Without this, an arm that reddens on every inventory entry — including
# the deliberately core-only ones — would pass the positive case vacuously.
python3 -c "
import json,sys
m=json.load(open(sys.argv[1]))
m['core_shared_inventory']=sorted(set(m['core_shared_inventory'])|{sys.argv[3]})
m['core_only_not_shared']=sorted(set(m['core_only_not_shared'])|{sys.argv[3]})
json.dump(m,open(sys.argv[2],'w'),indent=2)
" "$MANIFEST" "$TMP/declared.manifest.json" "$NEWCORE"
if bun "$CHECK" --fixtures-dir "$TMP/fixtures" --manifest "$TMP/declared.manifest.json" > "$TMP/declared.out" 2>&1; then
  echo "  -> OMITTED when undeclared, green when declared core-only"; pass=$((pass+1))
else
  cat "$TMP/declared.out"
  fail "a core fixture explicitly declared core_only_not_shared still went red — the OMITTED arm reddens on everything"
fi

echo
echo "self-test: $pass/$CASES cases passed"
[ "$pass" -eq "$CASES" ] || fail "only $pass/$CASES"
echo "OK — check-cross-repo-fixture-drift.ts has been SEEN to go red on real drift, on an omitted core fixture, and green on the tree."
