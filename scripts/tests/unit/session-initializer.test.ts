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
const smokeMain = readFileSync(join(repoRoot, "scripts/lib/smoke-main.ts"), "utf8");

describe("runSession's initializer is a stated obligation, not a default", () => {
  test("the opts field is REQUIRED — an omitted initializer must not compile", () => {
    // Was `ScenarioInitializer` (smoke-mode.ts) before the archive scenario
    // retired: "archive" became "adopt" — real/restored data, never a
    // default — and the type moved inline since smoke-mode.ts no longer
    // needs to name it. Still REQUIRED, still no `?`, which is the property
    // this test actually defends.
    expect(session).toContain('initializer: "simulation" | "adopt";');
    expect(session).not.toContain('initializer?: "simulation" | "adopt";');
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

describe("every smoke-side session caller states its scenario", () => {
  // The uniform `initializer: scenario.initializer` this test used to pin
  // retired along with the archive scenario: the two call sites now compute
  // it differently on purpose (the CI-twin session is unconditionally real,
  // the standing loop has to ask which data path it's on), so this checks
  // the SAME safety property — every caller states a real/adopt-aware value,
  // none defaults or hardcodes fiction — against each site's own expression.
  test("the CI-twin one-shot session states adopt, unconditionally (it is always real)", () => {
    expect(smokeMain).toContain('initializer: "adopt"');
  });

  test("the STANDING loop asks which data path it's on — the exact omission that caused the corruption", () => {
    expect(smokeMain).toContain('initializer: dataPath.kind === "ephemeral" ? "simulation" : "adopt"');
  });

  test("no smoke-side caller hardcodes simulation unconditionally, which would defeat a real or twin boot", () => {
    // Bare `initializer: "simulation"` (immediately closed by `,`/`}`) would be
    // an unconditional default; the ternary above is fine because "simulation"
    // there is never the whole expression, only one branch of it.
    expect(smokeMain).not.toMatch(/initializer:\s*"simulation"\s*[,}]/);
  });
});
