# Build context is the repo ROOT (for the file: contract dependency). No bundler.
FROM oven/bun:1
WORKDIR /app
COPY contract/ /contract/
COPY mcp/package.json mcp/bun.lock* /app/
RUN bun install
COPY mcp/ /app/
CMD ["bun", "run", "src/server.ts"]
