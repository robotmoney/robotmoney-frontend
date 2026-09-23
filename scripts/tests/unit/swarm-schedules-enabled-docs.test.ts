// Keep the adopted schedule contract in its single owning specification.
// Runtime env files still describe the currently shipped implementation until
// the adopted design is implemented.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const spec = readFileSync(join(repoRoot, "docs/technical/smoke-production-spec.md"), "utf8");
const sessions = spec.slice(spec.indexOf("### 6.3 Sessions are independent"), spec.indexOf("### 6.4"));

describe("adopted production schedule contract", () => {
  test("session scheduling does not depend on local participants", () => {
    expect(sessions).toContain("whether or not this host runs any participant");
    expect(sessions).toContain("third parties may supply every participant");
  });

  test("nothing is enabled; restart preserves operator state", () => {
    expect(sessions).toContain("There is nothing to enable.");
    expect(sessions).toContain("never disabled");
    expect(sessions).toContain("A plain restart never rewrites operator state");
    expect(sessions).not.toContain("schedules:enable");
    expect(sessions).not.toContain("swarm.*");
  });

  test("preflight checks the duration; readiness checks the epoch and scheduler health", () => {
    expect(sessions).toContain("Preflight checks that every active subject has an epoch duration");
    expect(sessions).toContain("does not require an open epoch before the scheduler starts");
    expect(sessions).toContain("A scheduler reporting exhausted work");
    expect(sessions).toContain("`collecting` rows alone establish nothing");
    expect(sessions).toContain("no `next_run_at`");
    expect(sessions).not.toContain("future `next_run_at`");
  });
});
