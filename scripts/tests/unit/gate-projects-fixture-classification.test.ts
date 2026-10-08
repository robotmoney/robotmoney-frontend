// The projects fixture-address degradations are known issue 1208, reported as
// warnings on both gates (twin:gate and prod:gate read the same committed file).
//
// Owner decision 2026-10-08: guard only, no purge in v0.6.0. Production keeps
// the fixture rows persisted under v0.5.4, so the 0.6 live refresh fails on
// every placeholder address each cron. The rules excuse exactly those
// placeholder addresses. RED CONTROL: the same lines naming a real 40-hex
// address stay unclassified and fail the gate.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";
import { CLASSIFICATIONS_PATH } from "../../twin-gate.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const uuid = "5f0c1a7e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const wallet = (addr: string) =>
  `[projects.refresh_wallets] wallet ${uuid} live read failed, keeping last-persisted balance (degraded): invalid address: ${addr}`;
const vaultExtractor = (addr: string) =>
  `[projects.fetch_vaults] extractor failed — keeping last-persisted rows (degraded): invalid address: ${addr}`;
const vaultJob = (addr: string) => `job 4182 (projects.fetch_vaults) DEGRADED — kept last-persisted, retry in 300s: invalid address: ${addr}`;
const vaultJobExhausted = (addr: string) =>
  `job 4182 (projects.fetch_vaults) DEGRADED — kept last-persisted (attempts exhausted; settled FAILED, next cron re-enqueues): invalid address: ${addr}`;

const FIXTURE_WALLETS = ["aaa", "bbb", "ccc", "ddd"].map((s) => `0xwallet0000000000000000000000000000000${s}`);
const FIXTURE_VAULT = "0xvault0000000000000000000000000000000aaa";
const REAL = "0x4200000000000000000000000000000000000006";

const groupsOf = (lines: string[]) => classify(inventory("worker-analytics", lines.map((text) => ({ ts: null, text }))), committed);

test("both gates read the committed classification file", () => {
  expect(CLASSIFICATIONS_PATH).toBe(join(import.meta.dir, "../../lib/gate/log-classifications.json"));
  expect(readFileSync(join(import.meta.dir, "../../prod-gate.ts"), "utf8")).toContain("CLASSIFICATIONS_PATH");
});

test("the fixture addresses are the dataset's own placeholder addresses", () => {
  const dataset = readFileSync(join(import.meta.dir, "../../../backend/src/projects/fixtures/dataset.ts"), "utf8");
  for (const a of [...FIXTURE_WALLETS, FIXTURE_VAULT]) expect(dataset).toContain(`"${a}"`);
});

describe("each logged fixture-address line is known issue 1208", () => {
  const cases: Array<[string, string]> = [
    ...FIXTURE_WALLETS.map((a) => [wallet(a), "known-projects-fixture-wallet-live-read"] as [string, string]),
    [vaultExtractor(FIXTURE_VAULT), "known-projects-fixture-vault-extractor"],
    [vaultJob(FIXTURE_VAULT), "known-projects-fixture-vault-job-degraded"],
    [vaultJobExhausted(FIXTURE_VAULT), "known-projects-fixture-vault-job-degraded"],
  ];
  for (const [line, id] of cases) {
    test(line.slice(0, 90), () => {
      const [g] = groupsOf([line]);
      expect(g!.rule?.id).toBe(id);
      expect(g!.rule?.class).toBe("known-issue");
      expect(g!.rule?.issue).toBe("1208");
    });
  }

  test("they are warnings, never failures, in a baseline and after the v0.6.0 release", () => {
    const lines = cases.map(([l]) => l);
    for (const mode of ["baseline", "post-release"] as const) {
      const v = inventoryVerdict(groupsOf(lines), mode, "v0.6.0");
      expect(v.failures).toEqual([]);
      expect(v.warnings.filter((w) => w.includes("(1208)")).length).toBeGreaterThan(0);
    }
    // The twin gate grades without a release tag; still a warning.
    expect(inventoryVerdict(groupsOf(lines), "post-release").failures).toEqual([]);
  });

  test("every 1208 rule cites the owner decision and tolerates with a reason", () => {
    for (const r of committed.filter((x) => x.issue === "1208")) {
      expect(r.tolerateAfterRelease).toContain("2026-10-08");
      expect(r.tolerateAfterRelease).toContain("no purge");
    }
  });
});

describe("RED CONTROL: the same failure on a real address stays unclassified and fails", () => {
  for (const line of [
    wallet(REAL),
    vaultExtractor(REAL),
    vaultJob(REAL),
    vaultJobExhausted(REAL),
    // Near misses: a placeholder of another shape, or a fixture address with a suffix.
    wallet("0xwallet0000000000000000000000000000000eee"),
    vaultExtractor("0xvault0000000000000000000000000000000aaa0"),
  ]) {
    test(line.slice(0, 90), () => {
      const [g] = groupsOf([line]);
      expect(g!.rule).toBeNull();
      const v = inventoryVerdict(groupsOf([line]), "post-release", "v0.6.0");
      expect(v.unclassifiedErrors).toBe(1);
      expect(v.failures.join("\n")).toContain("unclassified error");
    });
  }
});
