// The v0 roster's Bankr Agent Token LP is an ERC-20 token, not an ERC-4626
// vault, so before v0.6.2 projects.fetch_vaults failed totalAssets() on it every
// run and wrote no vault (issue 1291). v0.6.2 carries both fixes: issue 1291
// isolates each vault, and issue 1382 (migration 0124) deactivates both Bankr
// lp-fees rows. The two rules stay for baselines read from production before
// v0.6.2: a warning there, a failure if a line recurs after v0.6.2.
// RED CONTROL: the same lines naming any other vault stay unclassified and fail,
// and so does the per-vault line for either Bankr address.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const BANKR_LP = "0x7689006F6C3A3473449E42b628544E60D0bCCb07";
const BNKR = "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b";
const OTHER = "0x" + "4f".repeat(20);
const RULE_IDS = ["known-projects-bankr-lp-vault-extractor", "known-projects-bankr-lp-vault-job-degraded"];
const extractor = (a: string) => `[projects.fetch_vaults] extractor failed — keeping last-persisted rows (degraded): live-source: totalAssets() failed for ${a}`;
const job = (a: string) => `job 71389001 (projects.fetch_vaults) DEGRADED — kept last-persisted, retry in 4s: live-source: totalAssets() failed for ${a}`;
const perVault = (a: string) => `[projects.fetch_vaults] vault 3f1c0d52-0000-4000-8000-000000000000 live read failed, keeping last-persisted TVL (degraded): live-source: totalAssets() failed for ${a}`;
const groupsOf = (lines: string[]) => classify(inventory("worker-analytics", lines.map((text) => ({ ts: null, text }))), committed);

test("the Bankr LP vault's two lines are known issue 1291, fixed in 0.6.2, with no tolerance after the release", () => {
  const groups = groupsOf([extractor(BANKR_LP), job(BANKR_LP)]);
  expect(groups.map((g) => g.rule?.id)).toEqual(RULE_IDS);
  for (const g of groups) {
    expect(g.rule?.issue).toBe("1291");
    expect(g.rule?.fixedIn).toBe("0.6.2");
    expect(g.rule?.tolerateAfterRelease).toBeUndefined();
  }
});

test("a warning in a baseline, a failure after v0.6.2 (the release that carries migration 0124)", () => {
  const groups = groupsOf([extractor(BANKR_LP), job(BANKR_LP)]);
  const baseline = inventoryVerdict(groups, "baseline", "v0.6.2");
  expect(baseline.failures).toEqual([]);
  expect(baseline.warnings.length).toBe(2);
  const post = inventoryVerdict(groups, "post-release", "v0.6.2");
  expect(post.failures.length).toBe(2);
  for (const f of post.failures) expect(f).toContain("still present after the release that fixes it");
});

test("the migration ships in v0.6.2: the roster seed lists neither Bankr token as a vault", () => {
  const roster = readFileSync(join(import.meta.dir, "../../../backend/src/projects/seed/v0-roster-data.json"), "utf8");
  expect(roster).not.toContain(`"vault_address": "${BANKR_LP}"`);
  expect(roster).not.toContain(`"vault_address": "${BNKR}"`);
  const migration = readFileSync(join(import.meta.dir, "../../../backend/migrations/0124_deactivate_bankr_token_vaults.sql"), "utf8");
  expect(migration).toContain(BANKR_LP.toLowerCase());
  expect(migration).toContain(BNKR.toLowerCase());
});

test("red: the same failure on any other vault stays unclassified and fails", () => {
  const groups = groupsOf([extractor(OTHER), job(OTHER)]);
  expect(groups.map((g) => g.rule)).toEqual([null, null]);
  expect(inventoryVerdict(groups, "post-release", "v0.6.2").failures.length).toBeGreaterThan(0);
});

test("red: the per-vault line for either Bankr address is unclassified and fails", () => {
  for (const address of [BANKR_LP, BNKR]) {
    const groups = groupsOf([perVault(address)]);
    expect(groups.map((g) => g.rule)).toEqual([null]);
    for (const mode of ["baseline", "post-release"] as const) {
      expect(inventoryVerdict(groups, mode, "v0.6.2").failures.length, mode).toBe(1);
    }
  }
});
