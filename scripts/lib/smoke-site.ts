// Which website an instance serves, and switching it without touching a
// container (issue #1026, W7 preparation).
//
// website-server used to bind-mount the checkout's `_static` directly. Two
// things followed from that. A rebuild of `_static` in the checkout (any
// `bun smoke`, any `scripts/static-assembly.sh` run, even one for another
// instance) changed what a RUNNING stack served underneath it, half-way through
// `find -delete` and `cp -R`. And there was no way to switch a site without
// replacing the api, because both services mounted the same path.
//
// Now each instance owns `web/` in its state directory (smoke-state.ts
// `InstancePaths.webDir`), mounted read-only at `/srv/web` in website-server:
//
//   web/<siteId>/     one immutable directory per assembled site
//   web/current       a RELATIVE symlink naming the one nginx serves
//
// nginx's root is `/srv/web/current` (website-server/nginx.conf). The symlink is
// relative so it resolves identically on the host and inside the container.
//
// SWITCHING IS A RENAME. A new site is copied into a temporary directory and
// renamed into place; `current` is replaced by writing a temporary symlink and
// renaming it over the old one. rename(2) is atomic, so a request sees the old
// site or the new one, never a partial tree and never a missing root.
//
// THE SITE ID is the web client's own identity from the assembled
// `/version.json` (scripts/web-client/version.ts): `<version>-<commit>`. A
// working tree with uncommitted frontend edits assembles different bytes under
// the same commit, so when `web/<version>-<commit>` already exists with a
// different content digest (`.rm-static-manifest.json`), the new site gets that
// digest as a suffix rather than overwriting a directory a running server may
// be serving from.
//
// Stable API: wave 4's `bun smoke:web` imports placeSite and currentSite.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** The web directory's name inside an instance directory (smoke-state.ts `InstancePaths.webDir`). */
export const WEB_DIR_NAME = "web";

/** The symlink, inside the web directory, that names the served site. */
export const CURRENT_SITE_LINK = "current";

/** The assembled site's content manifest (scripts/lib/static-manifest.ts STATIC_MANIFEST_FILENAME). */
const MANIFEST_FILE = ".rm-static-manifest.json";

/** What {@link placeSite} did. */
export interface PlacedSite {
  /** The site id now named by `current`. */
  readonly siteId: string;
  /** Absolute path of `web/<siteId>/`. */
  readonly dir: string;
  /** True when this call copied the site in; false when that exact site was already placed. */
  readonly copied: boolean;
  /** True when `current` changed (it was absent or named another site). */
  readonly swapped: boolean;
  /** The site `current` named before this call, or `null` when there was none. */
  readonly previous: string | null;
}

function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * The base site id of an assembled directory: `<version>-<commit>` from its
 * `/version.json`. Refuses a missing or malformed file, or an empty field: a
 * site with no identity cannot be told apart from the one it would replace.
 */
export function siteIdOf(staticDir: string): string {
  const file = join(staticDir, "version.json");
  let parsed: { version?: unknown; commit?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; commit?: unknown };
  } catch {
    throw new Error(`Refusing: ${file} is missing or malformed, so the assembled site has no identity to place it under.`);
  }
  const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
  const commit = typeof parsed.commit === "string" ? parsed.commit.trim() : "";
  if (version === "" || commit === "") {
    throw new Error(`Refusing: ${file} carries no version and commit, so the assembled site has no identity.`);
  }
  return `${sanitize(version)}-${sanitize(commit)}`;
}

/** The content digest an assembled site records, or `null` when it records none. */
function contentDigest(siteDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(siteDir, MANIFEST_FILE), "utf8")) as { digest?: unknown };
    return typeof manifest.digest === "string" && manifest.digest !== "" ? manifest.digest : null;
  } catch {
    return null;
  }
}

/**
 * The site `current` names, or `null` when no site has been placed.
 *
 * Refuses when `current` exists but is not a symlink, or points outside the web
 * directory: either would mean something other than this module wrote it, and
 * nginx would be serving an unknown tree.
 */
export function currentSite(webDir: string): string | null {
  const link = join(webDir, CURRENT_SITE_LINK);
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    return null;
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(`Refusing: ${link} exists but is not a symlink; only placeSite() may write it.`);
  }
  const target = readlinkSync(link);
  if (target.includes("/") || target === "." || target === "..") {
    throw new Error(`Refusing: ${link} points at ${target}, not at a site directory beside it.`);
  }
  return target;
}

/**
 * Place an assembled site in the instance's web directory and make it current.
 *
 * Copies `staticDir` to `web/<siteId>/` unless that exact site (same id, same
 * content digest) is already there, then swaps `current` to it when `current`
 * is absent or names another site. Both steps are write-to-temporary then
 * rename, so a concurrent reader never sees a partial state.
 *
 * Refuses: a `staticDir` with no identity ({@link siteIdOf}) or no content
 * digest; a `current` that {@link currentSite} refuses.
 */
export function placeSite(webDir: string, staticDir: string): PlacedSite {
  mkdirSync(webDir, { recursive: true, mode: 0o755 });
  const base = siteIdOf(staticDir);
  const digest = contentDigest(staticDir);
  if (digest === null) {
    throw new Error(`Refusing: ${join(staticDir, MANIFEST_FILE)} is missing, so a placed site could not be told apart from a different one.`);
  }
  const previous = currentSite(webDir);

  let siteId = base;
  if (existsSync(join(webDir, base)) && contentDigest(join(webDir, base)) !== digest) {
    // Same version and commit, different bytes: a dirty working tree.
    siteId = `${base}-${digest.replace(/^sha256:/, "").slice(0, 12)}`;
  }
  const dir = join(webDir, siteId);

  let copied = false;
  if (!existsSync(dir)) {
    const staging = join(webDir, `.staging-${siteId}-${randomBytes(4).toString("hex")}`);
    try {
      cpSync(staticDir, staging, { recursive: true });
      renameSync(staging, dir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    copied = true;
  } else if (contentDigest(dir) !== digest) {
    throw new Error(`Refusing: ${dir} already holds a different site; site directories are never overwritten.`);
  }

  let swapped = false;
  if (previous !== siteId) {
    const temporary = join(webDir, `.current-${randomBytes(4).toString("hex")}`);
    symlinkSync(siteId, temporary);
    try {
      renameSync(temporary, join(webDir, CURRENT_SITE_LINK));
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    swapped = true;
  }
  return { siteId, dir, copied, swapped, previous };
}
