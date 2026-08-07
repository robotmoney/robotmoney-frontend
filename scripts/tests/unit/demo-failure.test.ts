// The startup-failure decisions, executed rather than grepped (the #456/#537
// split rule): which services a failed boot stops, what it recovers out of the
// log as a cause, and that the pane says whether the database is still moving.
import { describe, expect, test } from "bun:test";
import {
  DB_WRITER_SERVICES,
  renderFailurePane,
  selectFailureDetail,
  writerQuiesceLine,
} from "../../lib/demo-failure.ts";
import type { FatalState } from "../../lib/demo-tui-view.ts";

const STRIP_ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(STRIP_ANSI, "");

describe("DB_WRITER_SERVICES — what a failed boot must stop", () => {
  test("never names postgres: it IS the database, and --external-pg has no such container", () => {
    expect(DB_WRITER_SERVICES).not.toContain("postgres");
  });

  test("covers every lane that writes: the api and all four producer/worker lanes", () => {
    expect([...DB_WRITER_SERVICES].sort()).toEqual(
      ["analytics-producer", "api", "worker-analytics", "worker-research", "worker-swarm"],
    );
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
    expect(line).toContain("demo:down");
  });

  test("every state renders a non-empty line (no silent gap in the pane)", () => {
    for (const w of ["pending", "stopped", "failed", "none"] as const) {
      expect(plain(writerQuiesceLine(w)).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("selectFailureDetail — recovers a cause the orchestrator never sees", () => {
  // The real shape: demo-main can only raise "…failed (exit 1)". The refusal
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
    const detail = selectFailureDetail(REAL_LOG, "/tmp/demo.log");
    const joined = detail.join("\n");
    expect(joined).toContain("2 inconsistencies detected");
    expect(joined).toContain("recommendation_type");
    expect(joined).not.toContain("api healthy");
  });

  test("always ends by naming the full log, so the tail is never mistaken for all of it", () => {
    expect(selectFailureDetail(REAL_LOG, "/tmp/demo.log").at(-1)).toBe("full log: /tmp/demo.log");
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

  // Regression: the populated-database guard uses none of WARN/ERROR/FAIL, so
  // the pane anchored on the demo's own trailing "startup failed" line and
  // restated the exit code instead of naming the reason.
  test("a refusal surfaces the refusal, not the trailing 'startup failed' restatement", () => {
    const log = [
      " Container demo-api-run-1 Created",
      "[db-preflight] REFUSING to bootstrap: db.example.com:25060/defaultdb already has 55 table(s) in public.",
      "[db-preflight] A populated remote database is assumed to be production or production-alike;",
      "[db-preflight] largest tables by row estimate:",
      "[db-preflight]   raw_indicator_history ~116427 rows",
      "[2026-08-07T03:10:30.833Z] startup failed: external database preflight failed (exit 1)",
    ].join("\n");

    const joined = selectFailureDetail(log, "/tmp/d.log").join("\n");
    expect(joined).toContain("REFUSING to bootstrap");
    expect(joined).toContain("raw_indicator_history");
  });
});

describe("renderFailurePane", () => {
  const fatal: FatalState = {
    step: "archive restore",
    message: "archive initializer (already migrated) failed (exit 1)",
    detail: ["2 inconsistencies detected", "full log: /tmp/demo.log"],
    writers: "stopped",
  };

  test("shows the failed step, the message, the detail and the writer state together", () => {
    const pane = renderFailurePane(fatal, 100, "rm_demo_stack_x").map(plain).join("\n");
    expect(pane).toContain("STARTUP FAILED");
    expect(pane).toContain("archive restore");
    expect(pane).toContain("exit 1");
    expect(pane).toContain("2 inconsistencies detected");
    expect(pane).toContain("nothing is still writing");
  });

  test("tells the operator how to inspect the stack it deliberately left up", () => {
    const pane = renderFailurePane(fatal, 100, "rm_demo_stack_x").map(plain).join("\n");
    expect(pane).toContain("demo:status");
    expect(pane).toContain("rm_demo_stack_x");
  });

  test("never emits a line wider than the terminal (the TUI paints these raw)", () => {
    for (const line of renderFailurePane(fatal, 40, "rm_demo_stack_x")) {
      expect(plain(line).length).toBeLessThanOrEqual(40);
    }
  });

  test("a step-less failure (died before any step began) still renders", () => {
    const pane = renderFailurePane({ ...fatal, step: undefined }, 100, "p").map(plain).join("\n");
    expect(pane).toContain("STARTUP FAILED");
    expect(pane).toContain("exit 1");
  });
});
