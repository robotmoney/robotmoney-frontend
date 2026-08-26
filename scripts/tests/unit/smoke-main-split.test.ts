// Issue #456 — scripts/lib/smoke-main.ts had grown to 2087 lines / 45
// top-level functions (nearly double the 1131 lines the 2026-07-14
// maintainability review flagged, finding review-maintainability-032) and
// still carried the review's other flagged defect: a global
// `process.env.ADMIN_TOKEN = adminPassword` mutation making section ordering
// load-bearing for every same-process reader.
//
// smoke-main.ts does its setup at module scope and boots a stack on import, so
// it cannot be imported into a unit test (the same constraint
// scripts/tests/unit/smoke-onboarding-driver.test.ts and friends document).
// This suite is therefore written as FUNCTIONS OVER SOURCE TEXT, across
// smoke-main.ts and the two modules it now delegates to.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const libDir = join(repoRoot, "scripts", "lib");

const smokeMain = readFileSync(join(repoRoot, "scripts", "lib", "smoke-main.ts"), "utf8");
const tuiView = readFileSync(join(repoRoot, "scripts", "lib", "smoke-tui-view.ts"), "utf8");
const readinessPolling = readFileSync(join(repoRoot, "scripts", "lib", "smoke-readiness-polling.ts"), "utf8");

// The pre-#456 baseline, verified via `git log`/the issue body: 2087 lines,
// 45 top-level functions.
const PRE_FIX_LINES = 2087;
const PRE_FIX_FUNCTIONS = 45;

/** Every top-level (column-0) `function` / `async function` declaration. */
function topLevelFunctionCount(src: string): number {
  return [...src.matchAll(/^(export )?(async )?function [A-Za-z_]\w*\s*\(/gm)].length;
}

function allTsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...allTsFilesUnder(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("scripts/lib/smoke-main.ts is measurably smaller after the #456 split", () => {
  test("line count dropped from the pre-fix 2087", () => {
    const lines = smokeMain.split("\n").length;
    expect(lines).toBeLessThan(PRE_FIX_LINES);
    // A trivial one-line trim would technically satisfy "reduced" but proves
    // nothing; the issue asked for at least two real extracted modules, so
    // pin a real cut, not a rounding error.
    expect(PRE_FIX_LINES - lines).toBeGreaterThan(150);
  });

  test("top-level function count dropped from the pre-fix 45", () => {
    const count = topLevelFunctionCount(smokeMain);
    expect(count).toBeLessThan(PRE_FIX_FUNCTIONS);
    expect(PRE_FIX_FUNCTIONS - count).toBeGreaterThan(10);
  });

  test("at least two modules were extracted, and smoke-main.ts imports from both", () => {
    expect(smokeMain).toContain('from "./smoke-tui-view.ts"');
    expect(smokeMain).toContain('from "./smoke-readiness-polling.ts"');
    // Both files are real, non-trivial modules, not empty stubs.
    expect(tuiView.split("\n").length).toBeGreaterThan(50);
    expect(readinessPolling.split("\n").length).toBeGreaterThan(50);
  });

  test("the TUI state machine moved to smoke-tui-view.ts, not merely duplicated", () => {
    for (const fn of ["setContainer", "setStep", "startOnboarding", "setOnboardStep", "swarmProgress", "phaseGlyph", "columns"]) {
      expect(tuiView).toMatch(new RegExp(`export function ${fn}\\(|export const ${fn}\\b`));
      // smoke-main.ts must call these, not redeclare them.
      expect(smokeMain).not.toMatch(new RegExp(`^function ${fn}\\(`, "m"));
    }
  });

  test("the readiness-probe polling moved to smoke-readiness-polling.ts, not merely duplicated", () => {
    // pollResearch/pollNextRuns/pollContainerHealth are declared INSIDE the
    // createReadinessPolling() factory (private instance state, not
    // module-level) — matched without an `export`/indentation anchor;
    // classifyContainer is a standalone exported pure helper.
    for (const fn of ["pollResearch", "pollNextRuns", "pollContainerHealth"]) {
      expect(readinessPolling).toMatch(new RegExp(`(async )?function ${fn}\\(`));
      expect(smokeMain).not.toMatch(new RegExp(`^(async )?function ${fn}\\(`, "m"));
    }
    expect(readinessPolling).toContain("export function classifyContainer(");
    expect(readinessPolling).toContain("export function createReadinessPolling(");
    expect(smokeMain).not.toMatch(/^function classifyContainer\(/m);
    expect(smokeMain).not.toMatch(/^function createReadinessPolling\(/m);
    // The one instance smoke-main.ts creates, then drives via its methods.
    expect(smokeMain).toContain("createReadinessPolling({");
    expect(smokeMain).toContain("readinessPolling.startResearchPolling()");
    expect(smokeMain).toContain("readinessPolling.startHealthPolling()");
  });
});

describe("the process.env.ADMIN_TOKEN global mutation is gone (issue #456)", () => {
  test("smoke-main.ts no longer assigns process.env.ADMIN_TOKEN", () => {
    expect(smokeMain).not.toMatch(/process\.env\.ADMIN_TOKEN\s*=[^=]/);
  });

  test("no file under scripts/lib/** mutates process.env.ADMIN_TOKEN globally", () => {
    const offenders: string[] = [];
    for (const file of allTsFilesUnder(libDir)) {
      const src = readFileSync(file, "utf8");
      if (/process\.env\.ADMIN_TOKEN\s*=[^=]/.test(src)) offenders.push(file.slice(repoRoot.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  test("the automation token is threaded explicitly to every stack-internal driver", () => {
    expect(smokeMain).toContain("automationToken,");
    // swarm/session.ts: the in-process consumers the smoke's dynamically
    // imported driver calls now take an explicit token rather than reading
    // the (removed) global mutation off process.env in this same process.
    const session = readFileSync(join(libDir, "swarm", "session.ts"), "utf8");
    expect(session).toContain("getAutomationHeaders(token?: string)");
    expect(session).toMatch(/export async function admin\(action: string, body: unknown = \{\}, automationToken\?: string\)/);
    expect(session).toContain("rosterMembers(targetUrl: string = backendUrl(), automationToken?: string)");
    expect(session).toContain("existingMemberNames(targetUrl: string = backendUrl(), automationToken?: string)");
  });

  test("smoke keeps human setup and automation credentials distinct", () => {
    // Each of these previously relied on `...process.env` already carrying a
    // value this SAME process had mutated onto itself; each now gets it
    // explicitly in its own spawn env object.
    expect(smokeMain).toContain("const automationToken = credentials.automationToken;");
    expect(smokeMain).not.toContain("AUTOMATION_TOKEN: adminPassword");
    expect((smokeMain.match(/AUTOMATION_TOKEN: automationToken/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// RED CONTROLS. The same graders, pointed at fixtures shaped like the
// pre-#456 antipattern, must report — or the checks above prove nothing.
// ---------------------------------------------------------------------------
describe("red control: the graders catch the pre-#456 shape", () => {
  test("topLevelFunctionCount counts a simple fixture correctly", () => {
    const fixture = "function a() {}\nasync function b() {}\nexport function c() {}\nconst x = () => {};\n";
    expect(topLevelFunctionCount(fixture)).toBe(3);
  });

  test("the ADMIN_TOKEN mutation regex flags the retired pattern and ignores an unrelated ==", () => {
    expect(/process\.env\.ADMIN_TOKEN\s*=[^=]/.test("process.env.ADMIN_TOKEN = adminPassword;")).toBe(true);
    expect(/process\.env\.ADMIN_TOKEN\s*=[^=]/.test('if (process.env.ADMIN_TOKEN === "x") {}')).toBe(false);
    expect(/process\.env\.ADMIN_TOKEN\s*=[^=]/.test("const t = process.env.ADMIN_TOKEN;")).toBe(false);
  });
});
