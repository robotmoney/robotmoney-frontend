// Issue 1579: a statement timeout on the routes that run readSeatSilence (the
// member page, the admin member list, the admin overview) is the JIT compile
// fixed by jit=off on every app pool, not issue 1035's ledger load. The new
// rule sits ahead of known-api-statement-timeout-under-load so those lines
// classify to 1579. RED CONTROL: the same timeout on any other path still
// classifies to the 1035 rule.
//
// The lines are the shape api/index.ts logs (dbFailureLogPrefix + the error),
// as the v0.7.2 preflight baseline saw them on production.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const SOURCE = "rm_prod_stack-api-1";
const groupsOf = (lines: string[]) => classify(inventory(SOURCE, lines.map((text) => ({ ts: null, text }))), committed);
const timeout = (status: number, path: string) => `api error (${status} ${path}): PostgresError: canceling statement due to statement timeout`;

const SEAT_SILENCE_PATHS = [
  "/api/swarm/members/6f0c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f",
  "/api/swarm/members/house-alpha",
  "/api/swarm/admin/members",
  "/api/admin/overview",
];

describe("a statement timeout on a readSeatSilence route classifies to issue 1579", () => {
  for (const path of SEAT_SILENCE_PATHS) {
    for (const status of [500, 503]) {
      test(`${status} ${path}`, () => {
        const [g] = groupsOf([timeout(status, path)]);
        expect(g!.rule?.id).toBe("known-swarm-seat-silence-jit-statement-timeout");
        expect(g!.rule?.issue).toBe("1579");
      });
    }
  }

  // The jit=off fix ships in v0.8.0: the owner rescoped v0.7.4 to the web
  // client only (2026-11-10), so v0.7.4 does not fix it.
  test("the rule is fixed in 0.8.0, so a recurrence on v0.8.0 or later fails the post-release gate", () => {
    const rule = committed.find((r) => r.id === "known-swarm-seat-silence-jit-statement-timeout")!;
    expect(rule.class).toBe("known-issue");
    expect(rule.fixedIn).toBe("0.8.0");
    for (const release of ["v0.8.0", "0.8.1", "v0.9.0"]) {
      const v = inventoryVerdict(groupsOf([timeout(503, "/api/admin/overview")]), "post-release", release);
      expect(v.unclassifiedErrors).toBe(0);
      expect(v.failures.join("\n")).toContain("known-swarm-seat-silence-jit-statement-timeout");
      expect(v.failures.join("\n")).toContain("still present after the release that fixes it");
    }
    // No release tag (the twin gate): every known issue fails after the release.
    expect(inventoryVerdict(groupsOf([timeout(503, "/api/admin/overview")]), "post-release").failures).toHaveLength(1);
  });

  test("RED CONTROL: before 0.8.0 (v0.7.4 included) a recurrence is a warning, and the baseline only warns", () => {
    const groups = groupsOf([timeout(503, "/api/swarm/admin/members")]);
    for (const release of ["v0.7.3", "v0.7.4", "0.7.9"]) {
      const before = inventoryVerdict(groups, "post-release", release);
      expect(before.failures).toEqual([]);
      expect(before.warnings.join("\n")).toContain(`not fixed by ${release} or earlier`);
    }
    const baseline = inventoryVerdict(groups, "baseline", "v0.8.0");
    expect(baseline.failures).toEqual([]);
    expect(baseline.warnings.join("\n")).toContain("1579");
  });

  test("it is ordered ahead of known-api-statement-timeout-under-load", () => {
    const ids = committed.map((r) => r.id);
    expect(ids.indexOf("known-swarm-seat-silence-jit-statement-timeout")).toBeLessThan(ids.indexOf("known-api-statement-timeout-under-load"));
  });
});

describe("RED CONTROLS: other statement timeouts keep the 1035 rule", () => {
  for (const path of [
    "/api/analytics/raw-history",
    "/api/swarm/members",
    "/api/swarm/members/6f0c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f/takes",
    "/api/swarm/admin/members/6f0c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f",
    "/api/admin/overview-extra",
  ]) {
    test(path, () => {
      expect(groupsOf([timeout(503, path)])[0]!.rule?.id).toBe("known-api-statement-timeout-under-load");
    });
  }

  test("a bare statement-timeout line with no route keeps the 1035 rule", () => {
    expect(groupsOf(["PostgresError: canceling statement due to statement timeout"])[0]!.rule?.id).toBe("known-api-statement-timeout-under-load");
  });
});
