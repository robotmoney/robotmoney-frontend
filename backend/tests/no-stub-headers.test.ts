// No false placeholder headers (issue #1026, criterion 45).
//
// Step 1 of #1026's W2 workstream opened schema-snapshot.ts, schema-manifest.ts
// and their tests with a header announcing that every function threw and every
// test failed. The code then landed underneath those headers and they stayed,
// so a reader of the module's first lines was told the opposite of the truth.
// This file fails when any TypeScript file under backend/src/db,
// backend/scripts or backend/tests opens with such a header again.
//
// Only the OPENING comment block is read — the lines before the first line of
// code — because that is where the claim was made and where a reader looks.
// Prose further down that merely mentions the words is not a header.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const BACKEND = join(import.meta.dir, "..");
const SCANNED = ["src/db", "scripts", "tests"];

/** The opening comment block: leading `//` lines (and blank lines between them),
 *  up to the first line that is neither. */
function openingHeader(text: string): string {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("//") || line.trim() === "") lines.push(line);
    else break;
  }
  return lines.join("\n");
}

/** Why a header is a placeholder header, or `[]` when it is not. */
function placeholderReasons(text: string): string[] {
  const header = openingHeader(text);
  const reasons: string[] = [];
  if (/^\/\/\s*STUB\b/m.test(header)) reasons.push("a header line opens with STUB");
  if (/throws\s+`?NOT IMPLEMENTED/.test(header)) reasons.push("claims its functions throw NOT IMPLEMENTED");
  // "…fails against <the old tree>" is a red-control statement about the past,
  // not a placeholder claim about the present.
  if (/every test (?:here |in this file )?fails(?! against)/i.test(header)) reasons.push("claims every test here fails");
  if (/\bfails? by design/i.test(header)) reasons.push("claims its tests fail by design");
  return reasons;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Every scanned file that opens with a placeholder header, with its reasons. */
function offenders(root: string, dirs: readonly string[]): { file: string; reasons: string[] }[] {
  return dirs
    .flatMap((dir) => tsFiles(join(root, dir)))
    .map((path) => ({ file: relative(root, path), reasons: placeholderReasons(readFileSync(path, "utf8")) }))
    .filter((entry) => entry.reasons.length > 0);
}

describe("no file opens with a placeholder 'not implemented / every test fails' header", () => {
  test("backend/src/db, backend/scripts and backend/tests carry none", () => {
    const scanned = SCANNED.flatMap((dir) => tsFiles(join(BACKEND, dir)));
    // The scan must actually reach the files criterion 45 names.
    for (const file of [
      "src/db/preflight.ts",
      "src/db/schema-snapshot.ts",
      "src/db/schema-manifest.ts",
      "src/db/schema-compat.ts",
      "scripts/migrate-run.ts",
      "tests/schema-snapshot.test.ts",
      "tests/schema-manifest.test.ts",
    ]) {
      expect(scanned.map((path) => relative(BACKEND, path))).toContain(file);
    }
    expect(offenders(BACKEND, SCANNED)).toEqual([]);
  });

  test("RED CONTROL: the headers #1026 removed are caught, each for its own reason", () => {
    // Verbatim from the headers this criterion removed (schema-snapshot.ts and
    // schema-snapshot.test.ts before the fix).
    const moduleHeader = [
      "// The snapshot — the hand-maintained canonical description of the schema.",
      "//",
      "// STUB. Every function throws `NOT IMPLEMENTED`; nothing imports this module",
      "// yet. Step 1 of issue #1026's W2 workstream.",
      'import { readFile } from "node:fs/promises";',
    ].join("\n");
    expect(placeholderReasons(moduleHeader)).toEqual([
      "a header line opens with STUB",
      "claims its functions throw NOT IMPLEMENTED",
    ]);

    const testHeader = [
      "// These tests are the specification for src/db/schema-snapshot.ts. Every",
      "// function there throws `NOT IMPLEMENTED` today, so every test here fails —",
      "// #1026 W2 step 2's deliverable.",
      'import { test } from "bun:test";',
    ].join("\n");
    expect(placeholderReasons(testHeader)).toEqual([
      "claims its functions throw NOT IMPLEMENTED",
      "claims every test here fails",
    ]);

    expect(placeholderReasons("// Placeholder: these tests fail by design.\nexport {};")).toEqual([
      "claims its tests fail by design",
    ]);
  });

  test("RED CONTROL: the directory scan finds a planted header, and ignores the same words below the header", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-no-stub-headers-"));
    try {
      mkdirSync(join(root, "src", "db", "nested"), { recursive: true });
      writeFileSync(join(root, "src", "db", "nested", "planted.ts"), "// STUB. Nothing here works yet.\nexport {};\n");
      writeFileSync(
        join(root, "src", "db", "prose.ts"),
        "// A real module.\nexport const note = 1;\n// STUB. Every function throws `NOT IMPLEMENTED` (quoted history).\n",
      );
      expect(offenders(root, ["src/db"])).toEqual([
        { file: join("src", "db", "nested", "planted.ts"), reasons: ["a header line opens with STUB"] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ordinary prose that shares a word is not a placeholder header", () => {
    expect(placeholderReasons("// Every test in append-only-enforcement.test.ts passed throughout.\nexport {};")).toEqual([]);
    expect(placeholderReasons("// RED CONTROL. Every test here fails against the pre-#709 tree.\nexport {};")).toEqual([]);
    expect(placeholderReasons("// Offline: `globalThis.fetch` is stubbed and the real fetcher runs.\nexport {};")).toEqual([]);
  });
});
