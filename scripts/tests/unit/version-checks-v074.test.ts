import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_MARKERS, siteMarkerProblems } from "../../release/version-checks/v0.7.4/public-surface.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("v0.7.4 public-surface check (PRs 1588, 1589, 1590, 1594)", () => {
  test("every site PR in scope has a marker", () => {
    expect([...new Set(SITE_MARKERS.map((m) => m.pr))].sort()).toEqual([1588, 1589, 1590, 1594]);
  });

  test("each marker is in the committed file it names, so the served copy of this tree passes", () => {
    for (const m of SITE_MARKERS) {
      const body = readFileSync(join(ROOT, "frontend", "public", m.path), "utf8");
      expect(siteMarkerProblems(m, 200, body), m.path).toEqual([]);
    }
  });

  test("red: a 404 and a file without the text", () => {
    const m = SITE_MARKERS[0]!;
    expect(siteMarkerProblems(m, 404, "")[0]).toContain("answered 404");
    expect(siteMarkerProblems(m, 200, "<html></html>")[0]).toContain("is still served");
  });
});

describe("every v0.7.4 version check loads as version-check.ts runs it", () => {
  for (const name of ["archive-records", "public-surface"]) {
    test(name, async () => {
      const mod = await import(`../../release/version-checks/v0.7.4/${name}.ts`);
      expect(typeof mod.default).toBe("function");
    });
  }
});
