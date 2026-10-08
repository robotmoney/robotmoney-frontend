// The owner's triage of a baseline gate's failures (scripts/release/triage.ts, runbook R2.5).
import { describe, expect, test } from "bun:test";
import { RELEASE_STEPS } from "../../release/steps.ts";
import { applyTriage, failedFindings, parseTriage } from "../../release/triage.ts";

const report = {
  checks: [
    { id: "containers", status: "PASS", detail: ["6 service container(s)"] },
    { id: "capacity", status: "WARN", detail: ["database size 1.61 GB"] },
    {
      id: "jobs",
      status: "FAIL",
      detail: ['unclassified error — jobs:swarm.judge: ×2 "judge produced no judgement (model_unavailable:judge model responded 402: Insufficient balance"'],
    },
  ],
};

const entries = (text: string) => {
  const parsed = parseTriage(text);
  if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
  return parsed.entries;
};

describe("triage file", () => {
  test("parses check | fragment | reason, skipping blanks and comments", () => {
    expect(entries("# owner, 2026-10-08\n\njobs | responded 402 | Zen balance empty; topped up\n")).toEqual([
      { check: "jobs", fragment: "responded 402", reason: "Zen balance empty; topped up" },
    ]);
  });
  test("red control: a line without a reason refuses", () => {
    expect("errors" in parseTriage("jobs | responded 402\n")).toBe(true);
    expect("errors" in parseTriage("jobs | responded 402 | \n")).toBe(true);
  });
  test("red control: an empty file refuses", () => {
    expect("errors" in parseTriage("# nothing\n")).toBe(true);
  });
});

describe("applying a triage to a gate report", () => {
  test("only FAIL checks are findings; WARN and PASS are not", () => {
    expect(failedFindings(report)?.map((f) => f.check)).toEqual(["jobs"]);
  });
  test("an entry for the check whose fragment is in the detail accepts the report", () => {
    const r = applyTriage(report, entries("jobs | responded 402 | balance"));
    expect(r.accepted).toBe(true);
    expect(r.used.map((e) => e.fragment)).toEqual(["responded 402"]);
  });
  test("red control: the right fragment under the wrong check does not accept", () => {
    expect(applyTriage(report, entries("inventory | responded 402 | balance")).accepted).toBe(false);
  });
  test("red control: a fragment the detail lacks does not accept, and names the finding", () => {
    const r = applyTriage(report, entries("jobs | responded 404 | old model id"));
    expect(r.accepted).toBe(false);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0]!.check).toBe("jobs");
  });
  test("red control: a second, untriaged failure keeps the step failed", () => {
    const two = { checks: [...report.checks, { id: "sessions", status: "FAIL", detail: ["session stuck 900 min"] }] };
    const r = applyTriage(two, entries("jobs | responded 402 | balance"));
    expect(r.accepted).toBe(false);
    expect(r.unmatched.map((f) => f.check)).toEqual(["sessions"]);
  });
  test("red control: a report with no checks, or no failure, is never accepted by triage", () => {
    expect(applyTriage({}, entries("jobs | x | y")).accepted).toBe(false);
    expect(applyTriage({ checks: [{ id: "jobs", status: "PASS", detail: [] }] }, entries("jobs | x | y")).accepted).toBe(false);
  });
});

describe("which steps read a triage", () => {
  test("only R2.5, the baseline gate, is a triage step", () => {
    expect(RELEASE_STEPS.filter((s) => s.triage).map((s) => s.id)).toEqual(["R2.5"]);
  });
});
