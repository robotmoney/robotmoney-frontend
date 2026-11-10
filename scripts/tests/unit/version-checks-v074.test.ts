import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { noJitProblems, parseResult, RESULT_MARKER } from "../../release/version-checks/v0.7.4/no-jit.ts";
import { SITE_MARKERS, siteMarkerProblems } from "../../release/version-checks/v0.7.4/public-surface.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const read = (container: string, code: number, result: unknown) => ({ container, code, stdout: `${RESULT_MARKER}${JSON.stringify(result)}\n`, stderr: "" });

describe("v0.7.4 no-jit check (PR 1595)", () => {
  test("green: the api's pool is off on a server whose default is on", () => {
    expect(noJitProblems([read("rm_smoke_stack_x-api-1", 0, { pool: "off", serverDefault: "on" })])).toEqual([]);
  });

  test("red: v0.7.3's pool runs with the server default", () => {
    expect(noJitProblems([read("api-1", 0, { pool: "on", serverDefault: "on" })]).join()).toContain("runs with jit on, not off");
  });

  test("red: no api container, a failed exec and output with no result line", () => {
    expect(noJitProblems([])).toEqual(["no running api container in the instance's compose project"]);
    expect(noJitProblems([{ container: "api-1", code: 1, stdout: "", stderr: "boom" }]).join()).toContain("did not run (exit 1): boom");
    expect(noJitProblems([{ container: "api-1", code: 0, stdout: "hello\n", stderr: "" }]).join()).toContain("did not run (exit 0)");
    expect(parseResult(`${RESULT_MARKER}{"pool":1}`)).toBeNull();
  });
});

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
  for (const name of ["archive-records", "public-surface", "no-jit"]) {
    test(name, async () => {
      const mod = await import(`../../release/version-checks/v0.7.4/${name}.ts`);
      expect(typeof mod.default).toBe("function");
    });
  }
});
