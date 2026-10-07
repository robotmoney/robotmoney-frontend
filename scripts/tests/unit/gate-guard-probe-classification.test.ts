// The boot's append-only guard probe and the scheduler's startup retry are expected log
// lines, classified narrowly (twin:gate on stage-2, 2026-10-07).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPEND_ONLY_TABLES } from "../../../backend/src/db/append-only-guard.ts";

const rules = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "lib", "gate", "log-classifications.json"), "utf8")) as Array<{ id: string; match: string; class: string }>;
const rule = (id: string) => {
  const r = rules.find((x) => x.id === id);
  if (!r) throw new Error(`no rule ${id}`);
  return new RegExp(r.match);
};

test("the privilege probe rule names exactly the guard's APPEND_ONLY_TABLES", () => {
  const listed = /\(([^)]+)\)/.exec(rules.find((x) => x.id === "expected-guard-probe-privilege")!.match)![1]!.split("|");
  expect([...listed].sort()).toEqual([...APPEND_ONLY_TABLES].sort());
});

test("it classifies the probe's refusal and nothing outside the guarded set", () => {
  const re = rule("expected-guard-probe-privilege");
  expect(re.test("<ts> UTC [<n>] ERROR:  permission denied for table swarm_subjects")).toBe(true);
  expect(re.test("<ts> UTC [<n>] ERROR:  permission denied for table audit_log")).toBe(true);
  // B11's line must still fail the gate.
  expect(re.test("<ts> UTC [<n>] ERROR:  permission denied for table buyback_scan_state")).toBe(false);
  expect(re.test("<ts> UTC [<n>] ERROR:  permission denied for table swarm_subjects_extra")).toBe(false);
});

test("the scheduler's startup retry is expected, its other errors are not", () => {
  const re = rule("expected-scheduler-startup-retry");
  expect(re.test("[system-scheduler] startup check: API unreachable at http://api:<n>/api/swarm/scheduler/full-read: Unable to connect. Is the computer able to access the url? — staying up and reporting unhealthy while the connect loop retries")).toBe(true);
  expect(re.test("[system-scheduler] automation token rejected: API rejected the automation token (HTTP <n>)")).toBe(false);
});
