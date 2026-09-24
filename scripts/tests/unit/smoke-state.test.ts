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
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDeploymentLock,
  generateRolePasswords,
  instancePaths,
  listInstances,
  PRODUCTION_INSTANCE,
  readRolePasswords,
  resolveInstance,
  SERVICE_TOKEN_HOLDERS,
  stateRoot,
  TOKEN_FILE_NAME,
  type InstanceResolutionInput,
} from "../../lib/smoke-state.ts";
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
