// Decision D88: methodology tags are consecutive (v3, v4, ...) with no gaps,
// and the current version is the last one listed.
import { describe, expect, test } from "bun:test";
import { CURRENT_REGIME_VERSION, REGIME_VERSIONS } from "../src/analyze/regime-versions.ts";

describe("REGIME_VERSIONS (D88)", () => {
  test("starts at v3 and steps by one with no gaps", () => {
    const nums = REGIME_VERSIONS.map((v) => {
      const m = /^v(\d+)$/.exec(v);
      expect(m, `bad tag ${v}`).not.toBeNull();
      return Number(m![1]);
    });
    expect(nums[0]).toBe(3);
    nums.forEach((n, i) => expect(n).toBe(3 + i));
    expect(nums).toContain(4);
  });

  test("CURRENT_REGIME_VERSION is the last entry", () => {
    expect(CURRENT_REGIME_VERSION).toBe(REGIME_VERSIONS[REGIME_VERSIONS.length - 1]!);
  });
});
