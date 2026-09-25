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

describe("member session logs", () => {
  test("every member's stderr since T0 is a source; older runs are not", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { memberSessionLogs } = await import("../../lib/gate/io.ts");
    const root = mkdtempSync(join(tmpdir(), "gate-members-"));
    const run = (session: string, member: string, text: string, ageMs: number) => {
      const dir = join(root, ".agents", "swarm-sessions", "proj", session, member, `${member}-run`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "stderr.log"), text);
      const t = new Date(Date.now() - ageMs);
      utimesSync(join(dir, "stderr.log"), t, t);
    };
    run("s1", "m1", "member-session-client failed: opencode inference timed out after 120000ms\n", 0);
    run("s2", "m1", "ok\n", 0);
    run("s0", "m2", "an old failure\n", 3_600_000);
    const sources = memberSessionLogs(root, "proj", Date.now() - 60_000);
    expect(sources.map((s) => s.source)).toEqual(["member: m1"]);
    expect(sources[0]!.lines.map((l) => l.text)).toContain("member-session-client failed: opencode inference timed out after 120000ms");
    expect(memberSessionLogs(root, "absent-project", 0)).toEqual([]);
  });
});
