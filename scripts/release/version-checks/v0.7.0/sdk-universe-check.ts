// V09-sdk-universe-check (SDK 0.2.0, PR 1433): `bun run universe:check` exits 0
// for the reference holdings (reference/holdings.json: the three states of the
// reference rule R1), against the universe the release commit ships. The SDK is
// the release commit's, from a sparse clone. Runs on the control machine and
// touches no target.
import { join } from "node:path";
import { realNet } from "../../public-analytics-read.ts";
import { realSdkDeps, type CheckResult, type SdkDeps } from "../../sdk-lib.ts";
import type { VersionCheck } from "../../version-check.ts";

export const REFERENCE_DIR = join(import.meta.dir, "reference");

export async function sdkUniverseCheck(deps: SdkDeps, commit: string, referenceDir = REFERENCE_DIR): Promise<CheckResult> {
  const sdk = await deps.prepareSdk(commit, deps.scratch());
  if ("problem" in sdk) return { found: { commit }, problems: [sdk.problem] };
  const r = await deps.run(["bun", "run", "universe:check", join(referenceDir, "holdings.json")], { cwd: sdk.sdkDir });
  return { found: { commit, exit: r.code }, problems: r.code === 0 ? [] : [`universe:check exited ${r.code}: ${r.stderr.trim().slice(-400)}`] };
}

export default (async (ctx) => {
  if (!ctx.commit) return { found: {}, problems: ["the step passes no --commit: the SDK is taken from the release commit"] };
  return sdkUniverseCheck(await realSdkDeps(ctx.origin, realNet(ctx.origin)), ctx.commit);
}) satisfies VersionCheck;
