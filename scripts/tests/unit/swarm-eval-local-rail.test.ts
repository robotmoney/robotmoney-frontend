// Regression guard for the #584 role split: every SessionRail passed to
// enroll() must carry `automationToken` explicitly (see demo-main-split's
// dedicated automation-token suite for the sibling in-process driver).
//
// scripts/swarm-eval-local.ts's runSwarmAuthoringEvalCase() builds
// its own rail literal rather than importing one, and the compliance review
// caught it missing `automationToken` — `process.env.AUTOMATION_TOKEN =
// credentials.automationToken` at the top of that function used to paper over
// the gap via agent.ts's now-removed env fallback, so the omission never
// failed until that fallback was deleted. This is a static, source-text
// check (importing the module is safe — runSwarmAuthoringEvalCase only
// executes under `bun run` via the `import.meta.main` guard at the bottom
// of the file — but grepping the literal is what actually pins the field,
// not just its presence anywhere in the file).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const src = readFileSync(join(repoRoot, "scripts", "swarm-eval-local.ts"), "utf8");

describe("swarm-eval-local.ts's rail carries automationToken", () => {
  test("the rail literal built for runSwarmAuthoringEvalCase's session includes automationToken", () => {
    const railLiteralMatch = src.match(/const rail = \{[\s\S]*?\n\s*\};/);
    expect(railLiteralMatch, "expected a `const rail = { ... };` literal in swarm-eval-local.ts").not.toBeNull();
    const railLiteral = railLiteralMatch![0];
    expect(railLiteral).toContain("automationToken: credentials.automationToken");
  });

  test("credentials.automationToken is defined before the rail literal references it", () => {
    const credentialsAt = src.indexOf("const credentials = generateStackCredentials();");
    const railAt = src.indexOf("const rail = {");
    expect(credentialsAt).toBeGreaterThan(-1);
    expect(railAt).toBeGreaterThan(credentialsAt);
  });
});
