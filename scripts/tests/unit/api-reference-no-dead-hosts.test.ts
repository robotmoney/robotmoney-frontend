// Issue #354 compliance-FAIL regression guard.
//
// The prior PR (#328) claimed the swarm API reference no longer named
// either dead swarm.* host, but the claim was false: both strings still
// appeared verbatim inside an HTML COMMENT at api-reference.html:12 — a
// place no prior check looked, because nothing asserted on the file's raw
// text, only on its rendered/parsed structure. This test reads each file as
// plain text (comments included) so a dead hostname creeping back in
// anywhere — prose, table cell, or comment — turns the suite red.
//
// WIDENED from the single api-reference.html file to the WHOLE docs views
// tree. Scoping it to one file is what let the same defect survive next door:
// participation.html carried `swarm.staging.robotmoney.net` in five places,
// one of them (`export BACKEND_URL=...`) behind a COPY BUTTON, so a reader
// copied a command pointing at a host that answers DEPLOYMENT_NOT_FOUND. A
// per-file allowlist cannot catch a file nobody remembered to add, so the file
// list is DISCOVERED from the directory instead of enumerated here.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const DOCS_VIEWS_DIR = "frontend/public/views/docs";

/** Every .html under the docs views tree, recursively, as repo-relative paths. */
function docsViewFiles(): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".html")) out.push(relative(repoRoot, child));
    }
  };
  walk(join(repoRoot, DOCS_VIEWS_DIR));
  return out.sort();
}

const FILES = docsViewFiles();

// The two hostnames the audit found dead (both answer DEPLOYMENT_NOT_FOUND).
// Kept as plain strings (not a shared constant) so this test still catches a
// literal reintroduction even if some other module's copy of the string ever
// changed.
const DEAD_HOSTS = ["swarm.robotmoney.net", "swarm.staging.robotmoney.net"];

describe("no docs view names a dead swarm.* API host", () => {
  // Canary against a vacuous pass: discovery must actually have found the
  // tree, and must include the two files this guard was written for. Without
  // this, a renamed/moved directory would make every assertion below vacuous.
  test("discovery found the docs views, including the two files this guard exists for", () => {
    expect(FILES.length).toBeGreaterThan(1);
    expect(FILES).toContain("frontend/public/views/docs/investment-swarm/api-reference.html");
    expect(FILES).toContain("frontend/public/views/docs/investment-swarm/participation.html");
  });

  for (const rel of FILES) {
    describe(rel, () => {
      const raw = read(rel);

      // Per-file canary: an empty file must not be able to pass silently.
      test("the file is non-empty", () => {
        expect(raw.length).toBeGreaterThan(0);
      });

      for (const host of DEAD_HOSTS) {
        test(`does not contain "${host}" anywhere, including inside comments`, () => {
          expect(raw).not.toContain(host);
        });
      }

      // Belt-and-suspenders: a pattern match in addition to the literal
      // toContain() checks above, so a future edit that varies casing/whitespace
      // around the dead hostnames still trips this guard.
      test("no swarm.*.robotmoney.net pattern appears anywhere in the file", () => {
        expect(raw).not.toMatch(/swarm\.(?:staging\.)?robotmoney\.net/i);
      });
    });
  }
});
