#!/usr/bin/env bash
# Build robotmoney/api:stack from backend/Dockerfile with the REPO ROOT as the
# build context (the Dockerfile copies contract/ from outside backend/).
#
# The contract with `stack prepare` is these three variables, read from the
# wrapper convention (see bozemanpass/stack-wrapper-static-content/build.sh):
#   STACK_CONTAINER_BUILD_WORK_DIR     docker build context
#   STACK_CONTAINER_BUILD_CONTAINERFILE  -f
#   STACK_CONTAINER_BUILD_TAG          image tag, <name>:stack
source ${STACK_CONTAINER_BASE_DIR}/build-base.sh

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
# stacks/robotmoney/containers/api -> repo root
REPO_ROOT=$( cd -- "${SCRIPT_DIR}/../../../.." &> /dev/null && pwd )

STACK_CONTAINER_BUILD_WORK_DIR=${STACK_CONTAINER_BUILD_WORK_DIR:-$REPO_ROOT}
STACK_CONTAINER_BUILD_CONTAINERFILE=${STACK_CONTAINER_BUILD_CONTAINERFILE:-$REPO_ROOT/backend/Dockerfile}
STACK_CONTAINER_BUILD_TAG=${STACK_CONTAINER_BUILD_TAG:-robotmoney/api:stack}

docker build -t $STACK_CONTAINER_BUILD_TAG ${build_command_args} \
  -f $STACK_CONTAINER_BUILD_CONTAINERFILE $STACK_CONTAINER_BUILD_WORK_DIR
rc=$?
if [ $rc -ne 0 ]; then
  echo "BUILD FAILED" 1>&2
  exit $rc
fi
