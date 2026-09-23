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
    expect(sessions).toContain("Third parties may supply every participant");
  });

  test("production initialization enables schedules; restart preserves operator state", () => {
    expect(sessions).toContain("production-initialization command");
    expect(sessions).toContain("sets the five `swarm.*` rows enabled");
    expect(sessions).toContain("A plain restart never rewrites operator state");
  });

  test("preflight does not require a future next_run_at", () => {
    expect(sessions).toContain("does not require a future `next_run_at`");
    expect(sessions).toContain("Readiness, after `worker` is up");
  });
});
