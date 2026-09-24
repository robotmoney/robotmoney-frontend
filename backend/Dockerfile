# Build context is the repo ROOT so we can include the file: contract dependency.
# No bundler: Bun runs the TypeScript sources directly.
FROM oven/bun:1.3.5

# Snapshot producers may use only this explicit build/runtime identity. An
# omitted build arg remains the empty string and is persisted as unavailable;
# application code never substitutes a package version or build timestamp.
ARG AUM_PRODUCER_REVISION
ENV AUM_PRODUCER_REVISION=$AUM_PRODUCER_REVISION

# THE IMAGE'S OWN IDENTITY (AC-ID-03), baked here and reported at /version and
# /health. Same rule as the line above and for the same reason: an omitted arg
# stays the empty string and is reported as `unavailable` rather than being
# filled in from a package version, a timestamp or a branch name. Nothing reads
# git at runtime — there is no repository in this image, and a container that
# shelled out to `git` on a staging host would report the identity of the
# unpinned checkout beside it, which is the exact condition AC-ID-03 detects.
ARG RM_BUILD_COMMIT
ENV RM_BUILD_COMMIT=$RM_BUILD_COMMIT
ARG RM_BUILD_TAG
ENV RM_BUILD_TAG=$RM_BUILD_TAG

WORKDIR /app

# Install backend deps with the contract resolvable at ../contract.
COPY contract/ /contract/
COPY backend/package.json backend/bun.lock* /app/
RUN bun install

COPY backend/ /app/

# `system-scheduler` ships from this image too (issue #1026 W4). It is NOT a
# backend module and deliberately cannot be one: scheduler spec §7 forbids it a
# database credential, and `backend/src/config.ts` requires DATABASE_URL at
# module scope, so anything living under `backend/` would acquire one by import.
# It therefore lives in `scripts/` and is copied in explicitly.
#
# ONLY these two paths, not `scripts/` wholesale. The rest of `scripts/` is
# operator tooling — it reaches Docker, reads `~/.env`, and holds the smoke
# driver — and none of it belongs inside a running container. A blanket
# `COPY scripts/` would put the deployment tooling in the image it deploys.
#
# The entrypoint imports `./lib/system-scheduler/*.ts` relatively, so the two
# paths have to keep their shape under /app.
COPY scripts/system-scheduler.ts /app/scripts/
COPY scripts/lib/system-scheduler/ /app/scripts/lib/system-scheduler/

# Overridden by compose command (api vs worker vs system-scheduler).
CMD ["bun", "run", "src/api/index.ts"]
