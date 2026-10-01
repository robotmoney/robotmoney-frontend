// THE PAID COINGECKO KEY MUST REACH THE STACK THROUGH THE DOCUMENTED BOOT
// (issue #1047). Both compose files interpolate COINGECKO_API_KEY into the
// worker lanes, but `bun smoke` / `bun run smoke:stage` build the compose
// environment from DEMO_COMPOSE_PASSTHROUGH. Without the entry an exported key
// became an EMPTY variable in the container and projects.refresh_coins stayed
// on the keyless public tier. Same gap and fix shape as the judge settings in
// smoke-judge-passthrough.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_COMPOSE_PASSTHROUGH, smokePassthroughEnv } from "../../lib/smoke-compose-passthrough.ts";

describe("COINGECKO_API_KEY reaches the stack through the documented boot", () => {
  test("COINGECKO_API_KEY is on DEMO_COMPOSE_PASSTHROUGH", () => {
    expect(DEMO_COMPOSE_PASSTHROUGH as readonly string[]).toContain("COINGECKO_API_KEY");
  });

  test("an exported key is forwarded to the compose environment", () => {
    const out = smokePassthroughEnv({ COINGECKO_API_KEY: "cg-unit-key" });
    expect(out.COINGECKO_API_KEY).toBe("cg-unit-key");
  });

  test("an unset or blank key is omitted, so the compose default (blank) stands", () => {
    expect(smokePassthroughEnv({})).not.toHaveProperty("COINGECKO_API_KEY");
    expect(smokePassthroughEnv({ COINGECKO_API_KEY: "" })).not.toHaveProperty("COINGECKO_API_KEY");
  });

  // Issue 1062: the analytics-producer makes the GeckoTerminal new_pools calls, so the key has to reach IT as well.
  for (const file of ["docker-compose.yml"]) {
    test(`${file} interpolates COINGECKO_API_KEY into analytics-producer`, () => {
      const text = readFileSync(join(import.meta.dir, "../../..", file), "utf8");
      const start = text.indexOf("\n  analytics-producer:");
      expect(start).toBeGreaterThan(-1);
      const next = text.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/);
      const block = text.slice(start, next === -1 ? undefined : start + 1 + next);
      expect(block).toContain("COINGECKO_API_KEY: ${COINGECKO_API_KEY:-}");
    });
  }
});
