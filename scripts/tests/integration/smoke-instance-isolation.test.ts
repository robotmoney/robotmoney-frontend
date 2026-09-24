// Two REAL instances on one host: a down, a resume and a volume reattach on one
// leave the other's containers, volume and records alone (smoke spec §1.1;
// issue #1026, criterion 33).
//
// The unit half (scripts/tests/unit/smoke-state.test.ts) proves the commands
// read and write only the named instance's STATE DIRECTORY, with Docker dead.
// This is the runtime half, against real stacks sharing one state root:
//
//   B   boots to readiness and is left running — the bystander.
//   A1  boots; SIGINT once replacement has begun: it stops at the next boundary.
//   A2  the same command RESUMES A's journal under the same plan id and reaches
//       readiness.
//   A   `smoke:status --instance A` names A's project, never B's.
//   A   `smoke:down --instance A` stops A's stack, keeping A's volume.
//   A3  `--local volume --instance A` reattaches A's OWN saved volume.
//
// After every step, B is exactly as it was: the same container ids, each still
// running and never restarted (same start time), its volume present, and its
// journal and receipt byte-for-byte unchanged.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEPLOYMENT_PHASES, readReceipt } from "../../lib/smoke-journal.ts";
import {
  BOOT_TIMEOUT_MS,
  containerIdentity,
  harness,
  journalNow,
  runCommand,
  spawnBoot,
  teardown,
  volumeExists,
  waitFor,
  type BootHarness,
  type RunningBoot,
} from "./smoke-boot-harness.ts";

let b: BootHarness | undefined;
let a: BootHarness | undefined;
let current: RunningBoot | undefined;
/** B as it stood after its own boot: what every later step must leave alone. */
let bBaseline: { containers: ReturnType<typeof containerIdentity>; journal: string; receipt: string } | undefined;

afterAll(() => {
  // A first: its harness shares B's state root, which B's teardown removes.
  if (a) teardown(a, current);
  if (b) teardown(b);
}, 600_000);

function bNow(): NonNullable<typeof bBaseline> {
  return {
    containers: containerIdentity(b!.project),
    journal: readFileSync(b!.paths.journalFile, "utf8"),
    receipt: readFileSync(b!.paths.receiptFile, "utf8"),
  };
}

// system-scheduler crash-loops until wave 4 provisions its token file (the
// known gap smoke-lifecycle.test.ts records), so Docker restarts it on its own
// and its start time moves: for it, only the container id is compared.
const CRASH_LOOPING = new Set(["system-scheduler"]);

function expectBUntouched(step: string): void {
  const now = bNow();
  const base = bBaseline!.containers;
  expect({ step, services: Object.keys(now.containers).sort() }).toEqual({ step, services: Object.keys(base).sort() });
  for (const [service, was] of Object.entries(base)) {
    const is = now.containers[service];
    expect({ step, service, id: is?.id }).toEqual({ step, service, id: was.id });
    if (!CRASH_LOOPING.has(service) && was.state === "running") {
      expect({ step, service, state: is?.state, startedAt: is?.startedAt }).toEqual({ step, service, state: "running", startedAt: was.startedAt });
    }
  }
  expect({ step, journalUnchanged: now.journal === bBaseline!.journal }).toEqual({ step, journalUnchanged: true });
  expect({ step, receiptUnchanged: now.receipt === bBaseline!.receipt }).toEqual({ step, receiptUnchanged: true });
  expect({ step, volume: volumeExists(`${b!.project}_pgdata`) }).toEqual({ step, volume: true });
}

describe("two real instances on one host: each operation acts only on the named one (criterion 33)", () => {
  test("B boots to readiness and is left running", async () => {
    b = harness("isob");
    a = harness("isoa", { root: b.root });
    expect(a.project).not.toBe(b.project);
    const boot = spawnBoot(b);
    const code = await boot.exited;
    expect({ code, tail: code === 0 ? "" : boot.output().slice(-3000) }).toEqual({ code: 0, tail: "" });
    bBaseline = bNow();
    for (const service of ["postgres", "api", "website-server"]) {
      expect({ service, state: bBaseline.containers[service]?.state }).toEqual({ service, state: "running" });
    }
  }, BOOT_TIMEOUT_MS);

  test("A is interrupted after replacement began, then RESUMED under the same plan id — B untouched throughout", async () => {
    expect(bBaseline).toBeDefined();
    current = spawnBoot(a!);
    await waitFor(() => (journalNow(a!)?.phases ?? []).some((r) => r.phase === "replace"), BOOT_TIMEOUT_MS - 180_000, "A to begin replacing", current);
    current.proc.kill("SIGINT");
    expect(await current.exited).toBe(130);
    const interrupted = journalNow(a!)!;
    expect(DEPLOYMENT_PHASES.indexOf(interrupted.phases.at(-1)!.phase)).toBeGreaterThanOrEqual(DEPLOYMENT_PHASES.indexOf("replace"));
    expect(interrupted.phases.at(-1)!.status).toBe("interrupted");
    expectBUntouched("after A was interrupted");

    current = spawnBoot(a!);
    const code = await current.exited;
    expect({ code, tail: code === 0 ? "" : current.output().slice(-3000) }).toEqual({ code: 0, tail: "" });
    expect(current.output()).toContain(`resuming the journal for plan ${interrupted.planId}`);
    const resumed = journalNow(a!)!;
    expect(String(resumed.planId)).toBe(String(interrupted.planId));
    expect(resumed.openedAt).toBe(interrupted.openedAt);
    expect(String(readReceipt(a!.paths)!.planId)).toBe(String(interrupted.planId));
    // A's own stack is up under A's project, beside B's.
    expect(containerIdentity(a!.project).api?.state).toBe("running");
    expectBUntouched("after A resumed to readiness");
  }, BOOT_TIMEOUT_MS * 2);

  test("smoke:status --instance A reports A's project and never B's", () => {
    const status = runCommand(a!, "smoke-status.ts", ["--instance", a!.instance]);
    expect(status.code).toBe(0);
    expect(status.out).toContain(`compose project ${a!.project}`);
    expect(status.out).not.toContain(b!.project);
    expect(status.out).not.toContain(String(journalNow(b!)!.planId));
    expectBUntouched("after smoke:status A");
  }, 60_000);

  test("smoke:down --instance A stops A's stack and keeps A's volume; B keeps running, unrestarted", () => {
    const down = runCommand(a!, "smoke-down.ts", ["--instance", a!.instance]);
    expect({ code: down.code, out: down.code === 0 ? "" : down.out }).toEqual({ code: 0, out: "" });
    expect(containerIdentity(a!.project)).toEqual({});
    expect(volumeExists(`${a!.project}_pgdata`)).toBe(true);
    expect(journalNow(a!)!.closedAt).not.toBeNull();
    expect(journalNow(b!)!.closedAt).toBeNull();
    expectBUntouched("after smoke:down A");
  }, 300_000);

  test("`--local volume --instance A` reattaches A's own saved volume, never B's — B untouched", async () => {
    current = spawnBoot(a!, [], { local: "volume" });
    const code = await current.exited;
    const text = current.output();
    expect({ code, tail: code === 0 ? "" : text.slice(-3000) }).toEqual({ code: 0, tail: "" });
    expect(text).toContain(`target: local volume on volume ${a!.project}_pgdata`);
    expect(text).not.toContain(`${b!.project}_pgdata`);
    expect(containerIdentity(a!.project).api?.state).toBe("running");
    expectBUntouched("after A reattached its volume");
  }, BOOT_TIMEOUT_MS);
});
