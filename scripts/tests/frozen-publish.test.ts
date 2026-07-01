// Tests for the frozen-bundle publish step (issue #24): the self-contained
// guard and the timestamp-labelled artifact name. These run in CI via
// `bun run test` (root `bun test scripts/tests`), so they EXECUTE the real
// guard scanner and the real artifact-name derivation on every PR — no external
// resource, no silent skip. If the guard ever stops catching an external
// reference, or the artifact label stops carrying the manifest timestamp, one
// of these assertions goes red.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCss, scanSelfContained } from "../check-frozen-selfcontained.ts";
import {
  frozenArtifactName,
  frozenArtifactNameFromManifest,
  sanitizeStamp,
} from "../frozen-artifact-name.ts";

const scriptsDir = join(fileURLToPath(import.meta.url), "..", "..");
const repoRoot = join(scriptsDir, "..");
const guardCli = join(scriptsDir, "check-frozen-selfcontained.ts");

// A minimally realistic "clean" bundle: inlined script + style, offline-safe
// anchors, and a `new URL()` call that must NOT be mistaken for an external
// resource. Mirrors the shape the real bake produces.
const CLEAN_HTML = `<!doctype html><html><head>
<style>body{background:#000}.x{background:url('data:image/png;base64,AAAA')}</style>
</head><body>
<a href="https://x.com/RobotMoneyAgent">follow</a>
<img src="data:image/gif;base64,R0lGOD" alt="inline">
<script>const RM_FROZEN={};const u=new URL("https://api.example.com/v1");void u;</script>
</body></html>`;

describe("scanSelfContained", () => {
  test("passes a clean, fully-inlined bundle (anchors + new URL() are not resources)", () => {
    const { inspected, violations } = scanSelfContained(CLEAN_HTML);
    expect(inspected).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  test.each([
    ["script[src]", `<script src="https://cdn.example.com/app.js"></script>`],
    ["link[href]", `<link rel="stylesheet" href="https://cdn.example.com/a.css">`],
    ["media[src]", `<img src="http://cdn.example.com/pic.png">`],
    ["media[src]", `<iframe src="//evil.example.com/frame"></iframe>`],
    ["object[data]", `<object data="https://example.com/a.pdf"></object>`],
    ["use[href]", `<svg><use href="https://example.com/s.svg#i"/></svg>`],
    ["css@import", `<style>@import "https://fonts.example.com/f.css";</style>`],
    ["css-url()", `<style>.b{background:url(https://cdn.example.com/bg.png)}</style>`],
  ])("flags an external %s reference", (kind, html) => {
    const { violations } = scanSelfContained(html);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.kind === kind)).toBe(true);
  });

  test("does not flag a data: URI or protocol-relative anchor", () => {
    const html = `<a href="//x.com/p">n</a><img src="data:image/png;base64,AA">`;
    expect(scanSelfContained(html).violations).toEqual([]);
  });

  test("extractCss ignores JS URL() but keeps <style> url()", () => {
    const css = extractCss(`<script>new URL("https://a.example")</script><style>a{background:url(https://b.example/x)}</style>`);
    expect(css).not.toContain("a.example");
    expect(css).toContain("b.example");
  });
});

// End-to-end: the guard CLI must exit 0 on a clean bundle and non-zero (loudly)
// on missing / empty / external-referencing bundles — the exact behavior CI relies on.
describe("check-frozen-selfcontained CLI", () => {
  function run(target: string): { code: number; stderr: string; stdout: string } {
    const p = Bun.spawnSync(["bun", "run", guardCli, target], { cwd: repoRoot });
    return {
      code: p.exitCode ?? -1,
      stderr: new TextDecoder().decode(p.stderr),
      stdout: new TextDecoder().decode(p.stdout),
    };
  }

  test("exit 0 on a clean bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "frozen-ok-"));
    const f = join(dir, "index.html");
    writeFileSync(f, CLEAN_HTML);
    try {
      const r = run(f);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("self-contained");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exit 1 loudly on an external <script src>", () => {
    const dir = mkdtempSync(join(tmpdir(), "frozen-ext-"));
    const f = join(dir, "index.html");
    writeFileSync(f, `<html><head><script src="https://cdn.example.com/x.js"></script></head><body>x</body></html>`);
    try {
      const r = run(f);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("external resource reference");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exit 1 when the bundle is absent", () => {
    const r = run(join(tmpdir(), "definitely-not-here-" + Date.now(), "index.html"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not found");
  });

  test("exit 1 when the bundle is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "frozen-empty-"));
    const f = join(dir, "index.html");
    writeFileSync(f, "");
    try {
      const r = run(f);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("frozen artifact name (timestamp label)", () => {
  test("sanitizeStamp removes GitHub-artifact-illegal characters", () => {
    const stamp = sanitizeStamp("2026-07-01T18:05:09.546Z");
    expect(stamp).toBe("2026-07-01T18-05-09-546Z");
    expect(stamp).not.toMatch(/[":<>|*?/\\.\s]/);
  });

  test("frozenArtifactName interpolates the (sanitized) bake timestamp", () => {
    const name = frozenArtifactName("2026-07-01T18:05:09.546Z");
    expect(name).toBe("frozen-spa-2026-07-01T18-05-09-546Z");
    expect(name.startsWith("frozen-spa-")).toBe(true);
  });

  test("empty bakedAt is rejected loudly", () => {
    expect(() => frozenArtifactName("")).toThrow();
  });

  test("reads bakedAt from a frozen-manifest.json and labels the artifact with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "frozen-manifest-"));
    const bakedAt = "2026-06-30T09:15:00.000Z";
    writeFileSync(join(dir, "frozen-manifest.json"), JSON.stringify({ bakedAt, source: "fixtures" }));
    try {
      const name = frozenArtifactNameFromManifest(join(dir, "frozen-manifest.json"));
      // The label provably carries the manifest's bake timestamp.
      expect(name).toBe(`frozen-spa-${sanitizeStamp(bakedAt)}`);
      expect(name).toContain("2026-06-30T09-15-00-000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The publish workflow must actually wire the guard + timestamped artifact — a
// green unit test on the helpers is worthless if the YAML never calls them.
describe("frozen-publish workflow wiring", () => {
  const wf = readFileSync(join(repoRoot, ".github", "workflows", "frozen-publish.yml"), "utf8");

  test("bakes the offline bundle via frozen:fixtures", () => {
    expect(wf).toMatch(/frozen:fixtures|bake-frozen\.ts --fixtures/);
  });
  test("runs the self-contained guard", () => {
    expect(wf).toContain("scripts/check-frozen-selfcontained.ts");
  });
  test("derives the artifact name from the manifest timestamp via the shared helper", () => {
    expect(wf).toContain("scripts/frozen-artifact-name.ts");
  });
  test("uploads the dist/frozen directory as a named artifact", () => {
    expect(wf).toContain("actions/upload-artifact");
    expect(wf).toContain("path: dist/frozen");
  });
  test("declares its CI taxonomy class", () => {
    expect(wf).toMatch(/CI_CLASS:\s*feature-correctness/);
  });
});
