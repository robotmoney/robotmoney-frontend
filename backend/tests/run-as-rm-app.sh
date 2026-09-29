#!/usr/bin/env bash
# Run the test files that pass with the shared api pool acting as rm_app, the real
# runtime role, instead of the schema-owner default (tests/preload.ts,
# RM_TEST_API_ROLE). The list is tests/rm-app-pool-files.txt; the files that
# cannot run that way are tests/rm-app-pool-blocked.txt: their fixtures DELETE,
# TRUNCATE, INSERT into tables the runtime role may not write, or run DDL, or
# read schema_migrations, schema_manifest, deployment_identity and
# automation_tokens directly, all of which only the schema owner may do.
set -euo pipefail
cd "$(dirname "$0")/.."
mapfile -t files < tests/rm-app-pool-files.txt
RM_TEST_API_ROLE=rm_app exec bun test "${files[@]}" "$@"
