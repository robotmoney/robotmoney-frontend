// V08-sdk-backtest-golden (SDK 0.2.0, PR 1426): `bun run backtest` for the
// reference portfolio prints its golden output. The reference is data in this
// folder (reference/portfolio.json over reference/prices.csv, 2025-01-01 to
// 2025-04-30, the default 10 bps cost) and reference/backtest.golden.json is
// what the SDK printed for it when the golden was made. The SDK is the release
// commit's, from a sparse clone. Regenerate the golden only for a deliberate
// change of the calculation, in the pull request that makes it. Runs on the
// control machine and touches no target.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { realNet } from "../../public-analytics-read.ts";
import { realSdkDeps, text, type CheckResult, type SdkDeps } from "../../sdk-lib.ts";
import type { VersionCheck } from "../../version-check.ts";

export const REFERENCE_DIR = join(import.meta.dir, "reference");
export const BACKTEST_ARGS = ["--from", "2025-01-01", "--to", "2025-04-30"] as const;

/** PURE. Why the printed backtest is not the golden one; empty when it is the same text. */
export function goldenProblems(actual: string, golden: string): string[] {
  if (actual === golden) return [];
  const a = actual.split("\n");
  const g = golden.split("\n");
  const at = a.findIndex((line, i) => line !== g[i]);
  const line = at === -1 ? Math.min(a.length, g.length) : at;
  return [`the backtest differs from its golden output at line ${line + 1}: printed ${JSON.stringify(a[line] ?? "(end)")}, golden ${JSON.stringify(g[line] ?? "(end)")}`];
}

export async function sdkBacktestGolden(deps: SdkDeps, commit: string, referenceDir = REFERENCE_DIR): Promise<CheckResult> {
  const sdk = await deps.prepareSdk(commit, deps.scratch());
  if ("problem" in sdk) return { found: { commit }, problems: [sdk.problem] };
  const r = await deps.run(["bun", "run", "backtest", join(referenceDir, "portfolio.json"), join(referenceDir, "prices.csv"), ...BACKTEST_ARGS], { cwd: sdk.sdkDir });
  if (r.code !== 0) return { found: { commit, exit: r.code }, problems: [`bun run backtest exited ${r.code}: ${r.stderr.trim().slice(-300)}`] };
  return { found: { commit, bytes: r.stdout.length }, problems: goldenProblems(text(r.stdout), readFileSync(join(referenceDir, "backtest.golden.json"), "utf8")) };
}

export default (async (ctx) => {
  if (!ctx.commit) return { found: {}, problems: ["the step passes no --commit: the SDK is taken from the release commit"] };
  return sdkBacktestGolden(await realSdkDeps(ctx.origin, realNet(ctx.origin)), ctx.commit);
}) satisfies VersionCheck;
