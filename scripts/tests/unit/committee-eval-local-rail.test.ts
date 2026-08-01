// Regression guard for a FAIL finding on issue #461's own PR (#463): issue
// #461 retired committee/agent.ts's env-reading getAdminHeaders() fallback,
// so every SessionRail passed to enroll() must now carry `adminToken`
// explicitly (agent.ts reads `rail.adminToken` directly — see
// demo-main-split.test.ts's "sessionRail carries adminToken" suite for the
// sibling in-process driver).
//
// scripts/committee-eval-local.ts's runCommitteeAuthoringEvalCase() builds
// its own rail literal rather than importing one, and the compliance review
// caught it missing `adminToken` — `process.env.ADMIN_TOKEN =
// credentials.adminToken` at the top of that function used to paper over
// the gap via agent.ts's now-removed env fallback, so the omission never
// failed until that fallback was deleted. This is a static, source-text
// check (importing the module is safe — runCommitteeAuthoringEvalCase only
// executes under `bun run` via the `import.meta.main` guard at the bottom
// of the file — but grepping the literal is what actually pins the field,
// not just its presence anywhere in the file).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const src = readFileSync(join(repoRoot, "scripts", "committee-eval-local.ts"), "utf8");

describe("committee-eval-local.ts's rail carries adminToken (issue #461 PR #463 finding)", () => {
  test("the rail literal built for runCommitteeAuthoringEvalCase's session includes adminToken", () => {
    const railLiteralMatch = src.match(/const rail = \{[\s\S]*?\n\s*\};/);
    expect(railLiteralMatch, "expected a `const rail = { ... };` literal in committee-eval-local.ts").not.toBeNull();
    const railLiteral = railLiteralMatch![0];
    expect(railLiteral).toContain("adminToken: credentials.adminToken");
  });

  test("credentials.adminToken is defined before the rail literal references it", () => {
    const credentialsAt = src.indexOf("const credentials = generateStackCredentials();");
    const railAt = src.indexOf("const rail = {");
    expect(credentialsAt).toBeGreaterThan(-1);
    expect(railAt).toBeGreaterThan(credentialsAt);
  });
});
