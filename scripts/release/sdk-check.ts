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
// Q37-sdk-tests/C25-sdk-tests: the SDK package's tests pass at the release commit.
//
// The clone comes from this checkout's `origin` (override: --repo-url). Exit 0
// only when the check found no problem.
import { realNet } from "./public-analytics-read.ts";
import { archiveRoutesCheck, packageTestsCheck, quickstartCheck, realSdkDeps, type CheckResult } from "./sdk-lib.ts";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

export const CHECKS = ["archive-routes", "quickstart", "package-tests"] as const;

async function main(): Promise<number> {
  const check = flag("--check");
  const origin = flag("--origin");
  const commit = flag("--commit");
  if (!check || !(CHECKS as readonly string[]).includes(check) || !origin || (check !== "archive-routes" && !commit)) {
    console.error("usage: bun scripts/release/sdk-check.ts --check archive-routes|quickstart|package-tests --origin <url> [--commit <40-hex sha>] [--repo-url <git url>]");
    return 2;
  }
  const net = realNet(origin);
  let result: CheckResult;
  try {
    if (check === "archive-routes") result = await archiveRoutesCheck(net);
    else {
      const deps = await realSdkDeps(origin, net, flag("--repo-url"));
      result = check === "quickstart" ? await quickstartCheck(deps, commit!) : await packageTestsCheck(deps, commit!);
    }
  } catch (error) {
    result = { found: {}, problems: [`the check could not run: ${error instanceof Error ? error.message : String(error)}`] };
  }
  console.log(`[sdk-check] ${check}: ${result.problems.length === 0 ? "ok" : `${result.problems.length} problem(s)`} ${JSON.stringify(result.found)}`);
  for (const p of result.problems) console.error(`[sdk-check] REFUSE: ${p}`);
  return result.problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
