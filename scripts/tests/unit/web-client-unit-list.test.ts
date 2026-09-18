// frontend/test/unit.list is the web client's unit selection — the subset of
// scripts/tests/unit/ the client's own merge gate runs
// (.github/workflows/web-client.yml via `bun run --cwd frontend test`,
// scripts/web-client/unit.ts). A hand-maintained list rots two ways: a listed
// file is moved or deleted (the runner already refuses that), or a NEW test
// that exercises client JS is written and never listed, so the client gate
// stops covering it while still reporting green. This file makes the second
// case red.
//
// Runs in the required `unit.yml` job — `bun run test:unit`. Pure file reads.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listedUnitTests } from "../../web-client/unit.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const unitDir = join(repoRoot, "scripts/tests/unit");
const SELF = "web-client-unit-list.test.ts";

// A test "executes client JS" when it imports from the shipped JS tree. Both
// static and dynamic import forms are matched; a test that only READS a client
// file (a css or html guard) is welcome on the list but not required there.
const CLIENT_JS_IMPORT = /(?:from\s*|import\s*\(\s*)["'][^"']*frontend\/public\/assets\/js\//;

function importsClientJs(source: string): boolean {
  return CLIENT_JS_IMPORT.test(source);
}

describe("frontend/test/unit.list is complete and real", () => {
  test("every listed path exists", async () => {
    const listed = await listedUnitTests();
    expect(listed.length).toBeGreaterThan(10);
    const missing = listed.filter((f) => !existsSync(join(repoRoot, f)));
    expect(missing, `unit.list names files that do not exist: ${missing.join(", ")}`).toEqual([]);
  });

  test("every listed path is a unit-tier test file", async () => {
    const listed = await listedUnitTests();
    const wrongTier = listed.filter((f) => !f.startsWith("scripts/tests/unit/") || !f.endsWith(".test.ts"));
    expect(wrongTier, "the client gate is unit-tier only (no Docker, no network)").toEqual([]);
  });

  test("every unit test that imports client JS is on the list", async () => {
    const listed = new Set(await listedUnitTests());
    const unlisted = readdirSync(unitDir)
      .filter((name) => name.endsWith(".test.ts") && name !== SELF)
      .filter((name) => importsClientJs(readFileSync(join(unitDir, name), "utf8")))
      .map((name) => `scripts/tests/unit/${name}`)
      .filter((path) => !listed.has(path));
    expect(
      unlisted,
      `these tests execute client JS but frontend/test/unit.list does not name them, so the web-client gate never runs them: ${unlisted.join(", ")}`,
    ).toEqual([]);
  });

  test("the import detector is non-vacuous — it matches a real listed file and a planted one", async () => {
    const listed = await listedUnitTests();
    const detected = listed.filter((f) => importsClientJs(readFileSync(join(repoRoot, f), "utf8")));
    expect(detected.length, "at least one listed test actually imports client JS").toBeGreaterThan(5);

    const dir = mkdtempSync(join(tmpdir(), "web-client-unit-list-"));
    try {
      const planted = join(dir, "planted.test.ts");
      writeFileSync(planted, 'import { fmt } from "../../../frontend/public/assets/js/app/lib/format.js";\n');
      expect(importsClientJs(readFileSync(planted, "utf8"))).toBe(true);
      const dynamic = join(dir, "dynamic.test.ts");
      writeFileSync(dynamic, 'const m = await import("../../../frontend/public/assets/js/app/seo.js");\n');
      expect(importsClientJs(readFileSync(dynamic, "utf8"))).toBe(true);
      const reader = join(dir, "reader.test.ts");
      writeFileSync(reader, 'const css = readFileSync("frontend/public/assets/css/dash.css", "utf8");\n');
      expect(importsClientJs(readFileSync(reader, "utf8"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
