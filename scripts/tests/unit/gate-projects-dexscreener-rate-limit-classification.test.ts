// projects.sync_revenue reads DexScreener. A 429 (rate limit) makes the handler keep the
// last-persisted revenue rows, mark the run degraded and retry the job
// (backend/src/worker/handlers/projects.ts), so it is an external outcome, not a platform
// failure. The v0.6.2 QA baseline on stage-2 (2026-10-16) read production's v0.6.1 stack and
// failed on the extractor line as unclassified.
// RED CONTROL: any other DexScreener status, or any other extractor kind, stays unclassified.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const RULE_IDS = ["external-dexscreener-rate-limit-extractor", "external-dexscreener-rate-limit-job-degraded"];
const extractor = (kind: string, why: string) => `[projects.${kind}] extractor failed — keeping last-persisted rows (degraded): ${why}`;
const job = (kind: string, why: string) => `job 71393404 (projects.${kind}) DEGRADED — kept last-persisted, retry in 2s: ${why}`;
const groupsOf = (lines: string[]) => classify(inventory("worker-analytics", lines.map((text) => ({ ts: null, text }))), committed);

test("a DexScreener 429 on sync_revenue is external, in the extractor line and the job line", () => {
  const groups = groupsOf([extractor("sync_revenue", "dexscreener 429"), job("sync_revenue", "dexscreener 429")]);
  expect(groups.map((g) => g.rule?.id)).toEqual(RULE_IDS);
  for (const g of groups) expect(g.rule?.class).toBe("external");
});

test("it is a warning in a baseline and after the release, never a failure", () => {
  const groups = groupsOf([extractor("sync_revenue", "dexscreener 429"), job("sync_revenue", "dexscreener 429")]);
  for (const mode of ["baseline", "post-release"] as const) {
    const v = inventoryVerdict(groups, mode, "v0.6.2");
    expect(v.failures).toEqual([]);
  }
});

test("red: another DexScreener status stays unclassified and fails", () => {
  const groups = groupsOf([extractor("sync_revenue", "dexscreener 500"), job("sync_revenue", "dexscreener 500")]);
  expect(groups.map((g) => g.rule)).toEqual([null, null]);
  expect(inventoryVerdict(groups, "baseline", "v0.6.2").failures.length).toBeGreaterThan(0);
});

test("red: a 429 on another projects job stays unclassified and fails", () => {
  const groups = groupsOf([extractor("fetch_vaults", "dexscreener 429")]);
  expect(groups.map((g) => g.rule)).toEqual([null]);
  expect(inventoryVerdict(groups, "baseline", "v0.6.2").failures.length).toBeGreaterThan(0);
});
