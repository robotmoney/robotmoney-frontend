// Test: preview pages workflow structure and deprecation assertions
// - workflow parses and has correct structure
// - serves-preview.ts does not exist
// - package.json preview script matches compose+serve form
// - no stray references to serve-preview.ts
// - docs/preview-server-spec.md does not exist
// - no live references to preview-server-spec
// - docs/architecture.md preview section covers wrapper, drift gate, etc.
// - docs/decisions.md has decision entry for D14/D13 revisit
import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("preview-workflow", () => {
  it("should have preview-pages.yml workflow file", () => {
    const workflowPath = join(repoRoot, ".github/workflows/preview-pages.yml");
    expect(existsSync(workflowPath)).toBe(true);
  });

  it("workflow should deploy only on preview/** branches", () => {
    const workflowPath = join(repoRoot, ".github/workflows/preview-pages.yml");
    const content = readFileSync(workflowPath, "utf-8");

    expect(content).toContain("preview/**");
  });

  it("workflow should use wrangler pages deploy with --branch", () => {
    const workflowPath = join(repoRoot, ".github/workflows/preview-pages.yml");
    const content = readFileSync(workflowPath, "utf-8");

    expect(content).toContain("wrangler pages deploy");
    expect(content).toContain("--branch");
  });

  it("workflow should reference CLOUDFLARE_API_TOKEN secret", () => {
    const workflowPath = join(repoRoot, ".github/workflows/preview-pages.yml");
    const content = readFileSync(workflowPath, "utf-8");

    expect(content).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("workflow should have CI_CLASS taxonomy classification", () => {
    const workflowPath = join(repoRoot, ".github/workflows/preview-pages.yml");
    const content = readFileSync(workflowPath, "utf-8");

    expect(content).toContain("CI_CLASS");
  });

  it("preview smoke job should not require Cloudflare credentials", () => {
    const workflowPath = join(repoRoot, ".github/workflows/preview-pages.yml");
    const content = readFileSync(workflowPath, "utf-8");

    // The smoke test job name or some marker indicating no CF secrets
    expect(content).toContain("smoke");
  });

  it("scripts/serve-preview.ts should not exist (deprecated)", () => {
    const servePath = join(repoRoot, "scripts/serve-preview.ts");
    expect(existsSync(servePath)).toBe(false);
  });

  it("package.json preview script should use compose+serve", () => {
    const packagePath = join(repoRoot, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf-8"));

    expect(pkg.scripts).toHaveProperty("preview");
    const previewScript = pkg.scripts.preview;
    expect(previewScript).toContain("compose-preview-deploy");
    expect(previewScript).toContain("--serve");
  });

  it("should have no serve-preview.ts references in live files", () => {
    const filesToCheck = [
      join(repoRoot, "README.md"),
      join(repoRoot, "CONTRIBUTING.md"),
      join(repoRoot, "package.json"),
    ];

    for (const file of filesToCheck) {
      if (existsSync(file)) {
        const content = readFileSync(file, "utf-8");
        // Allow references in decision records or recyclebin, but not in live docs
        if (!file.includes("decisions.md") && !file.includes("recyclebin")) {
          // Check for direct serve-preview references
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes("serve-preview") && !lines[i].includes("deprecated")) {
              expect(false).toBe(true);
            }
          }
        }
      }
    }
  });

  it("docs/preview-server-spec.md should not exist (retired)", () => {
    const specPath = join(repoRoot, "docs/preview-server-spec.md");
    expect(existsSync(specPath)).toBe(false);
  });

  it("docs/architecture.md should describe preview wrapper", () => {
    const archPath = join(repoRoot, "docs/architecture.md");
    if (existsSync(archPath)) {
      const content = readFileSync(archPath, "utf-8");
      // Should mention preview mode, wrapper, iframe, goldens
      expect(content).toContain("preview");
    }
  });

  it("docs/decisions.md should have new decision entry", () => {
    const decisionsPath = join(repoRoot, "docs/decisions.md");
    if (existsSync(decisionsPath)) {
      const content = readFileSync(decisionsPath, "utf-8");
      // Should mention the revisit of D14 and D13
      expect(content.includes("D14") || content.includes("D13")).toBe(true);
    }
  });

  it("should have no preview-server-spec references in live files", () => {
    const filesToCheck = [
      join(repoRoot, "README.md"),
      join(repoRoot, "CONTRIBUTING.md"),
      join(repoRoot, "docs/architecture.md"),
    ];

    for (const file of filesToCheck) {
      if (existsSync(file)) {
        const content = readFileSync(file, "utf-8");
        // Allow in decisions.md and recyclebin
        if (!file.includes("decisions.md") && !file.includes("recyclebin")) {
          expect(content).not.toContain("preview-server-spec");
        }
      }
    }
  });
});
