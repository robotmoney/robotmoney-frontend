// The §4.3 policy × identity matrix, row by row, in REAL `bun smoke` processes —
// criteria 13 and 46 (smoke-production-spec.md §4.1-§4.3, §10 W1/W2).
//
//   | RM_ENV | connection         | identity row   | result                         |
//   |--------|--------------------|----------------|--------------------------------|
//   | prod   | remote             | production     | production guards armed        |
//   | prod   | remote             | anything else  | refuse                         |
//   | prod   | --local            | any            | refuse                         |
//   | stage  | remote             | rehearsal      | stage                          |
//   | stage  | remote             | anything else  | refuse (incl. a typed password)|
//   | stage  | --local blank/dump | written by smoke | stage                        |
//   | stage  | --local volume     | rehearsal      | stage                          |
//   | stage  | --local volume     | anything else  | refuse                         |
//   | unset  | remote             | any            | refuse                         |
//   | unset  | --local            | as stage       | warn, proceed                  |
//   | other  | any                | any            | refuse                         |
//
// The matrix has ONE implementation (backend/src/deploy-policy.ts); the unit
// suite (scripts/tests/unit/smoke-env-policy.test.ts) grades the function. This
// file grades the PROGRAM: each row is the command an operator types, against a
// database whose enrollment is really that row's, and the proof is what the
// process did — refused before which step, or reached the target lock with the
// posture the row names. Spec §7's order binds every row that depends on the
// target's answer: the plan reads the enrollment only as its expectation, and
// the matrix judges it after the target lock is held (criterion 34), so such a
// row refuses with its `lock` preparation journaled failed and nothing after
// it run. Only the rows that need no answer (unset, other) refuse before any
// step. An allowed boot is stopped with SIGINT once its `lock`
// preparation (acquisition, revalidation and the matrix on the locked read) has
// committed; everything after that is other files' business.
//
// The REMOTE rows run against a database provisioned as §9.1 leaves production
// (./remote-db-harness.ts). The LOCAL rows run against the boot's own Postgres
// (./smoke-boot-harness.ts); the `--local dump` row restores a gpg-encrypted
// backup built by ../support/make-encrypted-backup.ts from a database enrolled
// `production`, the way §5.1/§5.2 capture one. (What a dump boot does after its
// enrollment, and a v0.5.0 dump that predates the identity table, are
// ./smoke-dump-lifecycle.test.ts's.) `--allow-insecure` is not yet a `bun smoke` flag (the overlay it
// replaces is removed in a later #1026 wave), so criterion 46's "incl.
// `--allow-insecure`" is proven here only through the typed-password and plain
// stage boots.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  BOOT_TIMEOUT_MS,
  bootQuery,
  harness,
  journalNow,
  spawnBoot,
  teardown,
  waitFor,
  type BootHarness,
  type RunningBoot,
} from "./smoke-boot-harness.ts";
import { holdTokenFiles, onTerminal, repoRoot, startRemoteDb, type Operator, type RemoteDb } from "./remote-db-harness.ts";
import { makeEncryptedBackup } from "../support/make-encrypted-backup.ts";
import { instancePaths, PRODUCTION_INSTANCE, readStackState } from "../../lib/smoke-state.ts";
import { readJournal } from "../../lib/smoke-journal.ts";
import { smokeTwinUrlFromContainer } from "../../lib/smoke-twin.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Remote rows
// ─────────────────────────────────────────────────────────────────────────────

let db: RemoteDb;
beforeAll(async () => {
  db = await startRemoteDb("matrix");
}, 180_000);
afterAll(() => db?.close());

function remoteArgv(op: Operator, instance: string | null, extra: readonly string[] = [], lockTimeoutSeconds = 10): string[] {
  holdTokenFiles(op, instance ?? PRODUCTION_INSTANCE);
  return ["bun", "--no-env-file", "scripts/smoke.ts", ...(instance ? ["--instance", instance] : []), "--credentials", op.roster, "--lock-timeout", String(lockTimeoutSeconds), ...extra];
}

/**
 * A row that depends on the target's answer refuses UNDER the target lock: the
 * journal's last record is the `lock` preparation, failed, and no step after it
 * began — no site placed, no image built, no preflight, no container replaced,
 * no owner prompt. (Assembly and the web compatibility decision run BEFORE the
 * lock by design, smoke spec §13.3, and write only the checkout's `_static`.)
 */
function expectRefusedAtTheLock(op: Operator, instance: string, out: string): void {
  const journal = readJournal(instancePaths(op.root, instance));
  expect(journal).not.toBeNull();
  const last = journal!.phases.at(-1)!;
  expect([last.phase, last.step, last.status]).toEqual(["prepare", "lock", "failed"]);
  expect(out).toContain("target lock held");
  for (const after of ["phase: prepare (site)", "phase: prepare (images)", "phase: preflight", "phase: replace"]) {
    expect(out).not.toContain(after);
  }
  expect(out).not.toContain("rm_owner password");
}

/** Run to completion; for the refusing rows. */
function remoteRefusal(op: Operator, env: Record<string, string | undefined>, instance: string | null): { code: number; out: string } {
  const full: Record<string, string> = { ...op.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete full[k];
    else full[k] = v;
  }
  const r = Bun.spawnSync(remoteArgv(op, instance), { cwd: repoRoot, env: full, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

/** Run until the `lock` preparation commits, then stop it; for the allowed rows. */
async function remoteAllowed(op: Operator, env: Record<string, string | undefined>, instance: string | null): Promise<{ code: number; out: string }> {
  const full: Record<string, string> = { ...op.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete full[k];
    else full[k] = v;
  }
  const proc = Bun.spawn(remoteArgv(op, instance), { cwd: repoRoot, env: full, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let out = "";
  const pumps = Promise.all(
    [proc.stdout, proc.stderr].map(async (stream) => {
      for await (const chunk of stream as ReadableStream<Uint8Array>) out += new TextDecoder().decode(chunk);
    }),
  );
  try {
    const deadline = Date.now() + 180_000;
    while (!/target lock held/.test(out) || !/phase: prepare \(assemble\)/.test(out)) {
      if (proc.exitCode !== null) break;
      if (Date.now() > deadline) throw new Error(`the boot never passed its lock preparation:\n${out.slice(-3000)}`);
      await Bun.sleep(100);
    }
    proc.kill("SIGINT");
    const code = await proc.exited;
    await pumps;
    return { code, out };
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}

describe("§4.3 remote rows — a real `bun smoke` against a remote database", () => {
  test("prod × remote × production: production guards armed — the plan says so and the boot passes its target lock", async () => {
    db.setIdentity("production");
    const op = db.operator("prod_production");
    // A production-policy boot demands a funded model for its host-side
    // drivers (AC-MODEL-01, scripts/lib/smoke-inference-preflight.ts). The key
    // is a placeholder: this boot is stopped long before anything spends it.
    const r = await remoteAllowed(op, { RM_ENV: "prod", AGENT_MODEL: "deepseek", OPENCODE_API_KEY: "sk-placeholder-never-spent" }, null);
    expect(r.out).toContain("target: remote");
    expect(r.out).toContain("RM_ENV=prod, deployment_identity production");
    expect(r.out).toContain("instance=rm_prod");
    expect(r.out).toContain("target lock held");
    // Stopped by the test after the lock, never refused by the matrix.
    expect(r.code).toBe(130);
    expect(r.out).not.toContain("refusing");
  }, 300_000);

  for (const kind of ["rehearsal", null] as const) {
    test(`prod × remote × ${kind ?? "no row"}: refused by the matrix on the locked read, before anything after the lock`, () => {
      db.setIdentity(kind);
      const op = db.operator(`prod_${kind ?? "none"}`);
      // A production-policy boot demands a funded model before the plan
      // (AC-MODEL-01); the placeholder is never spent.
      const r = remoteRefusal(op, { RM_ENV: "prod", AGENT_MODEL: "deepseek", OPENCODE_API_KEY: "sk-placeholder-never-spent" }, null);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("prod policy requires an identity of production");
      // The plan records what it read, and does not dress an absent row up as rehearsal.
      expect(r.out).toContain(`RM_ENV=prod, deployment_identity ${kind ?? "absent"}`);
      expectRefusedAtTheLock(op, "rm_prod", r.out);
    }, 120_000);
  }

  test("stage × remote × rehearsal: stage — and RM_ENV from ~/.env counts, since §3 lists it there", async () => {
    db.setIdentity("rehearsal");
    // No RM_ENV in the process: the ~/.env line decides (args override env).
    const op = db.operator("stage_rehearsal", ["RM_ENV = stage"]);
    const r = await remoteAllowed(op, { RM_ENV: undefined }, "rm_it_matrix_stage");
    expect(r.out).toContain("RM_ENV=stage, deployment_identity rehearsal");
    expect(r.out).toContain("target lock held");
    expect(r.code).toBe(130);
    // Criterion 34 on the REMOTE path, from the journal the boot wrote: the
    // plan, the instance's own files, the site assembly and its web-compat
    // decision (spec §13.3: before the first mutation; neither reads nor
    // writes the target), then the target lock (acquire, revalidate, matrix)
    // — and only then anything that acts on the target.
    const steps = readJournal(instancePaths(op.root, "rm_it_matrix_stage"))!.phases.map((p) => `${p.phase}:${p.step ?? ""}`);
    expect(steps.slice(0, 5)).toEqual(["plan:", "prepare:instance", "prepare:assemble", "prepare:web-compat", "prepare:lock"]);
  }, 300_000);

  for (const kind of ["production", null] as const) {
    test(`stage × remote × ${kind ?? "no row"}: a PLAIN stage boot refuses at the lock — stage never touches production data`, () => {
      db.setIdentity(kind);
      const op = db.operator(`stage_${kind ?? "none"}`);
      const r = remoteRefusal(op, { RM_ENV: "stage" }, "rm_it_matrix_plain");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(`RM_ENV=stage against a remote target whose deployment_identity is ${kind ?? "no identity row"}`);
      expect(r.out).toContain("stage policy (incl. --allow-insecure) never touches production data");
      expectRefusedAtTheLock(op, "rm_it_matrix_plain", r.out);
    }, 120_000);
  }

  test("criterion 46: a stage run WITH a typed owner password, on a terminal, refuses against production identity before the password is ever asked for", async () => {
    // The typed password is not an input to the decision: the matrix refuses
    // on the target's own answer, and the prompt that would take the password
    // is never reached.
    db.setIdentity("production");
    const op = db.operator("stage_typed");
    const boot = onTerminal(remoteArgv(op, "rm_it_matrix_typed", ["--migrate"]), { ...op.env, RM_ENV: "stage" });
    try {
      const code = await boot.exited();
      expect(code).not.toBe(0);
      expect(boot.screen()).toContain("whose deployment_identity is production");
      expectRefusedAtTheLock(op, "rm_it_matrix_typed", boot.screen());
    } finally {
      boot.kill();
    }
  }, 120_000);

  test("unset × remote: refuses before any connection or step, even against a rehearsal target", () => {
    db.setIdentity("rehearsal");
    const r = remoteRefusal(db.operator("unset_remote"), { RM_ENV: undefined }, "rm_it_matrix_unset");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("RM_ENV is not set and the target is reached as a remote connection");
    expect(r.out).not.toContain("phase:");
    expect(r.out).not.toContain("plan id:");
  }, 120_000);

  test("criterion 21: a target re-enrolled while `bun smoke` waited for the lock refuses once it acquires — the plan is re-run on the locked read", async () => {
    // The plan was read (rehearsal) before the lock existed. Another tool holds
    // the lock; while the boot waits, the target is re-enrolled production and
    // the holder lets go. The boot acquires, re-reads identity, ledger and
    // manifest, finds the plan no longer true, releases and refuses — the
    // `lock` preparation journaled failed, nothing after it run.
    const { acquireTargetLock, readTargetStateAt } = await import("../../../backend/src/db/target-lock.ts");
    db.setIdentity("rehearsal");
    const op = db.operator("revalidate", ["RM_ENV = stage"]);
    const url = `postgres://rm_readonly:${db.passwords.rm_readonly}@${db.host}:${db.port}/${db.database}?sslmode=disable`;
    const held = await acquireTargetLock({
      databaseUrl: url,
      holder: { tool: "migrate", planId: null, instance: null, host: "another-host", pid: 4321 },
      timeoutMs: 10_000,
      expected: await readTargetStateAt(url),
    });
    if (!held.acquired) throw new Error(held.reason);
    const proc = Bun.spawn(remoteArgv(op, "rm_it_matrix_revalidate", [], 60), {
      cwd: repoRoot,
      env: { ...op.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    const pumps = Promise.all(
      [proc.stdout, proc.stderr].map(async (stream) => {
        for await (const chunk of stream as ReadableStream<Uint8Array>) out += new TextDecoder().decode(chunk);
      }),
    );
    try {
      // Queued: the boot's lock connection publishes itself while it waits.
      const deadline = Date.now() + 120_000;
      while (db.superuser("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'rm-tl:smoke|%';") === "0") {
        if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`the boot never queued for the lock:\n${out.slice(-3000)}`);
        await Bun.sleep(100);
      }
      db.setIdentity("production");
      await held.lock.release();
      const code = await proc.exited;
      await pumps;
      expect(code).not.toBe(0);
      expect(out).toContain("deployment_identity is production, but the plan was built against rehearsal");
      for (const after of ["phase: prepare (site)", "phase: prepare (images)", "phase: preflight", "phase: replace"]) {
        expect(out).not.toContain(after);
      }
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await held.lock.release();
    }
  }, 300_000);

  test("other × remote: the retired `smoke` value refuses, and is not downgraded to stage", () => {
    db.setIdentity("rehearsal");
    const r = remoteRefusal(db.operator("other_remote"), { RM_ENV: "smoke" }, "rm_it_matrix_other");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('RM_ENV="smoke" is not a policy value');
    expect(r.out).not.toContain("phase:");
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Local rows
// ─────────────────────────────────────────────────────────────────────────────

describe("§4.3 local rows — a real `bun smoke` against its own Postgres", () => {
  let h: BootHarness | undefined;
  let current: RunningBoot | undefined;
  afterAll(() => {
    if (h) teardown(h, current);
  }, 300_000);

  /** Stop `boot` once IT (not an earlier boot of the instance) has committed `step`. */
  async function stopAfter(boot: RunningBoot, step: string, since: number): Promise<number> {
    await waitFor(() => {
      const j = journalNow(h!);
      return j !== null && j.phases.some((r) => r.phase === "prepare" && r.step === step && r.status === "committed" && Date.parse(r.startedAt) >= since);
    }, BOOT_TIMEOUT_MS, `the boot to commit its ${step} preparation`, boot);
    boot.proc.kill("SIGINT");
    return await boot.exited;
  }

  test("prod × --local: refuses before anything is created", async () => {
    const x = harness("mxprod");
    try {
      const boot = spawnBoot(x, [], { env: { RM_ENV: "prod" }, migrate: false });
      const code = await boot.exited;
      expect(code).not.toBe(0);
      expect(boot.output()).toContain("RM_ENV=prod with connection local-blank: refusing — production never runs on a database smoke owns");
      expect(boot.output()).not.toContain("phase:");
    } finally {
      teardown(x);
    }
  }, 120_000);

  test("other × --local: refuses before anything is created", async () => {
    const x = harness("mxother");
    try {
      const boot = spawnBoot(x, [], { env: { RM_ENV: "ephemeral" }, migrate: false });
      expect(await boot.exited).not.toBe(0);
      expect(boot.output()).toContain('RM_ENV="ephemeral" is not a policy value');
    } finally {
      teardown(x);
    }
  }, 120_000);

  test("stage × --local dump × a restored `production` row: stage — the matrix passes the lock and smoke re-enrolls the copy rehearsal through rm_owner", async () => {
    // The row's input: a backup of a database enrolled `production` (§9.1's
    // shape), encrypted as §5.2 encrypts one. §4.3 does not consult a local
    // dump's row: it is "written by smoke as rehearsal", under the lock.
    const backup = await makeEncryptedBackup("production-identity");
    const x = harness("mxdump");
    let boot: RunningBoot | undefined;
    try {
      expect(backup.identity).toBe("production");
      boot = spawnBoot(x, [], { env: { RM_ENV: "stage" }, local: `dump=${backup.dir}`, migrate: false });
      await waitFor(() => {
        const j = journalNow(x);
        return j !== null && j.phases.some((r) => r.phase === "prepare" && r.step === "enroll" && r.status === "committed");
      }, BOOT_TIMEOUT_MS, "the boot to commit its enroll preparation", boot);
      boot.proc.kill("SIGINT");
      // Stopped by the test after the enrollment, never refused by the matrix.
      expect(await boot.exited).toBe(130);
      // A PLAN check only: this is the plan summary (smoke-journal.ts
      // renderTarget), printed before the restore. It says nothing about what
      // the matrix read. At lock time the restored row still says `production`,
      // and the matrix allows it because the connection is local
      // (backend/src/deploy-policy.ts). The proof that the matrix passed is the
      // journal below: lock committed, then enroll committed.
      expect(boot.output()).toContain("RM_ENV=stage, deployment_identity rehearsal");
      expect(boot.output()).toContain("target lock held");
      expect(boot.output()).not.toContain("refusing");
      // The site is assembled and its web compatibility decided BEFORE the
      // first mutation of the target (smoke spec §13.3, D54), so those two
      // read-only steps sit between the restore and the lock.
      const steps = journalNow(x)!.phases.map((p) => `${p.phase}:${p.step ?? ""}:${p.status}`);
      expect(steps.slice(0, 7)).toEqual([
        "plan::committed", "prepare:instance:committed", "prepare:restore:committed",
        "prepare:assemble:committed", "prepare:web-compat:committed",
        "prepare:lock:committed", "prepare:enroll:committed",
      ]);
      // The restored copy's own answer: the production row is gone, rehearsal is written by rm_owner.
      const url = smokeTwinUrlFromContainer(readStackState(x.paths)!.smokeTwinContainer!)!;
      const read = Bun.spawnSync(["psql", "-X", "-At", url, "-c", "SELECT string_agg(kind || ':' || written_by, ',') FROM deployment_identity"], { stdout: "pipe", stderr: "pipe" });
      expect(read.stdout.toString().trim()).toBe("rehearsal:rm_owner");
    } finally {
      teardown(x, boot);
      backup.close();
    }
  }, BOOT_TIMEOUT_MS);

  test("unset × --local blank: warns `RM_ENV not set, running as stage`, proceeds, and the bootstrap writes rehearsal", async () => {
    h = harness("mxlocal");
    const since = Date.now();
    current = spawnBoot(h, [], { env: { RM_ENV: undefined }, migrate: false });
    const code = await stopAfter(current, "bootstrap", since);
    expect(code).toBe(130);
    expect(current.output()).toContain("RM_ENV not set, running as stage");
    expect(current.output()).toContain("target lock held");
    expect(bootQuery(h.project, "SELECT kind FROM deployment_identity")).toBe("rehearsal");
  }, BOOT_TIMEOUT_MS);

  test("stage × --local volume × rehearsal: stage — the reattached volume passes its target lock", async () => {
    expect(h).toBeDefined();
    const since = Date.now();
    current = spawnBoot(h!, [], { local: "volume", migrate: false });
    const code = await stopAfter(current, "lock", since);
    expect(code).toBe(130);
    expect(current.output()).toContain("target lock held");
  }, BOOT_TIMEOUT_MS);

  test("criterion 52 in a real process: `--local volume --seed` on the reattached volume refuses before any step — a reattached volume is not a blank database", async () => {
    expect(h).toBeDefined();
    const before = journalNow(h!)!.phases.length;
    current = spawnBoot(h!, ["--credentials", h!.emptyRoster, "--seed"], { local: "volume", migrate: false });
    const code = await current.exited;
    expect(code).not.toBe(0);
    expect(current.output()).toContain("--seed cannot be used with --local volume");
    // Refused at the arguments: no phase began, the instance's journal is untouched.
    expect(current.output()).not.toContain("phase:");
    expect(journalNow(h!)!.phases.length).toBe(before);
  }, BOOT_TIMEOUT_MS);

  for (const kind of ["production", null] as const) {
    test(`stage × --local volume × ${kind ?? "no row"}: refuses at the lock — a reattached volume gets no weaker policy than a remote`, async () => {
      expect(h).toBeDefined();
      // Re-enrolled through the container's superuser, the way a wrong restore
      // or a hand edit would leave it. This is the row's INPUT, on this file's
      // own Postgres; nothing is put back afterwards (these are the file's last
      // rows), so no case depends on a reset.
      bootQuery(h!.project, kind === null ? "DELETE FROM deployment_identity" : `UPDATE deployment_identity SET kind = '${kind}'`);
      current = spawnBoot(h!, [], { local: "volume", migrate: false });
      const code = await current.exited;
      expect(code).not.toBe(0);
      expect(current.output()).toContain("a reattached volume gets no weaker policy than a remote");
      const last = journalNow(h!)!.phases.at(-1)!;
      expect([last.phase, last.step, last.status]).toEqual(["prepare", "lock", "failed"]);
      // Nothing past the lock ran: no site placed, no image built, no
      // preflight, no application service replaced. (Assembly and the web
      // compatibility decision run BEFORE the lock by design — smoke spec
      // §13.3 takes that decision before the first mutation of the target —
      // and write nothing but the checkout's `_static`.)
      for (const after of ["phase: prepare (site)", "phase: prepare (images)", "phase: preflight", "phase: replace"]) {
        expect(current.output()).not.toContain(after);
      }
    }, BOOT_TIMEOUT_MS);
  }
});
