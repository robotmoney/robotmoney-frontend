#!/usr/bin/env bash
# scripts/stack-migrate.sh — pre_start_command wrapper for
# stacks/robotmoney-swarm/'s app pod (issue #895, robotmoney/devops#18).
#
# Runs HOST-SIDE, invoked by `stack manage start` with $STACK_DEPLOYMENT_DIR
# set (pre_start_command / post_start_command are host-side scripts run by
# the deployer, not by a container — confirmed against the upstream skill).
#
# DATABASE_URL is declared `external: true` in stack.yml. Per
# robotmoney/devops's docs/secrets.md, a referenced (external) secret on the
# `compose` deploy target is "resolved at each up and passed by compose
# interpolation; never written to disk" — secrets.env on the host holds only
# *generated* secret values, so a script that tries to source it for
# DATABASE_URL has nothing to read. The migration has to reach the database
# the same way the app pod's own containers do: through compose
# interpolation, by running the same service one-off with
# `docker compose run --rm --no-deps`.
#
# This is robotmoney/devops's scaffold-stack.md Phase 2.3 placeholder
# mechanism, pending robotmoney/devops#12's secret-delivery spike confirming
# it against a real compose deployment (PRE_START_ENV / COMPOSE_RUN /
# CONTAINER_FALLBACK). As of this writing that spike has not run and
# no-paas-deployment.md records no confirmed mechanism yet — see issue #895's
# PR for the current status. If the spike instead finds
# pre_start_command's own process environment already carries
# $DATABASE_URL, drop the compose indirection below for a plain invocation
# of the migrate command, and update this comment and the doc together.
set -euo pipefail

: "${STACK_DEPLOYMENT_DIR:?STACK_DEPLOYMENT_DIR must be set (stack manage sets this for pre_start_command)}"

# Overridable only for tests / local dry-runs — the real deployment always
# gets these from $STACK_DEPLOYMENT_DIR and stack.yml's own service name.
COMPOSE_FILE="${STACK_MIGRATE_COMPOSE_FILE:-${STACK_DEPLOYMENT_DIR}/compose/composefile-app.yml}"
SERVICE="${STACK_MIGRATE_SERVICE:-api}"

exec docker compose -f "${COMPOSE_FILE}" run --rm --no-deps "${SERVICE}" \
  bun run src/db/migrate.ts
