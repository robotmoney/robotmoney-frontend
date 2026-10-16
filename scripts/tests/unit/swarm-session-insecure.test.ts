// NO INSECURE MODE IN THE SESSION DRIVER — D52 (1), issue #1026 W4.
//
// The file that once pinned regimeWriteInsecure()'s opt-in polarity now pins
// its replacement: there is no insecure gate to mirror. The driver's cross-role
// probes (scripts/lib/swarm/session.ts 5c: a member token on the regime write;
// 5d: a member token on an epoch turnover, the scheduler's
// `lifecycle_transitions` right, D55 (4)) ASSERT the refusal through
// assertRoleRefused instead of logging "insecure mode — gate open", and
// `bun smoke` no longer hands the driver RM_ALLOW_INSECURE.
//
// Pure: no network, no Docker.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertRoleRefused } from "../../lib/swarm/session.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const code = (file: string) =>
  readFileSync(join(REPO, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*/g, "");

describe("assertRoleRefused: only 401/403 is a refusal", () => {
  test("401 and 403 pass", () => {
    expect(() => assertRoleRefused("x", 401)).not.toThrow();
    expect(() => assertRoleRefused("x", 403)).not.toThrow();
  });

  test("RED CONTROL: the old open-gate answer (400: authorization passed, payload rejected) throws", () => {
    expect(() => assertRoleRefused("member token on the regime write", 400)).toThrow("the role gate let it through");
  });

  test("every other status is authorization passing, and throws", () => {
    for (const status of [200, 201, 202, 204, 404, 409, 422, 500, 503]) {
      expect(() => assertRoleRefused("x", status)).toThrow(`got ${status}`);
    }
  });
});

describe("the driver asserts both role gates and carries no insecure mode", () => {
  test("5c and 5d go through assertRoleRefused; no gate-open log survives", () => {
    const session = code("scripts/lib/swarm/session.ts");
    expect(session).toContain('assertRoleRefused("member token on the regime write", regimeWriteRes.status)');
    expect(session).toContain('assertRoleRefused("member token on the epoch turnover", adminCloseRes.status)');
    expect(session).not.toContain("gate open");
    expect(session).not.toContain("RM_ALLOW_INSECURE");
  });

  test("`bun smoke` spawns the session driver without RM_ALLOW_INSECURE", () => {
    const smokeMain = code("scripts/lib/smoke-main.ts");
    const at = smokeMain.indexOf('await run(["bun", "run", "scripts/lib/swarm/session.ts"]');
    expect(at).toBeGreaterThan(-1);
    const call = smokeMain.slice(at, smokeMain.indexOf('"swarm session")', at));
    expect(call).not.toContain("RM_ALLOW_INSECURE");
  });
});
