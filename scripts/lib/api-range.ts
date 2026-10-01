// The website ↔ API compatibility rule (D54, issue #1026 W7), server side.
//
// The static website is its own release unit. It declares the API versions it
// accepts as a semver range — frontend/package.json `apiRange`, published in the
// site's /version.json — and the API reports its version at GET /api/version,
// which is contract/package.json's version. This module is the one place a
// Bun-side tool decides whether the two agree:
//
//   - scripts/web-client/api-range.ts (CI, web-client.yml): the range must admit
//     the contract version in the same tree;
//   - `bun smoke` and `bun smoke:web` (wave 4): refuse an API outside the live
//     site's range, and a site whose range excludes the running API.
//
// KEEP THE EXPORTS STABLE — wave 4's compat refusal imports them by name.
//
// WHY A GRAMMAR CHECK IN FRONT OF Bun.semver. `Bun.semver.satisfies("0.2.0",
// "garbage")` and `Bun.semver.satisfies("0.2.0", "")` are both `true`: an
// unparseable or empty range reads as "anything goes". For a compatibility gate
// that is backwards, so a range must first parse under the small grammar the
// site actually uses — the same one the browser matcher implements
// (frontend/public/assets/js/app/lib/api-compat.js) — and anything else is
// outside every range. A missing range is treated the same way: a live site
// with no declared range admits no API.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

const NUM = "(?:0|[1-9]\\d*)";

/**
 * `X.Y.Z` with an optional prerelease tag. No `v` prefix, no partials, no
 * build metadata, no leading zeros. Kept textually in step with api-compat.js's
 * VERSION_RE; web-client-api-range.test.ts compares the two on a table.
 */
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/**
 * One comparator: `^X.Y.Z`, `~X.Y.Z`, `>=X.Y.Z`, `>X.Y.Z`, `<=X.Y.Z`, `<X.Y.Z`,
 * `=X.Y.Z` or a bare `X.Y.Z`. Comparator versions carry no prerelease tag.
 */
const COMPARATOR = new RegExp(`^(?:\\^|~|>=|<=|>|<|=)?${NUM}\\.${NUM}\\.${NUM}$`);

/** True when `version` is a version string this rule understands. */
export function isValidApiVersion(version: unknown): version is string {
  return typeof version === "string" && VERSION.test(version);
}

/**
 * True when `range` is one or more space-separated comparators (all must hold).
 * `||` alternatives, `x` wildcards and hyphen ranges are deliberately outside
 * the grammar: the browser matcher does not implement them, and a range the
 * browser cannot read would be enforced by CI and ignored by the page.
 */
export function isValidApiRange(range: unknown): range is string {
  if (typeof range !== "string") return false;
  const parts = range.trim().split(/\s+/);
  return parts.length > 0 && parts[0] !== "" && parts.every((p) => COMPARATOR.test(p));
}

/**
 * Does API `version` fall inside the site's `range`?
 *
 * `false` — never an exception — for a missing, empty or unparseable range, and
 * for a version that is not a plain semver string: all of them are outside
 * every range. Semantics are Bun.semver's (node-semver's), including that a
 * prerelease version satisfies no range here, because no comparator in the
 * grammar carries a prerelease tag.
 */
export function apiVersionInRange(version: string | null | undefined, range: string | null | undefined): boolean {
  if (!isValidApiVersion(version) || !isValidApiRange(range)) return false;
  return Bun.semver.satisfies(version, range.trim());
}

/** contract/package.json's version: the API version the tree at `root` builds. */
export function readContractVersion(root: string = repoRoot): string {
  const pkg = JSON.parse(readFileSync(join(root, "contract", "package.json"), "utf8")) as { version?: unknown };
  if (!isValidApiVersion(pkg.version)) {
    throw new Error(`contract/package.json has no valid version (got ${JSON.stringify(pkg.version)})`);
  }
  return pkg.version;
}

/** frontend/package.json's declared `apiRange`, or null when it declares none. */
export function readFrontendApiRange(root: string = repoRoot): string | null {
  const pkg = JSON.parse(readFileSync(join(root, "frontend", "package.json"), "utf8")) as { apiRange?: unknown };
  return typeof pkg.apiRange === "string" ? pkg.apiRange : null;
}

/**
 * The range a site's /version.json declares, or null when it declares none —
 * including a body that is not an object at all. Null is "outside every
 * range" to apiVersionInRange, which is the rule for a live site with no
 * declared range.
 */
export function readSiteApiRange(versionJson: unknown): string | null {
  if (!versionJson || typeof versionJson !== "object") return null;
  const range = (versionJson as { apiRange?: unknown }).apiRange;
  return typeof range === "string" && range.trim() !== "" ? range : null;
}
