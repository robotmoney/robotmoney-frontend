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

import { REGIME_WEIGHT_REFRESH, isRefreshDate, refreshDateOn } from "../src/analyze/regime-versions.ts";

describe("REGIME_WEIGHT_REFRESH (issue 1739)", () => {
  test("only v3 refits on the run's last day", () => {
    expect(REGIME_WEIGHT_REFRESH.v3.refitOnLastDay).toBe(true);
    expect(REGIME_WEIGHT_REFRESH.v4.refitOnLastDay).toBe(false);
    for (const v of REGIME_VERSIONS) if (v !== "v3") expect(REGIME_WEIGHT_REFRESH[v].refitOnLastDay, v).toBe(false);
  });

  const r = REGIME_WEIGHT_REFRESH.v4;
  test("the anchor day is a refresh date", () => {
    expect(refreshDateOn("2018-01-01", r)).toBe("2018-01-01");
    expect(isRefreshDate("2018-01-01", r)).toBe(true);
  });
  test("days between refits take the prior refresh date", () => {
    expect(refreshDateOn("2018-01-21", r)).toBe("2018-01-01");
    expect(refreshDateOn("2018-01-22", r)).toBe("2018-01-22");
    expect(isRefreshDate("2018-01-22", r)).toBe(true);
    expect(isRefreshDate("2018-01-23", r)).toBe(false);
    expect(refreshDateOn("2018-02-11", r)).toBe("2018-01-22");
  });
  test("a day before the anchor has no refresh date", () => {
    expect(refreshDateOn("2017-12-31", r)).toBeNull();
    expect(isRefreshDate("2017-12-31", r)).toBe(false);
  });
  test("a leap-year span counts real calendar days", () => {
    // 2018-01-01 + 777 days (37 x 21) is 2020-02-17, counting 2020-02-29.
    expect(refreshDateOn("2020-03-01", r)).toBe("2020-02-17");
    expect(isRefreshDate("2020-02-17", r)).toBe(true);
    expect(refreshDateOn("2020-03-09", r)).toBe("2020-03-09");
  });
});

import { AdoptionDateError, REGIME_ADOPTION_DATE, adoptionDate } from "../src/analyze/regime-versions.ts";

describe("adoption date per version (issue 1734, D94)", () => {
  test("every entry of REGIME_VERSIONS declares an ISO adoption date, in order", () => {
    let prev = "";
    for (const v of REGIME_VERSIONS) {
      const d = adoptionDate(v);
      expect(d, v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d > prev, `${v} adopted after the version before it`).toBe(true);
      prev = d;
    }
    expect(Object.keys(REGIME_ADOPTION_DATE).sort()).toEqual([...REGIME_VERSIONS].sort());
  });

  test("the loader throws a named error for a version without one", () => {
    expect(() => adoptionDate("v99")).toThrow(AdoptionDateError);
    try {
      adoptionDate("v99");
    } catch (e) {
      expect((e as Error).name).toBe("AdoptionDateError");
      expect((e as Error).message).toContain("v99");
    }
  });
});
