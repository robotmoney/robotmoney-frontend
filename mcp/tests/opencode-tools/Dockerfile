FROM oven/bun:1.3.5 AS dependencies

WORKDIR /app
COPY contract/ /contract/
COPY mcp/package.json mcp/bun.lock* /app/
RUN bun install --frozen-lockfile

FROM dependencies AS service
COPY mcp/ /app/

FROM dependencies AS agent
ARG OPENCODE_VERSION=1.16.2
ARG OPENCODE_LINUX_X64_SHA256=06a79c5bb7f8d01716b2440712cf67facd36db59188809aeb232374b206bd429
# Temporary compatibility workaround tracked by
# https://github.com/robotmoney/robotmoney-frontend/issues/131. OpenCode supports
# non-Git projects, but this pinned CLI/model currently returns no headless text
# or tool calls until the working directory is initialized as a repository.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSLo /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
    && echo "${OPENCODE_LINUX_X64_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin \
    && rm /tmp/opencode.tar.gz
COPY mcp/ /app/
COPY mcp/tests/opencode-tools/opencode.json /app/opencode.json
RUN git init /app
