import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "..", "..", "..");
const conf = readFileSync(join(repo, "website-server", "nginx.conf"), "utf8");
const headers =
  conf.match(/add_header\s+Content-Security-Policy\s+"([^"]*)"/g) ?? [];

function directives(): Record<string, string[]> {
  const m = /add_header\s+Content-Security-Policy\s+"([^"]*)"/.exec(conf);
  const out: Record<string, string[]> = {};
  for (const part of (m?.[1] ?? "").split(";")) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) out[name] = vals;
  }
  return out;
}

describe("website-server CSP", () => {
  const d = directives();

  test("exactly one Content-Security-Policy header", () => {
    expect(headers.length).toBe(1);
  });

  test("connect-src reaches Apps Script and nothing else new", () => {
    expect(d["connect-src"]).toEqual([
      "'self'",
      "https://script.google.com",
      "https://script.googleusercontent.com",
    ]);
    expect(d["connect-src"]).not.toContain("https://example.com");
  });

  test("script-src and frame-src allow Turnstile", () => {
    expect(d["script-src"]).toEqual([
      "'self'",
      "'unsafe-eval'",
      "https://challenges.cloudflare.com",
    ]);
    expect(d["frame-src"]).toEqual(["https://challenges.cloudflare.com"]);
  });

  test("other directives are unchanged", () => {
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["style-src"]).toEqual([
      "'self'",
      "'unsafe-inline'",
      "https://fonts.googleapis.com",
    ]);
    expect(d["img-src"]).toEqual(["'self'", "data:", "https:"]);
    expect(d["font-src"]).toEqual([
      "'self'",
      "data:",
      "https://fonts.gstatic.com",
    ]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["frame-ancestors"]).toEqual(["'self'"]);
  });
});
