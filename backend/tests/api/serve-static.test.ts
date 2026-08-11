import { test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic } from "../../src/api/static.ts";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "serve-static-test-"));

  mkdirSync(join(tempDir, "assets"), { recursive: true });
  writeFileSync(join(tempDir, "index.html"), "<html><body>SPA Shell</body></html>");
  writeFileSync(join(tempDir, "assets", "style.css"), "body { color: red; }");
  writeFileSync(join(tempDir, "assets", "app.js"), "console.log('app');");

  // A deployed STATIC_DIR is an ASSEMBLED dir (scripts/static-assembly.sh): it
  // carries a prerendered <route>/index.html per sitemap route alongside the
  // home-page shell. Mirror that shape so the route-shell selection is
  // exercised, not just the fallback.
  mkdirSync(join(tempDir, "research", "late-cycle-signals"), { recursive: true });
  writeFileSync(
    join(tempDir, "research", "late-cycle-signals", "index.html"),
    "<html><head><title>Late-Cycle Signals</title></head><body>Prerendered</body></html>",
  );
  mkdirSync(join(tempDir, "views", "docs", "skill"), { recursive: true });
  writeFileSync(join(tempDir, "views", "docs", "skill", "installation.html"), "<p>install fragment</p>");
  mkdirSync(join(tempDir, "docs", "skill", "installation"), { recursive: true });
  writeFileSync(
    join(tempDir, "docs", "skill", "installation", "index.html"),
    '<html><head><title>Installation</title></head><body><main id="view"></main></body></html>',
  );
});

afterAll(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("serveStatic sets Cache-Control: no-cache for index.html directly", async () => {
  const res = await serveStatic("/index.html", tempDir);
  expect(res).not.toBeNull();
  expect(res?.status).toBe(200);
  expect(res?.headers.get("Cache-Control")).toBe("no-cache");
});

test("serveStatic sets Cache-Control: no-cache for root path /", async () => {
  const res = await serveStatic("/", tempDir);
  expect(res).not.toBeNull();
  expect(res?.status).toBe(200);
  expect(res?.headers.get("Cache-Control")).toBe("no-cache");
});

test("serveStatic gives SPA documents a same-origin script policy and enables WebAuthn", async () => {
  const res = await serveStatic("/admin", tempDir);
  const policy = res?.headers.get("Content-Security-Policy");

  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("script-src 'self' 'unsafe-eval'");
  expect(policy?.match(/script-src ([^;]+)/)?.[1]).not.toContain("https:");
  expect(policy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  expect(policy).toContain("font-src 'self' data: https://fonts.gstatic.com");
  expect(res?.headers.get("Permissions-Policy")).toBe(
    "publickey-credentials-get=(self), publickey-credentials-create=(self)",
  );
  expect(res?.headers.get("X-Content-Type-Options")).toBe("nosniff");
});

test("serveStatic sets Cache-Control: no-cache for SPA client route fallback", async () => {
  const res = await serveStatic("/swarm/2026-07-30/subject", tempDir);
  expect(res).not.toBeNull();
  expect(res?.status).toBe(200);
  expect(res?.headers.get("Cache-Control")).toBe("no-cache");
});

test("serveStatic sets Cache-Control: public, max-age=300 for non-HTML static assets", async () => {
  const cssRes = await serveStatic("/assets/style.css", tempDir);
  expect(cssRes).not.toBeNull();
  expect(cssRes?.status).toBe(200);
  expect(cssRes?.headers.get("Cache-Control")).toBe("public, max-age=300");

  const jsRes = await serveStatic("/assets/app.js", tempDir);
  expect(jsRes).not.toBeNull();
  expect(jsRes?.status).toBe(200);
  expect(jsRes?.headers.get("Cache-Control")).toBe("public, max-age=300");
});

test("serveStatic returns null when asset does not exist and path has file extension", async () => {
  const res = await serveStatic("/assets/nonexistent.png", tempDir);
  expect(res).toBeNull();
});

// Issue #480: an extensionless route used to fall straight to the home-page
// shell, so every link unfurler read the home page's metadata for every URL.
test("serveStatic serves the prerendered <route>/index.html for an extensionless route that has one", async () => {
  const res = await serveStatic("/research/late-cycle-signals", tempDir);
  expect(res).not.toBeNull();
  expect(res?.status).toBe(200);
  expect(res?.headers.get("Cache-Control")).toBe("no-cache");
  const body = await res!.text();
  expect(body).toContain("<title>Late-Cycle Signals</title>");
  expect(body).not.toContain("SPA Shell");
});

test("serveStatic falls back to the home-page shell for an extensionless route with no prerendered file", async () => {
  const res = await serveStatic("/not-in-the-sitemap", tempDir);
  expect(res).not.toBeNull();
  const body = await res!.text();
  expect(body).toContain("SPA Shell");
});

test("serveStatic inlines the docs fragment into that docs route's PRERENDERED shell", async () => {
  const res = await serveStatic("/docs/skill/installation", tempDir);
  expect(res).not.toBeNull();
  const body = await res!.text();
  // Both halves: the route's own crawler metadata AND the fragment in the view.
  expect(body).toContain("<title>Installation</title>");
  expect(body).toContain("<p>install fragment</p>");
  expect(body).not.toContain("SPA Shell");
});
