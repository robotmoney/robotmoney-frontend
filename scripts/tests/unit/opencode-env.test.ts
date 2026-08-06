import { describe, expect, test } from "bun:test";
import { opencodeTimeoutEnv } from "../../lib/opencode-env.ts";
import { participateTimeoutMs } from "../../lib/swarm/agent.ts";

describe("OpenCode timeout environment", () => {
  test("omits missing and blank values instead of creating a zero timeout", () => {
    expect(opencodeTimeoutEnv({})).toEqual({});
    expect(opencodeTimeoutEnv({ OPENCODE_TIMEOUT_MS: "  " })).toEqual({});
    expect(participateTimeoutMs({})).toBe(300_000);
    expect(participateTimeoutMs({ OPENCODE_TIMEOUT_MS: "" })).toBe(300_000);
  });

  test("preserves a configured timeout for the inner and outer bounds", () => {
    expect(opencodeTimeoutEnv({ OPENCODE_TIMEOUT_MS: " 300000 " })).toEqual({ OPENCODE_TIMEOUT_MS: "300000" });
    expect(participateTimeoutMs({ OPENCODE_TIMEOUT_MS: "300000" })).toBe(480_000);
  });

  test("rejects malformed bounds instead of turning them into instant or unbounded timers", () => {
    for (const value of ["0", "-2", "1.5", "not-a-number", "Infinity"]) {
      expect(() => opencodeTimeoutEnv({ OPENCODE_TIMEOUT_MS: value })).toThrow(/positive integer/);
      expect(() => participateTimeoutMs({ OPENCODE_TIMEOUT_MS: value })).toThrow(/positive integer/);
    }
  });
});
