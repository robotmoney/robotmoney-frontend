// Regression guard for the #584 role split: every SessionRail passed to
// enroll() must carry the operator's token explicitly (see smoke-main-split's
// operator-token suite for the sibling in-process driver).
//
// scripts/swarm-eval-local.ts's runSwarmAuthoringEvalCase() builds its own
// rail literal rather than importing one, and the compliance review once
// caught it missing the token: an env mutation at the top of that function
// papered over the gap through agent.ts's since-removed env fallback, so the
// omission never failed until that fallback was deleted. The token is now the
// operator's service token (smoke spec §3, D52), read from the eval's
// throwaway instance after stack.up() provisioned it. This is a static,
// source-text check (importing the module is safe — runSwarmAuthoringEvalCase
// only executes under `bun run` via the `import.meta.main` guard at the bottom
// of the file — but grepping the literal is what actually pins the field, not
// just its presence anywhere in the file).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const src = readFileSync(join(repoRoot, "scripts", "swarm-eval-local.ts"), "utf8");

describe("swarm-eval-local.ts's rail carries the operator token", () => {
  test("the rail literal built for runSwarmAuthoringEvalCase's session includes operatorToken", () => {
    const railLiteralMatch = src.match(/const rail = \{[\s\S]*?\n\s*\};/);
    expect(railLiteralMatch, "expected a `const rail = { ... };` literal in swarm-eval-local.ts").not.toBeNull();
    const railLiteral = railLiteralMatch![0];
    expect(railLiteral).toMatch(/\n\s*operatorToken,\n/);
  });

  test("the operator token is read from the instance's file after stack.up(), before the rail literal", () => {
    const upAt = src.indexOf("await stack.up();");
    const tokenAt = src.indexOf('const operatorToken = readServiceToken(instance.paths, "operator");');
    const railAt = src.indexOf("const rail = {");
    expect(upAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeGreaterThan(upAt);
    expect(railAt).toBeGreaterThan(tokenAt);
    // No env token of any kind is set or read on this path.
    expect(src).not.toContain("AUTOMATION_TOKEN");
    expect(src).not.toContain("generateStackCredentials");
  });
});
