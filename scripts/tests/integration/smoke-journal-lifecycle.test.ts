// Ctrl-C stops a REAL `bun smoke` at the next phase boundary, journals it, and
// a rerun under the same plan id resumes (smoke spec §1.3-§1.4; issue #1026,
// criterion 24).
//
// One instance, three real processes, as an operator would meet them:
//
//   run 1  SIGINT while it prepares, BEFORE replace. It stops at the next
//          boundary, journals the stop, exits NON-ZERO, replaces no application
//          service, and tears nothing down.
//   run 2  the same command. Same plan id, so it RESUMES the same journal —
//          same opening, same plan — and continues. SIGINT once replacement
//          has begun: replacement finishes, the next boundary stops it,
//          journals it, exits non-zero, and the new services stay up.
//   run 3  the same command again. It resumes again and reaches readiness.
//   run 4  an untracked source file is added to a build context: the plan id
//          changes (criterion 38, D52's source identity), and the rerun
//          supersedes the journal instead of resuming it.
//
// `smoke:status` is read between the runs, from its own process, so the report
// an operator gets after each interruption is asserted too.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEPLOYMENT_PHASES, readArchivedJournals, readReceipt, type Journal } from "../../lib/smoke-journal.ts";
import {
  BOOT_TIMEOUT_MS,
  harness,
  journalNow,
  projectContainers,
  repoRoot,
  runCommand,
  spawnBoot,
  teardown,
  waitFor,
  type BootHarness,
  type RunningBoot,
} from "./smoke-boot-harness.ts";

const APP_SERVICES = ["api", "website-server", "worker-analytics", "worker-research", "system-scheduler"];
const REPLACE = DEPLOYMENT_PHASES.indexOf("replace");

let h: BootHarness | undefined;
let current: RunningBoot | undefined;
let afterRun1: Journal | null = null;

afterAll(() => {
  if (h) teardown(h, current);
}, 300_000);

describe("SIGINT at a phase boundary, and resume under the same plan id (criterion 24)", () => {
  test("run 1 — SIGINT before replace: stops at the next boundary, journals it, exits non-zero, replaces nothing", async () => {
    h = harness("journal");
    current = spawnBoot(h);
    await waitFor(() => (journalNow(h!)?.phases ?? []).some((r) => r.phase === "prepare"), 120_000, "run 1 to begin preparing", current);
    current.proc.kill("SIGINT");
    const code = await current.exited;
    expect({ code, tail: code === 0 ? current.output().slice(-2000) : "" }).toEqual({ code: 130, tail: "" });
    expect(current.output()).toContain("Nothing was torn down; the journal records where the run stopped.");

    afterRun1 = journalNow(h);
    const last = afterRun1!.phases.at(-1)!;
    expect(last.status).toBe("interrupted");
    expect(last.reason).toContain("SIGINT/SIGTERM at the boundary before");
    // It stopped BEFORE replace, and nothing it had committed was undone.
    expect(DEPLOYMENT_PHASES.indexOf(last.phase)).toBeLessThan(REPLACE);
    expect(afterRun1!.phases.slice(0, -1).every((r) => r.status === "committed")).toBe(true);
    // No application service was started, let alone replaced.
    const running = Object.keys(projectContainers(h.project));
    expect(running.filter((s) => APP_SERVICES.includes(s))).toEqual([]);
    expect(existsSync(h.paths.lockFile)).toBe(false);

    const status = runCommand(h, "smoke-status.ts", ["--instance", h.instance]);
    expect(status.out).toContain(`phase: ${last.phase}${last.step ? ` (${last.step})` : ""} — interrupted`);
    expect(status.out).toContain("services (replacement has not begun):");
  }, BOOT_TIMEOUT_MS);

  test("run 2 — the rerun RESUMES the same journal; SIGINT after replace began stops at the next boundary with the new services up", async () => {
    expect(afterRun1).not.toBeNull();
    current = spawnBoot(h!);
    await waitFor(() => (journalNow(h!)?.phases ?? []).some((r, i) => r.phase === "replace" && i >= afterRun1!.phases.length), BOOT_TIMEOUT_MS - 120_000, "run 2 to begin replacing", current);
    current.proc.kill("SIGINT");
    const code = await current.exited;
    expect({ code, tail: code === 0 ? current.output().slice(-2000) : "" }).toEqual({ code: 130, tail: "" });

    const journal = journalNow(h!)!;
    // SAME journal: same plan id, same opening; run 1's records kept, run 2's appended.
    expect(String(journal.planId)).toBe(String(afterRun1!.planId));
    expect(journal.openedAt).toBe(afterRun1!.openedAt);
    expect(journal.phases.slice(0, afterRun1!.phases.length).map((r) => r.startedAt)).toEqual(afterRun1!.phases.map((r) => r.startedAt));
    expect(journal.phases[afterRun1!.phases.length]).toMatchObject({ phase: "plan", step: "resume", status: "committed" });
    expect(current.output()).toContain(`resuming the journal for plan ${afterRun1!.planId}`);

    // Replacement committed, naming the services it brought up; the stop came at the next boundary.
    const replace = journal.phases.filter((r) => r.phase === "replace").at(-1)!;
    expect(replace.status).toBe("committed");
    expect(Object.keys(replace.outcome?.servicesReplaced ?? {}).sort()).toEqual(expect.arrayContaining(["api", "website-server"]));
    const last = journal.phases.at(-1)!;
    expect(last.status).toBe("interrupted");
    expect(DEPLOYMENT_PHASES.indexOf(last.phase)).toBeGreaterThan(REPLACE);
    // Nothing torn down: the replaced services are still there.
    const containers = projectContainers(h!.project);
    for (const service of ["api", "website-server"]) {
      expect({ service, state: containers[service] ?? "absent" }).toEqual({ service, state: "running" });
    }
    // smoke:status names the phase and lists each service new or old (§1.4).
    const status = runCommand(h!, "smoke-status.ts", ["--instance", h!.instance]);
    expect(status.out).toContain(`phase: ${last.phase} — interrupted`);
    expect(status.out).toContain("services (replacement BEGAN):");
    expect(status.out).toMatch(/\n\[smoke:status\] +api: new/);
    expect(readReceipt(h!.paths)).toBeNull();
  }, BOOT_TIMEOUT_MS);

  test("run 3 — the rerun resumes again under the same plan id and reaches readiness", async () => {
    const before = journalNow(h!)!;
    current = spawnBoot(h!);
    const code = await current.exited;
    expect({ code, tail: code === 0 ? "" : current.output().slice(-3000) }).toEqual({ code: 0, tail: "" });
    const journal = journalNow(h!)!;
    expect(String(journal.planId)).toBe(String(before.planId));
    expect(journal.openedAt).toBe(before.openedAt);
    expect(journal.phases.at(-1)).toMatchObject({ phase: "readiness", status: "committed" });
    const receipt = readReceipt(h!.paths)!;
    expect(String(receipt.planId)).toBe(String(before.planId));
    // The rebuild in each rerun kept the plan id: the id hashes image SOURCES,
    // not the digests a rebuild produces (D52).
    expect(current.output()).toContain(`plan id: ${before.planId}`);
  }, BOOT_TIMEOUT_MS);

  test("run 4 — criterion 38: a changed SOURCE in a build context changes the plan id, so the rerun SUPERSEDES", async () => {
    // Run 3's volume now holds data, so `--local blank` would refuse; the
    // reruns reattach it with `--local volume`. First WITHOUT a source change,
    // to fix the plan id of that mode; then with an untracked, unignored file
    // inside the repo-root build context (api and the workers build from `.`).
    // Nothing about the digests is touched between the two: the plan id moves
    // only because the source identity (the context's Git tree, computed from
    // the working tree) moved.
    const planOf = async (label: string): Promise<{ id: string; out: string }> => {
      const before = journalNow(h!);
      current = spawnBoot(h!, [], { local: "volume" });
      let exited = false;
      void current.exited.then(() => { exited = true; });
      await waitFor(() => {
        if (exited) return true;
        const j = journalNow(h!);
        return j !== null && (before === null || j.openedAt !== before.openedAt || j.phases.length > before.phases.length);
      }, 180_000, `${label} to journal its plan`, current);
      current.proc.kill("SIGINT");
      await current.exited;
      const out = current.output();
      const id = out.match(/plan id: ([0-9a-f]{64})/)?.[1];
      expect({ label, id: id ?? `none — ${out.slice(-2000)}` }).toEqual({ label, id: expect.stringMatching(/^[0-9a-f]{64}$/) });
      return { id: id!, out };
    };

    const unchanged = await planOf("run 4a (volume, sources unchanged)");
    const baseline = journalNow(h!)!;
    const probe = join(repoRoot, "scripts", "tests", "integration", `.plan-source-probe-${h!.instance}.txt`);
    writeFileSync(probe, `criterion 38 probe ${Date.now()}\n`);
    let changed: { id: string; out: string };
    try {
      changed = await planOf("run 4b (volume, one source file added)");
    } finally {
      rmSync(probe, { force: true });
    }
    expect(changed.id).not.toBe(unchanged.id);
    expect(changed.out).toContain(`The previous plan ${unchanged.id} is superseded`);
    // The superseded journal is archived with what it reached, not overwritten.
    expect(readArchivedJournals(h!.paths).map((j) => String(j.planId))).toContain(unchanged.id);
    // Only the images built from the changed context moved; website-server's did not.
    const journal = journalNow(h!)!;
    expect(journal.plan.images.api!.source).not.toBe(baseline.plan.images.api!.source);
    expect(journal.plan.images["website-server"]!.source).toBe(baseline.plan.images["website-server"]!.source);
    // Red control: with the probe gone the sources are back, and so is the id.
    const restored = await planOf("run 4c (volume, probe removed)");
    expect(restored.id).toBe(unchanged.id);
  }, BOOT_TIMEOUT_MS);
});
