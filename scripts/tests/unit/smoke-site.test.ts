// scripts/lib/smoke-site.ts — which website an instance serves, and switching
// it by an atomic symlink rename (issue #1026, W7 preparation).
//
// Executed against real directories: the properties that matter are
// filesystem facts (a relative symlink, a rename, a directory that is never
// overwritten), and a mocked fs would assert the mock.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SITE_LINK, currentSite, installSite, placeSite, PREVIOUS_SITE_LINK, previousSite, siteIdOf, switchSite, WEB_DIR_NAME } from "../../lib/smoke-site.ts";
import { instancePaths } from "../../lib/smoke-state.ts";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "rm-smoke-site-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An assembled `_static` as scripts/static-assembly.sh leaves it: version.json + the content manifest. */
function assembled(root: string, name: string, opts: { version?: string; commit?: string; digest?: string; body?: string } = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "version.json"), JSON.stringify({ name: "@robotmoney/web-client", version: opts.version ?? "0.1.0", commit: opts.commit ?? "b10589b1" }));
  writeFileSync(join(dir, "index.html"), opts.body ?? "<h1>site</h1>");
  writeFileSync(join(dir, "docs", "index.html"), "<p>docs</p>");
  writeFileSync(join(dir, ".rm-static-manifest.json"), JSON.stringify({ schema: 1, digest: opts.digest ?? `sha256:${"a".repeat(64)}`, files: 3 }));
  return dir;
}

describe("siteIdOf — the site's identity is its /version.json", () => {
  test("is <version>-<commit>", () => {
    expect(siteIdOf(assembled(scratch(), "_static"))).toBe("0.1.0-b10589b1");
  });

  test("a site with no version.json, or an empty field, has no identity and refuses", () => {
    const root = scratch();
    const dir = assembled(root, "_static");
    writeFileSync(join(dir, "version.json"), JSON.stringify({ version: "0.1.0", commit: "" }));
    expect(() => siteIdOf(dir)).toThrow(/no version and commit/);
    rmSync(join(dir, "version.json"));
    expect(() => siteIdOf(dir)).toThrow(/missing or malformed/);
  });
});

describe("placeSite — copy in, then swap `current` by rename", () => {
  test("the first placement copies the site and makes it current through a RELATIVE symlink", () => {
    const root = scratch();
    const web = join(root, "web");
    const placed = placeSite(web, assembled(root, "_static"));
    expect(placed).toMatchObject({ siteId: "0.1.0-b10589b1", copied: true, swapped: true, previous: null });
    const link = join(web, CURRENT_SITE_LINK);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // Relative, so it resolves identically on the host and at /srv/web inside website-server.
    expect(readlinkSync(link)).toBe("0.1.0-b10589b1");
    expect(readFileSync(join(link, "docs", "index.html"), "utf8")).toBe("<p>docs</p>");
    expect(currentSite(web)).toBe("0.1.0-b10589b1");
  });

  test("placing the same site again copies nothing and swaps nothing", () => {
    const root = scratch();
    const web = join(root, "web");
    const staticDir = assembled(root, "_static");
    placeSite(web, staticDir);
    expect(placeSite(web, staticDir)).toMatchObject({ copied: false, swapped: false, previous: "0.1.0-b10589b1" });
  });

  test("a new version becomes current and the previous site directory is kept, untouched", () => {
    const root = scratch();
    const web = join(root, "web");
    placeSite(web, assembled(root, "_a"));
    const next = placeSite(web, assembled(root, "_b", { version: "0.2.0", commit: "c0ffee12", digest: `sha256:${"b".repeat(64)}` }));
    expect(next).toMatchObject({ siteId: "0.2.0-c0ffee12", copied: true, swapped: true, previous: "0.1.0-b10589b1" });
    expect(existsSync(join(web, "0.1.0-b10589b1", "index.html"))).toBe(true);
    expect(currentSite(web)).toBe("0.2.0-c0ffee12");
  });

  test("the same version and commit with different bytes (a dirty tree) gets its own directory, never overwriting the served one", () => {
    const root = scratch();
    const web = join(root, "web");
    placeSite(web, assembled(root, "_a", { body: "<h1>old</h1>" }));
    const dirty = placeSite(web, assembled(root, "_b", { body: "<h1>edited</h1>", digest: `sha256:${"c".repeat(64)}` }));
    expect(dirty.siteId).toBe(`0.1.0-b10589b1-${"c".repeat(12)}`);
    expect(readFileSync(join(web, "0.1.0-b10589b1", "index.html"), "utf8")).toBe("<h1>old</h1>");
    expect(readFileSync(join(web, CURRENT_SITE_LINK, "index.html"), "utf8")).toBe("<h1>edited</h1>");
  });

  test("the swap leaves no temporary link or staging directory behind", () => {
    const root = scratch();
    const web = join(root, "web");
    placeSite(web, assembled(root, "_static"));
    const leftovers = (Bun.spawnSync(["ls", "-A", web]).stdout.toString().trim().split("\n")).filter((n) => n.startsWith("."));
    expect(leftovers).toEqual([]);
  });

  test("a site without a content manifest refuses: it could not be told apart from a different one", () => {
    const root = scratch();
    const staticDir = assembled(root, "_static");
    rmSync(join(staticDir, ".rm-static-manifest.json"));
    expect(() => placeSite(join(root, "web"), staticDir)).toThrow(/manifest/);
  });
});

describe("currentSite — only placeSite writes `current`", () => {
  test("no current site yet is null", () => {
    expect(currentSite(join(scratch(), "web"))).toBeNull();
  });

  test("red control: a `current` that is a directory, or a link out of the web dir, refuses", () => {
    const root = scratch();
    const web = join(root, "web");
    mkdirSync(join(web, CURRENT_SITE_LINK), { recursive: true });
    expect(() => currentSite(web)).toThrow(/not a symlink/);
    rmSync(join(web, CURRENT_SITE_LINK), { recursive: true });
    symlinkSync("/srv/elsewhere", join(web, CURRENT_SITE_LINK));
    expect(() => currentSite(web)).toThrow(/not at a site directory/);
  });
});

describe("installSite + switchSite — the two halves `bun smoke:web` runs with a range check between them", () => {
  test("installSite puts the site in place WITHOUT making it current", () => {
    const root = scratch();
    const web = join(root, "web");
    placeSite(web, assembled(root, "_a"));
    const next = installSite(web, assembled(root, "_b", { version: "0.2.0", commit: "c0ffee12", digest: `sha256:${"b".repeat(64)}` }));
    expect(next).toMatchObject({ siteId: "0.2.0-c0ffee12", copied: true });
    expect(currentSite(web)).toBe("0.1.0-b10589b1");
  });

  test("move: the build directory is renamed into place, and removed when that exact site is already installed", () => {
    const root = scratch();
    const web = join(root, "web");
    mkdirSync(web);
    const build = assembled(web, ".build-1");
    expect(installSite(web, build, { move: true })).toMatchObject({ siteId: "0.1.0-b10589b1", copied: true });
    expect(existsSync(build)).toBe(false);
    const again = assembled(web, ".build-2");
    expect(installSite(web, again, { move: true })).toMatchObject({ siteId: "0.1.0-b10589b1", copied: false });
    expect(existsSync(again)).toBe(false);
  });

  test("switchSite records the old `current` as `previous` before swapping, as a relative symlink", () => {
    const root = scratch();
    const web = join(root, "web");
    placeSite(web, assembled(root, "_a"));
    installSite(web, assembled(root, "_b", { version: "0.2.0", commit: "c0ffee12", digest: `sha256:${"b".repeat(64)}` }));
    expect(switchSite(web, "0.2.0-c0ffee12")).toEqual({ swapped: true, previous: "0.1.0-b10589b1" });
    expect(readlinkSync(join(web, PREVIOUS_SITE_LINK))).toBe("0.1.0-b10589b1");
    expect(previousSite(web)).toBe("0.1.0-b10589b1");
    expect(currentSite(web)).toBe("0.2.0-c0ffee12");
    // Already current: nothing moves, `previous` included.
    expect(switchSite(web, "0.2.0-c0ffee12")).toEqual({ swapped: false, previous: "0.2.0-c0ffee12" });
    expect(previousSite(web)).toBe("0.1.0-b10589b1");
  });

  test("red control: switching to a site that is not installed, or to a reserved name, refuses and changes nothing", () => {
    const root = scratch();
    const web = join(root, "web");
    placeSite(web, assembled(root, "_a"));
    expect(() => switchSite(web, "9.9.9-missing")).toThrow(/not an installed site directory/);
    expect(() => switchSite(web, PREVIOUS_SITE_LINK)).toThrow(/not a site id/);
    expect(() => switchSite(web, "../elsewhere")).toThrow(/not a site id/);
    expect(currentSite(web)).toBe("0.1.0-b10589b1");
    expect(previousSite(web)).toBeNull();
  });

  test("red control: a `previous` that is not a symlink into the web dir refuses", () => {
    const root = scratch();
    const web = join(root, "web");
    mkdirSync(join(web, PREVIOUS_SITE_LINK), { recursive: true });
    expect(() => previousSite(web)).toThrow(/not a symlink/);
  });
});

describe("the web directory is the instance's, mounted by website-server", () => {
  test("instancePaths names it, and a created instance has it world-traversable for nginx", () => {
    const paths = instancePaths(scratch(), "rm_local_site", { create: true });
    expect(paths.webDir).toBe(join(paths.dir, WEB_DIR_NAME));
    expect(lstatSync(paths.webDir).mode & 0o777).toBe(0o755);
  });

  test("website-server mounts ${RM_INSTANCE_STATE_DIR}/web read-only, and nginx serves web/current", () => {
    const repo = join(import.meta.dir, "..", "..", "..");
    const compose = readFileSync(join(repo, "docker-compose.yml"), "utf8");
    const block = compose.slice(compose.indexOf("\n  website-server:\n"), compose.indexOf("\n  worker-analytics:\n"));
    expect(block).toMatch(/- \$\{RM_INSTANCE_STATE_DIR:\?[^}]*\}\/web:\/srv\/web:ro/);
    expect(block).not.toContain("./_static:/srv/frontend");
    const nginx = readFileSync(join(repo, "website-server", "nginx.conf"), "utf8");
    expect(nginx).toMatch(/^\s*root \/srv\/web\/current;/m);
    // Every existing surface is kept: the api and health proxies and the headers.
    for (const kept of ["location = /health", "location ^~ /api/", "Content-Security-Policy", "try_files $uri $uri/index.html /_shell.html /index.html;"]) {
      expect(nginx).toContain(kept);
    }
  });
});
