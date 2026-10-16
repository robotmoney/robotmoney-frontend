// A worker job's connect failure that is re-queued with a backoff is the boot
// race (the job's first api call ran before the api listened), so both gates
// classify it as expected and never fail on it (issue 1280).
//
// The line is the one production worker-analytics logged once right after
// boot 2 of the v0.6.1 run 20261010T004257Z, which failed prod:gate R7.3a as
// an unclassified error. RED CONTROLS: the DEAD form of the same line, the same
// line from a non-worker container, and a different message behind the same
// job line stay unclassified and fail.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const WORKER = "rm_prod_stack_20261010-worker-analytics-1";
const groupsOf = (lines: string[], source = WORKER) => classify(inventory(source, lines.map((text) => ({ ts: null, text }))), committed);

const RETRY = "job 48213 (analytics.parity_sweep) failed, retry in 2s: Unable to connect. Is the computer able to access the url?";
const RULE = "expected-worker-job-first-connect-retry";

describe("a worker job's boot-time connect retry is expected", () => {
  test("the production 2026-10-10 line is classified expected", () => {
    const [g] = groupsOf([RETRY]);
    expect(g!.level).toBe("ERROR");
    expect(g!.rule?.id).toBe(RULE);
    expect(g!.rule?.class).toBe("expected");
  });

  test("it passes check 8 after the release, with no failure and no warning", () => {
    const v = inventoryVerdict(groupsOf([RETRY]), "post-release", "v0.6.1");
    expect(v.unclassifiedErrors).toBe(0);
    expect(v.failures).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  test("any job kind and any backoff on a worker container is the same race", () => {
    for (const line of [
      "job 7 (projects.fetch_vaults) failed, retry in 4s: Unable to connect. Is the computer able to access the url?",
      "job 9 (ops.repair_gaps) failed, retry in 16s: Unable to connect. Is the computer able to access the url?",
    ]) {
      expect(groupsOf([line], "rm_prod_stack-worker-ops-1")[0]!.rule?.id).toBe(RULE);
    }
  });
});

describe("RED CONTROLS: the rule stays narrow", () => {
  test("a job whose retries ran out (DEAD) is unclassified and fails", () => {
    const v = inventoryVerdict(
      groupsOf(["job 48213 (analytics.parity_sweep) failed — DEAD: Unable to connect. Is the computer able to access the url?"]),
      "post-release",
      "v0.6.1",
    );
    expect(v.unclassifiedErrors).toBe(1);
    expect(v.failures).toHaveLength(1);
  });

  test("the same line from a non-worker container is unclassified", () => {
    expect(groupsOf([RETRY], "rm_prod_stack_20261010-api-1")[0]!.rule).toBeNull();
    expect(groupsOf([RETRY], "rm_prod_stack_20261010-system-scheduler-1")[0]!.rule).toBeNull();
  });

  test("a different error behind the same job line is unclassified", () => {
    for (const line of [
      "job 48213 (analytics.parity_sweep) failed, retry in 2s: HTTP 500 from /api/analytics/parity-sweep",
      "job 48213 (analytics.parity_sweep) failed, retry in 2s: Unable to connect. Is the computer able to access the url? (after 3 attempts)",
      "job 48213 (analytics.parity_sweep) DEGRADED — kept last-persisted, retry in 2s: Unable to connect. Is the computer able to access the url?",
    ]) {
      expect(groupsOf([line])[0]!.rule).toBeNull();
    }
  });
});
