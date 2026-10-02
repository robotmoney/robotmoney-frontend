// The parity sweep runs inside one API request and outlives the api's 10 s idle
// timeout on a production-sized ledger. src/api/index.ts boots a server on
// import, so this reads the source rather than importing it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "api", "index.ts"), "utf8");

test("the parity-sweep request gets its own timeout, below Bun's 255 s cap", () => {
  const m = /PARITY_SWEEP_REQUEST_TIMEOUT_S = (\d+);/.exec(src);
  expect(m).not.toBeNull();
  const seconds = Number(m![1]);
  expect(seconds).toBeGreaterThan(10);
  expect(seconds).toBeLessThanOrEqual(255);
  expect(src).toContain('pathname === ROUTES.analytics.paritySweep && req.method === "POST"');
  expect(src).toContain("server.timeout(req, PARITY_SWEEP_REQUEST_TIMEOUT_S)");
});

test("it is set before any routing, and the slow-request log uses the same limit", () => {
  expect(src.indexOf("server.timeout(req, PARITY_SWEEP_REQUEST_TIMEOUT_S)")).toBeLessThan(src.indexOf('if (req.method === "OPTIONS")'));
  expect(src).toContain("limitMs: PARITY_SWEEP_REQUEST_TIMEOUT_S * 1000");
});
