// Q45-take-rules/C31-take-rules (PR 1340): the swarm skill and the docs carry every rule a
// take is refused for, so an operator never needs one relayed by hand.
//
// The check reads what the site serves: the skill an agent fetches
// (/skills/swarm-onboarding/SKILL.md) must name each refusal `submit` answers,
// in the server's own words, and the API reference must document the fields
// those refusals are about (`sessionId`, `reportSnapshotId`, and the
// `schemaVersion` the canonical rule signs).
import type { VersionCheck } from "../../version-check.ts";

export const SKILL_PATH = "/skills/swarm-onboarding/SKILL.md";
export const API_REFERENCE_PATH = "/views/docs/investment-swarm/api-reference.html";

/** The refusals PR 1340 documents, as the server words them. */
export const SKILL_REFUSALS = Object.freeze([
  "member is not on this session's expected roster",
  "member is excused from this session",
  "submission window closed",
  "amendment cap reached",
  "unknown field",
  "reportSnapshotId does not match this session's brief",
  "this session's brief is bound to no analytics report snapshot",
  "does not match the open session",
  "weights_bucket_not_canonical",
]);

/** The fields the API reference must document. */
export const API_REFERENCE_FIELDS = Object.freeze(["sessionId", "reportSnapshotId", "schemaVersion"]);

/** PURE. Every rule or field a served document is missing. */
export function takeRulesProblems(skill: { status: number; text: string }, apiReference: { status: number; text: string }): string[] {
  const out: string[] = [];
  if (skill.status !== 200) out.push(`${SKILL_PATH} answered ${skill.status}`);
  else for (const rule of SKILL_REFUSALS) if (!skill.text.includes(rule)) out.push(`${SKILL_PATH} does not name the refusal "${rule}"`);
  if (apiReference.status !== 200) out.push(`${API_REFERENCE_PATH} answered ${apiReference.status}`);
  else for (const field of API_REFERENCE_FIELDS) if (!apiReference.text.includes(field)) out.push(`${API_REFERENCE_PATH} does not document ${field}`);
  return out;
}

export default (async (ctx) => {
  const skill = await ctx.http(SKILL_PATH);
  const apiReference = await ctx.http(API_REFERENCE_PATH);
  const problems = takeRulesProblems(skill, apiReference);
  return {
    found: {
      skill: { status: skill.status, bytes: skill.text.length, refusalsNamed: SKILL_REFUSALS.filter((r) => skill.text.includes(r)).length, of: SKILL_REFUSALS.length },
      apiReference: { status: apiReference.status, bytes: apiReference.text.length, fieldsDocumented: API_REFERENCE_FIELDS.filter((f) => apiReference.text.includes(f)) },
    },
    problems,
  };
}) satisfies VersionCheck;
