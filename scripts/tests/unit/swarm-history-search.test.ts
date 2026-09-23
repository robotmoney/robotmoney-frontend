// The subject history's search box: dates as the page prints them are sent
// as the API stores them, and everything else as typed.
import { describe, expect, test } from "bun:test";
import { historySearchTerm, withoutFixtureReadings } from "../../../frontend/public/assets/js/app/alpine/static-views.js";

describe("historySearchTerm", () => {
  test("a date as the page prints it becomes the stored form", () => {
    expect(historySearchTerm("Aug 3, 2026")).toBe("2026-08-03");
    expect(historySearchTerm("3 August 2026")).toBe("2026-08-03");
    expect(historySearchTerm("Sept 15")).toBe("09-15");
    expect(historySearchTerm("aug 3rd")).toBe("08-03");
    expect(historySearchTerm("Aug 2026")).toBe("2026-08");
    expect(historySearchTerm("August")).toBe("-08-");
  });
  test("anything else goes as typed", () => {
    expect(historySearchTerm("2026-08-03")).toBe("2026-08-03");
    expect(historySearchTerm("market")).toBe("market");
    expect(historySearchTerm("RWA")).toBe("RWA");
    expect(historySearchTerm("on-chain demand")).toBe("on-chain demand");
    expect(historySearchTerm("Aug 42")).toBe("Aug 42");
    expect(historySearchTerm("")).toBe("");
  });
});

// A portfolio's recorded readings without the smoke fixture's baskets (#1030):
// the fixture writes no wallets, and a genuine reading lists what it read.
describe("recorded readings without the fixture's baskets", () => {
  const genuine = (date: string) => ({ date, total_value_usd: 100, wallets: [{ label: "primary" }], positions: [{ token: "WETH" }] });
  const fixture = (date: string) => ({ date, total_value_usd: 46447.86, wallets: [], positions: [{ token: "ROBOT" }] });
  test("drops a reading with no wallets when the others list theirs", () => {
    expect(withoutFixtureReadings([genuine("2026-08-03"), genuine("2026-08-04"), fixture("2026-08-06")]).map((s) => s.date)).toEqual(["2026-08-03", "2026-08-04"]);
  });
  test("keeps everything for a subject whose readings never list wallets", () => {
    const bare = [{ date: "2026-08-01" }, { date: "2026-08-02" }];
    expect(withoutFixtureReadings(bare)).toEqual(bare);
  });
});
