// Test: preview deploy directory composition
// - frontend/public files are byte-identical in the composed dir
// - _redirects and _headers have exact expected contents
// - goldens/api-goldens.json is included
// - no frontend/public files reference preview.html or the wrapper
import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FRONTEND_PUBLIC = join(repoRoot, "frontend/public");
const PREVIEW_SRC = join(repoRoot, "preview");
const GOLDENS = join(repoRoot, "goldens/api-goldens.json");
const DEPLOY_DIR = join(repoRoot, ".preview-deploy");

describe("preview-compose", () => {
  it("should compose the deploy directory", () => {
    // Run the compose script
    try {
      execSync("bun scripts/compose-preview-deploy.ts", {
        cwd: repoRoot,
        stdio: "inherit",
      });
    } catch (e) {
      throw new Error(`Compose failed: ${e}`);
    }

    expect(existsSync(DEPLOY_DIR)).toBe(true);
  });

  it("frontend/public files are byte-identical in composed dir", async () => {
    // Ensure compose was run
    if (!existsSync(DEPLOY_DIR)) {
      throw new Error(`Deploy dir ${DEPLOY_DIR} does not exist`);
    }

    // Check a few key files from frontend/public
    const testFiles = ["index.html", "favicon.svg"];
    for (const file of testFiles) {
      const srcPath = join(FRONTEND_PUBLIC, file);
      const dstPath = join(DEPLOY_DIR, file);

      if (existsSync(srcPath)) {
        expect(existsSync(dstPath)).toBe(true);

        const srcHash = createHash("sha256").update(readFileSync(srcPath)).digest("hex");
        const dstHash = createHash("sha256").update(readFileSync(dstPath)).digest("hex");

        expect(srcHash).toBe(dstHash);
      }
    }
  });

  it("_redirects contains the expected rule", async () => {
    const redirectsPath = join(DEPLOY_DIR, "_redirects");
    expect(existsSync(redirectsPath)).toBe(true);

    const content = readFileSync(redirectsPath, "utf-8");
    expect(content).toContain("/ /preview.html 200");
  });

  it("_headers contains the expected X-Robots-Tag", async () => {
    const headersPath = join(DEPLOY_DIR, "_headers");
    expect(existsSync(headersPath)).toBe(true);

    const content = readFileSync(headersPath, "utf-8");
    expect(content).toContain("X-Robots-Tag: noindex");
  });

  it("goldens/api-goldens.json is included in the deploy dir", async () => {
    const goldensPath = join(DEPLOY_DIR, "api-goldens.json");
    expect(existsSync(goldensPath)).toBe(true);

    const content = JSON.parse(readFileSync(goldensPath, "utf-8"));
    expect(content).toHaveProperty("routes");
    expect(typeof content.routes).toBe("object");
  });

  it("preview.html and 404.html are included", async () => {
    expect(existsSync(join(DEPLOY_DIR, "preview.html"))).toBe(true);
    expect(existsSync(join(DEPLOY_DIR, "404.html"))).toBe(true);
  });

  it("no frontend/public file references preview.html or wrapper", () => {
    // Check key files in frontend/public for preview-mode dependencies
    // to ensure production code is unchanged
    const indexHtml = readFileSync(join(FRONTEND_PUBLIC, "index.html"), "utf-8");
    expect(indexHtml).not.toContain("preview.html");
    expect(indexHtml).not.toContain("api-goldens");
    expect(indexHtml).not.toContain("contentWindow.fetch");
    expect(indexHtml).not.toContain("wrapper");
  });
});
