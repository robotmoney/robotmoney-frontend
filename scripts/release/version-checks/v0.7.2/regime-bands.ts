// Q49-regime-bands/C37-regime-bands (PR 1560): the regime page paints a risk-on and a risk-off band
// behind the line datasets, in the regime's own hues (views/shared.js, RM-200). Read-only: one GET
// of the served shared module, with the text PR 1560 added to it.
//
// v0.7.1's copy of the file has no risk_off wash, so a site still on v0.7.1 fails this check.
// A missing file answers a plain 404 (nginx.conf's asset location), so the SPA shell fallback can
// never pass for the module.
import type { VersionCheck } from "../../version-check.ts";

export const REGIME_BANDS_PATH = "/assets/js/app/alpine/views/shared.js";
/** The line PR 1560 added to shared.js: the risk-off band's wash in the regime's hue. */
export const REGIME_BANDS_MARKER = "risk_off: { fill: rgba(REGIME.risk_off, 0.11)";

/** PURE. Why the served shared module does not carry PR 1560's band; empty when it does. */
export function regimeBandProblems(status: number, body: string): string[] {
  if (status !== 200) return [`GET ${REGIME_BANDS_PATH} answered ${status}, not 200`];
  if (!body.includes(REGIME_BANDS_MARKER)) return [`GET ${REGIME_BANDS_PATH} does not carry ${JSON.stringify(REGIME_BANDS_MARKER)}: the site before PR 1560 is still served`];
  return [];
}

export default (async (ctx) => {
  const res = await ctx.http(REGIME_BANDS_PATH);
  const problems = regimeBandProblems(res.status, res.text);
  return { found: { path: REGIME_BANDS_PATH, status: res.status, marker: res.text.includes(REGIME_BANDS_MARKER) }, problems };
}) satisfies VersionCheck;
