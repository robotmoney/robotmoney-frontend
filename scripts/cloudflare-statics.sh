#!/usr/bin/env bash
# Assemble the Cloudflare Pages deploy dir (_site) for the hosted preview.
# Run by Cloudflare's Git-integration build (dashboard build command:
# `bash scripts/cloudflare-statics.sh`) — and locally for verification.
# Nothing in the repo invokes it automatically. See docs/architecture.md §4.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site && mkdir _site
cp -r frontend/public/. _site/
mkdir -p _site/preview _site/goldens
cp frontend/preview/index.html _site/preview/
cp frontend/preview/_redirects frontend/preview/_headers frontend/preview/404.html _site/
cp goldens/api-goldens.json _site/goldens/
