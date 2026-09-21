#!/usr/bin/env bash
# One-command local reproduction of .github/workflows/e2e.yml's required job.
# Skips the CI-runner-only provisioning (setup-bun, setup-node, pinned opencode
# CLI download) since a dev shell already has those; runs the same checks the
# workflow gates on: bun run scripts/smoke.ts, which internally runs
# smoke-frontend-check.ts, `test:browser` (Playwright), and smoke-live-smoke.ts
# against the same live external providers CI uses. Does NOT run the opt-in
# §11 R8 onboarding real-inference eval (ONBOARDING_REAL_EVAL stays unset),
# matching an ordinary PR run.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Worktrees don't carry a credential file at all; the funded key lives in
# $HOME/.env — the single credential file for the whole toolchain (issue #699:
# discrete tokens + role lines; OPENCODE_API_KEY is the funded-key line on a
# host that runs real inference).
ENV_FILE="${E2E_LOCAL_ENV_FILE:-$HOME/.env}"
if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "no $HOME/.env found — it must define a funded OPENCODE_API_KEY (see .env.example), or set E2E_LOCAL_ENV_FILE" >&2
  exit 1
fi
# $HOME/.env is not shell-sourceable (it uses `key = value` INI-ish syntax
# everywhere, role lines included) — pull just the one key we need.
OPENCODE_API_KEY="$(awk -F= '/^OPENCODE_API_KEY[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,""); print; exit}' "$ENV_FILE")"
export OPENCODE_API_KEY
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  echo "OPENCODE_API_KEY is empty in $ENV_FILE — the live swarm session step will fail loudly without it" >&2
  exit 1
fi

PINNED_OPENCODE_VERSION="1.18.1"
if ! command -v opencode >/dev/null 2>&1; then
  echo "opencode CLI not on PATH — install v${PINNED_OPENCODE_VERSION} (see e2e.yml's 'Install opencode CLI' step)" >&2
  exit 1
fi
LOCAL_OPENCODE_VERSION="$(opencode --version 2>&1 | tr -d '\n')"
if [ "$LOCAL_OPENCODE_VERSION" != "$PINNED_OPENCODE_VERSION" ]; then
  echo "note: local opencode is v${LOCAL_OPENCODE_VERSION}, CI pins v${PINNED_OPENCODE_VERSION} — behavior may differ"
fi

bun install --frozen-lockfile
bunx playwright install chromium

export CI=true
export SMOKE_PROJECT="rm_smoke_e2e_local_$(date +%s)"
LOG="/tmp/rm-e2e-local-${SMOKE_PROJECT}.log"
CONTAINER_LOG="/tmp/rm-e2e-local-${SMOKE_PROJECT}-containers.log"

cleanup() {
  echo "::capturing full container logs to $CONTAINER_LOG::"
  docker compose -p "$SMOKE_PROJECT" -f docker-compose.yml -f docker-compose.smoke.yml \
    logs --no-color > "$CONTAINER_LOG" 2>&1 || true
  echo "::teardown $SMOKE_PROJECT::"
  docker compose -p "$SMOKE_PROJECT" -f docker-compose.yml -f docker-compose.smoke.yml \
    down -v --remove-orphans || true
  WEB_PORT=1 POSTGRES_PORT=1 bun run scripts/smoke-clean.ts --project "$SMOKE_PROJECT" || true
}
trap cleanup EXIT

set -o pipefail
bun run scripts/smoke.ts 2>&1 | tee "$LOG"
STATUS=$?

echo "combined runtime+test log: $LOG"
echo "full container logs (api/worker/postgres): $CONTAINER_LOG"
if [ -d test-results ]; then
  echo "playwright failure traces (if any): test-results/ — view with: bunx playwright show-trace <trace.zip>"
fi
exit "$STATUS"
