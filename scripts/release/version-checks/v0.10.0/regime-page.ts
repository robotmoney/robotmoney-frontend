// Q42-regime-page/C30-regime-page (PR 1663, PR 1685, PR 1694; issue 1666): the site serves the page that shows the
// API's labels, cut on the composite under methodology v4 (D84, D88), and reads the composite on its own 0 to 1 scale.
// Read-only: GETs of two site files through the public origin, each with a one-off query value.
//
// WHAT IT REQUIRES:
//   - /assets/js/app/alpine/views/regime.js answers 200, applies the API's data as served (`_apply(data)`) and no
//     longer imports the client-side re-cut of PR 1663 (lib/regime-scale.js, removed by PR 1694);
//   - /assets/js/app/alpine/regime-dial.js answers 200 and reads the dial from `value`, not from `percentile`;
//   - (PR 1705) the swarm session page reads levels, not the composite's 3-year percentile: lib/session-brief.js picks
//     the panels' index levels and no compositePercentile, and views/swarm/session.html shows the composite itself.
import type { VersionCheck } from "../../version-check.ts";

export const FILES = [
  { path: "/assets/js/app/alpine/views/regime.js", must: /\b_apply\(data\)/, mustNot: /regime-scale\.js/, what: "shows the API's labels, not a client-side re-cut" },
  { path: "/assets/js/app/alpine/regime-dial.js", must: /\bvalue\b/, mustNot: /\.percentile\b/, what: "reads the dial from value, not percentile" },
  { path: "/assets/js/app/lib/session-brief.js", must: /pick\("macroIndex", "macro_index"\)/, mustNot: /compositePercentile/, what: "the session brief reads index levels, not percentiles" },
  { path: "/views/swarm/session.html", must: /Composite <b x-text="fmtNum\(session\.regimeSummary\?\.composite, 3\)">/, mustNot: /compositePercentile/, what: "the session page shows the composite, not its 3-year percentile" },
] as const;

/** PURE. Why the served files are not the composite-reading page; empty when they are. */
export function pageProblems(answers: readonly { path: string; status: number; text: string }[]): string[] {
  const out: string[] = [];
  for (const f of FILES) {
    const a = answers.find((x) => x.path === f.path);
    if (a === undefined) out.push(`${f.path} was not read`);
    else if (a.status !== 200) out.push(`${f.path} answered ${a.status}, not 200`);
    else {
      if (!f.must.test(a.text)) out.push(`${f.path} does not satisfy: ${f.what}`);
      if ("mustNot" in f && f.mustNot.test(a.text)) out.push(`${f.path} breaks: ${f.what}`);
    }
  }
  return out;
}

export default (async (ctx) => {
  const answers: { path: string; status: number; text: string }[] = [];
  for (const f of FILES) {
    const res = await ctx.http(`${f.path}?rm-v0100-page=${Date.now()}`);
    answers.push({ path: f.path, status: res.status, text: res.text });
  }
  return { found: { files: answers.map((a) => ({ path: a.path, status: a.status, bytes: a.text.length })) }, problems: pageProblems(answers) };
}) satisfies VersionCheck;
