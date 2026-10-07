// The boot's append-only and analytics ledger guard probes and the scheduler's startup
// retries are expected log lines, classified narrowly (twin:gate on stage-2, 2026-10-07).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Both guards reach backend config, which requires DATABASE_URL. Nothing connects to the stub.
process.env.DATABASE_URL ??= "postgres://stub:stub@127.0.0.1:1/stub";
const { APPEND_ONLY_TABLES } = await import("../../../backend/src/db/append-only-guard.ts");
const { LEDGER_FAMILIES } = await import("../../../backend/src/db/analytics-ledger-guard.ts");

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

test("the ledger probe rule names exactly the analytics ledger guard's tables", () => {
  const listed = /\(([^)]+)\)/.exec(rules.find((x) => x.id === "expected-ledger-guard-probe-privilege")!.match)![1]!.split("|");
  expect([...listed].sort()).toEqual(LEDGER_FAMILIES.flatMap((f) => f.tables).sort());
});

test("it classifies the ledger probe's refusal and nothing outside the ledgers", () => {
  const re = rule("expected-ledger-guard-probe-privilege");
  expect(re.test("<ts> UTC [<n>] ERROR: permission denied for table source_acquisitions")).toBe(true);
  expect(re.test("<ts> UTC [<n>] ERROR: permission denied for table swarm_brief_revisions")).toBe(true);
  // B11's line must still fail the gate, and so must a longer name that starts with a ledger's.
  expect(re.test("<ts> UTC [<n>] ERROR: permission denied for table buyback_scan_state")).toBe(false);
  expect(re.test("<ts> UTC [<n>] ERROR: permission denied for table source_fetches_extra")).toBe(false);
});

test("the scheduler's first-connect failure is expected only when the api did not answer", () => {
  const re = rule("expected-scheduler-first-connect-retry");
  expect(re.test("[system-scheduler] initial connect failed: Unable to connect. Is the computer able to access the url?")).toBe(true);
  expect(re.test("[system-scheduler] initial connect failed: API rejected the automation token (HTTP <n>)")).toBe(false);
});
