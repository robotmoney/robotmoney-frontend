#!/usr/bin/env bun
// `bun scripts/stamp-assets.ts <assembled site dir> [--verify]` — stamp every module import in the assembled site
// (docs/technical/static-asset-cache.md, C3). scripts/static-assembly.sh runs it after copying frontend/public and
// before prerendering, so the per-route pages cut from index.html carry the stamped entry point.
//
//   stamp-assets.ts _static            stamp in place, then verify what was written
//   stamp-assets.ts _static --verify   change nothing; exit 1 if any import is unstamped or unresolved
import { stampSite, verifySite } from "./lib/stamp-assets.ts";

const dir = process.argv[2];
if (!dir || dir.startsWith("-")) {
  console.error("usage: bun scripts/stamp-assets.ts <assembled site dir> [--verify]");
  process.exit(2);
}

try {
  if (process.argv.includes("--verify")) {
    const { stamp, problems } = verifySite(dir);
    if (problems.length > 0) {
      console.error(`[stamp-assets] ${dir} is not consistently stamped:\n  - ${problems.slice(0, 20).join("\n  - ")}`);
      process.exit(1);
    }
    console.log(`[stamp-assets] ${dir}: every import is stamped ?v=${stamp} and resolves`);
  } else {
    const s = stampSite(dir);
    console.log(`[stamp-assets] stamped ${s.specifiers} imports in ${s.files} scripts with ?v=${s.stamp}`);
  }
} catch (e) {
  console.error(`[stamp-assets] ${(e as Error).message}`);
  process.exit(1);
}
