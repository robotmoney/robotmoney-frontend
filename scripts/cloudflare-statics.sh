#!/usr/bin/env bash
# Assemble the Cloudflare Pages deploy dir (_site) for production or hosted preview.
# Run by Cloudflare's Git-integration build (dashboard build command:
# `bash scripts/cloudflare-statics.sh`) — and locally for verification.
# Nothing in the repo invokes it automatically. See docs/architecture.md §4.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${MODE:-${1:-prod}}"

rm -rf _site && mkdir _site
cp -r frontend/public/. _site/
mkdir -p _site/preview _site/goldens
cp frontend/preview/index.html _site/preview/
cp frontend/preview/404.html _site/
cp goldens/api-goldens.json _site/goldens/

if [ "$MODE" = "preview" ] || [ "$MODE" = "staging" ]; then
  cp frontend/preview/_redirects frontend/preview/_headers _site/
else
  cp frontend/prod/_redirects frontend/prod/_headers _site/
fi

bun scripts/prerender.ts
