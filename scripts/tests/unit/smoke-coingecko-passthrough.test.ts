// THE PAID COINGECKO KEY MUST REACH THE STACK THROUGH THE DOCUMENTED BOOT
// (issue #1047). Both compose files interpolate COINGECKO_API_KEY into the
// worker lanes, but `bun smoke` / `bun run smoke:stage` build the compose
// environment from DEMO_COMPOSE_PASSTHROUGH. Without the entry an exported key
// became an EMPTY variable in the container and projects.refresh_coins stayed
// on the keyless public tier. Same gap and fix shape as the judge settings in
// smoke-judge-passthrough.test.ts.
import { describe, expect, test } from "bun:test";
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
});
