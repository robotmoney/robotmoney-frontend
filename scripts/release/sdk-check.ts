#!/usr/bin/env bun
// scripts/release/sdk-check.ts — the template's SDK soak steps (SV.8), on the
// control machine, read-only against the target:
//
//   bun scripts/release/sdk-check.ts --check archive-routes  --origin <url>
//   bun scripts/release/sdk-check.ts --check quickstart      --origin <url> --commit <sha>
//   bun scripts/release/sdk-check.ts --check package-tests   --origin <url> --commit <sha>
//
// Q35-archive-routes/C23-archive-routes: the public archive routes answer 200 with format 1.
// Q36-sdk-quickstart/C24-sdk-quickstart: the SDK from a sparse clone of the release commit runs the
//   README quickstart against the target, and its as-of row for the latest run equals
//   the as-of row of the run's published regime_snapshots artifact (field by field and
//   by sha256; scripts/release/replay-row.ts). A target with no published run FAILS.
//   Two tiers: the newest archived run's as-of LABELS must equal the published ones; its whole row must too if
//   the run was made by the fixed producer (an image-commit build identity), else the differences are info and the step prints that the
//   full-row check is deferred to the post-seal report.
// post-seal (not a cutover step; run on its own after the day a fixed-release run ran in is sealed):
//   bun scripts/release/sdk-check.ts --check post-seal --target stage|prod [--commit <sha>]
//   the newest archived run must be from the fixed producer and its whole row must equal the published one.
// Q37-sdk-tests/C25-sdk-tests: the SDK package's tests pass at the release commit.
//
// The clone comes from this checkout's `origin` (override: --repo-url). Exit 0
// only when the check found no problem.
import { realNet } from "./public-analytics-read.ts";
import { archiveRoutesCheck, packageTestsCheck, postSealCheck, quickstartCheck, realSdkDeps, type CheckResult } from "./sdk-lib.ts";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

export const CHECKS = ["archive-routes", "quickstart", "package-tests", "post-seal"] as const;
const TARGET_ORIGINS: Record<string, string> = { stage: "https://stage.robotmoney-labs.dev", prod: "https://robotmoney.network" };

async function main(): Promise<number> {
  const check = flag("--check");
  const target = flag("--target");
  const origin = flag("--origin") ?? (target ? TARGET_ORIGINS[target] : undefined);
  const commit = flag("--commit") ?? (check === "post-seal" ? Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim() : undefined);
  if (!check || !(CHECKS as readonly string[]).includes(check) || !origin || (check !== "archive-routes" && !commit)) {
    console.error("usage: bun scripts/release/sdk-check.ts --check archive-routes|quickstart|package-tests|post-seal (--origin <url> | --target stage|prod) [--commit <40-hex sha>] [--repo-url <git url>]");
    return 2;
  }
  const net = realNet(origin);
  let result: CheckResult;
  try {
    if (check === "archive-routes") result = await archiveRoutesCheck(net);
    else {
      const deps = await realSdkDeps(origin, net, flag("--repo-url"));
      result = check === "quickstart" ? await quickstartCheck(deps, commit!) : check === "post-seal" ? await postSealCheck(deps, commit!) : await packageTestsCheck(deps, commit!);
    }
  } catch (error) {
    result = { found: {}, problems: [`the check could not run: ${error instanceof Error ? error.message : String(error)}`] };
  }
  console.log(`[sdk-check] ${check}: ${result.problems.length === 0 ? "ok" : `${result.problems.length} problem(s)`} ${JSON.stringify(result.found)}`);
  for (const n of result.notes ?? []) console.log(`[sdk-check] NOTE: ${n}`);
  for (const p of result.problems) console.error(`[sdk-check] REFUSE: ${p}`);
  return result.problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
