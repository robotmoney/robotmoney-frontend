// The default-deny log inventory both gates grade (scripts/lib/gate/).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classify,
  inventory,
  inventoryVerdict,
  lineLevel,
  renderInventory,
  validateRules,
  type ClassificationRule,
} from "../../lib/gate/log-inventory.ts";

const rules: ClassificationRule[] = [
  { id: "guard", match: "is immutable: DELETE is not permitted", class: "expected", reason: "the guard probe must be refused" },
  { id: "gecko", match: "geckoterminal.*throttled", class: "external", reason: "third-party rate limit, degraded around" },
  { id: "ro", match: "read-only transaction", class: "known-issue", issue: "1035", reason: "cluster read-only as its disk fills" },
];

describe("inventory", () => {
  test("groups error- and warning-like lines by normalised message, with counts and first/last", () => {
    const g = inventory("api", [
      { ts: "2026-09-25T10:00:00Z", text: "job 1 failed: boom" },
      { ts: "2026-09-25T11:00:00Z", text: "job 2 failed: boom" },
      { ts: "2026-09-25T11:30:00Z", text: "retrying in 500ms" },
      { ts: "2026-09-25T12:00:00Z", text: "all good" },
    ]);
    expect(g.map((x) => [x.level, x.key, x.count, x.first, x.last])).toEqual([
      ["ERROR", "job <n> failed: boom", 2, "2026-09-25T10:00:00Z", "2026-09-25T11:00:00Z"],
      ["WARN", "retrying in <n>ms", 1, "2026-09-25T11:30:00Z", "2026-09-25T11:30:00Z"],
    ]);
  });

  test("the level words cover what production actually logged on 2026-09-25", () => {
    for (const l of ["cannot execute UPDATE in a read-only transaction", "No space left on device... could not extend file", "permission denied for table x", "The socket connection was closed unexpectedly: request timed out"]) {
      expect(lineLevel(l)).toBe("ERROR");
    }
    expect(lineLevel("level=warning msg=x")).toBe("WARN");
    expect(lineLevel("session published")).toBeNull();
  });
});

describe("default deny", () => {
  const groups = classify(
    [
      ...inventory("db", [{ ts: null, text: "ERROR: ledger is immutable: DELETE is not permitted on t" }]),
      ...inventory("worker", [{ ts: null, text: "PostgresError: cannot execute UPDATE in a read-only transaction" }]),
      ...inventory("producer", [{ ts: null, text: "[geckoterminal] still throttled (HTTP 429)" }]),
      ...inventory("api", [{ ts: null, text: "something brand new failed" }]),
    ],
    rules,
  );

  test("an unclassified error fails in every mode", () => {
    for (const mode of ["baseline", "post-release"] as const) {
      const v = inventoryVerdict(groups, mode);
      expect(v.unclassifiedErrors).toBe(1);
      expect(v.failures.join("\n")).toContain('unclassified error — api: ×1 "something brand new failed"');
    }
  });

  test("a known issue is a warning in a baseline and a failure after the release", () => {
    expect(inventoryVerdict(groups, "baseline").warnings.join("\n")).toContain("known issue ro (1035)");
    expect(inventoryVerdict(groups, "post-release").failures.join("\n")).toContain("known issue ro (1035) still present after the release");
  });

  test("a known issue may be tolerated after the release only with a written reason", () => {
    const tolerant = classify(inventory("w", [{ ts: null, text: "read-only transaction x" }]), [{ ...rules[2]!, tolerateAfterRelease: "provider-side, tracked" }]);
    expect(inventoryVerdict(tolerant, "post-release").failures).toEqual([]);
  });

  test("the rendered inventory marks every unclassified group", () => {
    expect(renderInventory(groups).join("\n")).toContain("**UNCLASSIFIED**");
  });
});

describe("the committed classification file", () => {
  const file = JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8"));

  test("every rule is valid: an id, a compiling regex, a class and a real reason", () => {
    expect(() => validateRules(file)).not.toThrow();
  });

  test("every known issue names its issue", () => {
    for (const r of validateRules(file).filter((x) => x.class === "known-issue")) expect(r.issue).toBeTruthy();
  });

  test("validation rejects a rule with no reason", () => {
    expect(() => validateRules([{ id: "x", match: "y", class: "expected", reason: "" }])).toThrow("reason");
  });

  test("production's 2026-09-25 read-only and disk-full lines are known issues, not silently expected", () => {
    const committed = validateRules(file);
    const g = classify(inventory("w", [
      { ts: null, text: "PostgresError: cannot execute UPDATE in a read-only transaction" },
      { ts: null, text: 'PostgresError: could not write to file "base/pgsql_tmp/x": No space left on device' },
    ]), committed);
    expect(g.map((x) => x.rule?.class)).toEqual(["known-issue", "known-issue"]);
  });
});

describe("main's services against the committed classifications (default deny, with red controls)", () => {
  const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
  const sid = "3bd2d2ae-43d7-4bb4-9f6a-c4477e135775";
  const agent = (rest: string) => `[agent:athena] {"sessionId":"${sid}","memberId":"m1",${rest}}`;
  const judge = (reason: string) => `[judge:rm-judge] {"kind":"refused","sessionId":"${sid}","reason":"${reason}","detail":"x"}`;
  const verdictOf = (source: string, lines: string[], rules = committed) =>
    inventoryVerdict(classify(inventory(source, lines.map((text) => ({ ts: null, text }))), rules), "post-release", "v0.6.0");

  const timeout = agent('"oneShot":"timeout","submission":null,"durationMs":120000,"reason":"opencode inference timed out after 120000ms"');
  const rejected = agent('"oneShot":"ok","submission":"refused","nonce":"n1","durationMs":900,"reason":"weights_not_canonical_four: this take names {a, b}"');

  test("a participant's model timeout and a rejected take are external outcomes: reported, not failing", () => {
    const g = classify(inventory("participant-agent-athena", [timeout, rejected].map((text) => ({ ts: null, text }))), committed);
    expect(g.map((x) => [x.rule?.id, x.rule?.class])).toEqual([
      ["external-participant-take-timeout", "external"],
      ["external-participant-take-rejected", "external"],
    ]);
    expect(verdictOf("participant-agent-athena", [timeout, rejected]).failures).toEqual([]);
  });

  test("a judge's model timeout is external", () => {
    expect(verdictOf("participant-judge-rm", [judge("model_timeout")]).failures).toEqual([]);
  });

  test("RED CONTROL: a dead judge (credit, credential, model, runner) is unclassified and fails", () => {
    for (const reason of ["credit_exhausted", "credential_rejected", "model_not_supported", "model_unconfigured", "runner"]) {
      const v = verdictOf("participant-judge-rm", [judge(reason)]);
      expect(v.unclassifiedErrors).toBe(1);
      expect(v.failures.join("\n")).toContain("unclassified error");
    }
  });

  test("RED CONTROL: a refusal that is not a model outcome (a closed window) is unclassified and fails", () => {
    const closed = agent('"oneShot":"ok","submission":"refused","nonce":"n1","durationMs":9,"reason":"window_closed"');
    expect(verdictOf("participant-agent-athena", [closed]).failures.join("\n")).toContain("unclassified error");
  });

  test("RED CONTROL: a brand-new error in any service fails, and so does the same timeout once its rule is gone", () => {
    expect(verdictOf("system-scheduler", ["[system-scheduler] automation token rejected: 401 — unhealthy until restarted"]).failures).toHaveLength(1);
    expect(verdictOf("website-server", ["2026/10/03 [error] 7#7: *1 open() failed"]).failures).toHaveLength(1);
    expect(verdictOf("participant-agent-athena", [timeout], []).failures).toHaveLength(1);
  });

  test("lines of components main retired are no longer excused", () => {
    for (const line of [
      "swarm session failed (stack still running): independent analytics producer exited 1 for regime",
      "member-session-client failed: opencode inference timed out after 120000ms",
      "job 12 (swarm.judge) failed, retry in 30s: judge produced no judgement (model_timeout)",
      "[window] session read failed (attempt 2): GET /api/swarm/sessions/x -> HTTP 502; retrying",
    ]) {
      expect(verdictOf("old", [line]).failures).toHaveLength(1);
    }
  });

  test("a participant that cannot start is fatal in the log scan", async () => {
    const { classifyLog } = await import("../../twin-gate.ts");
    const v = classifyLog(["participant judge rm-judge refuses to subscribe: apiReachable=true tokenValid=false serverMemberId=none expected=m9"], []);
    expect([...v.fatal.keys()]).toEqual(["refuses to subscribe"]);
  });
});
