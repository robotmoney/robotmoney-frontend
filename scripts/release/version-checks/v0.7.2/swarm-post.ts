// Q39-swarm-post/C27-swarm-post (PR 1558): the swarm launch post is served. Read-only: one GET of
// the post's view fragment, which v0.7.1 does not have, for its headline. A missing static file
// answers a plain 404 (nginx.conf's asset location), so the SPA shell fallback can never pass.
import type { VersionCheck } from "../../version-check.ts";

export const SWARM_POST_PATH = "/views/blog/swarm-announcement.html";
/** The post's headline, from PR 1558's view. */
export const SWARM_POST_MARKER = "Robot Money launches with support from peaq";

/** PURE. Why the served post does not carry PR 1558's headline; empty when it does. */
export function swarmPostProblems(status: number, body: string): string[] {
  if (status !== 200) return [`GET ${SWARM_POST_PATH} answered ${status}, not 200`];
  if (!body.includes(SWARM_POST_MARKER)) return [`GET ${SWARM_POST_PATH} does not carry ${JSON.stringify(SWARM_POST_MARKER)}: the site before PR 1558 is still served`];
  return [];
}

export default (async (ctx) => {
  const res = await ctx.http(SWARM_POST_PATH);
  return { found: { path: SWARM_POST_PATH, status: res.status, marker: res.text.includes(SWARM_POST_MARKER) }, problems: swarmPostProblems(res.status, res.text) };
}) satisfies VersionCheck;
