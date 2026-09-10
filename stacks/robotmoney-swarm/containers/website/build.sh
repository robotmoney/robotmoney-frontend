#!/usr/bin/env bash
# Builds the website-server image: a plain static file server for the
# assembled `_static/` tree (no app layer), replicating routeShell's
# prerendered-file -> _shell.html -> index.html fallback order.
#
# BLOCKED ON issue #3 (devops) / #892 (this repo): "build: split
# website-server out of the api image for static/SPA serving". That issue
# lands frontend/Dockerfile; this script only wires the build once it exists,
# per #893's own explicit scope ("this task only wires
# containers/website/build.sh to reference it once it exists, and is
# sequenced after #3 merges"). Until then this build fails loudly (never
# silently) with docker's own "no such file" error rather than fabricating a
# stand-in Dockerfile that would conflict with #892's PR.
#
# Same env-var contract as containers/api/build.sh; see that file's header.
set -eo pipefail

source "${STACK_CONTAINER_BASE_DIR}/build-base.sh"

docker build \
  --tag "${STACK_FULL_CONTAINER_IMAGE_TAG}" \
  --file "${STACK_CONTENT_ROOT_DIR}/frontend/Dockerfile" \
  --build-arg STACK_HOST_UID="${STACK_HOST_UID}" \
  --build-arg STACK_HOST_GID="${STACK_HOST_GID}" \
  ${build_command_args} \
  "${STACK_CONTENT_ROOT_DIR}"
