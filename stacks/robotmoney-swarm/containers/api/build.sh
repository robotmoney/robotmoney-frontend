#!/usr/bin/env bash
# Builds the api image from the existing backend/Dockerfile, referenced (never
# moved or duplicated) with the repo root as build context — required because
# backend/Dockerfile copies contract/ from outside backend/ (field guide §2).
#
# stack invokes this script directly (it is named in container.yml's `build:`
# field) and sets these on its environment before running it:
#   STACK_CONTENT_ROOT_DIR          — the docker build context (repo root, per
#                                      this container's content-root: .)
#   STACK_FULL_CONTAINER_IMAGE_TAG  — the image tag to produce, <name>:stack
#   STACK_CONTAINER_BASE_DIR        — where build-base.sh lives; source it
#                                      first for STACK_FORCE_REBUILD /
#                                      STACK_CONTAINER_EXTRA_BUILD_ARGS support
set -eo pipefail

source "${STACK_CONTAINER_BASE_DIR}/build-base.sh"

docker build \
  --tag "${STACK_FULL_CONTAINER_IMAGE_TAG}" \
  --file "${STACK_CONTENT_ROOT_DIR}/backend/Dockerfile" \
  --build-arg STACK_HOST_UID="${STACK_HOST_UID}" \
  --build-arg STACK_HOST_GID="${STACK_HOST_GID}" \
  --build-arg AUM_PRODUCER_REVISION="${AUM_PRODUCER_REVISION:-}" \
  ${build_command_args} \
  "${STACK_CONTENT_ROOT_DIR}"
