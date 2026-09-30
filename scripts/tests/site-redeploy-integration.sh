#!/usr/bin/env bash
# End-to-end proof of `bun run site:redeploy` against a REAL compose stack: a website-server built from
# website-server/Dockerfile with the real read-only bind mount of `_static/`, a stub api that answers /health, and
# two more service containers. It runs the tool's dry run, a real redeploy, a rollback, and a forced failure (the
# api goes down, so the post-swap check fails and the tool must put the old site back), and asserts after each step
# that the containers never moved and the right site is live.
#
# Needs Docker, bun, git, rsync and network (the prerenderer reads the live regime). Not part of CI's unit tier:
#   bash scripts/tests/site-redeploy-integration.sh [OLD_TREE]      # OLD_TREE: a checkout to build the "old" site from
# This tree is the NEW site. By default the old site is where this branch left the release (the merge-base with
# origin/releases-0.5.x, else the parent commit), checked out in a temp worktree.
set -euo pipefail
cd "$(dirname "$0")/../.."
NEW="$PWD"
WORK="$(mktemp -d /tmp/site-it-XXXXXX)"
PROJECT="sitedeploytest$$"
OLD="${1:-}"
pass() { echo "  PASS  $*"; }
die() { echo "  FAIL  $*"; exit 1; }
cleanup() {
  docker compose -p "$PROJECT" -f "$WORK/docker-compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  [ -n "${WT:-}" ] && git -C "$NEW" worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ -z "$OLD" ]; then
  WT="$WORK/old-tree"
  git worktree add -q --detach "$WT" "$(git merge-base HEAD origin/releases-0.5.x 2>/dev/null || git rev-parse HEAD~1)"
  OLD="$WT"
  ln -s "$NEW/node_modules" "$OLD/node_modules" 2>/dev/null || true
  [ -d "$NEW/backend/node_modules" ] && ln -s "$NEW/backend/node_modules" "$OLD/backend/node_modules" 2>/dev/null || true
  [ -d "$NEW/contract/node_modules" ] && ln -s "$NEW/contract/node_modules" "$OLD/contract/node_modules" 2>/dev/null || true
fi

echo "== building the OLD site ($(git -C "$OLD" rev-parse --short HEAD)) as the live site"
LIVE="$WORK/live"
mkdir -p "$LIVE/.agents"
(cd "$OLD" && bash scripts/static-assembly.sh "$LIVE/_static" >/dev/null)
OLD_COMMIT="$(bun -e "console.log(require('$LIVE/_static/version.json').commit)")"

cat > "$WORK/docker-compose.yml" <<EOF
services:
  api:
    image: nginx:1.27-alpine
    volumes: ["$WORK/api.conf:/etc/nginx/conf.d/default.conf:ro"]
  worker:
    image: nginx:1.27-alpine
  website-server:
    build: { context: $NEW/website-server, dockerfile: Dockerfile }
    volumes: ["$LIVE/_static:/srv/frontend:ro"]
    ports: ["8080"]
    depends_on: [api]
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
      interval: 3s
      timeout: 3s
      retries: 10
      start_period: 2s
EOF
cat > "$WORK/api.conf" <<'EOF'
server { listen 8787; location / { default_type application/json; return 200 '{"status":"ok"}'; } }
EOF

echo "== starting the stack"
docker compose -p "$PROJECT" -f "$WORK/docker-compose.yml" up -d --build >/dev/null 2>&1
for _ in $(seq 1 40); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$PROJECT-website-server-1" 2>/dev/null)" = healthy ] && break
  sleep 2
done
WEBPORT="$(docker compose -p "$PROJECT" -f "$WORK/docker-compose.yml" port website-server 8080 | sed 's/.*://')"
echo "{\"project\":\"$PROJECT\",\"webPort\":$WEBPORT}" > "$LIVE/.agents/smoke-state.json"
served() { curl -s "http://127.0.0.1:$WEBPORT/version.json" | bun -e "console.log(JSON.parse(await Bun.stdin.text()).commit)"; }
ids() { docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.ID}} {{.RunningFor}}' | sort; }
started() { docker inspect --format '{{.Name}} {{.Id}} {{.State.StartedAt}}' $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT") | sort; }
[ "$(served)" = "$OLD_COMMIT" ] && pass "the stack serves the old site ($OLD_COMMIT)" || die "old site not served"
BEFORE="$(started)"

TOOL=(bun scripts/redeploy-website.ts --live "$LIVE")

echo "== 1. refuses to run from the live checkout"
if (cd "$NEW" && bun scripts/redeploy-website.ts --live "$NEW" >/dev/null 2>&1); then die "ran against its own tree"; else pass "refused (no state file in this tree)"; fi

echo "== 2. dry run changes nothing"
"${TOOL[@]}" --dry-run --build-dir "$WORK/build" 2>&1 | sed 's/^/    /'
[ "$(served)" = "$OLD_COMMIT" ] && pass "still serving the old site" || die "dry run changed the live site"
[ "$BEFORE" = "$(started)" ] && pass "no container moved" || die "a container moved during the dry run"

echo "== 3. real redeploy"
"${TOOL[@]}" --build-dir "$WORK/build" 2>&1 | sed 's/^/    /'
NEW_COMMIT="$(git -C "$NEW" rev-parse --short=8 HEAD)"
SERVED="$(served)"
case "$NEW_COMMIT" in "$SERVED"*) pass "the stack serves the new site ($SERVED)";; *) case "$SERVED" in "${NEW_COMMIT:0:7}"*) pass "the stack serves the new site ($SERVED)";; *) die "served $SERVED, expected $NEW_COMMIT";; esac;; esac
[ "$BEFORE" = "$(started)" ] && pass "every container has the same id and start time" || die "a container moved"
BACKUP="$(ls -d "$WORK"/site-backups/* | tail -1)"
[ -f "$BACKUP/receipt.json" ] && pass "receipt written: $(basename "$BACKUP")" || die "no receipt"

echo "== 4. rollback"
"${TOOL[@]}" --rollback "$BACKUP" 2>&1 | sed 's/^/    /'
[ "$(served)" = "$OLD_COMMIT" ] && pass "the old site is back ($OLD_COMMIT)" || die "rollback did not restore the old site"
[ "$BEFORE" = "$(started)" ] && pass "no container moved during the rollback" || die "a container moved"

echo "== 5. forced failure: the api goes down, so the post-swap check must fail and restore the old site"
docker stop "$PROJECT-api-1" >/dev/null
BEFORE2="$(started)"
if "${TOOL[@]}" --build-dir "$WORK/build2" 2>&1 | sed 's/^/    /'; then die "the tool reported success with the api down"; else pass "the tool exited non-zero"; fi
[ "$(served)" = "$OLD_COMMIT" ] && pass "the old site was put back automatically ($OLD_COMMIT)" || die "the failed deploy was left live"
[ "$BEFORE2" = "$(started)" ] && pass "no container moved" || die "a container moved"

echo "ALL CHECKS PASSED"
