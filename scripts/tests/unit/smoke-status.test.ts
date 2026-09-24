// `bun smoke:status` reads the receipt back, and the journal when there is none
// (smoke spec §1.4; issue #1026, criterion 29).
//
// The records are written through the REAL journal and receipt writers
// (scripts/lib/smoke-journal.ts) into a real instance directory, and read back
// by the real report — both through statusReport() and by running the command
// itself as a separate process with Docker pointed at a dead socket, because
// criterion 151 runs this suite with Docker unreachable and the records must
// still be readable then.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePlanId,
  openJournal,
  readJournal,
  readReceipt,
  writeReceipt,
  type DeploymentPlan,
  type PhaseOutcome,
  type Receipt,
  type StateExpectations,
} from "../../lib/smoke-journal.ts";
import { instancePaths, instanceStackProject, type InstancePaths } from "../../lib/smoke-state.ts";
import { classifyServices, statusReport } from "../../smoke-status.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const OLD = `sha256:${"1".repeat(64)}`;
const NEW = `sha256:${"2".repeat(64)}`;
const SOURCE = "a".repeat(40);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rm-smoke-status-"));
  roots.push(root);
  return root;
}

function plan(instance: string): DeploymentPlan {
  return {
    instance,
    target: { kind: "local", rmEnv: "stage", identity: "rehearsal", mode: "blank", volume: `rm_smoke_stack_0123456789_pgdata` },
    images: {
      api: { source: SOURCE, digest: null },
      "website-server": { source: SOURCE, digest: null },
      "worker-analytics": { source: SOURCE, digest: null },
      "system-scheduler": { source: SOURCE, digest: null },
    },
    roster: { agents: [], judges: [] },
    configuration: { RM_ENV: "smoke", SMOKE_CADENCE: "fast" },
    mutations: ["migrate"],
  };
}

const EMPTY: PhaseOutcome = {
  migrationsApplied: [],
  manifestPublished: null,
  participantsStarted: [],
  participantsStopped: [],
  servicesReplaced: {},
  spoofGenerationWritten: null,
};
function seen(services: Record<string, string>, ledger: string[] = []): StateExpectations {
  return { ledger, manifestHash: null, identity: "rehearsal", participants: [], services, spoofGeneration: null };
}

const MIGRATIONS = ["0001_init.sql", "0078_automation_token_holders.sql"];

/** A run that reached readiness and wrote its receipt. */
async function completedRun(paths: InstancePaths, instance: string): Promise<Receipt> {
  const p = plan(instance);
  const journal = openJournal(paths, { kind: "fresh-start", reason: "no journal" }, p);
  await journal.beginPhase("plan", null, seen({}));
  await journal.commitPhase(EMPTY);
  await journal.beginPhase("prepare", "migrate", seen({}));
  await journal.commitPhase({ ...EMPTY, migrationsApplied: MIGRATIONS });
  await journal.beginPhase("preflight", null, seen({}, MIGRATIONS));
  await journal.commitPhase(EMPTY);
  await journal.beginPhase("replace", null, seen({}, MIGRATIONS));
  await journal.commitPhase({ ...EMPTY, servicesReplaced: { api: NEW, "website-server": NEW } });
  await journal.beginPhase("participants", null, seen({ api: NEW }, MIGRATIONS));
  await journal.commitPhase(EMPTY);
  await journal.beginPhase("readiness", null, seen({ api: NEW }, MIGRATIONS));
  await journal.commitPhase(EMPTY);
  const receipt: Receipt = {
    planId: computePlanId(p),
    plan: p,
    instance,
    writtenAt: new Date(Date.now() + 1000).toISOString(),
    images: { api: NEW, "website-server": NEW },
    schema: { manifestHash: "sha256:manifest-abc", migrations: MIGRATIONS },
    preflight: [{ check: "schema-current", pass: true, detail: "schema is current: 78 migration(s) applied" }],
    readiness: [{ check: "api-health", pass: true, detail: "http://127.0.0.1:40001/health answered ok" }],
  };
  await writeReceipt(paths, receipt);
  return receipt;
}

/** A redeploy over a running stack, interrupted after replacement began. */
async function interruptedAfterReplace(paths: InstancePaths, instance: string): Promise<void> {
  const p = plan(instance);
  const journal = openJournal(paths, { kind: "fresh-start", reason: "no journal" }, p);
  const running = { api: OLD, "website-server": OLD, "worker-analytics": OLD, "system-scheduler": OLD };
  await journal.beginPhase("plan", null, seen(running));
  await journal.commitPhase(EMPTY);
  await journal.beginPhase("replace", null, seen(running));
  await journal.commitPhase({ ...EMPTY, servicesReplaced: { api: NEW, "website-server": NEW } });
  await journal.beginPhase("participants", null, seen({ ...running, api: NEW, "website-server": NEW }));
  await journal.endPhase("interrupted", "stopped by SIGINT/SIGTERM at the boundary before participants; nothing of it ran");
}

describe("the receipt is read back (§1.4, criterion 29)", () => {
  test("plan id, schema identity and every preflight result match what the run wrote", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "rm_local_one", { create: true });
    const receipt = await completedRun(paths, "rm_local_one");
    const lines = statusReport({
      instance: "rm_local_one",
      stateDir: paths.dir,
      journal: readJournal(paths),
      receipt: readReceipt(paths),
      stack: null,
      live: { api: NEW, "website-server": NEW },
      lockHolder: null,
    }).join("\n");
    expect(lines).toContain(`source: receipt — reached readiness under plan ${receipt.planId}`);
    expect(lines).toContain(`schema: manifest ${receipt.schema.manifestHash}; 2 migration(s), ending 0078_automation_token_holders.sql`);
    expect(lines).toContain("preflight schema-current: pass (schema is current: 78 migration(s) applied)");
    expect(lines).toContain("readiness api-health: pass");
    expect(lines).toMatch(/service api: 222222222222 at readiness — running now/);
  });

  test("the receipt is history and the daemon is now: a service that stopped since is said so", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "rm_local_one", { create: true });
    await completedRun(paths, "rm_local_one");
    const lines = statusReport({
      instance: "rm_local_one", stateDir: paths.dir, journal: readJournal(paths), receipt: readReceipt(paths), stack: null, live: {}, lockHolder: null,
    }).join("\n");
    expect(lines).toContain("service api: 222222222222 at readiness — NOT RUNNING now");
  });
});

describe("the journal is read when no receipt exists (§1.4)", () => {
  test("after an interrupted replace it names the phase and lists each service new or old", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "rm_local_two", { create: true });
    await interruptedAfterReplace(paths, "rm_local_two");
    const live = { api: NEW, "website-server": NEW, "worker-analytics": OLD };
    const lines = statusReport({
      instance: "rm_local_two", stateDir: paths.dir, journal: readJournal(paths), receipt: null, stack: null, live, lockHolder: null,
    }).join("\n");
    expect(lines).toContain("source: journal — this deployment is IN PROGRESS or was interrupted");
    expect(lines).toContain("phase: participants — interrupted — stopped by SIGINT/SIGTERM at the boundary before participants");
    expect(lines).toContain("services (replacement BEGAN):");
    expect(lines).toContain("api: new (222222222222)");
    expect(lines).toContain("website-server: new (222222222222)");
    expect(lines).toContain("worker-analytics: old (111111111111)");
    // §1.4: "no guarantee the old services survive" — a vanished one is said so.
    expect(lines).toContain("system-scheduler: not running");
  });

  test("a replace that never committed still tells new from old by the digest each runs now", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "rm_local_three", { create: true });
    const journal = openJournal(paths, { kind: "fresh-start", reason: "no journal" }, plan("rm_local_three"));
    await journal.beginPhase("replace", null, seen({ api: OLD, "worker-analytics": OLD }));
    await journal.endPhase("failed", "docker compose up exited 1");
    const standing = classifyServices(readJournal(paths)!, { api: NEW, "worker-analytics": OLD });
    expect(standing.find((s) => s.service === "api")?.standing).toBe("new");
    expect(standing.find((s) => s.service === "worker-analytics")?.standing).toBe("old");
    expect(standing.find((s) => s.service === "system-scheduler")?.standing).toBe("not running");
  });

  test("before replacement began, nothing is new: services are reported old or not running", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "rm_local_four", { create: true });
    const journal = openJournal(paths, { kind: "fresh-start", reason: "no journal" }, plan("rm_local_four"));
    await journal.beginPhase("plan", null, seen({}));
    await journal.commitPhase(EMPTY);
    await journal.beginPhase("prepare", "images", seen({}));
    await journal.endPhase("interrupted", "stopped by SIGINT/SIGTERM at the boundary before prepare (database)");
    const lines = statusReport({
      instance: "rm_local_four", stateDir: paths.dir, journal: readJournal(paths), receipt: null, stack: null, live: {}, lockHolder: null,
    }).join("\n");
    expect(lines).toContain("services (replacement has not begun):");
    expect(lines).not.toMatch(/: new/);
  });

  test("a newer journal in progress wins over an older plan's receipt, which is shown as history", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "rm_local_five", { create: true });
    const old = await completedRun(paths, "rm_local_five");
    const newer = { ...plan("rm_local_five"), mutations: [] as DeploymentPlan["mutations"] };
    const current = readJournal(paths)!;
    const journal = openJournal(
      paths,
      { kind: "supersede", previous: current, report: "superseded by a test" },
      newer,
    );
    await journal.beginPhase("plan", null, seen({ api: NEW }));
    await journal.commitPhase(EMPTY);
    const lines = statusReport({
      instance: "rm_local_five", stateDir: paths.dir, journal: readJournal(paths), receipt: readReceipt(paths), stack: null, live: { api: NEW }, lockHolder: { pid: 4242, planId: computePlanId(newer) },
    }).join("\n");
    expect(lines).toContain(`a run is IN PROGRESS: pid 4242 holds the deployment lock for plan ${computePlanId(newer)}`);
    expect(lines).toContain("source: journal");
    expect(lines).toContain(`last receipt (history): plan ${old.planId}`);
  });

  test("an instance with neither record says so", () => {
    const root = freshRoot();
    const paths = instancePaths(root, "rm_local_six", { create: true });
    expect(statusReport({ instance: "rm_local_six", stateDir: paths.dir, journal: null, receipt: null, stack: null, live: null, lockHolder: null }))
      .toContain("[smoke:status] No receipt and no journal: this instance has no recorded run.");
  });
});

describe("the command, as its own process, with Docker unreachable (criterion 151)", () => {
  const run = (root: string, args: string[]) => {
    const r = Bun.spawnSync(["bun", "--no-env-file", join(repoRoot, "scripts", "smoke-status.ts"), ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: root, RM_SMOKE_STATE_ROOT: root, DOCKER_HOST: "tcp://127.0.0.1:1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };

  test("reads the named instance's receipt from its state directory and exits 0", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "rm_local_cli", { create: true });
    const receipt = await completedRun(paths, "rm_local_cli");
    // A stack record, so the command asks the (dead) daemon and must survive it.
    writeFileSync(paths.stackStateFile, JSON.stringify({ instance: "rm_local_cli", project: "rm_smoke_stack_0123456789", composeFiles: "docker-compose.yml:docker-compose.smoke.yml", databaseUrl: "x", dbUser: "x", dbPassword: "x", dbName: "x", envClass: "local", envHash: "0123456789", db: "ephemeral", externalPg: false, apiPort: 0, webPort: 0, pgPort: 0, stage: false, logFile: "", createdAt: "" }));
    const r = run(root, ["--instance", "rm_local_cli"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`under plan ${receipt.planId}`);
    expect(r.out).toContain("preflight schema-current: pass");
    expect(r.out).toContain("daemon unreachable");
  }, 30_000);

  test("acts only on the named instance: a second instance's journal is not read", async () => {
    const root = freshRoot();
    await completedRun(instancePaths(root, "rm_local_a", { create: true }), "rm_local_a");
    await interruptedAfterReplace(instancePaths(root, "rm_local_b", { create: true }), "rm_local_b");
    const a = run(root, ["--instance", "rm_local_a"]);
    expect(a.out).toContain("source: receipt");
    expect(a.out).not.toContain("interrupted");
    const b = run(root, ["--instance", "rm_local_b"]);
    expect(b.out).toContain("phase: participants — interrupted");
    // Without a name, two instances are ambiguous and the command refuses rather than guessing.
    const neither = run(root, []);
    expect(neither.code).toBe(1);
    expect(neither.out).toContain("several instances have state here");
  }, 30_000);

  test("with NO stack record, services are UNKNOWN (read from the derived project), never 'not running'", async () => {
    // A boot killed before its stack record: containers may be running under
    // the project the instance fixes. The old code set live = {} and reported
    // every service "not running".
    const root = freshRoot();
    await interruptedAfterReplace(instancePaths(root, "rm_local_norec", { create: true }), "rm_local_norec");
    const r = run(root, ["--instance", "rm_local_norec"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`no stack record: live state read from the instance's derived compose project ${instanceStackProject("rm_local_norec", {})} (the daemon could not be asked: UNKNOWN)`);
    expect(r.out).not.toContain(": not running");
    expect(r.out).toContain("the daemon could not be asked; live service state is unknown");
  }, 30_000);

  test("a stale lock is reported as stale, not as a run in progress", () => {
    const root = freshRoot();
    const paths = instancePaths(root, "rm_local_stale", { create: true });
    const lines = statusReport({
      instance: "rm_local_stale", stateDir: paths.dir, journal: null, receipt: null, stack: null, live: null,
      lockHolder: { pid: 4242, planId: "p", alive: false },
    }).join("\n");
    expect(lines).toContain("a STALE deployment lock names pid 4242");
    expect(lines).not.toContain("IN PROGRESS");
  });

  test("red control: the retired checkout state file is not how it finds anything", () => {
    const src = Bun.file(join(repoRoot, "scripts", "smoke-status.ts"));
    return src.text().then((text) => {
      const code = text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
      expect(code).not.toContain('".agents"');
      expect(code).not.toContain("smoke-state.json");
    });
  });
});
