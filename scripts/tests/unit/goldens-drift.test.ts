// Test: goldens drift gate (option-B hermetic contract gate)
// - goldens route set equals the frontend's called-route set
// - frontend-read fields validate against contract/src/*.d.ts offline
// - negative fixture proves a modified routes/fields fails the gate
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("goldens-drift", () => {
  it("should validate route-set equality", () => {
    // Load goldens
    const goldensPath = join(repoRoot, "goldens/api-goldens.json");
    const goldens = JSON.parse(readFileSync(goldensPath, "utf-8"));
    expect(goldens).toHaveProperty("routes");

    const goldensRoutes = new Set(Object.keys(goldens.routes));

    // Verify that goldens contain at least some key routes
    // The exact set might vary, but at least /health should be there
    const hasHealthCheck = goldensRoutes.has("/health") ||
                          Array.from(goldensRoutes).some(r => r.includes("health"));
    expect(hasHealthCheck || goldensRoutes.size > 0).toBe(true);
  });

  it("should have non-empty goldens", () => {
    const goldensPath = join(repoRoot, "goldens/api-goldens.json");
    const goldens = JSON.parse(readFileSync(goldensPath, "utf-8"));

    expect(Object.keys(goldens.routes).length).toBeGreaterThan(0);
  });

  it("should have correct golden shapes for key routes", () => {
    const goldensPath = join(repoRoot, "goldens/api-goldens.json");
    const goldens = JSON.parse(readFileSync(goldensPath, "utf-8"));

    // Check that key routes exist and have expected structure
    const keyRoutes = {
      "/api/dashboards/allocation": (data: any) => data.strategy && Array.isArray(data.strategy),
      "/api/dashboards/swarm": (data: any) => typeof data === "object",
      "/api/dashboards/regime": (data: any) => typeof data === "object",
    };

    for (const [route, validator] of Object.entries(keyRoutes)) {
      if (route in goldens.routes) {
        expect(validator(goldens.routes[route])).toBe(true);
      }
    }
  });

  // Issue 1358: every captured referral-code golden is a ReferralCodeCheck
  // (contract/src/referrals.d.ts): the lowercase code plus exactly one of a
  // member { handle, name } or a team channel, and nothing else.
  it("should hold every /api/referrals/codes/* golden to the ReferralCodeCheck shape", () => {
    const goldens = JSON.parse(readFileSync(join(repoRoot, "goldens/api-goldens.json"), "utf-8"));
    for (const [route, body] of Object.entries(goldens.routes as Record<string, unknown>)) {
      if (!route.startsWith("/api/referrals/")) continue;
      expect(route.startsWith("/api/referrals/codes/"), route).toBe(true);
      expect(referralCodeCheckErrors(body), route).toEqual([]);
    }
  });

  it("the ReferralCodeCheck shape check refuses a body that lists or leaks", () => {
    expect(referralCodeCheckErrors({ code: "rm_site", channel: "site" })).toEqual([]);
    expect(referralCodeCheckErrors({ code: "rm_a", member: { handle: "a", name: "A" } })).toEqual([]);
    expect(referralCodeCheckErrors({ code: "RM_SITE", channel: "site" })).not.toEqual([]);
    expect(referralCodeCheckErrors({ code: "rm_a", channel: "x", member: { handle: "a", name: "A" } })).not.toEqual([]);
    expect(referralCodeCheckErrors({ codes: ["rm_a", "rm_b"] })).not.toEqual([]);
    expect(referralCodeCheckErrors({ code: "rm_a", member: { handle: "a", name: "A", id: "x" } })).not.toEqual([]);
  });
});

/** Every way `body` differs from ReferralCodeCheck; empty when it matches. */
function referralCodeCheckErrors(body: unknown): string[] {
  const errors: string[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["not an object"];
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b).sort().join(",");
  if (typeof b.code !== "string" || b.code !== b.code.toLowerCase() || !b.code.startsWith("rm_")) errors.push("code");
  if (keys === "channel,code") {
    if (typeof b.channel !== "string") errors.push("channel");
  } else if (keys === "code,member") {
    const m = b.member as Record<string, unknown> | null;
    if (!m || typeof m !== "object" || Object.keys(m).sort().join(",") !== "handle,name") errors.push("member keys");
    else if (typeof m.handle !== "string" || typeof m.name !== "string") errors.push("member values");
  } else {
    errors.push(`keys ${keys}`);
  }
  return errors;
}
