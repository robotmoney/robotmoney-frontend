// Two line families the v0.6.1 production R2.5 baseline (2026-10-10) failed on
// without either being a failure (issue 1278):
//   - website-server nginx access-log lines whose request path carries a
//     scanner's words (error, fail): an access-log line is classified by its
//     shape and status, never by words in it;
//   - the judge participant's `subscription error: Unable to connect`, the same
//     boot/connect race the scheduler and worker rules already cover; the
//     client reconnects on its own.
// RED CONTROLS: a 5xx access-log line, an nginx error-log line, the same 404
// line from another container, any other judge subscription error, and the
// judge message from a non-judge container all stay unclassified and fail.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const WEB = "rm_prod_stack_20261010-website-server-1";
const JUDGE = "rm_prod_stack_20261010-participant-judge-themis-1";
const groupsOf = (lines: string[], source: string) => classify(inventory(source, lines.map((text) => ({ ts: null, text }))), committed);
const verdictOf = (lines: string[], source: string, mode: "baseline" | "post-release") => inventoryVerdict(groupsOf(lines, source), mode, "v0.6.1");

// nginx `combined` format (website-server/nginx.conf sets no log_format), with
// the request paths the production run logged.
const access = (request: string, status: number, agent = "Mozilla/5.0 zgrab/0.x") =>
  `203.0.113.7 - - [10/Oct/2026:00:51:12 +0000] "${request}" ${status} 153 "-" "${agent}"`;
const SCANNERS = [
  access("GET /error.php?SERVER_NAME=<script>alert(1)</script> HTTP/1.1", 404),
  access("GET /admin/public/login.jsp?error=1 HTTP/1.1", 404),
  access("POST /rails/actions?error=ActiveRecord::PendingMigrationError&action=run HTTP/1.1", 404),
];
const ONBOARDING_PROBE = access("GET /skills/swarm-onboarding/this-path-cannot-exist.md HTTP/1.1", 404, "robotmoney-drift-audit");
const ACCESS_RULE = "expected-website-access-line-4xx";

const JUDGE_RETRY = "[judge:themis] subscription error: Unable to connect. Is the computer able to access the url?";
const JUDGE_RULE = "expected-judge-subscribe-connect-retry";

describe("a website-server 4xx access-log line is expected whatever its path says", () => {
  test("the three scanner probes and the onboarding dead-path probe are each classified expected", () => {
    for (const line of [...SCANNERS, ONBOARDING_PROBE]) {
      const [g] = groupsOf([line], WEB);
      expect(g!.level).toBe("ERROR");
      expect(g!.rule?.id).toBe(ACCESS_RULE);
      expect(g!.rule?.class).toBe("expected");
    }
  });

  test("they pass the inventory in a baseline and after the release, with no failure and no warning", () => {
    for (const mode of ["baseline", "post-release"] as const) {
      const v = verdictOf([...SCANNERS, ONBOARDING_PROBE], WEB, mode);
      expect(v.unclassifiedErrors).toBe(0);
      expect(v.failures).toEqual([]);
      expect(v.warnings).toEqual([]);
    }
  });

  test("a line longer than the 400-char sample still matches when its status is inside the sample", () => {
    const line = access("GET /error.php?payload=failed HTTP/1.1", 400, "fail ".repeat(100));
    expect(line.length).toBeGreaterThan(400);
    expect(groupsOf([line], WEB)[0]!.rule?.id).toBe(ACCESS_RULE);
  });

  test("a request so long that its status falls outside the sample stays unclassified (fails safe, never passes by accident)", () => {
    const line = access(`GET /error.php?payload=${"failed".repeat(120)} HTTP/1.1`, 404);
    expect(groupsOf([line], WEB)[0]!.rule).toBeNull();
  });
});

describe("RED CONTROLS: the access-log rule is keyed on source, shape and status", () => {
  test("a 5xx access-log line from website-server is unclassified and fails", () => {
    // The same scanner path, answered 502: the status, not the path, is what grades it.
    const line = access("GET /error.php?SERVER_NAME=<script>alert(1)</script> HTTP/1.1", 502);
    const v = verdictOf([line], WEB, "post-release");
    expect(groupsOf([line], WEB)[0]!.rule).toBeNull();
    expect(v.unclassifiedErrors).toBe(1);
    expect(v.failures).toHaveLength(1);
  });

  test("an nginx error-log line containing 'error' from website-server is unclassified and fails", () => {
    const line = '2026/10/10 00:51:12 [error] 29#29: *14 open() "/usr/share/nginx/html/error.php" failed (2: No such file or directory), client: 203.0.113.7, server: _, request: "GET /error.php HTTP/1.1"';
    const v = verdictOf([line], WEB, "post-release");
    expect(groupsOf([line], WEB)[0]!.rule).toBeNull();
    expect(v.failures).toHaveLength(1);
  });

  test("the same 404 access-log line from the api container is unclassified", () => {
    expect(groupsOf([SCANNERS[0]!], "rm_prod_stack_20261010-api-1")[0]!.rule).toBeNull();
  });
});

describe("the judge's subscribe connect retry is expected", () => {
  test("the production 2026-10-10 line is classified expected", () => {
    const [g] = groupsOf([JUDGE_RETRY], JUDGE);
    expect(g!.level).toBe("ERROR");
    expect(g!.rule?.id).toBe(JUDGE_RULE);
    expect(g!.rule?.class).toBe("expected");
  });

  test("it passes the inventory after the release, with no failure and no warning", () => {
    const v = verdictOf([JUDGE_RETRY], JUDGE, "post-release");
    expect(v.unclassifiedErrors).toBe(0);
    expect(v.failures).toEqual([]);
    expect(v.warnings).toEqual([]);
  });
});

describe("RED CONTROLS: the judge rule stays narrow", () => {
  test("any other subscription error is unclassified and fails", () => {
    for (const line of [
      "[judge:themis] subscription error: judge subscription failed: HTTP 500",
      "[judge:themis] subscription error: judge subscription failed: HTTP 503",
      "[judge:themis] subscription error: judge subscription refused with HTTP 403",
      "[judge:themis] subscription error: Unable to connect. Is the computer able to access the url? (after 3 attempts)",
    ]) {
      const v = verdictOf([line], JUDGE, "post-release");
      expect(groupsOf([line], JUDGE)[0]!.rule).toBeNull();
      expect(v.failures).toHaveLength(1);
    }
  });

  test("the same connect message from an agent participant or the api container is unclassified", () => {
    expect(groupsOf(["[agent:hermes] subscription error: Unable to connect. Is the computer able to access the url?"], "rm_prod_stack_20261010-participant-agent-hermes-1")[0]!.rule).toBeNull();
    expect(groupsOf([JUDGE_RETRY], "rm_prod_stack_20261010-api-1")[0]!.rule).toBeNull();
  });
});
