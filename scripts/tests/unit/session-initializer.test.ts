// The archive-scenario guard, pinned at the place it actually failed.
//
// session.ts already refused to author reference-shaped subject data under the
// archive initializer, and said so at length. The guard still leaked, because
// it was written as `opts?.initializer ?? "simulation"` and the standing-session
// loop did not pass `initializer` — so the DANGEROUS branch was the one you got
// by forgetting a parameter.
//
// What that cost, observed end-to-end: a smoke boot restored all four subjects
// from the archive faithfully ("inserted=4 … drifted=0, no inconsistencies
// detected"), then its own standing session overwrote robotmoney-allocation's
// recommendation_type from bucket_weights to position_actions — and, because
// that write does not touch updated_at, left the row timestamped as though the
// restore had produced it. The NEXT smoke boot against that database then
// detected drift and refused to start. The corruption was self-inflicted,
// silent, and reproducible from an empty database.
//
// TypeScript now enforces the call-site obligation. These tests defend the
// shape that makes that enforcement possible, because reverting `initializer`
// to optional would compile fine and quietly restore the bug.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const session = readFileSync(join(repoRoot, "scripts/lib/swarm/session.ts"), "utf8");
const demoMain = readFileSync(join(repoRoot, "scripts/lib/demo-main.ts"), "utf8");

describe("runSession's initializer is a stated obligation, not a default", () => {
  test("the opts field is REQUIRED — an omitted initializer must not compile", () => {
    expect(session).toContain("initializer: ScenarioInitializer;");
    expect(session).not.toContain("initializer?: ScenarioInitializer;");
  });

  test("the guard compares the value directly, with no defaulting fallback", () => {
    expect(session).toContain('if (opts.initializer === "simulation")');
    expect(session).not.toMatch(/opts\?\.initializer\s*\?\?/);
  });

  test("subject fixtures are still gated on the simulation branch at all", () => {
    // The fixture write is what corrupts a restored subject; if this call ever
    // moves outside the guard the tests above would still pass.
    const guardIdx = session.indexOf('if (opts.initializer === "simulation")');
    const fixtureIdx = session.indexOf('admin("subject_fixtures"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fixtureIdx).toBeGreaterThan(guardIdx);
    // Immediately inside the guard, not merely somewhere after it.
    expect(fixtureIdx - guardIdx).toBeLessThan(200);
  });
});

describe("every demo-side session caller states its scenario", () => {
  test("both the first session and the STANDING loop pass the scenario's initializer", () => {
    const passes = demoMain.match(/initializer: scenario\.initializer/g) ?? [];
    // One for the opening session, one for the standing loop that runs forever.
    // The standing loop was the omission that caused the corruption.
    expect(passes.length).toBeGreaterThanOrEqual(2);
  });

  test("no demo-side caller hardcodes simulation, which would defeat a smoke boot", () => {
    expect(demoMain).not.toContain('initializer: "simulation"');
  });
});
