// No market-data refresh at startup (owner, 2026-09-28). The regime runs on the
// analytics producer's own schedule. A startup refresh that timed out under
// analytics-ledger load tore production's whole stack down on 2026-09-25.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the standing boot never runs the regime producer itself", () => {
  const src = readFileSync(join(import.meta.dir, "../../lib/smoke-main.ts"), "utf8");
  expect(src).not.toContain("runRegimeClassify(");
  expect(src).not.toContain("regime-boot");
});
