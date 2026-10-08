// prod:gate's pure decisions (scripts/prod-gate.ts). Each case is something
// production actually did on 2026-09-24/25 that no runbook step caught.
import { describe, expect, test } from "bun:test";
import { evaluateCapacity, parseProdGateArgs, renderProdReport } from "../../prod-gate.ts";

const GB = 1024 ** 3;

describe("evaluateCapacity (report-only)", () => {
  test("no stated capacity still reports the size, as a warning", () => {
    const v = evaluateCapacity(8 * GB, undefined, null, "2026-09-25T17:00:00Z");
    expect(v.status).toBe("WARN");
    expect(v.detail.join("\n")).toContain("8.00 GB");
  });

  test("a tight disk warns and never fails", () => {
    expect(evaluateCapacity(8.5 * GB, 10, null, "2026-09-25T17:00:00Z").status).toBe("WARN");
    expect(evaluateCapacity(5 * GB, 30, null, "2026-09-25T17:00:00Z").status).toBe("PASS");
  });

  test("steep growth is reported with its projection, as a warning", () => {
    const v = evaluateCapacity(8.2 * GB, 30, { sizeBytes: 6.5 * GB, at: "2026-09-25T09:00:00Z" }, "2026-09-25T17:00:00Z");
    expect(v.status).toBe("WARN");
    expect(v.detail.join("\n")).toContain("GB/day");
  });

  test("slow growth on a roomy disk passes", () => {
    expect(evaluateCapacity(2 * GB, 30, { sizeBytes: 1.99 * GB, at: "2026-09-24T17:00:00Z" }, "2026-09-25T17:00:00Z").status).toBe("PASS");
  });
});

describe("parseProdGateArgs", () => {
  test("defaults to a 24 h baseline graded as v0.6.0", () => {
    expect(parseProdGateArgs([])).toMatchObject({ mode: "baseline", windowHours: 24, stuckAfterMin: 780, release: "v0.6.0" });
  });

  test("rejects an unknown mode, a bad capacity and a non-markdown report", () => {
    expect(parseProdGateArgs(["--mode", "later"])).toHaveProperty("error");
    expect(parseProdGateArgs(["--db-capacity-gb", "-1"])).toHaveProperty("error");
    expect(parseProdGateArgs(["--report", "/tmp/x.txt"])).toHaveProperty("error");
  });

  test("--defer-sessions is a flag", () => {
    expect(parseProdGateArgs(["--mode", "post-release", "--defer-sessions", "--db-capacity-gb", "25"])).toMatchObject({ mode: "post-release", deferSessions: true, capacityGb: 25 });
  });

  test("--sessions graded|deferred is the value form the release run renders from target data", () => {
    expect(parseProdGateArgs(["--mode", "post-release", "--sessions", "deferred"])).toMatchObject({ deferSessions: true });
    expect(parseProdGateArgs(["--mode", "post-release", "--sessions", "graded"])).toMatchObject({ deferSessions: false });
    expect(parseProdGateArgs(["--mode", "post-release", "--defer-sessions", "--sessions", "deferred"])).toMatchObject({ deferSessions: true });
    // red: an unknown value, or a contradiction, refuses.
    expect(parseProdGateArgs(["--sessions", "later"])).toHaveProperty("error");
    expect(parseProdGateArgs(["--sessions", "graded", "--defer-sessions"])).toHaveProperty("error");
    expect(parseProdGateArgs(["--defer-sessions", "--sessions", "graded"])).toHaveProperty("error");
  });

  test("selects the stack by --instance; the old state-file, driver-log and SMOKE_PROJECT routes are gone", () => {
    expect(parseProdGateArgs(["--instance", "rm_prod", "--mode", "post-release"])).toMatchObject({ mode: "post-release" });
    expect(parseProdGateArgs(["--state-file", "/x/smoke-state.json"])).toEqual({ error: 'unknown argument "--state-file".' });
    expect(parseProdGateArgs(["--driver-log", "/x.log"])).toEqual({ error: 'unknown argument "--driver-log".' });
  });
});

describe("known issues after the release", () => {
  test("only a known issue THIS release fixes fails; issue 1035 is a warning", async () => {
    const { classify, inventory, inventoryVerdict } = await import("../../lib/gate/log-inventory.ts");
    const rules = [
      { id: "wallet", match: "permission denied for table wallet_backfill_state", class: "known-issue" as const, issue: "D2", fixedIn: "0.5.1", reason: "rm_worker lacked the grants, fixed by 0061" },
      { id: "ledger", match: "upstream prematurely closed", class: "known-issue" as const, issue: "1035", reason: "ledger load, not this release" },
    ];
    const g = classify(inventory("x", [{ ts: null, text: "PostgresError: permission denied for table wallet_backfill_state" }, { ts: null, text: "[error] upstream prematurely closed connection" }]), rules);
    const v = inventoryVerdict(g, "post-release", "v0.5.1");
    expect(v.failures.join("\n")).toContain("known issue wallet (D2, fixed in 0.5.1) still present after the release that fixes it");
    expect(v.warnings.join("\n")).toContain("known issue ledger (1035), not fixed by v0.5.1 or earlier");
  });
});

describe("fixedByOrBefore", () => {
  test("fixed in this release or an earlier one counts; a later one does not (semver)", async () => {
    const { fixedInOrBefore } = await import("../../lib/gate/log-inventory.ts");
    expect(fixedInOrBefore("0.5.1", "v0.5.2")).toBe(true);
    expect(fixedInOrBefore("0.5.2", "0.5.2")).toBe(true);
    expect(fixedInOrBefore("0.5.3", "v0.5.2")).toBe(false);
    expect(fixedInOrBefore("0.4.9", "0.5.0")).toBe(true);
    expect(fixedInOrBefore("0.10.0", "0.9.9")).toBe(false);
  });

  test("a rule must keep the version out of its issue id and write fixedIn as plain semver", async () => {
    const { validateRules } = await import("../../lib/gate/log-inventory.ts");
    const base = { id: "x", match: "y", class: "known-issue", reason: "a reason long enough" };
    expect(() => validateRules([{ ...base, issue: "v0.5.2-1035" }])).toThrow("not a version");
    expect(() => validateRules([{ ...base, issue: "1035", fixedIn: "v0.5.2" }])).toThrow("plain semver");
    expect(() => validateRules([{ ...base, issue: "1035", fixedIn: "0.5.2" }])).not.toThrow();
  });
});

describe("the report", () => {
  test("names the instance, the outcome of each session and the participants", () => {
    const md = renderProdReport({
      mode: "post-release", verdict: "FAIL", host: "h", commit: "v0.6.0", instance: "rm_prod", project: "p", since: "2026-10-03T00:00:00Z",
      finishedAt: "2026-10-03T01:00:00Z", dbSizeBytes: 2 * GB,
      checks: [{ id: "sessions", title: "sessions", status: "FAIL", detail: ["session s1 (a) published unjudged (judging outcome 'no_consensus')"] }],
      sessions: [{ id: "s1", subject: "a", state: "published", outcome: "no_consensus", ageMin: 120, publishedAtMs: 1, takes: 3, judged: false, receipt: false }],
      containers: [{ name: "p-participant-judge-1", running: true, health: "none", restarts: 0, startedAt: "t", oneShot: false, participantKind: "judge" }],
      inventory: [],
    });
    expect(md).toContain("| Instance | `rm_prod` |");
    expect(md).toContain("| a | published | no_consensus |");
    expect(md).toContain("participant (judge)");
  });
});
