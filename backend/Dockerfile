# Build context is the repo ROOT so we can include the file: contract dependency.
# No bundler: Bun runs the TypeScript sources directly.
FROM oven/bun:1.3.5

WORKDIR /app

# Install backend deps with the contract resolvable at ../contract.
COPY contract/ /contract/
COPY backend/package.json backend/bun.lock* /app/
RUN bun install

COPY backend/ /app/

# Overridden by compose command (api vs worker).
CMD ["bun", "run", "src/api/index.ts"]
