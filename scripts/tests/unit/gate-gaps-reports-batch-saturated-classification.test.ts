// Issue 1721: the v0.10.0 production soak (run 20261121T220208Z) logged one
// 503 db_saturated gate=batch for /api/pipeline/read/gaps.reports. Its cause,
// the read's two-connection fan-out on the batch pool, is fixed in 0.10.1
// (backend/tests/api-batch-pool-claim.test.ts). The soak line classifies to a
// known issue so the v0.10.0 verdict warns, and a recurrence from 0.10.1 on
// fails. RED CONTROLS: a db_saturated on another route or gate stays
// unclassified.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const SOURCE = "rm_prod_stack-api-1";
const groupsOf = (lines: string[]) => classify(inventory(SOURCE, lines.map((text) => ({ ts: null, text }))), committed);
const saturated = (path: string, gate: string) =>
  `api error (503 ${path}) db_saturated gate=${gate}: DbSaturatedError: database pool "${gate}" is saturated: no connection became free within 500ms`;
const SOAK_LINE = saturated("/api/pipeline/read/gaps.reports", "batch");

describe("the soak's gaps.reports db_saturated line is a known issue (1721)", () => {
  test("it classifies to known-gaps-reports-batch-fan-out", () => {
    const [g] = groupsOf([SOAK_LINE]);
    expect(g!.rule?.id).toBe("known-gaps-reports-batch-fan-out");
    expect(g!.rule?.class).toBe("known-issue");
    expect(g!.rule?.issue).toBe("1721");
  });

  test("on v0.10.0 it warns, from 0.10.1 a recurrence fails", () => {
    const groups = groupsOf([SOAK_LINE]);
    const soak = inventoryVerdict(groups, "post-release", "v0.10.0");
    expect(soak.failures).toEqual([]);
    expect(soak.warnings.join("\n")).toContain("known-gaps-reports-batch-fan-out");
    for (const release of ["v0.10.1", "0.11.0"]) {
      expect(inventoryVerdict(groups, "post-release", release).failures.join("\n")).toContain("still present after the release that fixes it");
    }
  });
});

describe("RED CONTROLS: other db_saturated lines stay unclassified", () => {
  for (const [path, gate] of [
    ["/api/pipeline/read/gaps.reports", "request"],
    ["/api/pipeline/read/gaps.reports", "pipeline:rm_prod/pipeline-worker"],
    ["/api/pipeline/queue/claim", "batch"],
    ["/api/pipeline/read/wallet_backfill.plan_state", "batch"],
  ] as const) {
    test(`${path} gate=${gate}`, () => {
      const [g] = groupsOf([saturated(path, gate)]);
      expect(g!.rule).toBeNull();
      expect(inventoryVerdict(groupsOf([saturated(path, gate)]), "post-release", "v0.10.0").unclassifiedErrors).toBe(1);
    });
  }
});
