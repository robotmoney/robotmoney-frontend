// known-db-write-500 (issue 1035, fixed in 0.5.2) excuses only a 5xx on the
// analytics write routes. A 4xx is the api rejecting a payload, so it stays
// unclassified and fails the gate on its own merits (issue 1413: FRED's
// maintenance page parsed into points the api answered with HTTP 400).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const SOURCE = "rm_prod_stack-worker-analytics-1";
const groupsOf = (lines: string[]) => classify(inventory(SOURCE, lines.map((text) => ({ ts: null, text }))), committed);

const write = (route: string, status: string) => `[extract] FRED UMCSENT FAILED: analytics API POST /api/analytics/${route} failed: HTTP ${status}`;

describe("known-db-write-500 matches a 5xx on the analytics write routes", () => {
  for (const route of ["source-acquisitions", "telemetry", "vintages"]) {
    for (const status of ["500", "503"]) {
      test(`${route} HTTP ${status}`, () => {
        expect(groupsOf([write(route, status)])[0]!.rule?.id).toBe("known-db-write-500");
      });
    }
  }
});

describe("RED CONTROLS: a 4xx on the analytics write routes is not excused", () => {
  const PROD_400 = `${write("source-acquisitions", "400")} — {"error":"values[0] must have exactly one market time"}`;

  test("the 2026-10-21 FRED HTTP 400 line is unclassified", () => {
    expect(groupsOf([PROD_400])[0]!.rule).toBeNull();
  });

  test("it fails the post-release gate as an unclassified error, not as the 0.5.2 known issue", () => {
    const v = inventoryVerdict(groupsOf([PROD_400]), "post-release", "v0.6.3");
    expect(v.unclassifiedErrors).toBe(1);
    expect(v.failures.join("\n")).not.toContain("known-db-write-500");
  });

  test("other 4xx statuses are unclassified on every write route", () => {
    for (const route of ["source-acquisitions", "telemetry", "vintages"]) {
      for (const status of ["404", "409", "422"]) {
        expect(groupsOf([write(route, status)])[0]!.rule).toBeNull();
      }
    }
  });
});
