// Issue 1561 (D81): WEB_CONTENT_PATHS covers everything the site is built from.
//
// The list is two things at once: bun smoke:web's source identity (the plan id
// hashes those trees) and the web content release line's eligibility rule (a
// release may change only those paths). A file the assembly reads that is
// missing from the list would let a content release ship a change no plan id
// sees, and a backend file wrongly in it would let a backend change ship
// without a platform release. So: every file scripts/static-assembly.sh runs,
// and every relative import those files reach, lies inside the list.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { WEB_CONTENT_PATHS } from "../../lib/website-release.ts";
import { classifyContentDiff, isContentPath } from "../../release/web-release-lib.ts";

const ROOT = join(import.meta.dir, "../../..");
const ASSEMBLY = "scripts/static-assembly.sh";

/** The repository paths static-assembly.sh names on its command lines (comments left out). */
function assemblyInputs(): string[] {
  const out = new Set<string>([ASSEMBLY]);
  for (const line of readFileSync(join(ROOT, ASSEMBLY), "utf8").split("\n")) {
    if (line.trim().startsWith("#")) continue;
    for (const m of line.matchAll(/(?:^|[\s"'])((?:scripts|frontend)\/[A-Za-z0-9_./-]+)/g)) out.add(m[1]!.replace(/\/\.?$/, ""));
  }
  return [...out];
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** Every repository file reachable from `start` by relative imports, start included. */
function closure(start: string): string[] {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|js|mjs)$/.test(file)) continue;
    // Comments name modules too (JSDoc `import("./x").T`); only code imports count.
    const text = readFileSync(join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = relative(ROOT, resolve(dirname(join(ROOT, file)), m[1]!));
      if (!existsSync(join(ROOT, target))) throw new Error(`${file} imports ${m[1]}, which does not exist`);
      queue.push(target);
    }
  }
  return [...seen];
}

describe("WEB_CONTENT_PATHS", () => {
  const inputs = assemblyInputs();

  test("the assembly's command lines name the scripts it runs and the client it copies", () => {
    for (const p of ["frontend/public", "scripts/web-client/version.ts", "scripts/stamp-assets.ts", "scripts/prerender.ts", "scripts/static-manifest.ts"]) {
      expect(inputs).toContain(p);
    }
  });

  test("every file static-assembly.sh runs, and every relative import they reach, lies in WEB_CONTENT_PATHS", () => {
    const files = inputs.filter((p) => statSync(join(ROOT, p)).isFile()).flatMap(closure);
    expect(files.length).toBeGreaterThan(inputs.length);
    expect(files).toContain("scripts/lib/regime-snapshot.ts");
    expect(files).toContain("scripts/lib/contract-freshness.ts");
    expect(classifyContentDiff([...inputs, ...files]).offending).toEqual([]);
  });

  test("every entry exists, and no entry is a backend, contract, server or lockfile path", () => {
    for (const p of WEB_CONTENT_PATHS) expect(existsSync(join(ROOT, p))).toBe(true);
    for (const p of ["backend/src/api/index.ts", "contract/src/routes.js", "website-server/nginx.conf", "bun.lock", "docker-compose.yml", "package.json"]) {
      expect(isContentPath(p)).toBe(false);
    }
  });
});
