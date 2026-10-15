// The parity sweep used to run inside one api request and outlive Bun's ~10 s
// idle timeout on a production-sized ledger, so src/api/index.ts lifted the
// limit to 240 s for that one route (production, 2026-09-25). Issue 1375 makes
// each request one bounded statement for one domain, and the exemption is
// gone: the parity route keeps the api's 10 s limit like every other route
// (smoke-production-spec section 3). src/api/index.ts boots a server on
// import, so this reads the source rather than importing it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "api", "index.ts"), "utf8");

test("the api carries no parity-sweep timeout constant", () => {
  expect(src).not.toContain("PARITY_SWEEP_REQUEST_TIMEOUT_S");
});

test("no route gets its own request timeout: every request keeps API_IDLE_TIMEOUT_SECONDS", () => {
  expect(src).not.toMatch(/server\.timeout\(/);
  expect(src).toContain("idleTimeout: API_IDLE_TIMEOUT_SECONDS");
});
