import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const page = readFileSync(join(root, "ops/cloudflare/offhost-fallback.html"), "utf8");
const descriptor = JSON.parse(readFileSync(join(root, "ops/cloudflare/error-pages.json"), "utf8")) as {
  customPages: Array<{ errorClass?: string; errorCode?: number; page: string }>;
};

describe("off-host fallback page", () => {
  test("is self-contained HTML with no external requests", () => {
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).not.toMatch(/https?:\/\//i);
    expect(page).not.toMatch(/<script|<link|<img|@import|url\(/i);
  });

  test("the Cloudflare descriptor references the page for 5xx and 1033", () => {
    const byKey = (f: (c: (typeof descriptor.customPages)[number]) => boolean) => descriptor.customPages.find(f);
    expect(byKey((c) => c.errorClass === "5xx")?.page).toBe("ops/cloudflare/offhost-fallback.html");
    expect(byKey((c) => c.errorCode === 1033)?.page).toBe("ops/cloudflare/offhost-fallback.html");
  });
});
