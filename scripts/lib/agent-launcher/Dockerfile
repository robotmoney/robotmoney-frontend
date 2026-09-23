# The agent-launcher image (issue #1012) — a Bun runtime plus a Docker CLIENT,
# and nothing else. It runs scripts/agent/agent-launcher.ts, whose whole job is
# to turn one narrow internal HTTP request into one short-lived judge container
# on the SAME rail a member agent rides.
#
# NO DAEMON IS INSTALLED HERE. The client talks to the HOST's daemon over the
# socket compose binds in; this image must never grow `dockerd`, and the service
# must never gain a published port (docker-compose.yml's agent-launcher block
# explains why the socket is concentrated on exactly one service).
#
# The Docker CLI and the compose plugin are COPIED OUT OF THE OFFICIAL PINNED
# IMAGE rather than installed from an apt repository. That keeps the version a
# reviewable literal in this file — an unpinned `apt-get install docker-ce-cli`
# would silently change the tool that builds every judge container's argv, and
# `docker compose run`'s flag surface is exactly what buildMemberAgentArgv()
# assumes.
FROM docker:28.3-cli AS docker-cli

FROM oven/bun:1.3.5

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose \
     /usr/local/libexec/docker/cli-plugins/docker-compose

WORKDIR /app

# WHY THE COMPOSE FILES ARE IN THE IMAGE: the launcher starts judge containers
# with `docker compose -p <project> -f docker-compose.yml … run member-agent`,
# so it needs the same topology description the stack was brought up from. They
# are copied (not mounted) so the launcher cannot be pointed at a compose file
# nobody reviewed.
COPY package.json tsconfig.json ./
COPY docker-compose.yml docker-compose.smoke.yml docker-compose.stage.yml ./

# scripts/ plus ONE backend leaf: no contract, no frontend, no database client.
# The launcher's whole dependency set is scripts/agent/*, scripts/stack/config.ts
# and scripts/lib/*, all of which import nothing outside node: builtins, plus
# backend/src/swarm/judge-launcher.ts — a dependency-free file holding the route
# and port both ends of this contract read, so a renamed route cannot leave the
# worker posting judgings at a 404. There is deliberately no `bun install` step:
# a launcher with no third-party runtime dependency is a launcher with no
# third-party supply chain on the one host process that holds the Docker socket.
COPY scripts ./scripts
COPY backend/src/swarm/judge-launcher.ts ./backend/src/swarm/judge-launcher.ts

# The shared spool directory. docker-compose.yml binds a HOST directory over
# this same path so a `-v` source written here resolves identically for the
# daemon — see scripts/agent/judge-agent.ts's header.
ENV SWARM_LAUNCHER_SPOOL_DIR=/tmp/rm-agent-launcher
RUN mkdir -p /tmp/rm-agent-launcher

EXPOSE 8799
CMD ["bun", "run", "scripts/agent/agent-launcher.ts"]
