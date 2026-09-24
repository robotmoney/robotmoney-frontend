// Unit specification for scripts/lib/smoke-state.ts — deployment instance
// identity (§1.1), the per-instance state directory, the four generated role
// passwords (§5), the service-token files (§3) and the instance deployment lock
// (§1.2) of docs/technical/smoke-production-spec.md.
//
// WHY PERSISTENCE IS TESTED BEHAVIOURALLY. Precedence rule 4 ("the name
// persisted by a previous local run") is asserted by RESOLVING TWICE against one
// state root, not by writing a file whose format these tests would then freeze.
// The requirement is that the second run finds the first run's name; the file
// that carries it is the implementation's business.
//
// WHY A CHILD PROCESS APPEARS BELOW. The stale-lock case — a holder killed with
// SIGKILL — cannot be produced inside the test process, and faking it by writing
// a lock file would freeze a format. So one test spawns a real holder, kills it
// uncleanly, and asserts the takeover is possible.
//
// Acceptance gates served (spec §10, W1):
//   - "Concurrent CI jobs plus a standing stage select distinct instances with
//      prior state present."
//   - "Second `bun smoke` against a locked instance refuses." (module half: the
//      refusal names the holder's pid and plan id; two real `bun smoke`
//      processes contending is the integration test that later #1026 work adds)
//   - "`volume` reuse after restart."
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDeploymentLock,
  generateRolePasswords,
  instanceFlag,
  instancePaths,
  listInstances,
  PRODUCTION_INSTANCE,
  readRolePasswords,
  readStackState,
  resolveInstance,
  selectExistingInstance,
  SERVICE_TOKEN_HOLDERS,
  stateRoot,
  throwawayInstance,
  TOKEN_FILE_NAME,
  writeStackState,
  type InstancePaths,
  type InstanceResolutionInput,
  type StackStateRecord,
} from "../../lib/smoke-state.ts";
import { computePlanId, openJournal, readArchivedJournals, readJournal, type DeploymentPlan } from "../../lib/smoke-journal.ts";
import type { StackEnvironment } from "../../stack/naming.ts";

const MODULE = join(import.meta.dir, "..", "..", "lib", "smoke-state.ts");
const PLAN = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const OTHER_PLAN = "beef0000beef0000beef0000beef0000beef0000beef0000beef0000beef0000";

const roots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-smoke-state-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots) {
    try {
      chmodSync(root, 0o700);
    } catch {
      /* best effort */
    }
  }
});

const CI = (hash: string): StackEnvironment => ({ class: "ci", hash });
const LOCAL = (hash: string): StackEnvironment => ({ class: "local", hash });

function resolution(overrides: Partial<InstanceResolutionInput> & { stateRoot: string }): InstanceResolutionInput {
  return {
    flag: undefined,
    rmEnv: "stage",
    environment: LOCAL("0123456789"),
    ...overrides,
  };
}

describe("PRODUCTION_INSTANCE — §1.1, production is named, not resolved", () => {
  test("the production instance is the literal `rm_prod`, and a prod-policy run is given exactly it", () => {
    expect(PRODUCTION_INSTANCE).toBe("rm_prod");
    expect(resolveInstance(resolution({ stateRoot: freshRoot(), rmEnv: "prod" })).name).toBe("rm_prod");
  });
});

describe("resolveInstance — §1.1 precedence, applied in order", () => {
  test("rule 1: `--instance` outranks CI identity and any persisted name", () => {
    const root = freshRoot();
    resolveInstance(resolution({ stateRoot: root }));
    const resolved = resolveInstance(resolution({ stateRoot: root, flag: "my-stage", environment: CI("aaaaaaaaaa") }));
    expect(resolved.name).toBe("my-stage");
    expect(resolved.source).toBe("flag");
  });

  test("rule 2: RM_ENV=prod is the fixed production instance, outranking CI identity", () => {
    const root = freshRoot();
    const resolved = resolveInstance(resolution({ stateRoot: root, rmEnv: "prod", environment: CI("aaaaaaaaaa") }));
    expect(resolved.name).toBe(PRODUCTION_INSTANCE);
    expect(resolved.source).toBe("production");
  });

  test("rule 3: a CI run takes its name from the run's identity hash", () => {
    const resolved = resolveInstance(resolution({ stateRoot: freshRoot(), environment: CI("abc1234567") }));
    expect(resolved.source).toBe("ci-identity");
    expect(resolved.name).toContain("abc1234567");
  });

  test("rule 3 is a prohibition: a CI run never inherits a standing stage's persisted name", () => {
    const root = freshRoot();
    const standingStage = resolveInstance(resolution({ stateRoot: root }));
    const ciJob = resolveInstance(resolution({ stateRoot: root, environment: CI("abc1234567") }));
    expect(ciJob.name).not.toBe(standingStage.name);
    expect(ciJob.source).toBe("ci-identity");
  });

  test("two concurrent CI jobs on one host with prior state present select distinct instances", () => {
    const root = freshRoot();
    resolveInstance(resolution({ stateRoot: root }));
    const jobA = resolveInstance(resolution({ stateRoot: root, environment: CI("1111111111") }));
    const jobB = resolveInstance(resolution({ stateRoot: root, environment: CI("2222222222") }));
    expect(jobA.name).not.toBe(jobB.name);
    expect(jobA.stateDir).not.toBe(jobB.stateDir);
  });

  test("rule 5 then rule 4: a first local run mints and persists a name, and the next run finds it", () => {
    const root = freshRoot();
    const first = resolveInstance(resolution({ stateRoot: root }));
    expect(first.source).toBe("fresh");
    expect(first.persistedDuringResolution).toBe(true);

    const second = resolveInstance(resolution({ stateRoot: root }));
    expect(second.name).toBe(first.name);
    expect(second.source).toBe("persisted");
    expect(second.persistedDuringResolution).toBe(false);
  });

  test("a resolved instance's state directory lives under the state root, one directory per instance", () => {
    const root = freshRoot();
    const resolved = resolveInstance(resolution({ stateRoot: root }));
    expect(resolved.stateDir.startsWith(root)).toBe(true);
    expect(resolved.stateDir).toBe(join(root, resolved.name));
  });

  test("a minted local name is a legal compose project name", () => {
    const resolved = resolveInstance(resolution({ stateRoot: freshRoot() }));
    expect(resolved.name).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });

  test("an `--instance` that is not a legal compose project name refuses, naming the offending value", () => {
    expect(() => resolveInstance(resolution({ stateRoot: freshRoot(), flag: "Bad Name" }))).toThrow("Bad Name");
  });

  test("naming the production instance from a stage policy refuses — it would contend for production's lock", () => {
    expect(() => resolveInstance(resolution({ stateRoot: freshRoot(), flag: PRODUCTION_INSTANCE }))).toThrow(
      /rm_prod/,
    );
  });

  test("RM_ENV=prod with an `--instance` other than rm_prod refuses", () => {
    expect(() =>
      resolveInstance(resolution({ stateRoot: freshRoot(), rmEnv: "prod", flag: "something-else" })),
    ).toThrow(/rm_prod/);
  });

  test("a CI class with an empty identity hash refuses — rule 3 forbids guessing", () => {
    expect(() => resolveInstance(resolution({ stateRoot: freshRoot(), environment: CI("") }))).toThrow(/identity|hash/i);
  });

  test("a state root that is a file, not a directory, refuses rather than degrading to a fresh name every boot", () => {
    const root = freshRoot();
    const asFile = join(root, "not-a-dir");
    writeFileSync(asFile, "x");
    expect(() => resolveInstance(resolution({ stateRoot: asFile }))).toThrow(/director/i);
  });

  test("an unwritable state root refuses, because rule 4 can never hold on the next boot", () => {
    const root = freshRoot();
    chmodSync(root, 0o500);
    expect(() => resolveInstance(resolution({ stateRoot: root }))).toThrow(/writ|permission/i);
  });
});

describe("stateRoot — §1.1, never inside the repository working tree", () => {
  test("resolves an absolute path under the operator's home", () => {
    const root = stateRoot({ HOME: "/home/operator" });
    expect(root.startsWith("/home/operator")).toBe(true);
  });

  test("never resolves inside the checkout, where `git clean` and a worktree switch would lose it", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    expect(stateRoot({ HOME: "/home/operator" }).startsWith(repoRoot)).toBe(false);
  });

  test("is deterministic for one environment", () => {
    expect(stateRoot({ HOME: "/home/operator" })).toBe(stateRoot({ HOME: "/home/operator" }));
  });

  test("two simulated hosts get two roots, which is what the W1 gates need in one process", () => {
    expect(stateRoot({ HOME: "/home/a" })).not.toBe(stateRoot({ HOME: "/home/b" }));
  });

  test("a relative root refuses: it would name a different directory per invocation", () => {
    expect(() => stateRoot({ HOME: "relative/home" })).toThrow(/absolute|relative/i);
  });

  test("an unresolvable HOME with no override refuses, naming HOME", () => {
    expect(() => stateRoot({})).toThrow("HOME");
  });
});

describe("instancePaths — the per-instance layout every W1 module agrees on", () => {
  test("every path is absolute and inside the instance's own directory", () => {
    const root = freshRoot();
    const paths = instancePaths(root, "alpha", { create: true });
    expect(paths.dir).toBe(join(root, "alpha"));
    for (const path of [
      paths.nameFile,
      paths.rolePasswordsFile,
      paths.tokensDir,
      ...Object.values(paths.tokenDirs),
      ...Object.values(paths.tokenFiles),
      paths.journalFile,
      paths.journalArchiveDir,
      paths.receiptFile,
      paths.lockFile,
      paths.spoofGenerationFile,
    ]) {
      expect(path.startsWith(`${paths.dir}/`)).toBe(true);
    }
  });

  test("every file and directory of the layout is a distinct path", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    const all = [
      paths.nameFile,
      paths.rolePasswordsFile,
      paths.tokensDir,
      ...Object.values(paths.tokenDirs),
      ...Object.values(paths.tokenFiles),
      paths.journalFile,
      paths.journalArchiveDir,
      paths.receiptFile,
      paths.lockFile,
      paths.spoofGenerationFile,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  test("two instances under one root are isolated: no shared path between them", () => {
    const root = freshRoot();
    const a = instancePaths(root, "alpha", { create: true });
    const b = instancePaths(root, "beta", { create: true });
    expect(a.dir).not.toBe(b.dir);
    expect(a.journalFile).not.toBe(b.journalFile);
    expect(a.lockFile).not.toBe(b.lockFile);
    expect(a.rolePasswordsFile).not.toBe(b.rolePasswordsFile);
  });

  test("§3: one token directory per holder, each holding exactly one token file, all under the tokens root", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    expect(Object.keys(paths.tokenFiles).sort()).toEqual([...SERVICE_TOKEN_HOLDERS].sort());
    expect(Object.keys(paths.tokenDirs).sort()).toEqual([...SERVICE_TOKEN_HOLDERS].sort());
    expect([...SERVICE_TOKEN_HOLDERS].sort()).toEqual(["analytics-producer", "operator", "system-scheduler"]);
    for (const holder of SERVICE_TOKEN_HOLDERS) {
      expect(paths.tokenDirs[holder]).toBe(join(paths.tokensDir, holder));
      expect(paths.tokenFiles[holder]).toBe(join(paths.tokenDirs[holder], TOKEN_FILE_NAME));
    }
    expect(new Set(Object.values(paths.tokenFiles)).size).toBe(SERVICE_TOKEN_HOLDERS.length);
  });

  test("§3/§5: the path a holder's mount exposes holds its own token and no other holder's", () => {
    // Compose mounts tokenDirs[holder] into that holder (criterion 113). With
    // every token and the role passwords written, walk each holder's mount and
    // prove it reaches exactly one file: its own token.
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    generateRolePasswords(paths);
    for (const holder of SERVICE_TOKEN_HOLDERS) writeFileSync(paths.tokenFiles[holder], `secret-of-${holder}\n`);

    for (const holder of SERVICE_TOKEN_HOLDERS) {
      const mount = paths.tokenDirs[holder];
      const reachable = readdirSync(mount, { recursive: true }).map(String);
      expect(reachable).toEqual([TOKEN_FILE_NAME]);
      expect(readFileSync(join(mount, TOKEN_FILE_NAME), "utf8")).toBe(`secret-of-${holder}\n`);
      for (const other of SERVICE_TOKEN_HOLDERS.filter((h) => h !== holder)) {
        expect(paths.tokenFiles[other].startsWith(`${mount}/`)).toBe(false);
        expect(paths.tokenDirs[other].startsWith(`${mount}/`)).toBe(false);
      }
      expect(paths.rolePasswordsFile.startsWith(`${mount}/`)).toBe(false);
    }
  });

  test("the tokens directory is separate from the role passwords: mounting a holder's directory hands it no database password", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    expect(paths.tokensDir).not.toBe(paths.dir);
    for (const other of [
      paths.rolePasswordsFile,
      paths.journalFile,
      paths.receiptFile,
      paths.spoofGenerationFile,
      paths.nameFile,
      paths.lockFile,
    ]) {
      expect(other.startsWith(`${paths.tokensDir}/`)).toBe(false);
    }
    expect(paths.dir.startsWith(`${paths.tokensDir}/`)).toBe(false);
    generateRolePasswords(paths);
    expect(readdirSync(paths.tokensDir).sort()).toEqual([...SERVICE_TOKEN_HOLDERS].sort());
    for (const holder of SERVICE_TOKEN_HOLDERS) expect(readdirSync(paths.tokenDirs[holder])).toEqual([]);
  });

  test("the tokens directory is created owner-only, like the instance directory", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    expect(statSync(paths.tokensDir).isDirectory()).toBe(true);
    expect(statSync(paths.tokensDir).mode & 0o777).toBe(0o700);
    for (const holder of SERVICE_TOKEN_HOLDERS) expect(statSync(paths.tokenDirs[holder]).mode & 0o777).toBe(0o700);
    expect(statSync(paths.journalArchiveDir).mode & 0o777).toBe(0o700);
  });

  test("the created directory is owner-only, because it holds the four role passwords in the clear", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
  });

  test("without `create` nothing is written — computing paths is not a side effect", () => {
    const root = freshRoot();
    instancePaths(root, "alpha");
    expect(readdirSync(root)).toEqual([]);
  });

  test("an instance name containing a path separator refuses: it could overwrite another instance's journal", () => {
    expect(() => instancePaths(freshRoot(), "alpha/beta", { create: true })).toThrow(/name/i);
  });

  test("an instance name containing `..` refuses for the same reason", () => {
    expect(() => instancePaths(freshRoot(), "..", { create: true })).toThrow(/name/i);
  });

  test("an instance directory path that exists as a file refuses, naming the path", () => {
    const root = freshRoot();
    writeFileSync(join(root, "alpha"), "x");
    expect(() => instancePaths(root, "alpha", { create: true })).toThrow(join(root, "alpha"));
  });
});

describe("generateRolePasswords / readRolePasswords — §5, generate once, reuse on `volume`", () => {
  test("generates four distinct non-empty passwords for the four roles", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    const generated = generateRolePasswords(paths);
    const values = [generated.rm_owner, generated.rm_app, generated.rm_worker, generated.rm_readonly];
    for (const value of values) expect(value.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(4);
  });

  test("persists them in the instance's state directory so a later `volume` reattach can authenticate", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    const generated = generateRolePasswords(paths);
    expect(existsSync(paths.rolePasswordsFile)).toBe(true);
    expect(readRolePasswords(paths)).toEqual(generated);
  });

  test("the passwords file is owner-only on disk", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    generateRolePasswords(paths);
    expect(statSync(paths.rolePasswordsFile).mode & 0o777).toBe(0o600);
  });

  test("two instances generate different passwords — state is per instance", () => {
    const root = freshRoot();
    const a = generateRolePasswords(instancePaths(root, "alpha", { create: true }));
    const b = generateRolePasswords(instancePaths(root, "beta", { create: true }));
    expect(a.rm_app).not.toBe(b.rm_app);
  });

  test("regenerating over an existing file refuses: it would orphan the credentials the volume's roles hold", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    generateRolePasswords(paths);
    expect(() => generateRolePasswords(paths)).toThrow(/exist/i);
  });

  test("a `volume` reattach with no saved passwords refuses and points at a fresh instance with `--local dump`", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    expect(() => readRolePasswords(paths)).toThrow(/--local dump/);
  });

  test("that refusal never offers to reset the roles — the credential to do so is in the missing file", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    let message = "";
    try {
      readRolePasswords(paths);
    } catch (error) {
      message = String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message.toLowerCase()).not.toContain("reset");
    expect(message.toLowerCase()).not.toContain("prompt");
  });

  test("a passwords file missing one of the four roles refuses rather than returning a partial set", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    writeFileSync(paths.rolePasswordsFile, JSON.stringify({ rm_owner: "a", rm_app: "b", rm_worker: "c" }), {
      mode: 0o600,
    });
    expect(() => readRolePasswords(paths)).toThrow(/rm_readonly|malformed|missing/i);
  });

  test("a malformed passwords file refuses", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    writeFileSync(paths.rolePasswordsFile, "not json", { mode: 0o600 });
    expect(() => readRolePasswords(paths)).toThrow(/malformed|parse|read/i);
  });

  test("a world-readable passwords file refuses: it hands every local account the database", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    generateRolePasswords(paths);
    chmodSync(paths.rolePasswordsFile, 0o644);
    expect(() => readRolePasswords(paths)).toThrow(/permission|readable|mode/i);
  });
});

describe("acquireDeploymentLock — §1.2, a second `bun smoke` against a locked instance refuses", () => {
  test("the first acquisition records this process as the holder", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    const lock = acquireDeploymentLock(paths, PLAN);
    try {
      expect(lock.instance).toBe("alpha");
      expect(lock.holderPid).toBe(process.pid);
      expect(lock.planId).toBe(PLAN);
      expect(Number.isNaN(Date.parse(lock.acquiredAt))).toBe(false);
    } finally {
      lock.release();
    }
  });

  test("a second acquisition on a live holder refuses, naming the holder's pid and pointing at smoke:status", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    const lock = acquireDeploymentLock(paths, PLAN);
    try {
      let message = "";
      try {
        acquireDeploymentLock(paths, OTHER_PLAN);
        throw new Error("expected the second acquisition to refuse");
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain(String(process.pid));
      expect(message).toContain(`plan ${PLAN}`);
      expect(message).not.toContain(OTHER_PLAN);
      expect(message).toContain("smoke:status");
    } finally {
      lock.release();
    }
  });

  test("the lock is per instance: a second instance on the same host is unaffected", () => {
    const root = freshRoot();
    const a = acquireDeploymentLock(instancePaths(root, "alpha", { create: true }), PLAN);
    const b = acquireDeploymentLock(instancePaths(root, "beta", { create: true }), PLAN);
    try {
      expect(a.instance).toBe("alpha");
      expect(b.instance).toBe("beta");
    } finally {
      a.release();
      b.release();
    }
  });

  test("a lock is taken FOR a plan: an empty plan id refuses", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    expect(() => acquireDeploymentLock(paths, "")).toThrow(/plan id/);
  });

  test("release is idempotent, so it is safe to call from a signal handler", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    const lock = acquireDeploymentLock(paths, PLAN);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  test("after release the instance can be locked again", () => {
    const paths = instancePaths(freshRoot(), "alpha", { create: true });
    acquireDeploymentLock(paths, PLAN).release();
    const second = acquireDeploymentLock(paths, PLAN);
    expect(second.holderPid).toBe(process.pid);
    second.release();
  });

  test("a lock left by a SIGKILLed holder is taken over, since §1.4 requires a rerun to resume", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "alpha", { create: true });
    const holderScript = join(root, "holder.ts");
    writeFileSync(
      holderScript,
      [
        `import { acquireDeploymentLock, instancePaths } from ${JSON.stringify(MODULE)};`,
        `const paths = instancePaths(${JSON.stringify(root)}, "alpha", { create: true });`,
        `acquireDeploymentLock(paths, ${JSON.stringify(PLAN)});`,
        `console.log("locked");`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );

    const child = Bun.spawn(["bun", holderScript], { stdout: "pipe", stderr: "pipe" });
    // READ UNTIL THE MARKER, NEVER TO EOF.
    //
    // This used to be `await new Response(child.stdout).text()`, which waits for
    // stdout to CLOSE. The holder deliberately never exits — that is the whole
    // point, it has to be alive and holding the lock when SIGKILL arrives — so
    // its stdout never closes and the drain never resolved. The test hung for
    // every implementation, including one that does not import the module at
    // all, so it could never have been made to pass by writing better code.
    //
    // Reading chunk by chunk until "locked" appears is what the test actually
    // means: wait until the holder reports it HAS the lock, then kill it.
    const decoder = new TextDecoder();
    let stdout = "";
    const reader = child.stdout.getReader();
    while (!stdout.includes("locked")) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
    expect(stdout).toContain("locked");
    child.kill("SIGKILL");
    await child.exited;

    const taken = acquireDeploymentLock(paths, PLAN);
    expect(taken.holderPid).toBe(process.pid);
    taken.release();
  });
});

describe("listInstances — §1.1, attributing this host's state to instances", () => {
  test("reports every instance with state on the host", () => {
    const root = freshRoot();
    instancePaths(root, "alpha", { create: true });
    instancePaths(root, "beta", { create: true });
    expect(listInstances(root).map((entry) => entry.name).sort()).toEqual(["alpha", "beta"]);
  });

  test("an empty state root lists nothing", () => {
    expect(listInstances(freshRoot())).toEqual([]);
  });

  test("reports journal and receipt presence without opening a database", () => {
    const root = freshRoot();
    const paths = instancePaths(root, "alpha", { create: true });
    writeFileSync(paths.journalFile, "{}");
    const [entry] = listInstances(root);
    expect(entry?.hasJournal).toBe(true);
    expect(entry?.hasReceipt).toBe(false);
  });

  test("reports whether a run is live on the instance", () => {
    const root = freshRoot();
    const paths = instancePaths(root, "alpha", { create: true });
    const lock = acquireDeploymentLock(paths, PLAN);
    try {
      expect(listInstances(root)[0]?.locked).toBe(true);
    } finally {
      lock.release();
    }
    expect(listInstances(root)[0]?.locked).toBe(false);
  });

  test("an unreadable state root refuses — `no instances` and `I could not look` must not read the same", () => {
    const root = freshRoot();
    const asFile = join(root, "not-a-dir");
    writeFileSync(asFile, "x");
    expect(() => listInstances(asFile)).toThrow(/read|director/i);
  });
});

// ── The stack record, and selecting an instance that already exists ─────────
function stackRecord(instance: string, overrides: Partial<StackStateRecord> = {}): StackStateRecord {
  return {
    instance,
    project: `rm_smoke_stack_${instance.slice(-10).padStart(10, "0")}`,
    apiPort: 0,
    webPort: 0,
    pgPort: 0,
    stage: false,
    envClass: "local",
    envHash: "0123456789",
    composeFiles: "docker-compose.yml:docker-compose.smoke.yml",
    db: "ephemeral",
    externalPg: false,
    databaseUrl: "postgres://robotmoney:robotmoney@postgres:5432/robotmoney",
    dbUser: "robotmoney",
    dbPassword: "robotmoney",
    dbName: "robotmoney",
    logFile: "",
    pgVolume: `${instance}_pgdata_volume`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("the stack record — what `bun smoke` brought up, kept with the instance (criterion 40)", () => {
  test("it lives in the instance directory, owner-only, and reads back", () => {
    const paths = instancePaths(freshRoot(), "rm_local_rec", { create: true });
    expect(paths.stackStateFile.startsWith(paths.dir)).toBe(true);
    expect(paths.logFile.startsWith(paths.dir)).toBe(true);
    expect(paths.overlaysDir.startsWith(paths.dir)).toBe(true);
    writeStackState(paths, stackRecord("rm_local_rec"));
    expect(statSync(paths.stackStateFile).mode & 0o777).toBe(0o600);
    expect(readStackState(paths)?.pgVolume).toBe("rm_local_rec_pgdata_volume");
  });

  test("no record is null; a malformed one refuses rather than reading as absent", () => {
    const paths = instancePaths(freshRoot(), "rm_local_rec", { create: true });
    expect(readStackState(paths)).toBeNull();
    writeFileSync(paths.stackStateFile, "{not json");
    expect(() => readStackState(paths)).toThrow(/malformed/);
    writeFileSync(paths.stackStateFile, JSON.stringify({ apiPort: 1 }));
    expect(() => readStackState(paths)).toThrow(/no compose project/);
  });

  test("the layout names nothing inside a checkout: every path is under the state root", () => {
    const root = freshRoot();
    const paths = instancePaths(root, "rm_local_rec", { create: true });
    for (const path of [paths.stackStateFile, paths.logFile, paths.overlaysDir, paths.webDir, paths.journalFile, paths.receiptFile, ...Object.values(paths.tokenFiles)]) {
      expect(path.startsWith(root)).toBe(true);
    }
  });
});

describe("selectExistingInstance — lifecycle commands select, they never mint", () => {
  test("the named instance, or the only one with state; several without a name refuses", () => {
    const root = freshRoot();
    const a = instancePaths(root, "rm_local_a", { create: true });
    expect(selectExistingInstance(root, undefined).dir).toBe(a.dir);
    instancePaths(root, "rm_local_b", { create: true });
    expect(selectExistingInstance(root, "rm_local_b").dir).toBe(join(root, "rm_local_b"));
    expect(() => selectExistingInstance(root, undefined)).toThrow(/several instances/);
  });

  test("an unknown name refuses, lists the known ones, and creates nothing", () => {
    const root = freshRoot();
    instancePaths(root, "rm_local_a", { create: true });
    expect(() => selectExistingInstance(root, "rm_local_zzz")).toThrow(/rm_local_a/);
    expect(existsSync(join(root, "rm_local_zzz"))).toBe(false);
    expect(() => selectExistingInstance(freshRoot(), undefined)).toThrow(/nothing has been deployed/);
  });

  test("instanceFlag reads both spellings, and refuses a flag with no name", () => {
    expect(instanceFlag(["--local", "blank", "--instance", "rm_x"])).toBe("rm_x");
    expect(instanceFlag(["--instance=rm_y"])).toBe("rm_y");
    expect(instanceFlag(["--local", "blank"])).toBeUndefined();
    expect(() => instanceFlag(["--instance", "--migrate"])).toThrow(/needs a name/);
  });

  test("throwawayInstance is outside every state root and gone after dispose", () => {
    const t = throwawayInstance("rm_eval_x");
    expect(t.stateDir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(t.paths.tokenDirs["analytics-producer"])).toBe(true);
    t.dispose();
    expect(existsSync(t.stateDir)).toBe(false);
  });
});

// ── Criterion 33: status, down, volume reuse and resume act only on the named instance ──
//
// Two instances with state on one host, and the real commands run as their own
// processes against them — with Docker pointed at a dead socket, so nothing can
// be touched except through the state directories, and so this runs wherever
// the unit suite does (criterion 151). Each command is aimed at ONE instance,
// and the other instance's files are byte-for-byte what they were.
describe("two instances on one host: each command acts only on the named one (criterion 33)", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const DEAD_DOCKER = "tcp://127.0.0.1:1";

  function planFor(instance: string): DeploymentPlan {
    return {
      instance,
      target: { kind: "local", rmEnv: "stage", identity: "rehearsal", mode: "blank", volume: `${instance}_pgdata_volume` },
      images: { api: { source: "a".repeat(40), digest: null } },
      roster: { agents: [], judges: [] },
      configuration: { SMOKE_CADENCE: "fast" },
      mutations: [],
    };
  }
  async function instanceWithOpenJournal(root: string, instance: string): Promise<InstancePaths> {
    const paths = instancePaths(root, instance, { create: true });
    writeStackState(paths, stackRecord(instance));
    const journal = openJournal(paths, { kind: "fresh-start", reason: "no journal" }, planFor(instance));
    await journal.beginPhase("plan", null, { ledger: [], manifestHash: null, identity: "rehearsal", participants: [], services: {}, spoofGeneration: null });
    await journal.commitPhase({ migrationsApplied: [], manifestPublished: null, participantsStarted: [], participantsStopped: [], servicesReplaced: {}, spoofGenerationWritten: null });
    return paths;
  }
  /** Every file of an instance directory, with its bytes: what "untouched" means. */
  function snapshot(paths: InstancePaths): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else out[full.slice(paths.dir.length)] = readFileSync(full, "utf8");
      }
    };
    walk(paths.dir);
    return out;
  }
  function run(root: string, script: string, args: string[]): { code: number; out: string } {
    const r = Bun.spawnSync(["bun", "--no-env-file", join(repoRoot, "scripts", script), ...args], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? root, RM_SMOKE_STATE_ROOT: root, DOCKER_HOST: DEAD_DOCKER, RM_ENV: "smoke", AGENT_MODEL: "free" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  }

  test("smoke:status reports the named instance only", async () => {
    const root = freshRoot();
    const a = await instanceWithOpenJournal(root, "rm_local_alpha");
    const b = await instanceWithOpenJournal(root, "rm_local_bravo");
    const before = snapshot(b);
    const r = run(root, "smoke-status.ts", ["--instance", "rm_local_alpha"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`plan ${readJournal(a)!.planId}`);
    expect(r.out).not.toContain(String(readJournal(b)!.planId));
    expect(snapshot(b)).toEqual(before);
  }, 30_000);

  test("smoke:down stops and closes the named instance only; the other's journal stays open", async () => {
    const root = freshRoot();
    const a = await instanceWithOpenJournal(root, "rm_local_alpha");
    const b = await instanceWithOpenJournal(root, "rm_local_bravo");
    // No stack record on alpha: down has no containers to stop, and still closes its journal.
    rmSync(a.stackStateFile);
    const before = snapshot(b);
    const r = run(root, "smoke-down.ts", ["--instance", "rm_local_alpha"]);
    expect(r.code).toBe(0);
    expect(readJournal(a)!.closedAt).not.toBeNull();
    expect(readJournal(b)!.closedAt).toBeNull();
    expect(snapshot(b)).toEqual(before);
  }, 30_000);

  test("`--local volume` reattaches the NAMED instance's saved volume, never the other's", () => {
    const root = freshRoot();
    const a = instancePaths(root, "rm_local_alpha", { create: true });
    writeStackState(a, stackRecord("rm_local_alpha"));
    instancePaths(root, "rm_local_bravo", { create: true });
    // bravo has no saved volume: refused, naming bravo — alpha's volume is not borrowed.
    const bravo = run(root, "smoke.ts", ["--local", "volume", "--instance", "rm_local_bravo"]);
    expect(bravo.code).toBe(1);
    expect(bravo.out).toContain("found no saved volume for instance rm_local_bravo");
    expect(bravo.out).not.toContain("rm_local_alpha_pgdata_volume");
    // alpha's saved volume is the one asked about (the dead daemon then refuses).
    const alpha = run(root, "smoke.ts", ["--local", "volume", "--instance", "rm_local_alpha"]);
    expect(alpha.code).toBe(1);
    expect(alpha.out).toContain("volume=rm_local_alpha_pgdata_volume: could not ask Docker");
  }, 60_000);

  test("smoke:reap --instance aims at the named instance's recorded project; without it, every instance's project is protected", () => {
    const root = freshRoot();
    writeStackState(instancePaths(root, "rm_local_alpha", { create: true }), stackRecord("rm_local_alpha", { project: "rm_smoke_stack_aaaaaaaaaa" }));
    writeStackState(instancePaths(root, "rm_local_bravo", { create: true }), stackRecord("rm_local_bravo", { project: "rm_smoke_stack_bbbbbbbbbb" }));
    const aimed = run(root, "smoke-reap.ts", ["--dry-run", "--instance", "rm_local_alpha"]);
    expect(aimed.out).toContain("--instance rm_local_alpha: sweeping only project=rm_smoke_stack_aaaaaaaaaa");
    expect(aimed.out).not.toContain("rm_smoke_stack_bbbbbbbbbb");
    // G1 across the host: both instances' stacks are protected by default.
    const broad = run(root, "smoke-reap.ts", ["--dry-run"]);
    expect(broad.out).toContain("G1 protects project=rm_smoke_stack_aaaaaaaaaa");
    expect(broad.out).toContain("G1 protects project=rm_smoke_stack_bbbbbbbbbb");
    // Red control: an instance with no stack record names no project to sweep.
    instancePaths(root, "rm_local_charlie", { create: true });
    const none = run(root, "smoke-reap.ts", ["--dry-run", "--instance", "rm_local_charlie"]);
    expect(none.code).toBe(2);
    expect(none.out).toContain("instance rm_local_charlie has no stack record");
  }, 60_000);

  test("journal resume decides on the named instance's journal only; the other's is untouched", async () => {
    const root = freshRoot();
    const a = await instanceWithOpenJournal(root, "rm_local_alpha");
    const b = await instanceWithOpenJournal(root, "rm_local_bravo");
    rmSync(a.stackStateFile);
    const before = snapshot(b);
    const aPlan = readJournal(a)!.planId;
    // A real boot aimed at alpha. Its plan differs from the planted one, so it
    // supersedes alpha's journal (§1.3 rule 2) — then fails at the dead daemon.
    const r = run(root, "smoke.ts", ["--local", "blank", "--instance", "rm_local_alpha"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`The previous plan ${aPlan} is superseded`);
    const archived = readArchivedJournals(a);
    expect(archived.map((j) => String(j.planId))).toEqual([String(aPlan)]);
    expect(String(readJournal(a)!.planId)).not.toBe(String(aPlan));
    // bravo: not archived, not superseded, not written.
    expect(readArchivedJournals(b)).toEqual([]);
    expect(snapshot(b)).toEqual(before);
    expect(computePlanId(planFor("rm_local_bravo"))).toBe(readJournal(b)!.planId);
  }, 90_000);
});
