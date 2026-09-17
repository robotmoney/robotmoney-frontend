#!/usr/bin/env bash
# Builds the website-server image: a plain static file server for the
# assembled `_static/` tree (no app layer), replicating routeShell's
# prerendered-file -> _shell.html -> index.html fallback order.
#
# #892 landed this repo's website-server split as `website-server/Dockerfile`
# (a plain nginx:alpine recipe), not `frontend/Dockerfile` as this issue's
# own scope text anticipated before #892 was implemented — verified directly
# against the merged tree, see website-server/Dockerfile and
# website-server/nginx.conf. Unlike backend/Dockerfile (api, producer),
# website-server/Dockerfile only COPYs nginx.conf from its own directory, so
# its build context is website-server/ itself, not the repo root: passing
# STACK_CONTENT_ROOT_DIR (repo root) as context would make that COPY fail
# ("nginx.conf: no such file or directory") because Docker resolves COPY
# sources against the build context, not the Dockerfile's own directory.
#
# Same env-var contract as containers/api/build.sh; see that file's header.
set -eo pipefail

source "${STACK_CONTAINER_BASE_DIR}/build-base.sh"

docker build \
  --tag "${STACK_FULL_CONTAINER_IMAGE_TAG}" \
  --file "${STACK_CONTENT_ROOT_DIR}/website-server/Dockerfile" \
  --build-arg STACK_HOST_UID="${STACK_HOST_UID}" \
  --build-arg STACK_HOST_GID="${STACK_HOST_GID}" \
  ${build_command_args} \
  "${STACK_CONTENT_ROOT_DIR}/website-server"
