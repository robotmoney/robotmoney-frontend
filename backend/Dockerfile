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
# The pure regime compute lives in packages/analyst-sdk (issue #1095) and the
# backend re-exports it through shims at the old analytics/ paths. From
# /app/src/analytics/<dir>/ the shims reach `../../../../packages/analyst-sdk`,
# which is /packages/analyst-sdk here, the same way contract/ sits at /contract.
# src and package.json only: tests/ (fixtures, goldens, ~4.7 MB) are not runtime.
COPY packages/analyst-sdk/package.json /packages/analyst-sdk/package.json
COPY packages/analyst-sdk/src/ /packages/analyst-sdk/src/
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

# The STANDING PARTICIPANT ships from this image too (smoke spec §6.2, issue
# #1026): one container per credential-file entry, started by `bun smoke`'s
# `participants` phase with `bun run scripts/agent/participant/main.ts`, which
# routes an agent to its poll loop and a judge to its subscription. Like the
# scheduler it holds no database credential (it refuses one at startup), so it
# lives in `scripts/`, not in `backend/src/` whose config demands one.
#
# ONLY the participant's own directory and the one library it imports at run
# time (the credential-key list its startup check refuses by). Its other
# `scripts/lib` imports are `import type`, which Bun erases.
#
# The judge client reads the server's own prompt and digest from
# `backend/src/swarm/judge.ts` by its repository path: from
# /app/scripts/agent/participant, `../../../backend/...` is /app/backend/...,
# so the one symlink below gives that path its meaning here — /app/backend is
# this image's /app, the same sources, never a second copy that could drift.
COPY scripts/agent/participant/ /app/scripts/agent/participant/
COPY scripts/lib/db-credential-keys.ts /app/scripts/lib/db-credential-keys.ts
RUN ln -s . /app/backend

# Overridden by compose command (api vs worker vs system-scheduler vs participant).
CMD ["bun", "run", "src/api/index.ts"]
