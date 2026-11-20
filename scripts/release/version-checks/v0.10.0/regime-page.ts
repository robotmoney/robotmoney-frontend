// Q42-regime-page/C30-regime-page (PR 1663, PR 1685; issue 1666): the site serves the page that reads the composite on
// its own 0 to 1 scale. Read-only: GETs of three site files through the public origin, each with a one-off query value.
//
// WHAT IT REQUIRES:
//   - /assets/js/app/lib/regime-scale.js answers 200 and exports readOnComposite (the module PR 1663 added);
//   - /assets/js/app/alpine/views/regime.js answers 200 and imports readOnComposite from it;
//   - /assets/js/app/alpine/regime-dial.js answers 200 and reads the dial from `value`, not from `percentile`.
import type { VersionCheck } from "../../version-check.ts";

export const FILES = [
  { path: "/assets/js/app/lib/regime-scale.js", must: /export function readOnComposite\b/, what: "exports readOnComposite" },
  { path: "/assets/js/app/alpine/views/regime.js", must: /import \{ readOnComposite \} from "\.\.\/\.\.\/lib\/regime-scale\.js(\?v=[0-9a-f]+)?"/, what: "imports readOnComposite" },
  { path: "/assets/js/app/alpine/regime-dial.js", must: /\bvalue\b/, mustNot: /\.percentile\b/, what: "reads the dial from value, not percentile" },
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
      if ("mustNot" in f && f.mustNot.test(a.text)) out.push(`${f.path} still reads the percentile (${f.what})`);
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
