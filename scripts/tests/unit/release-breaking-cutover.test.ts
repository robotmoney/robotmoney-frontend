// The breaking-migration cutover (issue 1484; smoke spec section 8.5): a release whose runbook declares
// `breaking:` runs maintenance page on, bun smoke:down, migrate, a full boot, maintenance page off, in place
// of the rolling migrate and boot, and its probe grade allows exactly that declared window.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredWindow, gradeRun } from "../../release/probe.ts";
import type { RunJournal } from "../../release/journal.ts";
import { loadReleaseRunbook, loadTemplate, stepNameOf, twinProblems, type RunbookStep } from "../../release/runbook.ts";
import { skipReason } from "../../release/run.ts";
import { BREAKING_SKIPS, stepListHash } from "../../release/steps.ts";
import type { ReleaseTarget } from "../../release/target.ts";
import { gradeProbeWithDeclaredWindow, type ProbeReceipt } from "../../lib/rollout-probe.ts";
import { activeWindow, setMaintenance } from "../../release/maintenance.ts";

const stage = { rmEnv: "stage" } as ReleaseTarget;
const prod = { rmEnv: "prod" } as ReleaseTarget;
const v070 = loadReleaseRunbook("v0.7.0");
const v062 = loadReleaseRunbook("v0.6.2");
/** The steps that run on a target for a release: what the runner resolves the cutover to. */
const runs = (steps: readonly RunbookStep[], target: ReleaseTarget, breaking: boolean) => steps.filter((s) => skipReason(s, target, breaking) === undefined).map((s) => s.id);

const QA_BREAKING = ["Q18a-maintenance-on", "Q18b-smoke-down", "Q18c-migrate-breaking", "Q22a-full-boot", "Q24a-maintenance-off"];
const C_BREAKING = ["C05a-maintenance-on", "C05b-smoke-down", "C05c-migrate-breaking", "C10a-full-boot", "C12a-maintenance-off"];

describe("the breaking cutover order", () => {
  test("v0.7.0 declares breaking and carries all five steps on each side, each with a twin", () => {
    expect(v070.breaking).toEqual(["0127_rm_worker_retired.sql"]);
    const have = v070.steps.map((s) => s.id);
    for (const id of [...QA_BREAKING, ...C_BREAKING]) expect(have).toContain(id);
    expect(twinProblems(v070.steps, "v0.7.0")).toEqual([]);
    expect(QA_BREAKING.map(stepNameOf)).toEqual(C_BREAKING.map(stepNameOf));
  });

  test("on stage a breaking release resolves to maintenance-on, smoke-down, migrate, boot, maintenance-off, and skips the rolling migrate and boot", () => {
    const ran = runs(v070.steps, stage, true);
    const upgrade = ran.filter((id) => /^Q(1[89]|2[0-5])/.test(id));
    expect(upgrade).toEqual([
      "Q18a-maintenance-on", "Q18b-smoke-down", "Q18c-migrate-breaking", "Q19-env-rewrite", "Q20-set-identity", "Q21-tokens",
      "Q22a-full-boot", "Q23-ready", "Q24-site", "Q24a-maintenance-off", "Q25-probe-grade",
    ]);
    expect(ran).not.toContain("Q18-migrate");
    expect(ran).not.toContain("Q22-rolling-boot");
  });

  test("on production the same order holds in C steps, C06-version-tag stays, and C05-migrate and C10-rolling-boot do not run", () => {
    const ran = runs(v070.steps, prod, true);
    expect(ran.filter((id) => /^C(0[5-9]|1[0-3])/.test(id))).toEqual([
      "C05a-maintenance-on", "C05b-smoke-down", "C05c-migrate-breaking", "C06-version-tag", "C07-env-rewrite", "C08-set-identity", "C09-tokens",
      "C10a-full-boot", "C11-ready", "C12-site", "C12a-maintenance-off", "C13-probe-grade",
    ]);
    expect(ran).not.toContain("C05-migrate");
    expect(ran).not.toContain("C10-rolling-boot");
  });

  test("the skipped rolling steps and the breaking steps are each other's converse", () => {
    expect(BREAKING_SKIPS).toEqual(["migrate", "rolling-boot"]);
    const q18 = v070.steps.find((s) => s.id === "Q18-migrate")!;
    expect(skipReason(q18, stage, true)).toContain("declares breaking");
    expect(skipReason(q18, stage, false)).toBeUndefined();
    const down = v070.steps.find((s) => s.id === "Q18b-smoke-down")!;
    expect(skipReason(down, stage, false)).toContain("declares no breaking");
    expect(skipReason(down, stage, true)).toBeUndefined();
    // the migrate against the stopped stack is the irreversible one, and the maintenance page and the stop are not
    expect(v070.steps.find((s) => s.id === "C05c-migrate-breaking")!.irreversible).toBe(true);
    expect(v070.steps.find((s) => s.id === "C05b-smoke-down")!.cmds[0]).toEqual(["bun", "run", "smoke:down", "--instance", "{instance}"]);
    expect(v070.steps.find((s) => s.id === "C05c-migrate-breaking")!.cmds[0]).toContain("--confirm-target");
    expect(v070.steps.find((s) => s.id === "C10a-full-boot")!.cmds[0]).toEqual(["bun", "run", "smoke", "--static-port", "--instance", "{instance}"]);
  });

  test("red control: a production step with no QA twin, or a twin with other commands, is refused", () => {
    const noTwin = v070.steps.filter((s) => s.id !== "Q18b-smoke-down");
    expect(twinProblems(noTwin, "x").join()).toContain("C05b-smoke-down has no QA twin named smoke-down");
    const changed = v070.steps.map((s) => (s.id === "C05b-smoke-down" ? { ...s, cmds: [["bun", "run", "smoke:down"]] } : s));
    expect(twinProblems(changed, "x").join()).toContain("differ");
  });
});

describe("a release that does not declare breaking is unchanged", () => {
  test("v0.6.2 has none of the breaking steps and its recorded step-list hash is the value it had before", () => {
    expect(v062.breaking).toBeUndefined();
    expect(v062.steps.some((s) => [...QA_BREAKING, ...C_BREAKING].includes(s.id))).toBe(false);
    expect(v062.steps.some((s) => (s as RunbookStep & { breakingOnly?: boolean }).breakingOnly === true)).toBe(false);
    expect(stepListHash(v062.steps)).toBe("063950472adc89cbd00b2a359a419baecc8f9eaad54496e312c2fd5f81b11925");
  });

  test("red control: adding a breaking step to the list changes the hash", () => {
    const withStep = [...v062.steps, loadTemplate().steps.find((s) => s.id === "C05b-smoke-down")!];
    expect(stepListHash(withStep)).not.toBe(stepListHash(v062.steps));
  });

  test("a rolling release (no breaking) records every breaking step skipped and runs the rolling ones", () => {
    const ran = runs(loadTemplate().steps, stage, false);
    expect(ran).toContain("Q18-migrate");
    expect(ran).toContain("Q22-rolling-boot");
    expect(ran.some((id) => QA_BREAKING.includes(id))).toBe(false);
  });
});

describe("the maintenance page", () => {
  test("on writes maintenance.json, off removes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "maint-"));
    const file = join(dir, "maintenance.json");
    setMaintenance(dir, "on", new Date("2026-10-27T00:00:00Z"), 30);
    expect(JSON.parse(readFileSync(file, "utf8")).state).toBe("active");
    expect(activeWindow(new Date("2026-10-27T00:00:00Z"), 30).expectedEnd).toBe("2026-10-27T00:30:00.000Z");
    setMaintenance(dir, "off");
    expect(existsSync(file)).toBe(false);
    expect(setMaintenance(dir, "off")).toContain("no maintenance.json");
    writeFileSync(file, "{}");
  });
});

const T0 = Date.parse("2026-10-27T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const rec = (id: string, status: string, startedAt: number, endedAt: number) => [id, { id, status, startedAt: iso(startedAt), endedAt: iso(endedAt) }] as const;
const journalSteps = (extra: ReturnType<typeof rec>[]) => Object.fromEntries(extra) as unknown as RunJournal["steps"];
/** A probe every 2 s with 200s over [from, to]. */
const probes = (from: number, to: number, skip: (at: number) => boolean = () => false): ProbeReceipt[] => {
  const out: ProbeReceipt[] = [];
  for (let at = from; at <= to; at += 2_000) if (!skip(at)) out.push({ at, status: 200 });
  return out;
};
const WINDOW = { start: T0, end: T0 + 600_000 };
const DECL = { start: T0 + 100_000, end: T0 + 300_000 };

describe("the declared window in the probe grade", () => {
  test("declaredWindow reads maintenance-on start to maintenance-off end, by step name, on either side", () => {
    for (const [on, off] of [["Q18a-maintenance-on", "Q24a-maintenance-off"], ["C05a-maintenance-on", "C12a-maintenance-off"]] as const) {
      const w = declaredWindow(journalSteps([rec(on, "ok", DECL.start, DECL.start + 1000), rec(off, "ok", DECL.end - 1000, DECL.end)]));
      expect(w).toEqual({ window: DECL });
    }
  });

  test("a rolling run declares none, and a skipped maintenance-on declares none", () => {
    expect(declaredWindow(journalSteps([]))).toBe("none");
    expect(declaredWindow(journalSteps([rec("Q18a-maintenance-on", "skipped", T0, T0)]))).toBe("none");
  });

  test("red control: a window opened and never closed is a problem, and so is one whose off step failed", () => {
    expect(declaredWindow(journalSteps([rec("C05a-maintenance-on", "ok", DECL.start, DECL.start)]))).toHaveProperty("problem");
    expect(declaredWindow(journalSteps([rec("C05a-maintenance-on", "ok", DECL.start, DECL.start), rec("C12a-maintenance-off", "failed", DECL.end, DECL.end)]))).toHaveProperty("problem");
  });

  const steps = journalSteps([rec("C05a-maintenance-on", "ok", DECL.start, DECL.start + 1000), rec("C12a-maintenance-off", "ok", DECL.end - 1000, DECL.end)]);

  test("a gap and non-200 answers inside the declared window pass", () => {
    const receipts = probes(WINDOW.start, WINDOW.end, (at) => at > DECL.start + 4_000 && at < DECL.end - 4_000);
    const withErrors = [...receipts, { at: DECL.start + 10_000, status: 503 }];
    expect(gradeRun(withErrors, WINDOW, steps, 2_000, 3_000).ok).toBe(true);
    // the same receipts fail when no window was declared: the rolling grade is unchanged
    expect(gradeRun(withErrors, WINDOW, journalSteps([]), 2_000, 3_000).ok).toBe(false);
  });

  test("red control: a gap outside the declared window fails, before it and after it", () => {
    const hole = (a: number, b: number) => probes(WINDOW.start, WINDOW.end, (at) => at > a && at < b && !(at > DECL.start + 4_000 && at < DECL.end - 4_000));
    const before = hole(T0 + 20_000, T0 + 50_000);
    expect(gradeRun(before, WINDOW, steps, 2_000, 3_000).ok).toBe(false);
    const after = hole(DECL.end + 20_000, DECL.end + 50_000);
    expect(gradeRun(after, WINDOW, steps, 2_000, 3_000).ok).toBe(false);
  });

  test("red control: a non-200 outside the window fails", () => {
    const receipts = [...probes(WINDOW.start, WINDOW.end), { at: T0 + 30_001, status: 502 }];
    const g = gradeProbeWithDeclaredWindow(receipts, WINDOW, DECL, 2_000, 3_000);
    expect(g.ok).toBe(false);
    expect(g.problems.join()).toContain("outside the declared maintenance window");
  });

  test("red control: a window that never closed fails the grade even with clean receipts", () => {
    const open = journalSteps([rec("C05a-maintenance-on", "ok", DECL.start, DECL.start + 1000)]);
    const g = gradeRun(probes(WINDOW.start, WINDOW.end), WINDOW, open, 2_000, 3_000);
    expect(g.ok).toBe(false);
    expect(g.problems.join()).toContain("never closed");
  });

  test("a run with no receipts at all fails even inside a declared window", () => {
    expect(gradeRun([], WINDOW, steps, 2_000, 3_000).ok).toBe(false);
  });
});
