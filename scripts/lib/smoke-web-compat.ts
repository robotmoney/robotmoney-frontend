// `bun smoke` AND THE LIVE SITE — smoke-production-spec.md §13.3, D54,
// criterion 162.
//
//   "Before it replaces `api`, `bun smoke` reads the live site's
//    `/version.json`. It refuses when the new API version is outside the live
//    site's range, unless the same plan deploys a site whose range includes
//    that version. A live site with no declared range counts as outside every
//    range."
//
// The live site is the one the instance's `web/current` names
// (scripts/lib/smoke-site.ts); its `/version.json` is the file inside that
// directory, which is exactly what website-server serves. The new API version
// is this tree's contract version (scripts/lib/api-range.ts). A plan DEPLOYS a
// site when its prepare phase would place a site other than the live one: the
// assembled `_static` has another id, or the same id with other bytes (the
// test placeSite() applies). When it does, that site is what serves once the
// plan's `api` is up, so its range is the one that must admit the API.
//
// Decided BEFORE the plan switches `current`, and before any service is
// replaced, so a refusal leaves the live site and every container as they were.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiVersionInRange, readSiteApiRange } from "./api-range.ts";
import { currentSite, siteIdOf } from "./smoke-site.ts";

/** A site as the check sees it: its id and the range its `/version.json` declares (null: none). */
export interface SiteRange {
  readonly siteId: string;
  readonly range: string | null;
}

export interface WebCompatPlan {
  readonly apiVersion: string;
  /** The site `web/current` names now, or null when the instance has never served one. */
  readonly live: SiteRange | null;
  /** The site this plan's prepare phase places, or null when it would place the live one again. */
  readonly deploys: SiteRange | null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The content digest an assembled site records (`.rm-static-manifest.json`), or null. */
function siteDigest(dir: string): string | null {
  const manifest = readJson(join(dir, ".rm-static-manifest.json")) as { digest?: unknown } | null;
  return manifest && typeof manifest.digest === "string" && manifest.digest !== "" ? manifest.digest : null;
}

/**
 * What the live site and this plan's site declare, read from disk before the
 * plan places anything.
 */
export function readWebCompatPlan(webDir: string, assembledDir: string, apiVersion: string): WebCompatPlan {
  const liveId = currentSite(webDir);
  const live = liveId === null ? null : { siteId: liveId, range: readSiteApiRange(readJson(join(webDir, liveId, "version.json"))) };
  const assembledId = siteIdOf(assembledDir);
  const sameAsLive =
    liveId !== null &&
    assembledId === liveId &&
    existsSync(join(webDir, liveId)) &&
    siteDigest(join(webDir, liveId)) === siteDigest(assembledDir);
  const deploys = sameAsLive ? null : { siteId: assembledId, range: readSiteApiRange(readJson(join(assembledDir, "version.json"))) };
  return { apiVersion, live, deploys };
}

const describeSite = (site: SiteRange): string =>
  `${site.siteId} (${site.range === null ? "no declared range" : `apiRange ${site.range}`})`;

/**
 * The refusal, or null when the boot may proceed.
 *
 * The site that serves after this plan — the one it deploys, else the live
 * one — must admit the new API version. A site with no declared range admits
 * none (D54). So: a live site outside the range refuses unless the plan
 * deploys one inside it; a plan that deploys a site outside the range refuses
 * whatever the live one declared, because that site is what would serve.
 */
export function webCompatRefusal(plan: WebCompatPlan): string | null {
  const serving = plan.deploys ?? plan.live;
  if (serving !== null && apiVersionInRange(plan.apiVersion, serving.range)) return null;
  const live = plan.live === null ? "no live site" : `the live site ${describeSite(plan.live)}`;
  const deployed = plan.deploys === null ? "this plan deploys no other site" : `this plan deploys ${describeSite(plan.deploys)}`;
  return (
    `refusing to replace api: API version ${plan.apiVersion} is outside the range of the site that would serve it — ` +
    `${live}; ${deployed} (smoke spec §13.3, D54: a site with no declared range is outside every range). ` +
    "Deploy a site whose apiRange admits this version (`bun smoke:web`), or boot a tree whose site does."
  );
}
