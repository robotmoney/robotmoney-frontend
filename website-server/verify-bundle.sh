#!/bin/sh
# The build-stage gate of the website-server image (issue 1627,
# docs/technical/web-serving-architecture.md §3.2). Dockerfile.bundle runs it
# inside the server image, as root, before a single bundle file can reach the
# final image. A bundle that fails any check fails the build, so an unsigned or
# mislabelled bundle can never become an image.
#
#   verify-bundle.sh <in-dir> <out-dir> <web-tag> <commit> <bundle-sha256>
#
# <in-dir> holds exactly one bundle with its digest statement and signature, as
# scripts/lib/web-bundle.ts packs and signs it. The checks, in order:
#
#   1. the bundle's file name is the one the tag and commit name
#      (robotmoney-web-<tag without web-v>-<commit>.tar.gz), so the labels the
#      image carries are the bundle's own;
#   2. its sha256 is <bundle-sha256>, and the digest statement names exactly
#      this tarball and that sha256;
#   3. a key in the server image's allowed-signers file signed the statement in
#      the web-bundle namespace (ssh-keygen -Y verify);
#   4. every tar entry is a regular file at a relative path with no `..`.
#      BusyBox tar lists a hardlink as a regular file (`-rw-r--r-- ... b -> a`),
#      so a listing line with ` -> ` is refused too (issue 1628);
#   5. after extraction, every path is a directory or a regular file with one
#      link, so a hardlink the listing missed still fails;
#   6. the extracted site carries version.json.
#
# Only then is the site extracted to <out-dir>. The manifest check and the
# version.json identity check are web-bundle.ts's, run on the host before the
# build (P5). The signature covers every byte of the tarball, so this stage
# needs neither to refuse a changed bundle.
set -eu

NAMESPACE="robotmoney-web-bundle@v1"
SIGNERS="${RM_WEB_BUNDLE_ALLOWED_SIGNERS:-/etc/robotmoney/allowed-signers}"

fail() {
	echo "web bundle refused: $*" >&2
	exit 1
}

[ $# -eq 5 ] || fail "usage: verify-bundle.sh <in-dir> <out-dir> <web-tag> <commit> <bundle-sha256>"
in=$1
out=$2
tag=$3
commit=$4
digest=$5

case "$tag" in web-v?*) ;; *) fail "the web tag '$tag' does not start with web-v" ;; esac
echo "$commit" | grep -Eqx '[0-9a-f]{7,40}' || fail "the commit '$commit' is not a hex commit"
echo "$digest" | grep -Eqx '[0-9a-f]{64}' || fail "the bundle digest '$digest' is not a sha256"
[ -s "$SIGNERS" ] || fail "the server image has no allowed-signers file at $SIGNERS"
[ ! -e "$out" ] || fail "$out already exists"

name="robotmoney-web-${tag#web-v}-${commit}.tar.gz"
cd "$in"
count=$(find . -maxdepth 1 -name 'robotmoney-web-*.tar.gz' | wc -l)
[ "$count" -eq 1 ] || fail "the bundle context must hold exactly one robotmoney-web-*.tar.gz, found $count"
[ -f "$name" ] || fail "the bundle context holds no $name, the bundle $tag at $commit names"

actual=$(sha256sum "$name" | cut -d' ' -f1)
[ "$actual" = "$digest" ] || fail "$name has sha256 $actual, not $digest"
expected_statement=$(mktemp)
printf '%s  %s\n' "$actual" "$name" >"$expected_statement"
[ -f "$name.sha256" ] || fail "the digest file is missing"
cmp -s "$expected_statement" "$name.sha256" || fail "the digest file does not name this bundle's sha256"
rm -f "$expected_statement"

[ -f "$name.sha256.sig" ] || fail "the signature is missing"
signer=""
for principal in $(ssh-keygen -Y find-principals -s "$name.sha256.sig" -f "$SIGNERS" 2>/dev/null || true); do
	if ssh-keygen -Y verify -f "$SIGNERS" -I "$principal" -n "$NAMESPACE" -s "$name.sha256.sig" <"$name.sha256" >/dev/null 2>&1; then
		signer=$principal
		break
	fi
done
[ -n "$signer" ] || fail "no key in $SIGNERS signed $name in namespace $NAMESPACE"

listing=$(tar -tvzf "$name") || fail "the tarball is not a valid gzip tar"
if echo "$listing" | grep -v '^-' | grep -q .; then fail "the tarball holds an entry that is not a regular file"; fi
if echo "$listing" | grep -q ' -> '; then fail "the tarball holds a link"; fi
unsafe=$(tar -tzf "$name" | grep -E '^/|(^|/)\.\.?(/|$)|//|^$' || true)
[ -z "$unsafe" ] || fail "the tarball holds an unsafe path: $unsafe"

mkdir -p "$out"
tar -xzf "$name" -C "$out"
odd=$(find "$out" ! -type d ! -type f; find "$out" -type f -links +1)
[ -z "$odd" ] || { rm -rf "$out"; fail "the extracted bundle holds a link or a special file: $odd"; }
[ -f "$out/version.json" ] || fail "the bundle carries no version.json"
echo "verified $name (sha256 $actual, signer $signer)"
