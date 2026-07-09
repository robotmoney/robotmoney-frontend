#!/usr/bin/env bash
# issue #93 AC: project overview text is ADMIN-MANAGED free text — there must be
# ZERO AI/LLM overview enrichment anywhere under backend/src. The legacy
# robotmoney-bot-analytics `enrich-project-overviews` Deno edge function (which
# required an Anthropic API key) was never ported here, and reintroducing any
# Anthropic/Claude/LLM overview synthesis is explicitly forbidden. This static
# guard fails CI (non-zero exit) if backend/src references any such marker, so a
# stray port can never sneak an LLM back onto the overview path.
set -euo pipefail

backend="$(cd "$(dirname "$0")/.." && pwd)"
target="$backend/src"
# Case-insensitive: Anthropic SDK / Claude model calls / the legacy enrichment fn.
pattern='anthropic|claude|enrich-project-overviews'

if matches=$(grep -rniE "$pattern" "$target"); then
  echo "check-no-ai-overview: FAILED — backend/src must not reference AI/LLM overview enrichment:" >&2
  echo "$matches" >&2
  exit 1
fi

echo "check-no-ai-overview: OK (no AI/LLM overview enrichment references in backend/src)"
