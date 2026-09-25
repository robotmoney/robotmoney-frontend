// The startup-failure decisions, executed rather than grepped (the #456/#537
// split rule): which services a failed boot stops, what it recovers out of the
// log as a cause, and that the pane says whether the database is still moving.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB_WRITER_SERVICES, selectFailureDetail, writerQuiesceLine } from "../../lib/smoke-failure.ts";

const STRIP_ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(STRIP_ANSI, "");

describe("DB_WRITER_SERVICES — what a failed boot must stop", () => {
  test("never names postgres: it IS the database, and --external-pg has no such container", () => {
    expect(DB_WRITER_SERVICES).not.toContain("postgres");
  });

  test("covers every service that writes: the api, the producer and both worker lanes", () => {
    expect([...DB_WRITER_SERVICES].sort()).toEqual(
      ["analytics-producer", "api", "worker-analytics", "worker-research"],
    );
  });

  test("never names system-scheduler: it holds no database credential to quiesce", () => {
    // system-scheduler-spec.md §7 — it holds exactly one credential, an API
    // token. Listing it here would claim a writer that cannot write, and would
    // stop the one container whose /health explains a stalled boot.
    expect(DB_WRITER_SERVICES).not.toContain("system-scheduler");
  });
});

describe("writerQuiesceLine — states whether the database stopped changing", () => {
  test("a successful quiesce says nothing is still writing", () => {
    expect(plain(writerQuiesceLine("stopped"))).toContain("nothing is still writing");
  });

  test("a FAILED quiesce says so loudly — those writes are the ones no teardown undoes", () => {
    const line = plain(writerQuiesceLine("failed"));
    expect(line).toContain("could NOT stop");
    expect(line).toContain("STILL be writing");
    expect(line).toContain("smoke:down");
  });

  test("every state renders a non-empty line (no silent gap in the report)", () => {
    for (const w of ["stopped", "failed", "none"] as const) {
      expect(plain(writerQuiesceLine(w)).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("selectFailureDetail — recovers a cause the orchestrator never sees", () => {
  // The real shape: smoke-main can only raise "…failed (exit 1)". The refusal
  // itself is in the log, written by the child.
  const REAL_LOG = [
    "[2026-08-07T02:14:57.245Z] api healthy",
    "robotmoney prod-bootstrap — one-time production data pipelines",
    "[v0-seed-bootstrap] members: inserted=0 unchanged=3 drifted=0 (of 3)",
    "[v0-seed-bootstrap] 2 inconsistencies detected — existing row(s) differ from the archive and were NOT overwritten:",
    '  - swarm_subjects (id=robotmoney-allocation) field "recommendation_type": existing="position_actions" incoming="bucket_weights"',
    "WARN [1/2] v0-seed:bootstrap — 0.9s — 0 members inserted, 2 drift",
  ].join("\n");

  test("surfaces the refusal lines, not the healthy narration around them", () => {
    const detail = selectFailureDetail(REAL_LOG, "/tmp/smoke.log");
    const joined = detail.join("\n");
    expect(joined).toContain("2 inconsistencies detected");
    expect(joined).toContain("recommendation_type");
    expect(joined).not.toContain("api healthy");
  });

  test("always ends by naming the full log, so the tail is never mistaken for all of it", () => {
    expect(selectFailureDetail(REAL_LOG, "/tmp/smoke.log").at(-1)).toBe("full log: /tmp/smoke.log");
  });

  test("falls back to the plain tail when nothing matches — something beats nothing", () => {
    const detail = selectFailureDetail("alpha\nbravo\ncharlie", "/tmp/d.log");
    expect(detail).toEqual(["alpha", "bravo", "charlie", "full log: /tmp/d.log"]);
  });

  test("caps the excerpt so a noisy log cannot crowd the pane off the screen", () => {
    const noisy = Array.from({ length: 200 }, (_, i) => `ERROR line ${i}`).join("\n");
    expect(selectFailureDetail(noisy, "/tmp/d.log")).toHaveLength(7); // 6 + the log path
  });

  test("an empty log yields just the pointer, never a crash", () => {
    expect(selectFailureDetail("", "/tmp/d.log")).toEqual(["full log: /tmp/d.log"]);
  });

  // Regression: the preflight refusal uses none of WARN/ERROR/FAIL, so the
  // pane anchored on the smoke's own trailing "startup failed" line and
  // restated the exit code instead of naming the reason. (The refusal now
  // fires only for a SIMULATION boot against a populated database — an
  // archive boot adopts it — but the pane behavior under test is the same.)
  test("a refusal surfaces the refusal, not the trailing 'startup failed' restatement", () => {
    const log = [
      " Container smoke-api-run-1 Created",
      "[db-preflight] REFUSING a simulation boot: db.example.com:25060/defaultdb already has 55 table(s) in public.",
      "[db-preflight] Demo/simulation fixtures overwrite by design, so a populated database",
      "[db-preflight] can only be adopted by a production-shaped (archive) boot: bun run smoke:archive.",
      "[db-preflight] largest tables by row estimate:",
      "[db-preflight]   raw_indicator_history ~116427 rows",
      "[2026-08-07T03:10:30.833Z] startup failed: external database preflight failed (exit 1)",
    ].join("\n");

    const joined = selectFailureDetail(log, "/tmp/d.log").join("\n");
    expect(joined).toContain("REFUSING a simulation boot");
    expect(joined).toContain("raw_indicator_history");
  });
});

// The failure PANE retired with the TUI (issue #1026, smoke spec §1: `bun
// smoke` draws nothing). What an operator gets instead is the boot's own
// printed report, executed here as a real failing `bun smoke` process: Docker
// is pointed at a dead socket, so the boot resolves its instance, prints and
// journals its plan, and then fails at the stack's Docker check.
describe("a failed boot's printed report (it replaced the failure pane)", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const root = mkdtempSync(join(tmpdir(), "rm-smoke-failure-"));
  const credentials = join(root, "credential.json");
  Bun.write(credentials, JSON.stringify({ agents: {}, judges: {} }));
  const run = () => {
    const r = Bun.spawnSync(
      ["bun", "--no-env-file", join(repoRoot, "scripts", "smoke.ts"), "--local", "blank", "--instance", "rm_local_failreport", "--credentials", credentials],
      {
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? root, RM_SMOKE_STATE_ROOT: root, DOCKER_HOST: "tcp://127.0.0.1:1", RM_ENV: "stage", AGENT_MODEL: "free" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };

  test("names the failure, says whether the writers stopped, and how to inspect and stop the instance", () => {
    try {
      const r = run();
      expect(r.code).toBe(1);
      expect(r.out).toContain("[smoke] startup failed: docker is required");
      // The dead daemon cannot stop anything, and the report says so rather than implying calm.
      expect(r.out).toContain(`[smoke] ${writerQuiesceLine("failed")}`);
      expect(r.out).toContain("inspect:     bun smoke:status --instance rm_local_failreport");
      expect(r.out).toContain("tear down:   bun smoke:down --instance rm_local_failreport");
      // Printed and exited: nothing repaints.
      expect(r.out).not.toContain("\x1b[?1049h");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
