// Import boundary for the projects fixture (issue #1208). The fixture dataset
// must reach a running process only through injectProjectsDataSource, which
// refuses unless the test harness armed the seam (D69). A static importer
// under backend/src would be a path around that seam, so the import graph
// under backend/src is pinned here:
//   - projects/fixtures/dataset.ts is imported only by access/fixture-source.ts
//   - projects/access/fixture-source.ts is imported by no module under
//     backend/src (only the harness: tests/preload.ts and tests/support)
// Imports are parsed from source (static import/export-from and dynamic import).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

function importers(target: string): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[1]!;
      if (!spec.startsWith(".")) continue;
      const resolved = resolve(dirname(file), spec);
      if (resolved === target || resolved === target.replace(/\.ts$/, "")) {
        hits.push(relative(SRC, file));
        break;
      }
    }
  }
  return hits.sort();
}

describe("the projects fixture is reachable only through the test seam", () => {
  test("fixtures/dataset.ts is imported only by access/fixture-source.ts", () => {
    expect(importers(join(SRC, "projects/fixtures/dataset.ts"))).toEqual(["projects/access/fixture-source.ts"]);
  });

  test("access/fixture-source.ts is imported by no module under backend/src", () => {
    expect(importers(join(SRC, "projects/access/fixture-source.ts"))).toEqual([]);
  });
});
