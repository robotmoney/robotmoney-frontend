// scripts/lib/website-redeploy.ts: the checks behind `bun run site:redeploy`. Each one is what stands between a
// broken site and a live one, so each is proven on a real directory, including the failure it exists to catch.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBuild, diffContainers, diffManifests, guardChangedFiles, manifestOf, parseSitemapRoutes, routeFile, rsyncArgs,
  sameManifest, stylesheetStampProblems, walk,
} from "../../lib/website-redeploy.ts";

const made: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "site-redeploy-test-"));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hash8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const SITEMAP = `<urlset>
  <url><loc>https://robotmoney.network/</loc></url>
  <url><loc>https://robotmoney.network/regime</loc></url>
  <url><loc>https://robotmoney.network/docs/skill/agent-basket</loc></url>
</urlset>`;

/** A minimal assembled site that passes every check; tests break one thing at a time. */
function goodSite(dir: string, commit = "abcd1234") {
  const css = "body{margin:0}";
  mkdirSync(join(dir, "assets/css"), { recursive: true });
  writeFileSync(join(dir, "assets/css/views.css"), css);
  writeFileSync(join(dir, "index.html"), `<link rel="stylesheet" href="/assets/css/views.css?v=${hash8(css)}" />`);
  writeFileSync(join(dir, "version.json"), JSON.stringify({ name: "@robotmoney/web-client", version: "0.1.0", commit }));
  for (const r of ["regime", "docs/skill/agent-basket"]) {
    mkdirSync(join(dir, r), { recursive: true });
    writeFileSync(join(dir, r, "index.html"), "<html></html>");
  }
  for (let i = 0; i < 12; i++) writeFileSync(join(dir, `f${i}.txt`), String(i));
}

describe("sitemap and route files", () => {
  test("reads every <loc> as a path, '/' for the home page", () => {
    expect(parseSitemapRoutes(SITEMAP)).toEqual(["/", "/regime", "/docs/skill/agent-basket"]);
  });
  test("an origin written with regex characters matches literally (robotmoney.net must not match robotmoney.network)", () => {
    expect(parseSitemapRoutes("<loc>https://robotmoney.network/work</loc>", "https://robotmoney.net")).toEqual([]);
  });
  test("the assembler's file for a route", () => {
    expect(routeFile("/")).toBe("index.html");
    expect(routeFile("/regime")).toBe("regime/index.html");
    expect(routeFile("/docs/skill/agent-basket/")).toBe("docs/skill/agent-basket/index.html");
  });
});

describe("stylesheet stamps", () => {
  const read = (files: Record<string, string>) => (rel: string) => (rel in files ? Buffer.from(files[rel]!) : null);
  test("a stamp equal to the file's sha256 prefix is fine", () => {
    const css = "a{}";
    expect(stylesheetStampProblems(`href="/assets/css/a.css?v=${hash8(css)}"`, read({ "assets/css/a.css": css }))).toEqual([]);
  });
  test("a stale stamp names the file, the stamp and the real hash", () => {
    const p = stylesheetStampProblems(`href="/assets/css/a.css?v=deadbeef"`, read({ "assets/css/a.css": "a{}" }));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("?v=deadbeef");
    expect(p[0]).toContain(hash8("a{}"));
  });
  test("an unstamped link, a missing file and a page with no stylesheet are all problems", () => {
    expect(stylesheetStampProblems(`href="/assets/css/a.css"`, read({ "assets/css/a.css": "a{}" }))).toHaveLength(1);
    expect(stylesheetStampProblems(`href="/assets/css/b.css?v=00000000"`, read({}))[0]).toContain("missing from the build");
    expect(stylesheetStampProblems("<html></html>", read({}))).toEqual(["index.html links no stylesheet"]);
  });
});

describe("checkBuild", () => {
  test("a complete site passes", () => {
    const d = tmp();
    goodSite(d);
    expect(checkBuild({ dir: d, headSha: "abcd1234ffff", sitemapXml: SITEMAP, liveEntryCount: 20 })).toEqual([]);
  });
  test("an empty directory is 'the assembly did not run', not a list of a hundred missing routes", () => {
    const d = tmp();
    expect(checkBuild({ dir: d, headSha: "abcd1234", sitemapXml: SITEMAP })).toEqual([`${d} has no index.html: the assembly did not run`]);
  });
  test("a version.json from another commit is caught", () => {
    const d = tmp();
    goodSite(d, "99999999");
    expect(checkBuild({ dir: d, headSha: "abcd1234ffff", sitemapXml: SITEMAP }).join("\n")).toContain("version.json says commit 99999999");
  });
  test("a route that was not prerendered is caught", () => {
    const d = tmp();
    goodSite(d);
    rmSync(join(d, "regime"), { recursive: true });
    expect(checkBuild({ dir: d, headSha: "abcd1234ffff", sitemapXml: SITEMAP }).join("\n")).toContain("1 sitemap route(s) were not prerendered: /regime");
  });
  test("a stale stylesheet stamp is caught", () => {
    const d = tmp();
    goodSite(d);
    writeFileSync(join(d, "assets/css/views.css"), "body{margin:1px}");
    expect(checkBuild({ dir: d, headSha: "abcd1234ffff", sitemapXml: SITEMAP }).join("\n")).toContain("views.css");
  });
  test("a symlink is refused: a bind-mounted site must not contain one", () => {
    const d = tmp();
    goodSite(d);
    symlinkSync("/etc/passwd", join(d, "leak"));
    expect(checkBuild({ dir: d, headSha: "abcd1234ffff", sitemapXml: SITEMAP }).join("\n")).toContain("symlinks");
  });
  test("a build far smaller than the live site is refused", () => {
    const d = tmp();
    goodSite(d);
    expect(checkBuild({ dir: d, headSha: "abcd1234ffff", sitemapXml: SITEMAP, liveEntryCount: 400 }).join("\n")).toContain("too small to be the whole site");
  });
});

describe("manifests", () => {
  test("diffManifests names what a swap adds, changes and removes; sameManifest is true only for identical trees", () => {
    const a = tmp();
    const b = tmp();
    writeFileSync(join(a, "keep"), "1");
    writeFileSync(join(a, "change"), "old");
    writeFileSync(join(a, "gone"), "x");
    writeFileSync(join(b, "keep"), "1");
    writeFileSync(join(b, "change"), "new");
    writeFileSync(join(b, "new"), "y");
    const d = diffManifests(manifestOf(a), manifestOf(b));
    expect(d).toEqual({ added: ["new"], changed: ["change"], removed: ["gone"] });
    expect(sameManifest(manifestOf(a), manifestOf(b))).toBe(false);
    expect(sameManifest(manifestOf(b), manifestOf(b))).toBe(true);
  });
  test("rsync's holding directories are not part of the site", () => {
    const d = tmp();
    mkdirSync(join(d, ".~tmp~"), { recursive: true });
    writeFileSync(join(d, ".~tmp~", "half"), "x");
    writeFileSync(join(d, "real"), "y");
    expect(walk(d)).toEqual(["real"]);
  });
});

describe("diffContainers: the proof that only the website moved", () => {
  const c = (name: string, id = "a".repeat(64), startedAt = "2026-09-29T22:26:38Z") => ({ name, id, startedAt });
  test("identical ids and start times are no problem", () => {
    expect(diffContainers([c("p-api-1"), c("p-web-1")], [c("p-web-1"), c("p-api-1")])).toEqual([]);
  });
  test("a restart (same id, new start time) is caught", () => {
    const p = diffContainers([c("p-api-1")], [c("p-api-1", "a".repeat(64), "2026-09-30T00:00:00Z")]);
    expect(p).toEqual(["p-api-1 was restarted (2026-09-29T22:26:38Z -> 2026-09-30T00:00:00Z)"]);
  });
  test("a recreation (new id), a vanished container and a new container are all caught", () => {
    const p = diffContainers([c("p-api-1"), c("p-worker-1")], [c("p-api-1", "b".repeat(64)), c("p-extra-1")]);
    expect(p.join("\n")).toContain("p-api-1 was recreated");
    expect(p.join("\n")).toContain("p-worker-1 was running and is gone");
    expect(p.join("\n")).toContain("p-extra-1 is new");
  });
});

describe("guardChangedFiles", () => {
  test("a change to the nginx image blocks; a compose change only warns; frontend changes are fine", () => {
    const g = guardChangedFiles(["frontend/public/index.html", "website-server/nginx.conf", "docker-compose.yml", "docker-compose.stage.yml", "backend/src/x.ts"]);
    expect(g.blockers).toEqual(["website-server/nginx.conf"]);
    expect(g.warnings).toEqual(["docker-compose.yml", "docker-compose.stage.yml"]);
    expect(guardChangedFiles(["frontend/public/index.html"])).toEqual({ blockers: [], warnings: [] });
  });
});

describe("rsyncArgs", () => {
  test("swaps the CONTENTS of one directory into another, near-atomically, and never replaces the directory", () => {
    const a = rsyncArgs("/build/", "/live/_static");
    expect(a.slice(0, 2)).toEqual(["rsync", "-a"]);
    expect(a).toContain("--delay-updates");
    expect(a).toContain("--delete-after");
    expect(a).toContain("--checksum");
    expect(a.slice(-2)).toEqual(["/build/", "/live/_static/"]);
    expect(a).not.toContain("--delete");
  });
  test("modes are 755 for directories and 644 for files, in the one unambiguous form", () => {
    // Regression: `--chmod=Du=rwx,go=rx,Fu=rw,go=r` ended every directory at 744 (the last clause applies to
    // directories too) and nginx in the container could not enter any of them: the whole site answered 500.
    const chmod = rsyncArgs("/b", "/l").filter((x) => x.startsWith("--chmod"));
    expect(chmod).toEqual(["--chmod=D755,F644"]);
  });
  test("a rollback keeps the backup's own modes instead of normalising them", () => {
    expect(rsyncArgs("/b", "/l", { keepModes: true }).some((x) => x.startsWith("--chmod"))).toBe(false);
  });
});
