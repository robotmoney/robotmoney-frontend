// The v0 roster's Bankr Agent Token LP is not an ERC-4626 vault, so
// projects.fetch_vaults fails totalAssets() on it every run and writes no
// vault (issue 1291, pre-existing since v0.6.0, fixed by no release yet). Both
// gates report the two lines as a known issue: a warning, after the release too.
// RED CONTROL: the same lines naming any other vault stay unclassified and fail.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const BANKR_LP = "0x7689006F6C3A3473449E42b628544E60D0bCCb07";
const OTHER = "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b";
const extractor = (a: string) => `[projects.fetch_vaults] extractor failed — keeping last-persisted rows (degraded): live-source: totalAssets() failed for ${a}`;
const job = (a: string) => `job 71389001 (projects.fetch_vaults) DEGRADED — kept last-persisted, retry in 4s: live-source: totalAssets() failed for ${a}`;
const groupsOf = (lines: string[]) => classify(inventory("worker-analytics", lines.map((text) => ({ ts: null, text }))), committed);

test("the Bankr LP vault's two lines are known issue 1291, and the roster names that vault", () => {
  const groups = groupsOf([extractor(BANKR_LP), job(BANKR_LP)]);
  expect(groups.map((g) => g.rule?.id)).toEqual(["known-projects-bankr-lp-vault-extractor", "known-projects-bankr-lp-vault-job-degraded"]);
  expect(groups.every((g) => g.rule?.issue === "1291")).toBe(true);
  const roster = readFileSync(join(import.meta.dir, "../../../backend/src/projects/seed/v0-roster-data.json"), "utf8");
  expect(roster).toContain(BANKR_LP);
});

test("a warning, not a failure, in a baseline and after the release (tolerated with a reason)", () => {
  for (const mode of ["baseline", "post-release"] as const) {
    const v = inventoryVerdict(groupsOf([extractor(BANKR_LP), job(BANKR_LP)]), mode, mode === "post-release" ? "v0.6.2" : undefined);
    expect(v.failures, mode).toEqual([]);
    expect(v.warnings.length, mode).toBeGreaterThan(0);
  }
});

test("red: the same failure on any other vault stays unclassified and fails", () => {
  const groups = groupsOf([extractor(OTHER), job(OTHER)]);
  expect(groups.map((g) => g.rule)).toEqual([null, null]);
  expect(inventoryVerdict(groups, "post-release", "v0.6.2").failures.length).toBeGreaterThan(0);
});
