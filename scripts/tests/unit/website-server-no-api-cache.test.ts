// Issue 1629 (docs/technical/web-serving-architecture.md §3.4, R12): the web
// server stores no api response. The api keeps its own public analytics answers
// in process (backend/tests/api/public-analytics-cache.test.ts), so an nginx
// proxy_cache would only add a second store that survives an api deploy and
// can serve answers from old code. Checkout-only: this reads the tracked files.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

describe("website-server stores no api response", () => {
  test("`git grep -n proxy_cache -- website-server` returns nothing", () => {
    const r = spawnSync("git", ["grep", "-n", "proxy_cache", "--", "website-server"], { cwd: repoRoot, encoding: "utf8" });
    // git grep exits 1 when nothing matches, 0 with matches, and 128 or more on an error.
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toBe("");
  });

  test("the public analytics paths have no location of their own: the /api/ proxy carries them", () => {
    const conf = readFileSync(join(repoRoot, "website-server/nginx.conf"), "utf8").replace(/^\s*#.*$/gm, "");
    expect(conf).not.toMatch(/location[^{]*\/api\/public\/analytics/);
    expect(conf).toMatch(/location\s+\^~\s+\/api\/\s*\{/);
    expect(conf).not.toMatch(/X-Cache-Status/);
  });
});
