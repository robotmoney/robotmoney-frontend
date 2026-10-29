// The archive tool's import boundary (issue 1477): csvb lives in robotmoney-frontend but is a client of the analyst
// SDK's format 1 module only. No file under packages/csvb/src imports from backend/ (and so none reaches the API's
// store, database client or secrets). The SDK never imports csvb (scripts/tests/unit/analyst-sdk-purity.test.ts).
// A planted violation must be caught, so a scanner that matches nothing cannot pass.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const BACKEND = resolve(import.meta.dir, "..", "..", "..", "backend");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

/** The module specifiers a file names that resolve into backend/, or name it. */
function backendImports(file: string, code: string): string[] {
  const out: string[] = [];
  const re = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|^\s*import\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const spec = (m[1] ?? m[2] ?? m[3] ?? m[4])!;
    const into = spec.startsWith(".") ? resolve(file, "..", spec) : spec;
    if (into === BACKEND || into.startsWith(BACKEND + "/") || /(^|\/)backend\//.test(spec) || spec.startsWith("@robotmoney/backend")) out.push(spec);
  }
  return out;
}

describe("csvb imports nothing from backend/", () => {
  test("no file under packages/csvb/src imports from backend/", () => {
    const files = tsFiles(SRC);
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap((f) => backendImports(f, readFileSync(f, "utf8")).map((s) => `${relative(SRC, f)}: ${s}`));
    expect(hits).toEqual([]);
  });

  test("red control: a planted backend import is reported, relative or by path", () => {
    const at = join(SRC, "audit", "x.ts");
    expect(backendImports(at, `import { sql } from "../../../../backend/src/db/client.ts";`)).toEqual(["../../../../backend/src/db/client.ts"]);
    expect(backendImports(at, `const m = await import("backend/src/analytics/store/public-archive-store.ts");`)).toHaveLength(1);
    expect(backendImports(at, `import { encodeCsvRow } from "@robotmoney/analyst-sdk/src/archive/format1.ts";`)).toEqual([]);
  });
});
