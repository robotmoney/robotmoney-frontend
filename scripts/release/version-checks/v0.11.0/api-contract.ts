// Q38-api-contract/C26-api-contract (PR 1755, issue 1753, tracking issue 1754): the running api speaks contract 0.5.12.
// PR 1755 added the producer-only route GET /api/analytics/kept-regime-days and the optional `methodology` parameter,
// and bumped contract/package.json from 0.5.11 to 0.5.12. `GET /api/version` names that number as `api`
// (backend/src/ops/api-version.ts) and the image's build commit as `commit`. Read-only: one GET through the public origin.
//
// WHAT IT REQUIRES:
//   - /api/version answers 200 with JSON;
//   - `api` is exactly 0.5.12 (contract/package.json at the release commit);
//   - when the step passes --commit, `commit` is that release commit (the image is this release's, not v0.10.0's).
import type { VersionCheck } from "../../version-check.ts";

/** The contract version this release ships (contract/package.json at the release commit). */
export const EXPECTED_CONTRACT = "0.5.12";

/** PURE. Why the answer is not this release's api; empty when it is. */
export function apiContractProblems(res: { status: number; text: string }, commit: string | undefined): { problems: string[]; api: string | null; commit: string | null } {
  if (res.status !== 200) return { problems: [`GET /api/version answered ${res.status}, not 200`], api: null, commit: null };
  let body: { api?: unknown; commit?: unknown };
  try {
    body = JSON.parse(res.text) as { api?: unknown; commit?: unknown };
  } catch {
    return { problems: ["GET /api/version is not JSON"], api: null, commit: null };
  }
  const api = typeof body.api === "string" ? body.api : null;
  const got = typeof body.commit === "string" ? body.commit : null;
  const problems: string[] = [];
  if (api !== EXPECTED_CONTRACT) problems.push(`/api/version reports api ${api ?? "(absent)"}, this release's contract is ${EXPECTED_CONTRACT}`);
  if (commit !== undefined && got !== commit) problems.push(`/api/version reports commit ${got ?? "(null)"}, not the release commit ${commit}`);
  return { problems, api, commit: got };
}

export default (async (ctx) => {
  const res = await ctx.http(`/api/version?rm-v0110-contract=${Date.now()}`);
  const { problems, api, commit } = apiContractProblems(res, ctx.commit);
  return { found: { status: res.status, api, commit, expected: EXPECTED_CONTRACT }, problems };
}) satisfies VersionCheck;
