// Q36-judge-draw/C24-judge-draw (PR 1406, D71): every eligible judge judges, and one on-time
// answer is drawn at random after the judging deadline.
//
// The change is backend code and the texts that describe it; it has no migration and no row a
// read-only session can tell apart before a session reaches its judging deadline. So the check
// reads what is deployed: the running api image holds the draw module with its versioned rule,
// and the served openapi.json and agent skill say the new rule and no longer say "judge of
// record" is the lowest member id. It draws nothing and writes nothing.
import type { VersionCheck } from "../../version-check.ts";

export const DRAW_RULE = "rejection-u32-v1";
export const DRAW_MODULE = "/app/src/swarm/judge-draw.ts";
export const OPENAPI_PATH = "/openapi.json";
export const SKILL_PATH = "/skills/swarm-onboarding/SKILL.md";

export interface JudgeDrawObservation {
  /** `grep -c <rule> <module>` inside the api container: exit code and the count printed. */
  readonly module: { code: number; count: number } | null;
  readonly openapi: { status: number; text: string };
  readonly skill: { status: number; text: string };
}

/** PURE. Every reason the judge draw is not in place. */
export function judgeDrawProblems(o: JudgeDrawObservation): string[] {
  const out: string[] = [];
  if (o.module === null) out.push("no running api container of the instance to read");
  else if (o.module.code !== 0 || o.module.count < 1) out.push(`${DRAW_MODULE} in the api container does not carry the rule ${DRAW_RULE}`);
  for (const [path, r] of [[OPENAPI_PATH, o.openapi], [SKILL_PATH, o.skill]] as const) if (r.status !== 200) out.push(`${path} answered ${r.status}`);
  if (o.openapi.status === 200 && !/drawn at random after the judging deadline/.test(o.openapi.text)) out.push(`the served openapi.json does not describe the draw after the judging deadline`);
  if (o.openapi.status === 200 && /comes first by member id/.test(o.openapi.text)) out.push(`the served openapi.json still describes the judge of record as the lowest member id`);
  if (o.skill.status === 200 && !/drawn at\s+random/.test(o.skill.text)) out.push(`the served swarm skill does not say one on-time answer is drawn at random`);
  return out;
}

export default (async (ctx) => {
  const project = ctx.project();
  const api = ctx.docker(["ps", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=api", "--format", "{{.Names}}"]).stdout.split("\n").map((s) => s.trim()).find(Boolean);
  let module: JudgeDrawObservation["module"] = null;
  if (api) {
    const r = ctx.docker(["exec", api, "grep", "-c", DRAW_RULE, DRAW_MODULE]);
    module = { code: r.code, count: Number.parseInt(r.stdout.trim(), 10) || 0 };
  }
  const [openapi, skill] = await Promise.all([ctx.http(OPENAPI_PATH), ctx.http(SKILL_PATH)]);
  return {
    found: { project, api: api ?? null, module, statuses: { openapi: openapi.status, skill: skill.status } },
    problems: judgeDrawProblems({ module, openapi, skill }),
  };
}) satisfies VersionCheck;
