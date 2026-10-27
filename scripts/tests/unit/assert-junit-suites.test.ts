// The CI guard scripts/checks/assert-junit-suites.ts (issue 1421) must turn an
// absent suite, a suite that ran zero tests or too few, a skipped behaviour
// case and an empty report into violations, and accept a complete run. The
// last case runs bun test for real, so the guard is checked against the JUnit
// format the pinned bun actually writes, not only a hand-written sample.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSuites, junitViolations } from "../../checks/assert-junit-suites.ts";

const suite = (file: string, tests: number, skipped = 0, failures = 0) =>
  `  <testsuite name="${file}" file="${file}" tests="${tests}" assertions="1" failures="${failures}" skipped="${skipped}" time="0">\n` +
  `    <testsuite name="a describe" file="${file}" line="3" tests="${tests}" failures="${failures}" skipped="${skipped}" time="0">\n    </testsuite>\n  </testsuite>\n`;
const report = (...suites: string[]) => {
  const n = suites.reduce((s, x) => s + Number(/tests="(\d+)"/.exec(x)![1]), 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${n}" failures="0" skipped="0">\n${suites.join("")}</testsuites>\n`;
};
const want = [{ file: "tests/a.test.ts", min: 3 }, { file: "tests/b.test.ts", min: 1 }];

describe("assert-junit-suites", () => {
  test("a complete run with every named suite present, nonzero and unskipped passes", () => {
    expect(junitViolations(report(suite("tests/a.test.ts", 3), suite("tests/b.test.ts", 2)), want)).toEqual([]);
  });

  test("only file-level suites are counted, not nested describes", () => {
    const s = fileSuites(report(suite("tests/a.test.ts", 3)));
    expect([...s.keys()]).toEqual(["tests/a.test.ts"]);
  });

  const cases: Array<[string, string, RegExp]> = [
    ["an absent suite", report(suite("tests/a.test.ts", 3)), /tests\/b\.test\.ts: absent/],
    ["a suite that ran zero tests", report(suite("tests/a.test.ts", 3), suite("tests/b.test.ts", 0)), /b\.test\.ts: ran zero tests/],
    ["a suite below its case count", report(suite("tests/a.test.ts", 2), suite("tests/b.test.ts", 1)), /a\.test\.ts: ran 2 test\(s\), expected at least 3/],
    ["a skipped behaviour case", report(suite("tests/a.test.ts", 3, 1), suite("tests/b.test.ts", 1)), /a\.test\.ts: skipped 1/],
    ["a failed case", report(suite("tests/a.test.ts", 3, 0, 1), suite("tests/b.test.ts", 1)), /a\.test\.ts: 1 failure/],
    ["an empty report", report(), /zero executed tests/],
  ];
  for (const [name, xml, expected] of cases) {
    test(`flags ${name}`, () => {
      const v = junitViolations(xml, want);
      expect(v.some((m) => expected.test(m)), v.join("\n")).toBe(true);
    });
  }

  test("the real bun JUnit report: a skip and a todo are caught, a clean file passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "junit-guard-"));
    try {
      writeFileSync(join(dir, "clean.test.ts"), 'import { test, expect } from "bun:test";\ntest("one", () => expect(1).toBe(1));\ntest("two", () => expect(2).toBe(2));\n');
      writeFileSync(join(dir, "skips.test.ts"), 'import { test } from "bun:test";\ntest.skip("s", () => {});\ntest.todo("t");\ntest("p", () => {});\n');
      const out = join(dir, "report.xml");
      const proc = Bun.spawnSync([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${out}`, "./clean.test.ts", "./skips.test.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      const xml = readFileSync(out, "utf8");
      const files = [...fileSuites(xml).keys()];
      const clean = files.find((f) => f.endsWith("clean.test.ts"))!;
      const skips = files.find((f) => f.endsWith("skips.test.ts"))!;
      expect(junitViolations(xml, [{ file: clean, min: 2 }])).toEqual([]);
      expect(junitViolations(xml, [{ file: skips, min: 1 }]).some((m) => /skipped 2/.test(m))).toBe(true);
      expect(junitViolations(xml, [{ file: "missing.test.ts", min: 1 }]).some((m) => /absent/.test(m))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
