// V07-sdk-rules-check (SDK 0.2.0, PR 1439): `bun run rules:check` exits 0 for
// every shipped rule file in packages/analyst-sdk/rules/, run from a sparse
// clone of the release commit. A release with no rule file fails. Runs on the
// control machine and touches no target.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { realNet } from "../../public-analytics-read.ts";
import { realSdkDeps, type CheckResult, type SdkDeps } from "../../sdk-lib.ts";
import type { VersionCheck } from "../../version-check.ts";

/** PURE. Why the rule files are not all valid; empty when each exited 0. */
export function ruleProblems(results: readonly { file: string; code: number; stderr: string }[]): string[] {
  if (results.length === 0) return ["packages/analyst-sdk/rules/ holds no rule file"];
  return results.filter((r) => r.code !== 0).map((r) => `rules:check ${r.file} exited ${r.code}: ${r.stderr.trim().slice(-300)}`);
}

export async function sdkRulesCheck(deps: SdkDeps, commit: string): Promise<CheckResult> {
  const sdk = await deps.prepareSdk(commit, deps.scratch());
  if ("problem" in sdk) return { found: { commit }, problems: [sdk.problem] };
  const files = readdirSync(join(sdk.sdkDir, "rules")).filter((f) => f.endsWith(".json")).sort();
  const results: { file: string; code: number; stderr: string }[] = [];
  for (const f of files) {
    const r = await deps.run(["bun", "run", "rules:check", join("rules", f)], { cwd: sdk.sdkDir });
    results.push({ file: f, code: r.code, stderr: r.stderr });
  }
  return { found: { commit, files: results.map((r) => ({ file: r.file, exit: r.code })) }, problems: ruleProblems(results) };
}

export default (async (ctx) => {
  if (!ctx.commit) return { found: {}, problems: ["the step passes no --commit: the SDK is taken from the release commit"] };
  return sdkRulesCheck(await realSdkDeps(ctx.origin, realNet(ctx.origin)), ctx.commit);
}) satisfies VersionCheck;
