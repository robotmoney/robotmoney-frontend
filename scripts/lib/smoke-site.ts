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
// EXCHANGING it with the old one (renameat2 RENAME_EXCHANGE), then removing the
// temporary name, which now holds the old link. A request sees the old site or
// the new one, never a partial tree and never a missing root.
//
// Why an exchange and not a plain rename over the old link: on Linux (6.8,
// ext4, measured 2026-09-25) an open() through `current` that races a
// rename(2) replacing it fails with ENOENT now and then — a few times per
// thousand switches — because the replaced entry is briefly gone for a path
// walk already in flight. An exchange never removes either name, and the same
// measurement saw no error. Where renameat2 is unavailable (not Linux, or a
// filesystem that refuses the flag) the switch falls back to rename(2).
//
// THE SITE ID is the web client's own identity from the assembled
// `/version.json` (scripts/web-client/version.ts): `<version>-<commit>`. A
// working tree with uncommitted frontend edits assembles different bytes under
// the same commit, so when `web/<version>-<commit>` already exists with a
// different content digest (`.rm-static-manifest.json`), the new site gets that
// digest as a suffix rather than overwriting a directory a running server may
// be serving from.
//
//   web/previous      a relative symlink naming the site `current` named before
//                     its last switch, so `bun smoke:web --rollback` can return
//
// Every switch records `previous` first and then swaps `current`, whichever
// tool made it (`bun smoke` through placeSite, `bun smoke:web` through
// installSite + switchSite). An interruption between the two renames leaves
// `previous` equal to `current`, which a rollback refuses rather than guesses.
//
// Stable API: `bun smoke` (scripts/stack/stack.ts) calls placeSite; `bun
// smoke:web` (scripts/lib/website-release.ts) calls installSite, switchSite,
// currentSite and previousSite.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** The web directory's name inside an instance directory (smoke-state.ts `InstancePaths.webDir`). */
export const WEB_DIR_NAME = "web";

/** The symlink, inside the web directory, that names the served site. */
export const CURRENT_SITE_LINK = "current";

/** The symlink, inside the web directory, that names the site served before the last switch. */
export const PREVIOUS_SITE_LINK = "previous";

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
 * The site directory a link in the web directory names, or `null` when the
 * link is absent. Refuses a link that is not a symlink, or that points outside
 * the web directory: either would mean something other than this module wrote
 * it, and nginx would be serving an unknown tree.
 */
function readSiteLink(webDir: string, name: string): string | null {
  const link = join(webDir, name);
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    return null;
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(`Refusing: ${link} exists but is not a symlink; only this module (scripts/lib/smoke-site.ts) may write it.`);
  }
  const target = readlinkSync(link);
  if (target.includes("/") || target === "." || target === ".." || target.startsWith(".")) {
    throw new Error(`Refusing: ${link} points at ${target}, not at a site directory beside it.`);
  }
  return target;
}

/**
 * renameat2(RENAME_EXCHANGE) through libc, or null where it cannot be had.
 * Resolved on first use, never at import: importing this module opens nothing.
 */
let exchangeNames: ((a: string, b: string) => boolean) | null | undefined;
function renameExchange(): ((a: string, b: string) => boolean) | null {
  if (exchangeNames !== undefined) return exchangeNames;
  exchangeNames = null;
  if (process.platform !== "linux") return exchangeNames;
  try {
    const libc = dlopen("libc.so.6", {
      renameat2: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
    });
    const AT_FDCWD = -100;
    const RENAME_EXCHANGE = 2;
    const cstring = (value: string) => ptr(Buffer.from(`${value}\0`));
    exchangeNames = (a, b) => libc.symbols.renameat2(AT_FDCWD, cstring(a), AT_FDCWD, cstring(b), RENAME_EXCHANGE) === 0;
  } catch {
    exchangeNames = null;
  }
  return exchangeNames;
}

/**
 * Point `name` at `siteId`: write a temporary symlink, then exchange it with
 * the old link (the temporary name then holds the old link and is removed), or
 * rename it into place when there is no old link or no exchange (header).
 */
function writeSiteLink(webDir: string, name: string, siteId: string): void {
  const temporary = join(webDir, `.${name}-${randomBytes(4).toString("hex")}`);
  const link = join(webDir, name);
  symlinkSync(siteId, temporary);
  try {
    const exchange = renameExchange();
    if (exchange !== null && lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() && exchange(temporary, link)) {
      unlinkSync(temporary);
      return;
    }
    renameSync(temporary, link);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * The site `current` names, or `null` when no site has been placed.
 *
 * Refuses when `current` exists but is not a symlink, or points outside the web
 * directory ({@link readSiteLink}).
 */
export function currentSite(webDir: string): string | null {
  return readSiteLink(webDir, CURRENT_SITE_LINK);
}

/**
 * The site `current` named before its last switch, or `null` when it has
 * never switched away from a site. Same refusals as {@link currentSite}.
 */
export function previousSite(webDir: string): string | null {
  return readSiteLink(webDir, PREVIOUS_SITE_LINK);
}

/** What {@link installSite} did. */
export interface InstalledSite {
  /** The id the site was installed under. */
  readonly siteId: string;
  /** Absolute path of `web/<siteId>/`. */
  readonly dir: string;
  /** True when this call put the site in place; false when that exact site was already there. */
  readonly copied: boolean;
}

/**
 * Put an assembled site into the web directory as `web/<siteId>/`, without
 * making it current.
 *
 * The id is {@link siteIdOf}'s `<version>-<commit>`, suffixed with the content
 * digest when that directory already holds different bytes (a dirty tree). A
 * site already installed with the same digest is left as it is.
 *
 * `move: true` renames `staticDir` into place instead of copying it, and
 * removes it when the same site was already installed: for a build directory
 * the caller assembled inside `webDir` itself, where rename(2) is atomic.
 *
 * Refuses: a `staticDir` with no identity or no content digest; a
 * `web/<siteId>/` that holds a different site (never overwritten).
 */
export function installSite(webDir: string, staticDir: string, opts: { readonly move?: boolean } = {}): InstalledSite {
  mkdirSync(webDir, { recursive: true, mode: 0o755 });
  const base = siteIdOf(staticDir);
  const digest = contentDigest(staticDir);
  if (digest === null) {
    throw new Error(`Refusing: ${join(staticDir, MANIFEST_FILE)} is missing, so a placed site could not be told apart from a different one.`);
  }

  let siteId = base;
  if (existsSync(join(webDir, base)) && contentDigest(join(webDir, base)) !== digest) {
    // Same version and commit, different bytes: a dirty working tree.
    siteId = `${base}-${digest.replace(/^sha256:/, "").slice(0, 12)}`;
  }
  const dir = join(webDir, siteId);

  if (existsSync(dir)) {
    if (contentDigest(dir) !== digest) {
      throw new Error(`Refusing: ${dir} already holds a different site; site directories are never overwritten.`);
    }
    if (opts.move === true) rmSync(staticDir, { recursive: true, force: true });
    return { siteId, dir, copied: false };
  }
  if (opts.move === true) {
    renameSync(staticDir, dir);
    return { siteId, dir, copied: true };
  }
  const staging = join(webDir, `.staging-${siteId}-${randomBytes(4).toString("hex")}`);
  try {
    cpSync(staticDir, staging, { recursive: true });
    renameSync(staging, dir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { siteId, dir, copied: true };
}

/** What {@link switchSite} did. */
export interface SiteSwitch {
  /** True when `current` changed. */
  readonly swapped: boolean;
  /** The site `current` named before this call, or `null` when there was none. */
  readonly previous: string | null;
}

/**
 * Make an installed site current.
 *
 * When `current` already names `siteId` nothing changes. Otherwise the site
 * `current` named (if any) is recorded as `previous` first, and then `current`
 * is swapped. Both are temporary-symlink-then-rename, so a reader never sees a
 * missing or partial link.
 *
 * Refuses: a `siteId` with no installed directory; a `current` or `previous`
 * that {@link readSiteLink} refuses.
 */
export function switchSite(webDir: string, siteId: string): SiteSwitch {
  if (siteId.includes("/") || siteId.startsWith(".") || siteId === CURRENT_SITE_LINK || siteId === PREVIOUS_SITE_LINK) {
    throw new Error(`Refusing: ${siteId} is not a site id.`);
  }
  let isDir = false;
  try {
    isDir = lstatSync(join(webDir, siteId)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(`Refusing: ${join(webDir, siteId)} is not an installed site directory, so it cannot become current.`);
  }
  const previous = currentSite(webDir);
  previousSite(webDir); // refuse a foreign `previous` before overwriting it
  if (previous === siteId) return { swapped: false, previous };
  if (previous !== null) writeSiteLink(webDir, PREVIOUS_SITE_LINK, previous);
  writeSiteLink(webDir, CURRENT_SITE_LINK, siteId);
  return { swapped: true, previous };
}

/**
 * Place an assembled site in the instance's web directory and make it current:
 * {@link installSite} (a copy) then {@link switchSite}. What `bun smoke` does
 * at every boot.
 *
 * Refuses: a `staticDir` with no identity ({@link siteIdOf}) or no content
 * digest; a `current` that {@link currentSite} refuses.
 */
export function placeSite(webDir: string, staticDir: string): PlacedSite {
  // Refuse a foreign `current` before copying anything in.
  currentSite(webDir);
  const installed = installSite(webDir, staticDir);
  const switched = switchSite(webDir, installed.siteId);
  return { ...installed, ...switched };
}
