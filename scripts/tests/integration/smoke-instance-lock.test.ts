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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStackState } from "../../lib/smoke-state.ts";
import {
  bootQuery,
  BOOT_TIMEOUT_MS,
  harness,
  journalNow,
  phaseList,
  projectContainers,
  repoRoot,
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

// ─────────────────────────────────────────────────────────────────────────────
// THE TARGET LOCK ACROSS TOOLS (spec §2; criteria 18, 36, 39)
// ─────────────────────────────────────────────────────────────────────────────
//
// `bun run migrate` and `bun smoke` are separate programs that meet only in the
// database, so they contend only there: on the ONE session lock (§2, D52: "one
// constant key ... every tool that reaches the same database contends, whatever
// hostname it used"). Each case is real processes against one real boot's own
// Postgres:
//
//   1. a running `bun smoke` holds the lock; `bun run migrate`, reaching the
//      same database under ANOTHER hostname (`localhost` where the boot used
//      127.0.0.1), waits its --lock-timeout and exits non-zero naming the
//      holder — smoke, its instance, its plan id — before any prompt;
//   2. the smoke's lock connection is killed mid-phase (pg_terminate_backend):
//      the boot proves the lock at its next boundary, journals that phase
//      failed, and exits non-zero — no phase proceeds on a lock it cannot prove;
//   3. a `bun run migrate` holds the lock (parked at its rm_owner prompt, on a
//      terminal); a `bun smoke` on the same database waits its --lock-timeout,
//      journals the `lock` preparation failed and exits non-zero, naming the
//      migrate and "no plan id".
describe("`bun run migrate` and `bun smoke` contend on the target lock as processes (criteria 18, 36, 39)", () => {
  let x: BootHarness | undefined;
  let smokeRun: RunningBoot | undefined;
  let migrateHome = "";

  afterAll(() => {
    if (x) teardown(x, smokeRun);
    if (migrateHome) rmSync(migrateHome, { recursive: true, force: true });
  }, 300_000);

  /** The published host port of the boot's own postgres. */
  function pgPort(project: string): number {
    const id = Bun.spawnSync(
      ["docker", "ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=postgres"],
      { stdout: "pipe" },
    ).stdout.toString().trim().split("\n")[0]!;
    const out = Bun.spawnSync(["docker", "port", id, "5432/tcp"], { stdout: "pipe" }).stdout.toString();
    return Number(out.split("\n")[0]!.split(":").at(-1));
  }

  /** A `$HOME/.env` for `bun run migrate` against the boot's database, under `host`. */
  function migrateEnv(host: string): Record<string, string> {
    const passwords = JSON.parse(readFileSync(x!.paths.rolePasswordsFile, "utf8")) as Record<string, string>;
    migrateHome = mkdtempSync(join(tmpdir(), "rm-lock-migrate-home-"));
    writeFileSync(
      join(migrateHome, ".env"),
      [`host = ${host}`, `port = ${pgPort(x!.project)}`, "database = robotmoney", "sslmode = disable", `rm_readonly = ${passwords.rm_readonly}`, ""].join("\n"),
    );
    return { PATH: process.env.PATH ?? "", HOME: migrateHome, RM_ENV: "stage", TERM: "dumb" };
  }

  function runMigrate(env: Record<string, string>, lockTimeoutSeconds: number): { code: number; out: string } {
    const r = Bun.spawnSync(["bun", "scripts/migrate.ts", "--instance", x!.instance, "--lock-timeout", String(lockTimeoutSeconds)], {
      cwd: join(repoRoot, "backend"),
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  }

  /** The backend pid of the smoke's lock connection, published through application_name. */
  function smokeLockBackend(): string {
    return bootQuery(x!.project, "SELECT pid FROM pg_stat_activity WHERE application_name LIKE 'rm-tl:smoke|%' LIMIT 1") ?? "";
  }

  test("1 + 2 — migrate under another hostname waits, then names smoke and its plan id; then the smoke's lock connection dies mid-phase and the boot journals that phase failed", async () => {
    x = harness("tlock");
    smokeRun = spawnBoot(x);
    // The lock is held from the `lock` preparation on; wait until the boot is
    // well past it, in the image build.
    await waitFor(() => {
      const steps = (journalNow(x!)?.phases ?? []).filter((r) => r.phase === "prepare").map((r) => [r.step, r.status]);
      return steps.some(([step, status]) => step === "lock" && status === "committed") && steps.some(([step]) => step === "assemble");
    }, BOOT_TIMEOUT_MS, "the boot to hold the target lock and begin assembling", smokeRun);
    const planId = journalNow(x)!.planId;

    // 1. Contention, two hostnames for one database: the boot used 127.0.0.1.
    const started = Date.now();
    const waited = runMigrate(migrateEnv("localhost"), 3);
    expect(waited.code).not.toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
    expect(waited.out).toContain(`held by smoke (instance ${x.instance}) under plan ${planId.slice(0, 12)}`);
    expect(waited.out).toMatch(/waited \d+ms and gave up/);
    expect(waited.out).not.toContain("rm_owner password");

    // 2. Connection loss mid-phase: the smoke's own lock connection is killed.
    const backend = smokeLockBackend();
    expect(backend).toMatch(/^\d+$/);
    expect(bootQuery(x.project, `SELECT pg_terminate_backend(${backend})`)).toBe("t");
    const code = await smokeRun.exited;
    expect(code).not.toBe(0);
    const records = journalNow(x)!.phases;
    const failed = records.at(-1)!;
    expect(failed.status).toBe("failed");
    expect(failed.reason).toContain("cannot be proven held");
    // No phase after the loss ran: nothing was replaced.
    expect(records.some((r) => r.phase === "replace")).toBe(false);
    expect(smokeRun.output()).toContain("The lock is not re-acquired");
  }, BOOT_TIMEOUT_MS);

  test("3 — a `bun run migrate` holding the lock at its prompt makes `bun smoke` wait, then journal `lock` failed and exit non-zero, naming migrate", async () => {
    expect(x).toBeDefined();
    // The migrate command, on a terminal, parked at its rm_owner prompt: it
    // acquired the lock (and ran its gates) before asking.
    const env = migrateEnv("127.0.0.1");
    const migrate = Bun.spawn(["script", "-qefc", `bun scripts/migrate.ts --instance ${x!.instance} --lock-timeout 5`, "/dev/null"], {
      cwd: join(repoRoot, "backend"),
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let screen = "";
    const pump = (async () => {
      for await (const chunk of migrate.stdout) screen += new TextDecoder().decode(chunk);
    })();
    try {
      const deadline = Date.now() + 60_000;
      while (!screen.includes("rm_owner password (not echoed")) {
        if (migrate.exitCode !== null || Date.now() > deadline) throw new Error(`migrate never reached its prompt:\n${screen}`);
        await Bun.sleep(50);
      }
      // A reattach of the same instance's volume: its own create step, then the lock.
      const second = spawnBoot(x!, ["--credentials", x!.emptyRoster, "--lock-timeout", "3"], { local: "volume" });
      const code = await second.exited;
      expect(code).not.toBe(0);
      expect(second.output()).toContain("held by migrate");
      expect(second.output()).toContain("with no plan id (a standalone tool)");
      const last = journalNow(x!)!.phases.at(-1)!;
      expect([last.phase, last.step, last.status]).toEqual(["prepare", "lock", "failed"]);
    } finally {
      migrate.kill("SIGKILL");
      await migrate.exited;
      await pump;
    }
  }, BOOT_TIMEOUT_MS);
});
