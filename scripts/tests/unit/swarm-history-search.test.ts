// The subject history's search box: dates as the page prints them are sent
// as the API stores them, and everything else as typed.
import { describe, expect, test } from "bun:test";
import { historySearchTerm } from "../../../frontend/public/assets/js/app/alpine/static-views.js";

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
