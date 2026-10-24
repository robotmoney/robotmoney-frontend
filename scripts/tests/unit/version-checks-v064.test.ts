// The pure decision of the v0.6.4 version check (scripts/release/version-checks/v0.6.4/):
// runtime-bun (1441). The shipped shape is every Bun service on the pinned version; each red
// control is the shape before the PR, or the failure the check exists to catch.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUN_SERVICES, BUN_VERSION, runtimeBunProblems, type RuntimeObservation } from "../../release/version-checks/v0.6.4/runtime-bun.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const on = (version: string): RuntimeObservation => ({
  services: Object.fromEntries(BUN_SERVICES.map((s) => [s, { container: `rm_prod-${s}-1`, code: 0, version }])),
});

describe("runtime-bun (1441)", () => {
  test("the pinned version is the backend image's base", () => {
    expect(readFileSync(join(ROOT, "backend", "Dockerfile"), "utf8")).toContain(`FROM oven/bun:${BUN_VERSION}\n`);
  });
  test("every Bun service on the pinned version passes", () => {
    expect(runtimeBunProblems(on(BUN_VERSION))).toEqual([]);
  });
  test("red: the services before 1441 run bun 1.3.5", () => {
    const p = runtimeBunProblems(on("1.3.5"));
    expect(p.length).toBe(BUN_SERVICES.length);
    expect(p.join()).toContain("runs bun 1.3.5, not 1.4.4");
  });
  test("red: one service missing, one exec failing, one printing nothing", () => {
    const o = on(BUN_VERSION);
    const p = runtimeBunProblems({
      services: {
        ...o.services,
        api: null,
        "worker-analytics": { container: "w", code: 126, version: "" },
        "system-scheduler": { container: "s", code: 0, version: "" },
      },
    }).join();
    expect(p).toContain("no running api container");
    expect(p).toContain("bun --version exited 126");
    expect(p).toContain("runs bun <nothing printed>");
  });
});
