// A second `bun smoke` PROCESS against a locked instance refuses, naming the
// holder and its plan id (smoke spec §1.2; issue #1026, criterion 15).
//
// Two real processes, not two calls in one: the lock that matters is the one a
// second operator's shell meets while the first is mid-deployment. Process A is
// a real boot, held in its long preparation (static assembly and the image
// build); process B is the same command against the same instance. B must
// refuse before it mutates anything, and must say WHO holds the lock and WHAT
// it is running, because that is the operator's next question.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { readStackState } from "../../lib/smoke-state.ts";
import {
  BOOT_TIMEOUT_MS,
  harness,
  journalNow,
  phaseList,
  projectContainers,
  runCommand,
  spawnBoot,
  teardown,
  waitFor,
  type BootHarness,
  type RunningBoot,
} from "./smoke-boot-harness.ts";

let h: BootHarness | undefined;
let holder: RunningBoot | undefined;

afterAll(() => {
  if (h) teardown(h, holder);
}, 300_000);

describe("the deployment lock, across two `bun smoke` processes (criterion 15)", () => {
  test("a second process on the locked instance exits non-zero naming the holder's pid and plan id, and mutates nothing", async () => {
    h = harness("lock");
    holder = spawnBoot(h);
    await waitFor(() => {
      const j = journalNow(h!);
      return existsSync(h!.paths.lockFile) && j !== null && j.phases.some((r) => r.phase === "prepare");
    }, 120_000, "the first boot to take its lock and begin preparing", holder);
    const planId = journalNow(h)!.planId;
    const lock = JSON.parse(readFileSync(h.paths.lockFile, "utf8")) as { holderPid: number; planId: string };
    expect(lock.holderPid).toBe(holder.proc.pid);
    const phasesBefore = phaseList(journalNow(h));

    const second = spawnBoot(h);
    const code = await second.exited;
    const out = second.output();
    expect(code).not.toBe(0);
    expect(out).toContain(`instance ${h.instance} is locked by pid ${holder.proc.pid}`);
    expect(out).toContain(`running plan ${planId}`);
    // It refused BEFORE anything: the holder's journal gained nothing from it,
    // and the lock still names the holder.
    const phasesAfter = phaseList(journalNow(h)).slice(0, phasesBefore.length);
    expect(phasesAfter).toEqual(phasesBefore);
    expect((JSON.parse(readFileSync(h.paths.lockFile, "utf8")) as { holderPid: number }).holderPid).toBe(holder.proc.pid);
    expect(out).not.toContain("phase: prepare");

    // `smoke:down` while the holder deploys: refused, naming the holder, and
    // nothing is stopped or closed. (Before, it tore the stack down and closed
    // the journal, and the holder's next phase reopened both.)
    const down = runCommand(h, "smoke-down.ts", ["--instance", h.instance]);
    expect(down.code).not.toBe(0);
    expect(down.out).toContain(`Refusing: a \`bun smoke\` run (pid ${holder.proc.pid}, plan ${planId})`);
    expect(down.out).not.toContain("tearing down");
    expect(journalNow(h)!.closedAt).toBeNull();
    expect((JSON.parse(readFileSync(h.paths.lockFile, "utf8")) as { holderPid: number }).holderPid).toBe(holder.proc.pid);
    // The stack record is written in the prepare step, before any compose
    // call, so status and down can find this boot's project from here on.
    expect(readStackState(h.paths)?.project).toBe(h.project);

    // The holder is still the one deploying. Stop it at its next boundary
    // (spec §1.4) and confirm it, not the refused process, released the lock.
    holder.proc.kill("SIGINT");
    const holderCode = await holder.exited;
    expect(holderCode).not.toBe(0);
    expect(existsSync(h.paths.lockFile)).toBe(false);
    expect(journalNow(h)!.phases.at(-1)?.status).toBe("interrupted");
    // Stopped before replace: no application service was started.
    const services = Object.keys(projectContainers(h.project)).filter((s) => s !== "postgres");
    expect(services).toEqual([]);
  }, BOOT_TIMEOUT_MS);

  test("red control: with the holder gone, the same second command is no longer refused by the lock", async () => {
    // A stale lock is taken over (and said so) rather than blocking forever:
    // the refusal above was about a LIVE holder, not about the file existing.
    expect(h).toBeDefined();
    const again = spawnBoot(h!);
    await waitFor(() => {
      const j = journalNow(h!);
      return j !== null && j.phases.filter((r) => r.phase === "plan").length >= 2;
    }, 120_000, "the rerun to journal its plan", again);
    // SIGHUP this time (a closed terminal): a stop at the next boundary like
    // SIGINT, journaled, never the default instant kill.
    again.proc.kill("SIGHUP");
    const code = await again.exited;
    expect(again.output()).not.toContain("is locked by pid");
    expect(code).toBe(130); // stopped at a boundary, which is not success
    expect(journalNow(h!)!.phases.at(-1)?.status).toBe("interrupted");
  }, BOOT_TIMEOUT_MS);
});
