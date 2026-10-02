// The analyst SDK README is the public API's front door (issue #1095, D58), so
// it must not name a route the contract does not have, and must not leave one
// out. Mechanical link check, no network and no database:
//   - every /api/public/analytics/ path the README mentions is a route in
//     contract/ (ROUTES.publicAnalytics), and has a JSON schema file there;
//   - every route in contract/ is listed in the README with a curl example;
//   - the README carries the CSV header, the shallow-clone command, the pointer
//     to the dashboards endpoint for regime outputs, and the data terms for
//     Yahoo (served, operator sign-off in D58).
//
// RED CONTROL: the checker is also run on a README with a route the contract
// lacks, and on one with a route missing, and must flag both.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ANALYTICS_SCHEMAS } from "../../../contract/src/public-analytics.js";
import { ROUTES } from "../../../contract/src/routes.js";

const root = join(import.meta.dir, "../../..");
const README = readFileSync(join(root, "packages/analyst-sdk/README.md"), "utf8");
const contractRoutes: string[] = Object.values(ROUTES.publicAnalytics);

/** Every distinct /api/public/analytics/<segment> path in the text. */
function listedRoutes(text: string): string[] {
  return [...new Set([...text.matchAll(/\/api\/public\/analytics\/[a-z][a-z-]*/g)].map((m) => m[0]))].sort();
}

/** Problems with a README against a route list: unknown routes, unlisted routes, routes with no curl line. */
function linkProblems(text: string, routes: readonly string[]): string[] {
  const listed = listedRoutes(text);
  const problems: string[] = [];
  for (const r of listed) if (!routes.includes(r)) problems.push(`README names ${r}, which contract/ does not have`);
  for (const r of routes) {
    if (!listed.includes(r)) problems.push(`contract/ has ${r}, which the README does not list`);
    else if (!new RegExp(`curl[^\\n]*${r.replaceAll("/", "\\/")}`).test(text)) problems.push(`README has no curl example for ${r}`);
  }
  return problems;
}

describe("packages/analyst-sdk/README.md", () => {
  test("lists exactly the contract's public analytics routes, each with a curl example", () => {
    expect(contractRoutes.length).toBe(4);
    expect(linkProblems(README, contractRoutes)).toEqual([]);
  });

  test("every listed route has a schema file in contract/, requiring schemaVersion", () => {
    for (const route of listedRoutes(README)) {
      const rel = (PUBLIC_ANALYTICS_SCHEMAS as Record<string, string>)[route];
      expect(rel, `no schema registered for ${route}`).toBeTruthy();
      const file = join(root, "contract/src", rel!);
      expect(existsSync(file), file).toBe(true);
      const schema = JSON.parse(readFileSync(file, "utf8"));
      expect(schema.required).toContain("schemaVersion");
      expect(schema.properties.schemaVersion).toEqual({ const: 1 });
    }
    expect(Object.keys(PUBLIC_ANALYTICS_SCHEMAS).sort()).toEqual([...contractRoutes].sort());
  });

  test("carries the CSV header, the shallow-clone command, the regime pointer and the Yahoo sign-off", () => {
    expect(README).toContain("date,indicator,value,source");
    expect(README).toContain("git clone --depth 1 --filter=blob:none --sparse");
    expect(README).toContain("git sparse-checkout set packages/analyst-sdk");
    expect(README).toContain("GET /api/dashboards/regime-snapshots?include=backtest");
    expect(README).toContain("### Data terms");
    expect(README).toContain("Yahoo-sourced rows are served");
    expect(README).toContain("2026-10-02");
    expect(README).not.toMatch(/withheld|excludedProviders|are never served/i);
  });

  test("RED CONTROL: a README naming a route the contract lacks, or missing one, is flagged", () => {
    const planted = README.replaceAll("/api/public/analytics/vintages", "/api/public/analytics/vintagez");
    const problems = linkProblems(planted, contractRoutes);
    expect(problems.some((p) => p.includes("vintagez") && p.includes("does not have"))).toBe(true);
    expect(problems.some((p) => p.includes("/api/public/analytics/vintages") && p.includes("does not list"))).toBe(true);

    const noCurl = README.replaceAll(/curl[^\n]*\/api\/public\/analytics\/asset-prices[^\n]*\n/g, "");
    expect(linkProblems(noCurl, contractRoutes).some((p) => p.includes("no curl example for /api/public/analytics/asset-prices"))).toBe(true);
  });
});
