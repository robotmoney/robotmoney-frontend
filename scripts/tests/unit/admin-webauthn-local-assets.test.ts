// Supply-chain regression guard for the operator-authenticated browser paths.
// Any remote executable import here would run with access to rm_admin_token.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const privilegedModules = [
  "frontend/public/assets/js/app/alpine/views/admin-surface.js",
  "frontend/public/assets/js/app/alpine/views/admin/shared.js",
  "frontend/public/assets/js/app/alpine/views/dash-gate.js",
];

test("privileged WebAuthn paths only import a same-origin client facade", () => {
  for (const relativePath of privilegedModules) {
    const source = readFileSync(join(repoRoot, relativePath), "utf8");
    expect(source).toMatch(/from ["'][^"']*lib\/webauthn-client\.js["'];/);
    expect(source).not.toMatch(/^\s*import(?:[\s\S]*?\sfrom\s*)?["']https?:\/\//m);
  }
});

test("the deployed shell and WebAuthn artifact contain no remote executable source", () => {
  const shell = readFileSync(join(repoRoot, "frontend/public/index.html"), "utf8");
  const artifact = join(repoRoot, "frontend/public/assets/js/vendor/simplewebauthn-browser-13.3.0.umd.min.js");

  expect(shell).toContain('src="/assets/js/vendor/simplewebauthn-browser-13.3.0.umd.min.js"');
  expect(shell).not.toMatch(/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i);
  expect(existsSync(artifact)).toBe(true);
  expect(readFileSync(artifact, "utf8").slice(0, 64)).toContain("@simplewebauthn/browser@13.3.0");
});
