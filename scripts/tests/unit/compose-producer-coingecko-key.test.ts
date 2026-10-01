// Issue 1062: the analytics-producer makes the GeckoTerminal new_pools calls, so the paid CoinGecko key has to reach IT
// (compose passed it to the worker lanes only). On this branch the worker lanes need it too (issue #1047, which adds it
// on main, is not here), for the token-price and pool lookups.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { smokePassthroughEnv } from "../../lib/smoke-compose-env.ts";

for (const file of ["docker-compose.yml", "docker-compose.smoke.yml"]) {
  test(`${file} interpolates COINGECKO_API_KEY into analytics-producer`, () => {
    const text = readFileSync(join(import.meta.dir, "../../..", file), "utf8");
    const start = text.indexOf("\n  analytics-producer:");
    expect(start).toBeGreaterThan(-1);
    const next = text.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/);
    const block = text.slice(start, next === -1 ? undefined : start + 1 + next);
    expect(block).toContain("COINGECKO_API_KEY: ${COINGECKO_API_KEY:-}");
  });
}

test("docker-compose.yml passes COINGECKO_API_KEY to the worker lanes", () => {
  const text = readFileSync(join(import.meta.dir, "../../..", "docker-compose.yml"), "utf8");
  const start = text.indexOf("x-worker-env: &worker-env");
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf("\n\n", start + 1) === -1 ? undefined : text.indexOf("\nx-", start + 1);
  const block = text.slice(start, end === -1 ? undefined : end);
  expect(block).toContain("COINGECKO_API_KEY: ${COINGECKO_API_KEY:-}");
});

test("docker-compose.smoke.yml passes COINGECKO_API_KEY to the worker lanes (the shared smoke-worker anchor)", () => {
  const text = readFileSync(join(import.meta.dir, "../../..", "docker-compose.smoke.yml"), "utf8");
  const start = text.indexOf("\n  worker-swarm: &smoke-worker");
  expect(start).toBeGreaterThan(-1);
  const next = text.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/);
  const block = text.slice(start, next === -1 ? undefined : start + 1 + next);
  expect(block).toContain("COINGECKO_API_KEY: ${COINGECKO_API_KEY:-}");
});

// The driver builds the compose environment from an allowlist (DEMO_COMPOSE_PASSTHROUGH). A name not on it never reaches a
// container, however compose interpolates it.
test("an exported COINGECKO_API_KEY is forwarded to the compose environment, and a blank one is not", () => {
  expect(smokePassthroughEnv({ COINGECKO_API_KEY: "cg-unit-key" }).COINGECKO_API_KEY).toBe("cg-unit-key");
  expect(smokePassthroughEnv({ COINGECKO_API_KEY: "cg-unit-key" }, { external: true }).COINGECKO_API_KEY).toBe("cg-unit-key");
  expect(smokePassthroughEnv({})).not.toHaveProperty("COINGECKO_API_KEY");
  expect(smokePassthroughEnv({ COINGECKO_API_KEY: "" })).not.toHaveProperty("COINGECKO_API_KEY");
});
