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

test("serveStatic sets Cache-Control: no-cache for SPA client route fallback", async () => {
  const res = await serveStatic("/committee/2026-07-30/subject", tempDir);
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
