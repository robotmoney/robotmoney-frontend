// Issue #759 test plan item 1: "the check goes red against a fixture serving
// the pre-#758 install block". The live counterpart
// (contract/tests/live/swarm-onboarding-skill-url-live.test.ts) makes a real
// network call and can only ever observe whatever robotmoney.network happens
// to be serving right now — it cannot itself demonstrate that the assertion
// would fire on a stale/pre-#758 deploy without one actually existing in
// production. So this file drives the SAME comparison
// (describeSkillMismatch, shared with the live test) against a fixture body
// standing in for exactly that stale deploy, offline and deterministically.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeSkillMismatch } from "../../src/skill-parity.js";

const repoRoot = join(import.meta.dir, "../../..");
const SKILL_REL = "frontend/public/skills/swarm-onboarding/SKILL.md";
const repoSkill = readFileSync(join(repoRoot, SKILL_REL), "utf8");
const URL = "https://robotmoney.network/skills/swarm-onboarding/SKILL.md";

// The exact shape #758 removed: an unverified pipe straight into tar, with no
// checksum download or check anywhere in the block.
const PRE_758_INSTALL_BLOCK = [
  "---",
  "name: swarm-onboarding",
  "description: fixture",
  "---",
  "",
  "## Step 2 — toolchain + keygen",
  "",
  "```bash",
  'TAG="v1.2.3"',
  'OS="linux"',
  'ARCH="x86_64"',
  'ARCHIVE="rmpc-${TAG}-${OS}-${ARCH}.tar.gz"',
  'BASE="https://github.com/robotmoney/robotmoney-core/releases/download/${TAG}"',
  'curl -fsSL "${BASE}/${ARCHIVE}" | tar xz',
  "install -m 755 rmpc /usr/local/bin/rmpc",
  "```",
].join("\n");

describe("describeSkillMismatch — shared logic behind the served-skill-parity check", () => {
  test("byte-identical served content is not a mismatch", () => {
    expect(describeSkillMismatch({ url: URL, served: repoSkill, repoPath: SKILL_REL, repo: repoSkill })).toBeNull();
  });

  test("goes red on a fixture serving the pre-#758 unverified curl-into-tar install block", () => {
    const result = describeSkillMismatch({
      url: URL,
      served: PRE_758_INSTALL_BLOCK,
      repoPath: SKILL_REL,
      repo: repoSkill,
    });

    // A non-null result is the "red" signal a caller's expect(...).toBeNull()
    // turns into a failing test.
    expect(result).not.toBeNull();
    // AC3: failure output names the URL, what differed, and that the deployed
    // install block may be the unverified form.
    expect(result).toContain(URL);
    expect(result).toContain(SKILL_REL);
    expect(result).toMatch(/first differing line/);
    expect(result).toContain("pre-#758 unverified curl-into-tar form");
  });

  test("goes red on any other divergence too, without claiming it is the unverified form", () => {
    const served = repoSkill.replace(/\n$/, "") + "\nan appended line the repo copy does not have\n";
    const result = describeSkillMismatch({ url: URL, served, repoPath: SKILL_REL, repo: repoSkill });

    expect(result).not.toBeNull();
    expect(result).toContain(URL);
    expect(result).not.toContain("pre-#758 unverified curl-into-tar form");
    expect(result).toContain("stale or diverged some other way");
  });
});
