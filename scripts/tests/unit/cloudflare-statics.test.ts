// Trivial gate: scripts/cloudflare-statics.sh (the Cloudflare Pages dashboard
// build command) assembles _site with the key files in the documented layout.
// No byte-identity machinery — existence of the load-bearing files only.
import { afterAll, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const site = join(repoRoot, "_site");

describe("cloudflare-statics.sh", () => {
  it("assembles _site with the SPA, wrapper, goldens, and _redirects", () => {
    execSync("bash scripts/cloudflare-statics.sh", { cwd: repoRoot, stdio: "pipe" });
    for (const f of ["index.html", "preview/index.html", "goldens/api-goldens.json", "_redirects", "_headers", "404.html"]) {
      expect(existsSync(join(site, f))).toBe(true);
    }
  });

  afterAll(() => {
    rmSync(site, { recursive: true, force: true });
  });
});
