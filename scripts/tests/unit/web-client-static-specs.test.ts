// scripts/web-client/static-specs.ts decides which browser specs the web-client
// gate runs against the assembled static site (`bun run --cwd frontend
// check:static`), with no api and no Docker. Its NOT_STATIC table is
// hand-maintained, so it can rot two ways: an entry names a spec that was
// renamed or deleted (the exclusion then silently covers nothing), or the
// table swallows every spec and the gate runs none. This file makes both red.
//
// Runs in the required `unit.yml` job — `bun run test:unit`. Pure file reads.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_STATIC, allSpecs, staticSpecs } from "../../web-client/static-specs.ts";

describe("web-client static spec selection", () => {
  test("every NOT_STATIC entry names a spec that exists", () => {
    const all = new Set(allSpecs());
    const stale = Object.keys(NOT_STATIC).filter((s) => !all.has(s));
    expect(stale, `NOT_STATIC names specs that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });

  test("every NOT_STATIC entry carries a reason", () => {
    for (const [spec, why] of Object.entries(NOT_STATIC)) {
      expect(why.trim().length, `${spec} needs a reason`).toBeGreaterThan(10);
    }
  });

  test("the gate runs a real set of specs, not none", () => {
    expect(staticSpecs().length).toBeGreaterThan(20);
  });

  test("a spec absent from NOT_STATIC is selected by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "static-specs-"));
    try {
      writeFileSync(join(dir, "brand-new-view.spec.ts"), "");
      writeFileSync(join(dir, "spa.spec.ts"), "");
      writeFileSync(join(dir, "helper.ts"), "");
      expect(staticSpecs(dir)).toEqual(["brand-new-view"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
