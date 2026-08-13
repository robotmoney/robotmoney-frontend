#!/usr/bin/env bash
# Assemble the api process's STATIC_DIR — the cutover host for robotmoney.network
# (docs/decisions.md D29, docs/runbooks/deployment.md §5.1).
#
# The api co-serves the marketing SPA straight from STATIC_DIR, so whatever
# sits in this directory IS what a link unfurler reads. `frontend/public` alone
# is not enough: it holds one `index.html` (the home-page shell) and nothing
# per-route, so every shared URL unfurled as the home page. This assembles the
# source tree PLUS the per-route `<route>/index.html` files
# `scripts/prerender.ts` writes from `seo.js`'s table — the same prerenderer
# `scripts/cloudflare-statics.sh` runs over `_site`, pointed at this directory
# via PRERENDER_DIR. There is no second metadata table.
#
# Run automatically before every `docker compose up` by scripts/stack/stack.ts
# (so `bun run demo`, the evals, and CI all serve prerendered HTML), and by
# `bun run static:assemble` for a hand-run `docker compose up -d`.
set -euo pipefail
cd "$(dirname "$0")/.."

# Output dir: argv[1], else $STATIC_ASSEMBLY_DIR, else `_static` (gitignored,
# a build output — never source). Relative paths resolve against the repo root.
OUT="${1:-${STATIC_ASSEMBLY_DIR:-_static}}"

# Clear the CONTENTS, never the directory itself. docker-compose.yml bind-mounts
# this path into the api container, and a bind follows the INODE: `rm -rf` +
# recreate would leave a running container serving a deleted directory. Emptying
# in place keeps the inode and still drops files for routes that left sitemap.xml.
mkdir -p "$OUT"
find "$OUT" -mindepth 1 -delete
cp -R frontend/public/. "$OUT"/

PRERENDER_DIR="$OUT" bun scripts/prerender.ts

# Post-deploy verification (issue #548): check live parity
if [ "${VERIFY_LIVE_ASSEMBLY:-}" = "true" ]; then
  echo "Verifying live SKILL.md against assembled copy..."
  curl -fsSL "https://robotmoney.network/skills/swarm-onboarding/SKILL.md" | cmp - "$OUT/skills/swarm-onboarding/SKILL.md" || {
    echo "ERROR: live/tree mismatch on SKILL.md" >&2
    exit 1
  }
fi
