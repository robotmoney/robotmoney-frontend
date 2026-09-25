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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journal } from "../../lib/smoke-journal.ts";
import { readStackState } from "../../lib/smoke-state.ts";
import type { MigrateJournalFile } from "../../../backend/scripts/migrate-journal.ts";
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

/**
 * The journal of a boot that is STILL WRITING it.
 *
 * THIS SPIN WORKS AROUND A PRODUCT DEFECT; IT DOES NOT FIX ONE. Smoke rewrites
 * its live journal in place (scripts/lib/smoke-journal.ts `writeDurably`:
 * `writeFileSync` with flag `w`, which truncates and then writes), so any
 * concurrent reader can land between the truncate and the write and read an
 * empty or partial file. For `bun smoke:status` or a resume that is a
 * "Refusing: the journal ... is malformed" (`readVersioned`); here
 * `journalNow` answers `null`. This file once failed in the full integration
 * run on exactly that. The fix belongs in smoke-journal.ts: stage the file and
 * rename it over the live one, as backend/scripts/migrate-journal.ts `persist`
 * already does. Once that write is atomic, delete this function and read with
 * `journalNow(...)!` again, so a torn read fails this test instead of being
 * retried away.
 */
function settledJournal(harness: BootHarness): Journal {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const journal = journalNow(harness);
    if (journal !== null) return journal;
    if (Date.now() > deadline) throw new Error(`the journal of ${harness.instance} never parsed within 10s`);
  }
}

/**
 * The records a refused process must have left alone, compared the only way a
 * live holder allows. The holder keeps preparing while the second process is
 * refused, so a record read as `started` before may since have been committed
 * BY THE HOLDER, and an exact comparison failed whenever the holder's step
 * finished in between — the same race's other half. The refused process itself
 * adds no record and marks none: every record from before is still in place,
 * same phase and step, with its status unchanged or moved forward from
 * `started` to `committed`.
 */
function recordsLeftAlone(
  before: ReturnType<typeof phaseList>,
  after: ReturnType<typeof phaseList>,
): Array<{ at: number; before: string; after: string }> {
  return before.flatMap(([phase, step, status], at) => {
    const [phaseNow, stepNow, statusNow] = after[at] ?? ["(missing)", null, "(missing)"];
    const same = phaseNow === phase && stepNow === step;
    const forward = statusNow === status || (status === "started" && statusNow === "committed");
    return same && forward ? [] : [{ at, before: `${phase}/${step}/${status}`, after: `${phaseNow}/${stepNow}/${statusNow}` }];
  });
}

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
    const planId = settledJournal(h).planId;
    const lock = JSON.parse(readFileSync(h.paths.lockFile, "utf8")) as { holderPid: number; planId: string };
    expect(lock.holderPid).toBe(holder.proc.pid);
    const phasesBefore = phaseList(settledJournal(h));

    const second = spawnBoot(h);
    const code = await second.exited;
    const out = second.output();
    expect(code).not.toBe(0);
    expect(out).toContain(`instance ${h.instance} is locked by pid ${holder.proc.pid}`);
    expect(out).toContain(`running plan ${planId}`);
    // It refused BEFORE anything: the holder's journal gained nothing from it,
    // and the lock still names the holder.
    const journalAfter = settledJournal(h);
    expect(journalAfter.planId).toBe(planId);
    expect(recordsLeftAlone(phasesBefore, phaseList(journalAfter))).toEqual([]);
    expect((JSON.parse(readFileSync(h.paths.lockFile, "utf8")) as { holderPid: number }).holderPid).toBe(holder.proc.pid);
    expect(out).not.toContain("phase: prepare");

    // `smoke:down` while the holder deploys: refused, naming the holder, and
    // nothing is stopped or closed. (Before, it tore the stack down and closed
    // the journal, and the holder's next phase reopened both.)
    const down = runCommand(h, "smoke-down.ts", ["--instance", h.instance]);
    expect(down.code).not.toBe(0);
    expect(down.out).toContain(`Refusing: a \`bun smoke\` run (pid ${holder.proc.pid}, plan ${planId})`);
    expect(down.out).not.toContain("tearing down");
    expect(settledJournal(h).closedAt).toBeNull();
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
//      migrate and "no plan id";
//   4. migrate as the LOSER: a `bun run migrate` that has taken the lock, run
//      its gates and had rm_owner typed has its lock connection killed
//      (pg_terminate_backend) while it waits at the `y`; answered `y`, it proves
//      the lock at its next boundary, journals that the phase `migrate: start`
//      failed, and exits non-zero with nothing applied and no receipt — and the
//      next run recovers to a published manifest.
describe("`bun run migrate` and `bun smoke` contend on the target lock as processes (criteria 18, 36, 39)", () => {
  let x: BootHarness | undefined;
  let smokeRun: RunningBoot | undefined;
  const migrateHomes: string[] = [];

  afterAll(() => {
    if (x) teardown(x, smokeRun);
    for (const home of migrateHomes) rmSync(home, { recursive: true, force: true });
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
    const migrateHome = mkdtempSync(join(tmpdir(), "rm-lock-migrate-home-"));
    migrateHomes.push(migrateHome);
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
    const planId = settledJournal(x).planId;

    // 1. Contention, two hostnames for one database: the boot used 127.0.0.1.
    //    The migrate receipts and journals into the instance's own state
    //    directory, so its journal is read below.
    const journalsBefore = migrateRecords("migrate-journal-");
    const started = Date.now();
    const waited = runMigrate({ ...migrateEnv("localhost"), RM_SMOKE_STATE_ROOT: x.root }, 3);
    expect(waited.code).not.toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
    expect(waited.out).toContain(`held by smoke (instance ${x.instance}) under plan ${planId.slice(0, 12)}`);
    expect(waited.out).toMatch(/waited \d+ms and gave up/);
    expect(waited.out).not.toContain("rm_owner password");
    // Migrate as the loser of contention journals its phase (§2): one new
    // journal, closed `refused` in `lock`, naming smoke and its plan id, with
    // no receipt.
    const lostJournals = migrateRecords("migrate-journal-").filter((name) => !journalsBefore.includes(name));
    expect(lostJournals.length).toBe(1);
    const lost = JSON.parse(readFileSync(join(x.paths.dir, lostJournals[0]!), "utf8")) as MigrateJournalFile;
    expect(lost.outcome).toBe("refused");
    expect(lost.receipt).toBeNull();
    expect(lost.phases.map((r) => [r.phase, r.status])).toEqual([
      ["config", "committed"],
      ["plan", "committed"],
      ["lock", "refused"],
    ]);
    expect(lost.phases.at(-1)?.reason).toContain(`held by smoke (instance ${x.instance}) under plan ${planId.slice(0, 12)}`);

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

  /** `bun run migrate` on a terminal, against the boot's database, receipting
   *  into the instance's own state directory — an operator on this host. */
  function migrateOnTerminal(): {
    readonly waitFor: (text: string) => Promise<void>;
    readonly type: (text: string) => Promise<void>;
    readonly exited: Promise<number>;
    readonly screen: () => string;
    readonly kill: () => void;
  } {
    const env = { ...migrateEnv("127.0.0.1"), RM_SMOKE_STATE_ROOT: x!.root };
    const child = Bun.spawn(["script", "-qefc", `bun scripts/migrate.ts --instance ${x!.instance} --lock-timeout 5`, "/dev/null"], {
      cwd: join(repoRoot, "backend"),
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let screen = "";
    let from = 0;
    const pump = (async () => {
      for await (const chunk of child.stdout) screen += new TextDecoder().decode(chunk);
    })();
    return {
      async waitFor(text) {
        const deadline = Date.now() + 60_000;
        let at = screen.indexOf(text, from);
        while (at < 0) {
          if (child.exitCode !== null || Date.now() > deadline) throw new Error(`migrate never showed "${text}":\n${screen}`);
          await Bun.sleep(25);
          at = screen.indexOf(text, from);
        }
        from = at + text.length;
      },
      async type(text) {
        child.stdin.write(`${text}\r`);
        await child.stdin.flush();
      },
      exited: (async () => {
        const code = await child.exited;
        await pump;
        return code;
      })(),
      screen: () => screen,
      kill: () => {
        if (child.exitCode === null) child.kill("SIGKILL");
      },
    };
  }

  /** The migrate journals and receipts in the instance's state directory, oldest first. */
  function migrateRecords(prefix: "migrate-journal-" | "migrate-receipt-"): string[] {
    return readdirSync(x!.paths.dir).filter((name) => name.startsWith(prefix)).sort();
  }

  // WHAT TEST 4 PROVES AND WHAT IT DOES NOT. It kills migrate's lock connection
  // while the operator process waits at its `y`, on a database with nothing
  // pending, so the loss is found at `migrate: start`, before any mutation, and
  // the rerun has nothing to resume: its `applied` and `resumedAndVerified` are
  // both empty, and this test asserts that rather than implying more. A loss
  // BETWEEN TWO COMMITS, and a rerun that resumes the committed file from the
  // §8.3 in-progress state, is proved in process only
  // (backend/tests/migrate-run.test.ts, "the lock connection killed between two
  // commits"): the operator process reads the repository's own
  // backend/migrations, and this file has no pending migration to give it
  // without a migrations-directory override on a production mutation tool,
  // which it will not add for a test.
  test("4 — migrate as the loser: its lock connection dies while it waits at the `y`; it journals the phase that could not start, exits non-zero, and a rerun completes (nothing was pending, so nothing is resumed)", async () => {
    expect(x).toBeDefined();
    const ownerPassword = (JSON.parse(readFileSync(x!.paths.rolePasswordsFile, "utf8")) as Record<string, string>).rm_owner!;
    const manifestBefore = bootQuery(x!.project, "SELECT content_hash FROM schema_manifest");
    const ledgerBefore = bootQuery(x!.project, "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations");
    expect(manifestBefore).toMatch(/^[0-9a-f]{16,}$/);
    const journalsBefore = migrateRecords("migrate-journal-");
    const receiptsBefore = migrateRecords("migrate-receipt-");

    // Lock, gates, the typed owner password: the command is mid-run, in its
    // `confirm` phase, holding the target lock on its own connection.
    const loser = migrateOnTerminal();
    try {
      await loser.waitFor("rm_owner password (not echoed");
      await loser.type(ownerPassword);
      await loser.waitFor("type y to continue");
      const backend = bootQuery(x!.project, "SELECT pid FROM pg_stat_activity WHERE application_name LIKE 'rm-tl:migrate|%' LIMIT 1") ?? "";
      expect(backend).toMatch(/^\d+$/);
      expect(bootQuery(x!.project, `SELECT pg_terminate_backend(${backend})`)).toBe("t");
      await loser.type("y");
      expect(await loser.exited).not.toBe(0);
    } finally {
      loser.kill();
    }
    expect(loser.screen()).toContain("cannot be proven held");
    expect(loser.screen()).toContain("The lock is not re-acquired");

    // Its journal names the phase: `confirm` committed, and `migrate: start` —
    // the next boundary, where the loss was found — failed and never ran.
    const journals = migrateRecords("migrate-journal-").filter((name) => !journalsBefore.includes(name));
    expect(journals.length).toBe(1);
    const journal = JSON.parse(readFileSync(join(x!.paths.dir, journals[0]!), "utf8")) as MigrateJournalFile;
    expect(journal.outcome).toBe("failed");
    expect(journal.phases.map((r) => [r.phase, r.status]).slice(-2)).toEqual([
      ["confirm", "committed"],
      ["migrate: start", "failed"],
    ]);
    expect(journal.phases.at(-1)?.reason).toContain("cannot be proven held");
    expect(journal.receipt).toBeNull();
    expect(readFileSync(join(x!.paths.dir, journals[0]!), "utf8")).not.toContain(ownerPassword);

    // Nothing was applied, nothing receipted, and no lock outlived it.
    expect(migrateRecords("migrate-receipt-")).toEqual(receiptsBefore);
    expect(bootQuery(x!.project, "SELECT content_hash FROM schema_manifest")).toBe(manifestBefore);
    expect(bootQuery(x!.project, "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations")).toBe(ledgerBefore);
    expect(bootQuery(x!.project, "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted")).toBe("0");

    // The next run completes: the whole sequence, to a receipt and a published
    // manifest. Nothing was pending and nothing committed before the loss, so
    // it applies nothing and resumes nothing (see the note above the test).
    const next = migrateOnTerminal();
    try {
      await next.waitFor("rm_owner password (not echoed");
      await next.type(ownerPassword);
      await next.waitFor("type y to continue");
      await next.type("y");
      expect({ code: await next.exited, screen: next.screen().slice(-2000) }).toEqual({ code: 0, screen: expect.any(String) });
    } finally {
      next.kill();
    }
    const receipts = migrateRecords("migrate-receipt-").filter((name) => !receiptsBefore.includes(name));
    expect(receipts.length).toBe(1);
    const recovered = migrateRecords("migrate-journal-").filter((name) => !journalsBefore.includes(name) && !journals.includes(name));
    expect((JSON.parse(readFileSync(join(x!.paths.dir, recovered[0]!), "utf8")) as MigrateJournalFile).outcome).toBe("succeeded");
    const receipt = JSON.parse(readFileSync(join(x!.paths.dir, receipts[0]!), "utf8")) as {
      applied: string[];
      resumedAndVerified: string[];
      manifest: { contentHash: string };
    };
    expect({ applied: receipt.applied, resumedAndVerified: receipt.resumedAndVerified }).toEqual({ applied: [], resumedAndVerified: [] });
    expect(bootQuery(x!.project, "SELECT content_hash FROM schema_manifest")).toBe(receipt.manifest.contentHash);
  }, BOOT_TIMEOUT_MS);
});
