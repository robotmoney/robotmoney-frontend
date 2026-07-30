// Loaded ONLY via an explicit `bun test ./path` invocation from
// scripts/tests/unit/harness-selftest.test.ts (Bun.spawnSync), never picked up
// by the real per-PR `bun test scripts/tests` recursive selection — the
// ".fixture.ts" suffix deliberately does not match bun's default test-file
// naming convention (".test."/".spec."), so this file existing under
// scripts/tests/fixtures/ can never make the real per-PR run fail.
import { expect, test } from "bun:test";

test("planted failure — proves the runner propagates a nonzero exit", () => {
  expect(1).toBe(2);
});
