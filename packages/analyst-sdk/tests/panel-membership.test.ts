// Issue 1708 (D89): panel membership is declared once, in PANEL_MEMBERSHIP.
// PANELS (the composite's panels) and ALL_PANELS derive from it, and no runtime
// analytics file lists panels literally.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ALL_PANELS, PANELS, PANEL_MEMBERSHIP } from "../src/index.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const ROOTS = [join(REPO, "packages/analyst-sdk/src"), join(REPO, "backend/src/analytics")];
// The published equal-weight comparison keeps its explicit base and eq lists.
const ALLOWED = new Set(["packages/analyst-sdk/src/analyze/regime-eq-comparison.ts"]);

// An array literal of panel names, e.g. ["macro", "onchain"].
const NAME = String.raw`["'](?:macro|onchain|factor)["']`;
const literal = new RegExp(String.raw`\[\s*${NAME}(?:\s*,\s*${NAME})*\s*,?\s*\]`);

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("panel membership registry", () => {
  test("PANELS is the included entries of PANEL_MEMBERSHIP and contains factor", () => {
    expect(ALL_PANELS).toEqual(Object.keys(PANEL_MEMBERSHIP) as typeof ALL_PANELS);
    expect(PANELS).toEqual(ALL_PANELS.filter((p) => PANEL_MEMBERSHIP[p] === "included"));
    expect(PANELS).toEqual(["macro", "onchain", "factor"]);
  });

  test("no runtime analytics source contains a literal panel list", () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const root of ROOTS) {
      for (const f of tsFiles(root)) {
        const rel = relative(REPO, f);
        if (ALLOWED.has(rel)) continue;
        scanned++;
        readFileSync(f, "utf8").split("\n").forEach((line, i) => {
          if (literal.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(scanned).toBeGreaterThan(20);
    expect(hits).toEqual([]);
  });

  test("the scan catches a literal panel list", () => {
    expect(literal.test(`computeRegime(t, d, ["macro", "onchain"], ages)`)).toBe(true);
    expect(literal.test(`const x = ['factor'];`)).toBe(true);
    expect(literal.test(`p === "macro"`)).toBe(false);
  });
});
