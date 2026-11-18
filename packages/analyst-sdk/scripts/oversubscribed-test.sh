#!/usr/bin/env bash
# Run one SDK test file with the machine 2x oversubscribed (issue 1667):
# start 2 x nproc CPU-bound busy loops, run `bun test <test file>` in
# packages/analyst-sdk, kill the loops on exit, and exit with the test's code.
#   bash packages/analyst-sdk/scripts/oversubscribed-test.sh tests/prepare.test.ts
set -u
if [ $# -ne 1 ]; then
  echo "usage: $0 <test file>" >&2
  exit 2
fi
SDK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The marker names the loops, so `pgrep -f analyst-sdk-oversubscribe-loop` finds any left behind.
MARKER="analyst-sdk-oversubscribe-loop"
pids=()
cleanup() {
  if [ ${#pids[@]} -gt 0 ]; then
    kill "${pids[@]}" 2>/dev/null
    wait "${pids[@]}" 2>/dev/null
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
loops=$((2 * $(nproc)))
for _ in $(seq "$loops"); do
  bash -c "while :; do :; done # $MARKER" &
  pids+=($!)
done
echo "oversubscribed: $loops busy loops on $(nproc) cpus" >&2
cd "$SDK" && bun test "$1"
