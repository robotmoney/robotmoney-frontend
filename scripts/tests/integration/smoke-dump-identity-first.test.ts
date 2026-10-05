// `bun smoke --local dump` of a production dump that predates 0081 — the
// identity-first `--local dump` pass (D55 (9), (10)), issue #1026 criterion 174,
// and the baseline-dump halves of criteria 13 and 76. smoke-production-spec.md
// §4.3 (the three named exceptions), §9.1 ("A production dump takes the same
// path"), §10 W2:
//
//   "A `--local dump` whose ledger equals the production baseline applies 0081
//   first, writes `rehearsal` in the same transaction, and boots; a dump with
//   any other pre-identity ledger refuses. Pointed at a remote connection, the
//   local dump preparation refuses, whatever `RM_ENV`, password or
//   acknowledgement says."
//   "Kill and rerun, for each of the three passes: kill it before 0081
//   commits, and the rerun takes the pass again; kill it after 0081, and the
//   rerun resumes through the normal path and applies the five files below 0081
//   (§9.1)."
//
// THE BACKUP is production's baseline (the 73-name ledger, D55 (8)), built and
// captured by ../support/make-encrypted-backup.ts `baseline`, dumped as the
// superuser (#699), gpg-encrypted like a real capture. It has no
// deployment_identity table, as a dump of today's production has none.
//
// WHERE THE PASS RUNS. In the enroll step's child (backend/scripts/
// smoke-prepare.ts localDumpIdentityFirst), which `bun smoke` starts after the
// restore and the target lock; `--migrate` then takes the normal path.
//
// THE KILLS are of the WHOLE boot (its process group, SIGKILL: the smoke parent
// and the preparation child die together, no handler runs) while the child's
// statement waits on a lock this test holds in the restored copy:
//   - before 0081 commits: an uncommitted ledger row under 0081's own name,
//     which the pass's ledger INSERT waits on, inside 0081's transaction;
//   - after 0063 commits: SHARE on swarm_judge_config, which the migrate step's
//     first file, 0056_swarm_judge_requires_model.sql, UPDATEs first.
// THE RERUN is of the killed STEP, as the smoke parent runs it: the same child
// (`runPrepareStep`, scripts/lib/smoke-database.ts) with the same request,
// under a target lock this test takes for the killed plan. A rerun of the whole
// boot first reattaches the restored copy (scripts/lib/smoke-main.ts), which is
// ./smoke-dump-lifecycle.test.ts's reattach case.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BOOT_TIMEOUT_MS, bootFailureReport, harness, journalNow, spawnBoot, teardown, waitFor, type BootHarness, type RunningBoot } from "./smoke-boot-harness.ts";
import { holdTokenFiles, repoRoot, startRemoteDb, type RemoteDb } from "./remote-db-harness.ts";
import { buildReleaseDatabase, makeEncryptedBackup, type EncryptedBackup } from "../support/make-encrypted-backup.ts";
import { instancePaths, readRolePasswords, readStackState } from "../../lib/smoke-state.ts";
import { roleUrl, runPrepareStep, type HostTarget, type PrepareStep } from "../../lib/smoke-database.ts";
import { smokeTwinUrlFromContainer } from "../../lib/smoke-twin.ts";
import { SUPPORTED_RELEASES } from "../../../backend/src/db/supported-releases.ts";
import { acquireTargetLock, readTargetStateAt } from "../../../backend/src/db/target-lock.ts";

const IDENTITY_MIGRATION = "0081_deployment_identity.sql";
const BASELINE = SUPPORTED_RELEASES[0]!;
const LOWER_FIVE = [
  "0056_swarm_judge_requires_model.sql",
  "0057_swarm_judge_policy_stamp.sql",
  "0058_swarm_judge_fault_injection.sql",
  "0059_swarm_judgement_completion_usage.sql",
  "0062_rm_worker_analytics_ledger_read_grant.sql",
];

/** Every migration file of this checkout, in filename (apply) order. */
const HEAD_FILES = readdirSync(join(repoRoot, "backend", "migrations")).filter((f) => f.endsWith(".sql")).sort();
/** What the migrate step applies after the pass: every file the baseline lacks but 0081, in filename order. */
const PENDING_AFTER_PASS = HEAD_FILES.filter((f) => !BASELINE.migrations.includes(f) && f !== IDENTITY_MIGRATION);

let dump: EncryptedBackup;
beforeAll(async () => {
  dump = await makeEncryptedBackup("baseline");
}, 300_000);
afterAll(() => dump?.close());

/** The restored copy this instance's boot recorded: its superuser URL and the host target. */
function restoredCopy(h: BootHarness): { superuserUrl: string; target: HostTarget; container: string } {
  const container = readStackState(h.paths)?.smokeTwinContainer;
  if (!container) throw new Error("the boot recorded no smoke-twin container");
  const superuserUrl = smokeTwinUrlFromContainer(container);
  if (!superuserUrl) throw new Error(`the smoke-twin container ${container} is not answering`);
  const url = new URL(superuserUrl);
  return {
    superuserUrl,
    container,
    target: { host: url.hostname, port: Number(url.port), database: decodeURIComponent(url.pathname.slice(1)), sslmode: "disable" },
  };
}

/** One statement over the host's psql. */
function psql(url: string, sql: string): string {
  const r = Bun.spawnSync(["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`psql failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

interface CopyState {
  ledger: string[];
  table: boolean;
  identity: string;
}

/** The files applied on top of the baseline, in the order their transactions ran. */
function applyOrder(url: string): string[] {
  const baseline = BASELINE.migrations.map((f) => `'${f}'`).join(",");
  return psql(url, `SELECT name FROM schema_migrations WHERE name NOT IN (${baseline}) ORDER BY applied_at, name`).split("\n").filter(Boolean);
}

function stateOf(url: string): CopyState {
  const ledger = psql(url, "SELECT name FROM schema_migrations ORDER BY name").split("\n").filter(Boolean);
  const table = psql(url, "SELECT to_regclass('public.deployment_identity') IS NOT NULL") === "t";
  return { ledger, table, identity: table ? psql(url, "SELECT string_agg(kind || ':' || written_by, ',') FROM deployment_identity") : "" };
}

/** Hold `sql` in an open transaction on `url` until released; it then rolls back. */
async function holdInTransaction(url: string, sql: string): Promise<{ release(): Promise<void> }> {
  const db = new Bun.SQL(url, { max: 1 });
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const isHeld = new Promise<void>((resolve) => (held = resolve));
  const done = db
    .begin(async (tx) => {
      await tx.unsafe(sql);
      held();
      await released;
      throw new Error("rollback");
    })
    .catch(() => undefined);
  await isHeld;
  return {
    async release() {
      release();
      await done;
      await db.close();
    },
  };
}

async function waitOwnerBlocked(url: string, pattern: string, boot: RunningBoot): Promise<void> {
  await waitFor(
    () =>
      psql(url, `SELECT count(*) FROM pg_stat_activity WHERE usename = 'rm_owner' AND wait_event_type = 'Lock' AND query LIKE '${pattern}'`) !== "0",
    BOOT_TIMEOUT_MS,
    `an rm_owner statement matching ${pattern} to block`,
    boot,
  );
}

async function waitOwnerGone(url: string): Promise<void> {
  await waitFor(() => psql(url, "SELECT count(*) FROM pg_stat_activity WHERE usename = 'rm_owner'") === "0", 60_000, "the killed run's rm_owner backends to end");
}

function stepCommitted(h: BootHarness, step: string): boolean {
  return (journalNow(h)?.phases ?? []).some((r) => r.phase === "prepare" && r.step === step && r.status === "committed");
}

/** SIGKILL the boot's whole process group: the smoke parent and its preparation child. */
async function killGroup(boot: RunningBoot): Promise<void> {
  try {
    process.kill(-boot.proc.pid, "SIGKILL");
  } catch {
    // already gone
  }
  await boot.exited;
}

/**
 * Rerun one preparation step of the killed plan exactly as the smoke parent
 * runs it — the same child, the same request — under a target lock this test
 * takes for that plan.
 */
async function rerunStep(h: BootHarness, action: "enroll" | "migrate"): Promise<Awaited<ReturnType<typeof runPrepareStep>>> {
  const copy = restoredCopy(h);
  const passwords = readRolePasswords(h.paths);
  const readerUrl = roleUrl(copy.target, "rm_readonly", passwords.rm_readonly);
  const planId = journalNow(h)!.planId;
  const acquired = await acquireTargetLock({
    databaseUrl: readerUrl,
    holder: { tool: "smoke", planId, instance: h.instance, host: hostname(), pid: process.pid },
    timeoutMs: 10_000,
    expected: await readTargetStateAt(readerUrl),
  });
  if (!acquired.acquired) throw new Error(acquired.reason);
  try {
    const step: PrepareStep = {
      action,
      rmEnv: "stage",
      connection: "local",
      target: copy.target,
      credentials: { source: "instance", stateRoot: h.root, instance: h.instance },
      lock: { backendPid: acquired.lock.backendPid, holder: acquired.lock.holder },
      stateDir: h.paths.dir,
      nonInteractive: true,
      ...(action === "enroll" ? { note: `--local dump ${dump.stamp}` } : {}),
    };
    return await runPrepareStep(repoRoot, step, { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", RM_SMOKE_STATE_ROOT: h.root });
  } finally {
    await acquired.lock.release();
  }
}

describe("`RM_ENV=stage bun smoke --local dump=<production baseline> --migrate`: the identity-first pass", () => {
  test("the dump is production's baseline: the 73-name ledger and no deployment_identity table", () => {
    expect(dump.ledger).toEqual([...BASELINE.migrations]);
    expect(dump.identity).toBeNull();
  });

  // ONE boot, shared by the two tests below: what the pass and the migrate
  // step did, and that the migrate step committed.
  let base: { steps: string[]; applyOrder: string[]; headLedger: boolean; why: string; migrateError: string } | undefined;

  test("enroll applies 0081 and writes rehearsal in ONE transaction, then --migrate applies the five lower files first and the rest", async () => {
    const h = harness("dumpbase");
    let boot: RunningBoot | undefined;
    try {
      boot = spawnBoot(h, [], { local: `dump=${dump.dir}`, env: { RM_ENV: "stage" } });
      const b = boot;
      await waitFor(() => b.exitCode() !== null || stepCommitted(h, "migrate"), BOOT_TIMEOUT_MS, "the boot to commit migrate or end", b);
      if (b.exitCode() === null) b.proc.kill("SIGINT");
      await b.exited;
      const steps = (journalNow(h)?.phases ?? []).map((p) => `${p.phase}:${p.step ?? ""}:${p.status}`);
      const copy = restoredCopy(h);
      const out = b.output();
      base = {
        steps,
        applyOrder: applyOrder(copy.superuserUrl),
        headLedger: stateOf(copy.superuserUrl).ledger.join("\n") === HEAD_FILES.join("\n"),
        why: bootFailureReport(b),
        migrateError: /startup failed: migrate: (.*)/.exec(out)?.[1] ?? "",
      };

      // The pass: enroll committed, 0081 and the row by rm_owner in one
      // transaction, the note naming the dump and the pass.
      expect({ enrolled: steps.includes("prepare:enroll:committed"), why: steps.includes("prepare:enroll:committed") ? "" : base.why }).toEqual({ enrolled: true, why: "" });
      expect(psql(copy.superuserUrl, "SELECT kind || ':' || written_by FROM deployment_identity")).toBe("rehearsal:rm_owner");
      expect(psql(copy.superuserUrl, "SELECT note FROM deployment_identity")).toContain(dump.stamp);
      expect(psql(copy.superuserUrl, "SELECT note FROM deployment_identity")).toContain("identity-first");
      expect(
        psql(copy.superuserUrl, `SELECT (SELECT xmin::text FROM schema_migrations WHERE name = '${IDENTITY_MIGRATION}') = (SELECT xmin::text FROM deployment_identity)`),
      ).toBe("t");

      // Then the migrate step, the normal path: 0081 was committed first (by
      // the pass), then the five lower files, then the rest, one transaction
      // each in filename order — every pending file of the checkout applied.
      expect(base.applyOrder).toEqual([IDENTITY_MIGRATION, ...PENDING_AFTER_PASS]);
      expect(base.applyOrder.slice(1, 6)).toEqual(LOWER_FIVE);
      expect(base.headLedger).toBe(true);
      expect(psql(copy.superuserUrl, "SELECT kind FROM deployment_identity")).toBe("rehearsal");
    } finally {
      teardown(h, boot);
    }
  }, BOOT_TIMEOUT_MS);

  // Once a KNOWN GAP: the first manifest refused to publish over the restored
  // copy because `ALTER DEFAULT PRIVILEGES` for rm_owner did not survive the
  // capture's --no-privileges. backend/schema/grants.sql now declares every
  // default privilege the snapshot records (D55 (6), w5-no-runtime-delete), and
  // the migrate run's reconciliation restores them before the manifest's
  // baseline comparison, so the migrate step commits.
  test("--migrate publishes the first manifest over the restored baseline copy, and the boot passes its migrate step", () => {
    if (!base) throw new Error("the baseline boot above did not run");
    expect({ migrated: base.steps.includes("prepare:migrate:committed"), error: base.migrateError }).toEqual({ migrated: true, error: "" });
  });

  test("KILLED BEFORE 0081 COMMITS: the copy keeps its baseline with no table, and the rerun takes the pass again", async () => {
    const h = harness("dumpkillb");
    let boot: RunningBoot | undefined;
    let blocker: { release(): Promise<void> } | undefined;
    try {
      boot = spawnBoot(h, [], { local: `dump=${dump.dir}`, env: { RM_ENV: "stage" }, ownProcessGroup: true });
      const b = boot;
      await waitFor(() => stepCommitted(h, "restore"), BOOT_TIMEOUT_MS, "the restore to commit", b);
      const copy = restoredCopy(h);
      blocker = await holdInTransaction(copy.superuserUrl, `INSERT INTO schema_migrations (name) VALUES ('${IDENTITY_MIGRATION}')`);
      await waitOwnerBlocked(copy.superuserUrl, "%INSERT INTO schema_migrations%", b);
      await killGroup(b);
      await blocker.release();
      blocker = undefined;
      await waitOwnerGone(copy.superuserUrl);

      expect(stateOf(copy.superuserUrl)).toEqual({ ledger: [...BASELINE.migrations], table: false, identity: "" });
      const enroll = journalNow(h)!.phases.filter((r) => r.phase === "prepare" && r.step === "enroll");
      expect(enroll.map((r) => r.status)).toEqual(["started"]);

      const again = await rerunStep(h, "enroll");
      expect(again).toMatchObject({ ok: true, detail: { kind: "rehearsal", identityFirst: BASELINE.name } });
      expect(stateOf(copy.superuserUrl)).toEqual({ ledger: [...BASELINE.migrations, IDENTITY_MIGRATION].sort(), table: true, identity: "rehearsal:rm_owner" });
    } finally {
      await blocker?.release();
      teardown(h, boot);
    }
  }, BOOT_TIMEOUT_MS);

  test("KILLED AFTER 0081 COMMITS: the copy holds 0081 with rehearsal, and the rerun of --migrate resumes through the normal path, the five lower files first", async () => {
    const h = harness("dumpkilla");
    let boot: RunningBoot | undefined;
    let blocker: { release(): Promise<void> } | undefined;
    try {
      boot = spawnBoot(h, [], { local: `dump=${dump.dir}`, env: { RM_ENV: "stage" }, ownProcessGroup: true });
      const b = boot;
      await waitFor(() => stepCommitted(h, "restore"), BOOT_TIMEOUT_MS, "the restore to commit", b);
      const copy = restoredCopy(h);
      blocker = await holdInTransaction(copy.superuserUrl, "LOCK TABLE swarm_judge_config IN SHARE MODE");
      await waitOwnerBlocked(copy.superuserUrl, "%swarm_judge_config%", b);
      // The committed state at this instant: the pass is done, 0056 is not.
      const whileBlocked = stateOf(copy.superuserUrl);
      await killGroup(b);
      await blocker.release();
      blocker = undefined;
      await waitOwnerGone(copy.superuserUrl);

      const passLeft = { ledger: [...BASELINE.migrations, IDENTITY_MIGRATION].sort(), table: true, identity: "rehearsal:rm_owner" };
      expect(whileBlocked).toEqual(passLeft);
      expect(stateOf(copy.superuserUrl)).toEqual(passLeft);
      expect(journalNow(h)!.phases.filter((r) => r.phase === "prepare" && r.step === "migrate").map((r) => r.status)).toEqual(["started"]);

      // The rerun of the killed step resumes through the normal path: every
      // pending file, the five lower files first, 0081 never again, and it
      // publishes the first manifest.
      const again = await rerunStep(h, "migrate");
      expect({ ok: again.ok, error: again.ok ? "" : again.error }).toEqual({ ok: true, error: "" });
      expect(applyOrder(copy.superuserUrl)).toEqual([IDENTITY_MIGRATION, ...PENDING_AFTER_PASS]);
      expect(stateOf(copy.superuserUrl)).toEqual({ ledger: HEAD_FILES, table: true, identity: "rehearsal:rm_owner" });
    } finally {
      await blocker?.release();
      teardown(h, boot);
    }
  }, BOOT_TIMEOUT_MS);
});

// ─────────────────────────────────────────────────────────────────────────────
// The pass never runs over a remote connection
// ─────────────────────────────────────────────────────────────────────────────

describe("pointed at a REMOTE database with no identity table and the baseline ledger", () => {
  const BASELINE_DB = "rm_prod_baseline";
  let remote: RemoteDb;
  const work = mkdtempSync(join(tmpdir(), "rm-dump-remote-"));
  beforeAll(async () => {
    remote = await startRemoteDb("dumpremote");
    remote.superuser(`CREATE DATABASE ${BASELINE_DB} OWNER rm_owner`);
    buildReleaseDatabase(remote.superuserUrl(BASELINE_DB), "baseline");
    // The release's 0053 left rm_owner NOLOGIN, as it left production; §9.1
    // step 1 gives it back, so a typed owner password WOULD work here.
    remote.superuser("ALTER ROLE rm_owner LOGIN", BASELINE_DB);
  }, 300_000);
  afterAll(() => {
    remote?.close();
    rmSync(work, { recursive: true, force: true });
  });

  const baselineState = (): CopyState => stateOf(remote.superuserUrl(BASELINE_DB));

  test("the remote database is production's shape: the baseline ledger and no table", () => {
    expect(baselineState()).toEqual({ ledger: [...BASELINE.migrations], table: false, identity: "" });
  });

  /**
   * The enroll step's child, pointed at the remote database, with a real
   * rm_owner password available in the instance's role file — so any refusal
   * is the pass's own, never a missing credential.
   */
  async function enrollRemote(label: string, over: Partial<PrepareStep>): Promise<Awaited<ReturnType<typeof runPrepareStep>>> {
    const root = join(work, label);
    const instance = `rm_it_dumpremote_${label}`;
    const paths = instancePaths(root, instance, { create: true });
    const dir = paths.dir;
    writeFileSync(paths.rolePasswordsFile, JSON.stringify(remote.passwords), { mode: 0o600 });
    const target: HostTarget = { host: remote.host, port: remote.port, database: BASELINE_DB, sslmode: "disable" };
    const readerUrl = roleUrl(target, "rm_readonly", remote.passwords.rm_readonly);
    const acquired = await acquireTargetLock({
      databaseUrl: readerUrl,
      holder: { tool: "smoke", planId: "remote-refusal-plan", instance, host: hostname(), pid: process.pid },
      timeoutMs: 10_000,
      expected: await readTargetStateAt(readerUrl),
    });
    if (!acquired.acquired) throw new Error(acquired.reason);
    try {
      return await runPrepareStep(
        repoRoot,
        {
          action: "enroll",
          rmEnv: "stage",
          connection: "remote",
          target,
          credentials: { source: "instance", stateRoot: root, instance },
          lock: { backendPid: acquired.lock.backendPid, holder: acquired.lock.holder },
          stateDir: dir,
          nonInteractive: true,
          note: "--local dump remote-refusal",
          ...over,
        },
        { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", RM_SMOKE_STATE_ROOT: root },
      );
    } finally {
      await acquired.lock.release();
    }
  }

  for (const [label, over] of [
    ["stage", { rmEnv: "stage" }],
    ["unset", { rmEnv: null }],
    ["prod", { rmEnv: "prod" }],
    ["claimslocal", { connection: "local" }],
  ] as const) {
    test(`the --local dump preparation refuses (${label}): 0081 not applied, no row written`, async () => {
      const result = await enrollRemote(label, over as Partial<PrepareStep>);
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toContain("Refusing the --local dump identity-first pass");
      // A request that CLAIMS a local connection to a remote server fails the
      // container proof: no restored copy of this plan answers at that address.
      expect((result as { error: string }).error).toContain(
        label === "claimslocal" ? "records no restored container" : "its connection is remote",
      );
      expect(baselineState()).toEqual({ ledger: [...BASELINE.migrations], table: false, identity: "" });
    }, 120_000);
  }

  // The loop above stops each request at the FIRST guard it meets: `prod`
  // keeps connection=remote, and `claimslocal` names an instance with no
  // restored container. The guards after those — RM_ENV=prod on the local
  // copy, the journal of another plan, and the published host:port — are
  // reached only from an instance whose plan really restored a copy. So one
  // boot restores the baseline dump and is killed with enroll blocked (the
  // copy keeps its baseline, the journal stays open with its restore
  // committed), and each request below is aimed from that state.
  test("from a plan that really restored a copy: RM_ENV=prod, another plan's lock, and a local claim aimed at another host:port each refuse at their own guard — and the plan's own request then passes", async () => {
    const h = harness("dumpguards");
    let boot: RunningBoot | undefined;
    let blocker: { release(): Promise<void> } | undefined;
    try {
      boot = spawnBoot(h, [], { local: `dump=${dump.dir}`, env: { RM_ENV: "stage" }, ownProcessGroup: true });
      const b = boot;
      await waitFor(() => stepCommitted(h, "restore"), BOOT_TIMEOUT_MS, "the restore to commit", b);
      const copy = restoredCopy(h);
      blocker = await holdInTransaction(copy.superuserUrl, `INSERT INTO schema_migrations (name) VALUES ('${IDENTITY_MIGRATION}')`);
      await waitOwnerBlocked(copy.superuserUrl, "%INSERT INTO schema_migrations%", b);
      await killGroup(b);
      await blocker.release();
      blocker = undefined;
      await waitOwnerGone(copy.superuserUrl);
      const baselineCopy = { ledger: [...BASELINE.migrations], table: false, identity: "" };
      expect(stateOf(copy.superuserUrl)).toEqual(baselineCopy);
      const planId = journalNow(h)!.planId;

      /** The enroll child for `instance`, under a target lock on `target` held by `lockPlan`. */
      const enroll = async (
        instance: { root: string; name: string; readonlyPassword: string },
        target: HostTarget,
        lockPlan: string,
        rmEnv: "stage" | "prod",
      ) => {
        const readerUrl = roleUrl(target, "rm_readonly", instance.readonlyPassword);
        const acquired = await acquireTargetLock({
          databaseUrl: readerUrl,
          holder: { tool: "smoke", planId: lockPlan, instance: instance.name, host: hostname(), pid: process.pid },
          timeoutMs: 10_000,
          expected: await readTargetStateAt(readerUrl),
        });
        if (!acquired.acquired) throw new Error(acquired.reason);
        try {
          return await runPrepareStep(
            repoRoot,
            {
              action: "enroll",
              rmEnv,
              connection: "local",
              target,
              credentials: { source: "instance", stateRoot: instance.root, instance: instance.name },
              lock: { backendPid: acquired.lock.backendPid, holder: acquired.lock.holder },
              stateDir: instancePaths(instance.root, instance.name).dir,
              nonInteractive: true,
              note: `--local dump ${dump.stamp}`,
            },
            { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", RM_SMOKE_STATE_ROOT: instance.root },
          );
        } finally {
          await acquired.lock.release();
        }
      };
      const own = { root: h.root, name: h.instance, readonlyPassword: readRolePasswords(h.paths).rm_readonly };
      const refusal = (result: Awaited<ReturnType<typeof runPrepareStep>>): string => {
        expect(result.ok).toBe(false);
        const error = (result as { error: string }).error;
        expect(error).toContain("Refusing the --local dump identity-first pass");
        return error;
      };

      // 1. RM_ENV=prod on the very copy this plan restored.
      expect(refusal(await enroll(own, copy.target, planId, "prod"))).toContain("RM_ENV=prod. The pass writes `rehearsal`");
      expect(stateOf(copy.superuserUrl)).toEqual(baselineCopy);

      // 2. The same copy, under a lock another plan holds: the open journal
      //    is not that plan's.
      expect(refusal(await enroll(own, copy.target, "another-plan", "stage"))).toContain(
        `is not the journal of plan another-plan that holds the target lock`,
      );
      expect(stateOf(copy.superuserUrl)).toEqual(baselineCopy);

      // 3. A local claim aimed at ANOTHER database — the remote server, with
      //    the baseline and no table — from an instance that records this
      //    plan's real restored container and its open journal (the remote's
      //    role file, so the reader connects and the refusal is the guard's).
      const aimedRoot = join(work, "aimed");
      const aimedName = "rm_it_dumpguards_aimed";
      const aimed = instancePaths(aimedRoot, aimedName, { create: true });
      writeFileSync(aimed.rolePasswordsFile, JSON.stringify(remote.passwords), { mode: 0o600 });
      copyFileSync(h.paths.stackStateFile, aimed.stackStateFile);
      copyFileSync(h.paths.journalFile, aimed.journalFile);
      const remoteTarget: HostTarget = { host: remote.host, port: remote.port, database: BASELINE_DB, sslmode: "disable" };
      expect(
        refusal(await enroll({ root: aimedRoot, name: aimedName, readonlyPassword: remote.passwords.rm_readonly }, remoteTarget, planId, "stage")),
      ).toContain(`the connection is ${remote.host}:${remote.port}, and the container this plan restored (${copy.container}) is published at`);
      expect(baselineState()).toEqual(baselineCopy);
      expect(stateOf(copy.superuserUrl)).toEqual(baselineCopy);

      // Positive control: the plan's own request, on its own copy, passes —
      // so each refusal above was its guard's, not a broken setup.
      const again = await rerunStep(h, "enroll");
      expect(again).toMatchObject({ ok: true, detail: { kind: "rehearsal", identityFirst: BASELINE.name } });
      expect(stateOf(copy.superuserUrl)).toEqual({ ledger: [...BASELINE.migrations, IDENTITY_MIGRATION].sort(), table: true, identity: "rehearsal:rm_owner" });
    } finally {
      await blocker?.release();
      teardown(h, boot);
    }
  }, BOOT_TIMEOUT_MS);

  test("RM_ENV=stage `bun smoke` against it refuses at the §4.3 matrix under the target lock: 0081 not applied, no row written", async () => {
    const op = remote.operator("stagebaseline", [], BASELINE_DB);
    holdTokenFiles(op, "rm_it_stagebaseline");
    const r = Bun.spawnSync(
      ["bun", "--no-env-file", "scripts/smoke.ts", "--instance", "rm_it_stagebaseline", "--credentials", op.roster, "--lock-timeout", "10"],
      { cwd: repoRoot, env: { ...op.env, RM_ENV: "stage" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect(r.exitCode).not.toBe(0);
    expect(out).toContain("target lock held");
    expect(out).toContain("RM_ENV=stage against a remote target whose deployment_identity is");
    expect(out).not.toContain("phase: prepare (migrate)");
    expect(out).not.toContain("rm_owner password");
    expect(baselineState()).toEqual({ ledger: [...BASELINE.migrations], table: false, identity: "" });
  }, 300_000);
});
