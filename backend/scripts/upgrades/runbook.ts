import { join } from "node:path";
import { readdirSync } from "node:fs";
import { mainWhere } from "../lib/rollout-where.ts";

const scriptDir = import.meta.dir;
const repoRoot = join(scriptDir, "..", "..", "..");

// Subsumes rollout:where and rollout:where:v022 by dynamically finding the latest upgrade folder
const dirs = readdirSync(scriptDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name.includes("-to-"))
  .map(d => d.name)
  .sort(); // String sort works for '0.2.1-to-0.2.2' vs '0.2.2-to-0.3.0'

const latestDir = dirs[dirs.length - 1];
let targetDir = latestDir;

// Optional: allow passing --version <dir> to run older runbooks
const vFlag = process.argv.indexOf("--version");
if (vFlag !== -1 && process.argv.length > vFlag + 1) {
  targetDir = process.argv[vFlag + 1];
}

const stepsPath = join(scriptDir, targetDir, "steps.ts");
const { STEPS, TAG_GLOB, TRACKING_ISSUE } = await import(stepsPath);

mainWhere({ repoRoot, steps: STEPS, tagGlob: TAG_GLOB, trackingIssue: TRACKING_ISSUE });
