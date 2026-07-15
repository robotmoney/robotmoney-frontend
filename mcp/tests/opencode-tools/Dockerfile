FROM oven/bun:1.3.5 AS dependencies

WORKDIR /app
COPY contract/ /contract/
COPY mcp/package.json mcp/bun.lock* /app/
RUN bun install --frozen-lockfile

FROM dependencies AS service
COPY mcp/ /app/

FROM dependencies AS agent
# OpenCode >= 1.18.x performs headless inference and MCP tool calls in a
# non-Git working directory; 1.16.2 silently emitted only `step_start` there,
# which forced a `git init /app` workaround (removed by issue #131).
ARG OPENCODE_VERSION=1.18.1
ARG OPENCODE_LINUX_X64_SHA256=9ecce27cf529ade5f177fab478b4876b5c31d9ddc8216b994816acf192159511
ARG RMPC_VERSION=v0.3.2
ARG RMPC_LINUX_X64_SHA256=56342cba710ac4053b6ae9fd68f02cc15a5ff6ddb978e2581da54084d3a704e4
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSLo /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
    && echo "${OPENCODE_LINUX_X64_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin \
    && curl -fsSLo /tmp/rmpc.tar.gz \
      "https://github.com/robotmoney/robotmoney-core/releases/download/${RMPC_VERSION}/rmpc-${RMPC_VERSION}-linux-amd64.tar.gz" \
    && echo "${RMPC_LINUX_X64_SHA256}  /tmp/rmpc.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/rmpc.tar.gz -C /usr/local/bin rmpc \
    && chmod +x /usr/local/bin/rmpc \
    && rm /tmp/opencode.tar.gz /tmp/rmpc.tar.gz
COPY mcp/ /app/
COPY mcp/tests/opencode-tools/opencode.json /app/opencode.json
