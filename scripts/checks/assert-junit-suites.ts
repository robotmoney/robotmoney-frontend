// CI guard (issue 1421): a named test suite that is absent, runs zero tests,
// runs fewer tests than it has behaviour cases, or skips one, is a red job,
// never a green one. Reads the JUnit report `bun test --reporter=junit` wrote.
//
//   bun scripts/checks/assert-junit-suites.ts <report.xml> <file>:<min> [<file>:<min> ...]
//
// <file> is the path as bun reports it (relative to the directory bun test ran
// in); <min> is the number of test cases the file must execute. For every named
// file the file-level <testsuite> must exist with tests >= min, skipped == 0
// and failures == 0, and the report as a whole must have run at least one test
// with nothing skipped in the named files. Dependency-free (node:fs only), so
// it runs in a job that installed nothing but bun.
import { readFileSync } from "node:fs";

export interface SuiteCounts {
  tests: number;
  failures: number;
  skipped: number;
}

/** File-level <testsuite> counts, keyed by file. Nested describe suites are ignored. */
export function fileSuites(xml: string): Map<string, SuiteCounts> {
  const out = new Map<string, SuiteCounts>();
  for (const m of xml.matchAll(/<testsuite\s([^>]*)>/g)) {
    const attrs = new Map([...m[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!]));
    const file = attrs.get("file");
    if (!file || attrs.get("name") !== file) continue;
    out.set(file, {
      tests: Number(attrs.get("tests") ?? 0),
      failures: Number(attrs.get("failures") ?? 0) + Number(attrs.get("errors") ?? 0),
      skipped: Number(attrs.get("skipped") ?? 0),
    });
  }
  return out;
}

export function junitViolations(xml: string, expected: ReadonlyArray<{ file: string; min: number }>): string[] {
  const problems: string[] = [];
  const total = /<testsuites\s[^>]*\btests="(\d+)"/.exec(xml);
  if (!total || Number(total[1]) === 0) problems.push("the report records zero executed tests");
  const suites = fileSuites(xml);
  for (const { file, min } of expected) {
    const s = suites.get(file);
    if (!s) {
      problems.push(`${file}: absent from the run (renamed, excluded, or failed to load)`);
      continue;
    }
    if (s.tests === 0) problems.push(`${file}: ran zero tests`);
    else if (s.tests < min) problems.push(`${file}: ran ${s.tests} test(s), expected at least ${min}`);
    if (s.skipped > 0) problems.push(`${file}: skipped ${s.skipped} test(s); a behaviour case may not be skipped`);
    if (s.failures > 0) problems.push(`${file}: ${s.failures} failure(s)`);
  }
  return problems;
}

function parseExpected(args: string[]): { file: string; min: number }[] {
  return args.map((a) => {
    const i = a.lastIndexOf(":");
    const file = i > 0 ? a.slice(0, i) : a;
    const min = i > 0 ? Number(a.slice(i + 1)) : 1;
    if (!file || !Number.isInteger(min) || min < 1) throw new Error(`bad suite argument ${JSON.stringify(a)}: expected <file>:<min> with min >= 1`);
    return { file, min };
  });
}

if (import.meta.main) {
  const [report, ...rest] = process.argv.slice(2);
  if (!report || rest.length === 0) {
    console.error("usage: bun scripts/checks/assert-junit-suites.ts <report.xml> <file>:<min> [...]");
    process.exit(2);
  }
  let xml: string;
  try {
    xml = readFileSync(report, "utf8");
  } catch {
    console.error(`::error::no JUnit report at ${report}: the test step did not produce one`);
    process.exit(1);
  }
  const problems = junitViolations(xml, parseExpected(rest));
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length > 0) process.exit(1);
  console.log(`[assert-junit-suites] ${rest.length} named suite(s) ran with nonzero, unskipped case counts`);
}
