// The parity sweep runs inside one API request, and on a production-sized
// ledger it outlived Bun's ~10 s default idle timeout: the socket was cut, the
// worker's analytics.parity_sweep went DEAD (24 in 24 h in production,
// 2026-09-25). src/api/index.ts boots a server on import, so this reads the
// source rather than importing it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "api", "index.ts"), "utf8");

test("the parity-sweep request gets its own idle timeout, below Bun's 255 s cap", () => {
  const m = /PARITY_SWEEP_REQUEST_TIMEOUT_S = (\d+);/.exec(src);
  expect(m).not.toBeNull();
  const seconds = Number(m![1]);
  expect(seconds).toBeGreaterThan(10);
  expect(seconds).toBeLessThanOrEqual(255);
  expect(src).toContain(
    'if (pathname === ROUTES.analytics.paritySweep && req.method === "POST") server.timeout(req, PARITY_SWEEP_REQUEST_TIMEOUT_S);',
  );
});

test("it is set before any routing, so no earlier return can skip it", () => {
  expect(src.indexOf("server.timeout(req, PARITY_SWEEP_REQUEST_TIMEOUT_S)"))
    .toBeLessThan(src.indexOf('if (req.method === "OPTIONS")'));
});
