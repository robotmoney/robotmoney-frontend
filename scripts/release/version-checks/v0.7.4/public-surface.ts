// Q38-public-surface/C26-public-surface (PRs 1588, 1589, 1590, 1594): the site the rolling boot
// switched to carries this release's site changes. Read-only, over the public origin.
//
// Each PR is proved by a text it added to one served file and that v0.7.3's copy of the file does
// not hold (the v0.7.1 SITE_MARKERS pattern, ../v0.7.1/public-surface.ts). Static files answer a
// plain 404 when missing (website-server/nginx.conf's asset location), and each view is read for a
// text no SPA shell carries, so the shell fallback can never pass for a page.
import type { VersionCheck } from "../../version-check.ts";
import { siteMarkerProblems } from "../v0.7.1/public-surface.ts";

export { siteMarkerProblems };

/** One served file per site change, and the text the PR added to it (absent from v0.7.3's copy). */
export const SITE_MARKERS: readonly { pr: number; path: string; text: string }[] = [
  // Launch polish: the regime dial on the regime page, and the early access confirmation.
  { pr: 1588, path: "/views/regime.html", text: "rmRegimeDial" },
  { pr: 1588, path: "/views/early-access.html", text: "ea-done-in" },
  // The onboarding skill: keep a judge loop running without systemd.
  { pr: 1589, path: "/skills/swarm-onboarding/SKILL.md", text: "### Running without systemd" },
  // A silent seat shows as a callout on its member page.
  { pr: 1590, path: "/views/swarm/member.html", text: "statusCallout(member)" },
  // The market regime under the home page's model portfolio.
  { pr: 1594, path: "/views/home.html", text: "hm-reg__h" },
];

export default (async (ctx) => {
  const site: { pr: number; path: string; status: number }[] = [];
  const problems: string[] = [];
  for (const marker of SITE_MARKERS) {
    const r = await ctx.http(marker.path);
    site.push({ pr: marker.pr, path: marker.path, status: r.status });
    problems.push(...siteMarkerProblems(marker, r.status, r.text));
  }
  return { found: { site }, problems };
}) satisfies VersionCheck;
