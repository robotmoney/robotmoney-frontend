// Issue #977 AC11: every new analytics run-ledger route (runs, runEvents,
// vintages, vintage) is exported consistently from BOTH routes.js (the
// runtime values) and routes.d.ts (the published type), and the backend API
// client actually consumes them through ROUTES — never a re-typed
// string-literal fallback that could silently drift from the contract.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "../../src/routes.js";

const contractRoot = join(import.meta.dir, "../..");
const routesDts = readFileSync(join(contractRoot, "src/routes.d.ts"), "utf8");
const backendApiClient = readFileSync(join(contractRoot, "../backend/src/analytics/api-client.ts"), "utf8");
const backendRoutesFile = readFileSync(join(contractRoot, "../backend/src/api/routes/analytics.ts"), "utf8");

const NEW_ROUTE_KEYS = ["runs", "runEvents", "vintages", "vintage"] as const;

describe("issue #977: analytics run-ledger routes are exported consistently", () => {
  test("each new route is a real, non-empty /api/analytics/* string on ROUTES.analytics", () => {
    for (const key of NEW_ROUTE_KEYS) {
      const value = (ROUTES.analytics as Record<string, string>)[key];
      expect(value, `ROUTES.analytics.${key} must exist`).toBeTruthy();
      expect(value.startsWith("/api/analytics/"), `ROUTES.analytics.${key} = ${value}`).toBe(true);
    }
    // Every value distinct — no two new keys silently collide on one path.
    const values = NEW_ROUTE_KEYS.map((k) => (ROUTES.analytics as Record<string, string>)[k]);
    expect(new Set(values).size).toBe(values.length);
  });

  test("routes.d.ts declares the SAME analytics keys routes.js exports at runtime — neither can drift from the other", () => {
    const block = routesDts.match(/analytics:\s*\{([\s\S]*?)\n\s*\};/);
    expect(block, "routes.d.ts must still declare an `analytics: { ... }` block").not.toBeNull();
    const declared = [...block![1]!.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*string;/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);

    const runtimeKeys = Object.keys(ROUTES.analytics).sort();
    expect(declared.sort()).toEqual(runtimeKeys);

    for (const key of NEW_ROUTE_KEYS) {
      expect(declared, `routes.d.ts must declare analytics.${key}`).toContain(key);
    }
  });

  test("the backend analytics API client consumes every new route via ROUTES.analytics.*, never a re-typed string-literal fallback", () => {
    for (const key of NEW_ROUTE_KEYS) {
      const path = (ROUTES.analytics as Record<string, string>)[key]!;
      expect(
        backendApiClient.includes(`ROUTES.analytics.${key}`),
        `analytics/api-client.ts must reference ROUTES.analytics.${key}`,
      ).toBe(true);
      // A hardcoded copy of the literal path string anywhere in the client
      // would work today and silently stop matching the contract the moment
      // routes.js changes — assert it never appears at all.
      expect(
        backendApiClient.includes(`"${path}"`) || backendApiClient.includes(`'${path}'`),
        `analytics/api-client.ts must not hardcode the literal path ${path} as a string-literal fallback`,
      ).toBe(false);
    }
  });

  test("the backend API route dispatcher recognizes every new route via ROUTES.analytics.*, never a re-typed string-literal fallback", () => {
    for (const key of NEW_ROUTE_KEYS) {
      const path = (ROUTES.analytics as Record<string, string>)[key]!;
      expect(
        backendRoutesFile.includes(`A.${key}`),
        `api/routes/analytics.ts must dispatch on A.${key} (A = ROUTES.analytics)`,
      ).toBe(true);
      expect(
        backendRoutesFile.includes(`"${path}"`) || backendRoutesFile.includes(`'${path}'`),
        `api/routes/analytics.ts must not hardcode the literal path ${path}`,
      ).toBe(false);
    }
  });
});
