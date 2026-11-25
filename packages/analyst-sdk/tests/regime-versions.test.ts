// Decision D88: methodology tags are consecutive (v3, v4, ...) with no gaps.
// Decision D96 (issue 1753) amends D88 item 2: the current version is the last
// one declared main, and a version computed beside it (v5) is listed after it.
import { describe, expect, test } from "bun:test";
import {
  BESIDE_REGIME_VERSIONS, CURRENT_REGIME_VERSION, REGIME_COMPOSITE_NORMALISATION, REGIME_KEPT_HISTORY, REGIME_KNOWLEDGE_TIME, REGIME_LABEL_CUT,
  REGIME_LINE, REGIME_LOOKBACK, REGIME_MISSING_PANEL, REGIME_OBSERVATION_WINDOWS, REGIME_RULES, REGIME_VERSIONS,
} from "../src/analyze/regime-versions.ts";
import { INDICATORS, REGIME_DERIVED_SERIES, REGIME_REGISTRY } from "../src/analyze/indicators.ts";
import { REGIME_BACKTEST_RULES } from "../src/analyze/backtest.ts";

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

  test("the versions are v3, v4, v5", () => {
    expect([...REGIME_VERSIONS]).toEqual(["v3", "v4", "v5"]);
  });

  // Decision D96 amends D88 item 2: a version computed beside the served one is listed after it.
  test("CURRENT_REGIME_VERSION is v4, the last version declared main; v5 is declared beside", () => {
    expect(REGIME_LINE).toEqual({ v3: "main", v4: "main", v5: "beside" });
    expect(CURRENT_REGIME_VERSION).toBe("v4");
    const main = REGIME_VERSIONS.filter((v) => REGIME_LINE[v] === "main");
    expect(CURRENT_REGIME_VERSION).toBe(main[main.length - 1]!);
    expect(BESIDE_REGIME_VERSIONS).toEqual(["v5"]);
    // Every beside version is listed after every main one.
    expect(REGIME_VERSIONS.map((v) => REGIME_LINE[v])).toEqual(["main", "main", "beside"]);
  });
});

describe("every per-version table has a v5 row (issue 1753)", () => {
  const tables = {
    REGIME_LINE, REGIME_LOOKBACK, REGIME_WEIGHT_REFRESH, REGIME_KNOWLEDGE_TIME, REGIME_OBSERVATION_WINDOWS, REGIME_MISSING_PANEL,
    REGIME_COMPOSITE_NORMALISATION, REGIME_KEPT_HISTORY, REGIME_ADOPTION_DATE, REGIME_LABEL_CUT, REGIME_RULES, REGIME_REGISTRY,
    REGIME_DERIVED_SERIES, REGIME_BACKTEST_RULES,
  };
  for (const [name, table] of Object.entries(tables)) {
    test(`${name} declares exactly the versions of REGIME_VERSIONS`, () => {
      expect(Object.keys(table).sort()).toEqual([...REGIME_VERSIONS].sort());
    });
  }

  test("the v5 rows state the rules of the model", () => {
    expect(REGIME_KNOWLEDGE_TIME.v5).toBe(false);
    expect(REGIME_OBSERVATION_WINDOWS.v5).toBe(false);
    expect(REGIME_WEIGHT_REFRESH.v5).toEqual({ intervalDays: 1, anchor: "2018-01-01", refitOnLastDay: false });
    expect(REGIME_MISSING_PANEL.v5).toBe("rebase");
    expect(REGIME_LABEL_CUT.v5).toBe("series");
    expect(REGIME_LOOKBACK.v5).toEqual({ rank: { kind: "trailing", days: 1095 }, weight: { kind: "trailing", days: 1095 }, percentile: { kind: "inception" } });
    expect(REGIME_COMPOSITE_NORMALISATION.v5).toBe("percentile");
    expect(REGIME_KEPT_HISTORY.v5).toBe(true);
    expect(adoptionDate("v5")).toBe("2026-11-23");
    expect(REGIME_RULES.v5).toEqual({
      knowledgeTime: false,
      observationWindows: false,
      weightRefresh: REGIME_WEIGHT_REFRESH.v5,
      missingPanel: "rebase",
      labelCut: "series",
      lookback: REGIME_LOOKBACK.v5,
      adoptionDate: "2026-11-23",
      compositeNormalisation: "percentile",
      keptHistory: true,
    });
    // Every day is a refresh date, so no fit is tied to the run's last day.
    expect(isRefreshDate("2026-11-16", REGIME_WEIGHT_REFRESH.v5)).toBe(true);
    expect(isRefreshDate("2018-01-02", REGIME_WEIGHT_REFRESH.v5)).toBe(true);
  });

  test("v3 and v4 keep the rules they had: no normalisation, no kept history", () => {
    for (const v of ["v3", "v4"] as const) {
      expect(REGIME_COMPOSITE_NORMALISATION[v]).toBe("none");
      expect(REGIME_KEPT_HISTORY[v]).toBe(false);
      expect(REGIME_REGISTRY[v]).toBe(INDICATORS);
      expect(REGIME_DERIVED_SERIES[v]).toEqual([]);
    }
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
