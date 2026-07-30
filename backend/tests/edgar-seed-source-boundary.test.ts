// Source-boundary coverage for the EDGAR/MNA seed CLI entrypoints (issue
// #108): backend/scripts/edgar-seed-{bootstrap,repopulate,regenerate}.ts must
// carry ZERO database access — no db/client.ts or db/worker-client.ts import,
// no `postgres` import, no SQL tag, no analytics store-writer import. These
// three files live OUTSIDE backend/src/analytics/**, so they are not covered
// by tests/analytics-api-boundary.test.ts's directory scan (which already
// covers the new src/analytics/edgar-seed-loader.ts and
// src/analytics/extract/edgar-seed{,-generator}.ts modules).
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS_DIR = join(import.meta.dir, "..", "scripts");
const EDGAR_SEED_SCRIPTS = ["edgar-seed-bootstrap.ts", "edgar-seed-repopulate.ts", "edgar-seed-regenerate.ts"];

interface Violation {
  file: string;
  line: number;
  text: string;
}

function scan(files: string[]): Violation[] {
  const patterns = [
    { re: /from\s+["'][^"']*db\/client(\.ts)?["']/, why: "imports db/client" },
    { re: /from\s+["'][^"']*db\/worker-client(\.ts)?["']/, why: "imports db/worker-client" },
    { re: /from\s+["']postgres["']/, why: "imports postgres directly" },
    { re: /\b(sql|tx|db)`/, why: "uses a SQL tag" },
    { re: /from\s+["'][^"']*analytics\/store\/[^"']*["']|from\s+["']\.\.?\/store\/[^"']*["']|from\s+["']\.\.?\/\.\.\/store\/[^"']*["']/, why: "imports an analytics store writer" },
  ];
  const out: Violation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      const trimmed = text.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      for (const { re, why } of patterns) {
        if (re.test(text)) out.push({ file, line: i + 1, text: `${why}: ${trimmed}` });
      }
    });
  }
  return out;
}

test("edgar-seed loader/repopulation/generator CLI entrypoints carry zero database access", () => {
  const files = EDGAR_SEED_SCRIPTS.map((f) => join(SCRIPTS_DIR, f));
  expect(files.length).toBe(3); // canary — a future rename/removal must update this test
  const violations = scan(files);
  expect(violations).toEqual([]);
});

test("the root demo bootstrap orchestration (scripts/lib/demo-main.ts) gained NO new database access alongside its EDGAR-seed wiring", () => {
  // demo-main.ts already talks to postgres via `docker compose exec ... psql`
  // subprocess calls (never a JS SQL tag/import) — this only guards that the
  // NEW edgar-seed-bootstrap wiring didn't introduce a direct import.
  const file = join(import.meta.dir, "..", "..", "scripts", "lib", "demo-main.ts");
  const src = readFileSync(file, "utf8");
  expect(src).toContain('"analytics-producer", "bun", "run", "src/producer/index.ts", "seed"');
  expect(src).not.toMatch(/from\s+["'][^"']*db\/client(\.ts)?["']/);
  expect(src).not.toMatch(/from\s+["'][^"']*analytics\/store\/[^"']*["']/);
  expect(src).not.toMatch(/from\s+["']postgres["']/);
});
