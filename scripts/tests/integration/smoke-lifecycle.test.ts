// A REAL `bun smoke` run, end to end (issue #1026; smoke spec §§1, 1.1-1.4).
//
// One boot of `bun smoke --local blank --migrate --instance <name>`, on a
// terminal (script(1) gives it a pty), against its own state root. Asserted of
// the running process and of what it leaves behind — never of the modules alone:
//
//   criterion 20  the plan is printed before the first mutation, and the
//                 journal's phase order says so: `plan` first, committed
//                 before any preparation began, then every §1.3 phase in order;
//   criterion 14  the printed plan holds none of the run's secrets: the role
//                 passwords and the owner password saved for the instance, the
//                 service tokens the running containers were given, and every
//                 participant's key, bearer and model key — planted with NO
//                 recognisable shape, so only the by-value check can catch them;
//   criterion 40  every state file lands under the instance directory, and the
//                 checkout's `.agents/` is not written at all;
//   criterion 26  a second process observes the run through `smoke:status` and
//                 `smoke:tui` while it is in progress, and again from the
//                 receipt afterwards; the boot itself, on a TTY, draws nothing;
//   criterion 29  `smoke:status` reads the receipt back with the plan id,
//                 schema identity and preflight results the run wrote;
//   (25, stack half) `bun smoke` exits 0 at readiness and the stack outlives it;
//   criterion 34  create, then the target lock, then the first decision read:
//                 the journal's preparation records say so, in that order;
//   criteria 76, 70  the blank bootstrap left `deployment_identity = rehearsal`,
//                 written by rm_owner, and rm_owner holds no CREATEROLE after
//                 the bootstrap and the migrate run;
//   (44, smoke half) the receipt's preflight is the full §7 registry, all seven
//                 checks, run by the boot and passed;
//   (28, roles)   the api runs as rm_app and the pipeline worker as rm_worker;
//                 no container holds the local superuser;
//   criteria 31, 96, 27, 41 (runtime)  the boot provisioned the three service
//                 tokens as its journaled `prepare (tokens)` step — a hash and
//                 the holder's rights in the store, the secret only in the
//                 holder's 0600 file — the REAL system-scheduler container read
//                 its file and runs healthy and authenticated, no service holds
//                 a token in its environment, and the receipt carries every
//                 §6.3 readiness condition as a named, passed result.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPlanRedacted, DEPLOYMENT_PHASES, readReceipt, type DeploymentPlan } from "../../lib/smoke-journal.ts";
import { instancePaths, SERVICE_TOKEN_HOLDERS } from "../../lib/smoke-state.ts";
import { READINESS_CHECKS } from "../../lib/smoke-readiness-scheduler.ts";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
  bootArgs,
  bootQuery,
  BOOT_TIMEOUT_MS,
  containerEnv,
  harness,
  journalNow,
  listTree,
  projectContainers,
  repoRoot,
  runCommand,
  spawnBoot,
  teardown,
  waitFor,
  type BootHarness,
  type RunningBoot,
} from "./smoke-boot-harness.ts";

// Shapeless secrets: lower-case words and hyphens, which credentialShape()
// cannot tell from a hostname or a config value. Only the run's by-value
// secret list keeps them out of the plan.
const ROLE_PASSWORDS = {
  rm_owner: "harbor-lantern-quietly-owner",
  rm_app: "violet-orchard-morning-app",
  rm_worker: "copper-meadow-evening-worker",
  rm_readonly: "silver-canyon-drifting-readonly",
};
const PARTICIPANT = {
  bearer: "tangerine-marble-bearer-athena",
  modelKey: "cobalt-kettle-modelkey-athena",
  privateD: "velvet-thunder-private-athena",
};
const JUDGE = {
  bearer: "saffron-glacier-bearer-themis",
  modelKey: "amber-willow-modelkey-themis",
  privateD: "ivory-comet-private-themis",
};

let h: BootHarness;
let boot: RunningBoot;
let exitCode = -1;
let agentsBefore: string[] = [];
let duringStatus = { code: -1, out: "" };
let duringTui = { code: -1, out: "" };
let serviceTokens: string[] = [];
let containersAfterExit: Record<string, string> = {};
let schedulerHealthAfterExit = "";

beforeAll(async () => {
  h = harness("lifecycle");
  // Plant the instance's saved role passwords (§5: `volume` mode reuses them),
  // owner-only as readRolePasswords() requires, and a two-member roster.
  const paths = instancePaths(h.root, h.instance, { create: true });
  writeFileSync(paths.rolePasswordsFile, JSON.stringify(ROLE_PASSWORDS), { mode: 0o600 });
  chmodSync(paths.rolePasswordsFile, 0o600);
  const credentials = join(h.root, "roster.json");
  const entry = (who: string, s: typeof PARTICIPANT) => ({
    memberId: `member-${who}`,
    publicKeyB64: `${who}-public-key-b64`,
    privateJwk: { kty: "OKP", crv: "Ed25519", x: `${who}-public-key-b64`, d: s.privateD },
    bearer: s.bearer,
    modelKey: s.modelKey,
  });
  writeFileSync(credentials, JSON.stringify({ agents: { athena: entry("athena", PARTICIPANT) }, judges: { themis: entry("themis", JUDGE) } }));

  agentsBefore = listTree(join(repoRoot, ".agents"));
  boot = spawnBoot(h, ["--credentials", credentials], { tty: true });

  // Observe from ANOTHER process while the run holds its lock (criterion 26).
  await waitFor(() => {
    const j = journalNow(h);
    return j !== null && j.phases.some((r) => r.phase === "prepare") && existsSync(h.paths.lockFile);
  }, 120_000, "the boot to journal its plan and begin preparing", boot);
  duringStatus = runCommand(h, "smoke-status.ts", ["--instance", h.instance]);
  duringTui = runCommand(h, "smoke-tui.ts", ["--instance", h.instance, "--once"]);

  exitCode = await boot.exited;
  containersAfterExit = projectContainers(h.project);
  schedulerHealthAfterExit = containerHealthStatus(h.project, "system-scheduler");
  serviceTokens = SERVICE_TOKEN_HOLDERS.map((holder) =>
    existsSync(h.paths.tokenFiles[holder]) ? readFileSync(h.paths.tokenFiles[holder], "utf8").trim() : undefined,
  ).filter((t): t is string => typeof t === "string" && t.length > 0);
}, BOOT_TIMEOUT_MS);

afterAll(() => {
  if (h) teardown(h, boot);
}, 300_000);

/** A service container's Docker health status (`healthy`, `unhealthy`, `starting`), or `absent`. */
function containerHealthStatus(project: string, service: string): string {
  const id = Bun.spawnSync(
    ["docker", "ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`],
    { stdout: "pipe" },
  ).stdout.toString().trim().split("\n")[0];
  if (!id) return "absent";
  return Bun.spawnSync(["docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", id], { stdout: "pipe" })
    .stdout.toString().trim();
}

/** The plan block exactly as the boot printed it. */
function printedPlan(): string {
  const out = boot.output();
  const start = out.indexOf("── plan ──");
  const end = out.indexOf("plan id:", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return out.slice(start, out.indexOf("\n", end));
}

describe("a real `bun smoke` run (criteria 20, 14, 40, 26, 29)", () => {
  test("it exits 0 at readiness, and the stack outlives the process (spec §1)", () => {
    expect({ exitCode, tail: exitCode === 0 ? "" : boot.output().slice(-3000) }).toEqual({ exitCode: 0, tail: "" });
    // Docker keeps the stack up after `bun smoke` is gone (restart: unless-stopped).
    // RUNNING, not merely present: a crash-looping container is `restarting`,
    // and a service that never runs must not pass as one that survived.
    for (const service of ["postgres", "api", "website-server"]) {
      expect({ service, state: containersAfterExit[service] ?? "absent" }).toEqual({ service, state: "running" });
    }
  });

  test("criterion 31 (routed from wave 3): system-scheduler RUNS healthy after the boot exits — it read its provisioned token", () => {
    // It used to crash-loop on "automation token file not found". The boot's
    // `prepare (tokens)` step wrote the file; the REAL container read it
    // through its read-only mount, authenticated, and answers healthy.
    expect(containersAfterExit["system-scheduler"]).toBe("running");
    expect(schedulerHealthAfterExit).toBe("healthy");
    for (const service of ["analytics-producer", "worker-analytics"]) {
      expect({ service, state: containersAfterExit[service] ?? "absent" }).toEqual({ service, state: "running" });
    }
  });

  test("criteria 31, 96: three token files, the hash and the holder's rights in the store, no token in any environment", () => {
    // Journaled as its own preparation step (§5), after the database was enrolled.
    const steps = journalNow(h)!.phases.filter((r) => r.phase === "prepare").map((r) => `${r.step}:${r.status}`);
    expect(steps).toContain("tokens:committed");
    expect(steps.indexOf("tokens:committed")).toBeGreaterThan(steps.indexOf("bootstrap:committed"));
    const rights: Record<string, string> = {
      "system-scheduler": "lifecycle_transitions,read_sessions,read_subjects",
      "analytics-producer": "analytics_ingestion",
      operator: "admin",
    };
    for (const holder of SERVICE_TOKEN_HOLDERS) {
      const file = h.paths.tokenFiles[holder];
      expect({ holder, mode: statSync(file).mode & 0o777 }).toEqual({ holder, mode: 0o600 });
      expect({ holder, dirMode: statSync(h.paths.tokenDirs[holder]).mode & 0o777 }).toEqual({ holder, dirMode: 0o700 });
      const secret = readFileSync(file, "utf8").trim();
      const hash = createHash("sha256").update(secret).digest("hex");
      // The store holds the hash and the rights — and never the secret.
      const row = bootQuery(h.project, `SELECT holder || '|' || array_to_string(ARRAY(SELECT unnest(rights) ORDER BY 1), ',') FROM automation_tokens WHERE token_hash = '${hash}'`);
      expect({ holder, row }).toEqual({ holder, row: `${holder}|${rights[holder]}` });
      expect(bootQuery(h.project, `SELECT count(*) FROM automation_tokens WHERE token_hash = '${secret.replace(/'/g, "''")}' OR instance = '${secret.replace(/'/g, "''")}'`)).toBe("0");
    }
    expect(bootQuery(h.project, `SELECT count(*) FROM automation_tokens WHERE instance = '${h.instance}'`)).toBe("3");
    // No service carries a token in its environment (smoke spec §3, D52).
    for (const service of ["api", "worker-analytics", "worker-research", "system-scheduler", "analytics-producer", "website-server"]) {
      for (const key of ["ADMIN_TOKEN", "AUTOMATION_TOKEN", "ANALYTICS_TOKEN"]) {
        expect({ service, key, value: containerEnv(h.project, service, key) ?? null }).toEqual({ service, key, value: null });
      }
    }
    expect(containerEnv(h.project, "system-scheduler", "SCHEDULER_TOKEN_FILE")).toBe("/run/rm-token/token");
    expect(containerEnv(h.project, "analytics-producer", "ANALYTICS_TOKEN_FILE")).toBe("/run/rm-token/token");
    expect(containerEnv(h.project, "api", "ANALYTICS_TOKEN_FILE") ?? null).toBeNull();
  });

  test("criteria 27, 41: the receipt carries every §6.3 readiness condition as a named, passed result", () => {
    const receipt = readReceipt(h.paths)!;
    expect(receipt.readiness.map((c) => c.check)).toEqual([...READINESS_CHECKS]);
    for (const check of receipt.readiness) expect({ check: check.check, pass: check.pass }).toEqual({ check: check.check, pass: true });
    // The green-on-container-up list is gone: no readiness entry is just "healthy (compose --wait)".
    expect(JSON.stringify(receipt.readiness)).not.toContain("compose --wait");
    expect(receipt.readiness.find((c) => c.check === "scheduler-authenticated")!.detail).toContain("authenticated");
  });

  test("criterion 20: the plan is printed before the first mutation, and the journal's phase order proves it", () => {
    const out = boot.output();
    const planId = out.match(/plan id: ([0-9a-f]{64})/)?.[1];
    expect(planId).toBeDefined();
    // The printed plan comes before any preparation is narrated.
    expect(out.indexOf("plan id:")).toBeLessThan(out.indexOf("phase: prepare"));
    const journal = journalNow(h)!;
    expect(String(journal.planId)).toBe(planId!);
    const records = journal.phases;
    // `plan` is the first record, and it committed before any other record began.
    expect(records[0]?.phase).toBe("plan");
    expect(records[0]?.status).toBe("committed");
    for (const later of records.slice(1)) expect(Date.parse(later.startedAt)).toBeGreaterThanOrEqual(Date.parse(records[0]!.endedAt!));
    // Every §1.3 phase, in order, each committed.
    const order = records.map((r) => DEPLOYMENT_PHASES.indexOf(r.phase));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect([...new Set(records.map((r) => r.phase))]).toEqual([...DEPLOYMENT_PHASES]);
    expect(records.every((r) => r.status === "committed")).toBe(true);
    // The preparation this run journaled, each separately (§1.3).
    const steps = records.filter((r) => r.phase === "prepare").map((r) => r.step);
    for (const step of ["instance", "assemble", "site", "images", "database", "migrate"]) expect(steps).toContain(step);
  });

  test("criterion 34: create, then the target lock, then every decision — the journal's preparation order", () => {
    // Spec §7: "database create/restore (local) → target lock (§2) → identity
    // matrix (§4.3) → authorized preparation → preflight → containers"; §2:
    // acquisition "After any local database is created or restored, before the
    // first read used for a decision". The `lock` record holds both the
    // acquisition (with its revalidation) and the matrix on the locked read;
    // nothing that decides anything — the bootstrap, the migrate run's gates,
    // preflight — is journaled before it.
    const records = journalNow(h)!.phases;
    const steps = records.filter((r) => r.phase === "prepare").map((r) => r.step);
    const at = (step: string) => steps.indexOf(step);
    expect(at("database")).toBeGreaterThan(at("instance"));
    expect(at("lock")).toBe(at("database") + 1);
    expect(at("bootstrap")).toBe(at("lock") + 1);
    expect(at("migrate")).toBe(at("bootstrap") + 1);
    // …and every preparation precedes preflight, which precedes replacement.
    const phases = records.map((r) => r.phase);
    expect(phases.lastIndexOf("prepare")).toBeLessThan(phases.indexOf("preflight"));
    expect(phases.indexOf("preflight")).toBeLessThan(phases.indexOf("replace"));
    // The boot said which lock it held, and whose plan.
    expect(boot.output()).toMatch(/target lock held \(smoke, plan [0-9a-f]{12}, backend pid \d+\)/);
  });

  test("criteria 76 + 70: the blank bootstrap enrolled the database as rehearsal through rm_owner, and rm_owner holds no CREATEROLE", () => {
    expect(bootQuery(h.project, "SELECT kind || '|' || written_by FROM deployment_identity")).toBe("rehearsal|rm_owner");
    // rm_owner LOGIN, never superuser, never CREATEROLE — after the bootstrap
    // AND the migrate run this boot performed as rm_owner.
    expect(bootQuery(h.project, "SELECT rolcanlogin || '|' || rolsuper || '|' || rolcreaterole FROM pg_roles WHERE rolname = 'rm_owner'")).toBe("true|false|false");
    // The ledger and the manifest were written by the bootstrap and republished by the run.
    expect(Number(bootQuery(h.project, "SELECT count(*) FROM schema_migrations"))).toBeGreaterThan(90);
    expect(bootQuery(h.project, "SELECT count(*) FROM schema_manifest")).toBe("1");
  });

  test("the api runs as rm_app and the pipeline worker as rm_worker — no container holds the local superuser", () => {
    const user = (url: string | undefined) => (url ? decodeURIComponent(new URL(url).username) : "(unset)");
    expect(user(containerEnv(h.project, "api", "DATABASE_URL"))).toBe("rm_app");
    expect(user(containerEnv(h.project, "worker-analytics", "DATABASE_URL"))).toBe("rm_worker");
    expect(user(containerEnv(h.project, "worker-analytics", "WORKER_DATABASE_URL"))).toBe("rm_worker");
    for (const service of ["api", "worker-analytics", "worker-research", "system-scheduler", "analytics-producer", "website-server"]) {
      for (const key of ["DATABASE_URL", "WORKER_DATABASE_URL", "MIGRATE_DATABASE_URL"]) {
        const value = containerEnv(h.project, service, key);
        if (value) expect({ service, key, user: user(value) }).not.toEqual({ service, key, user: "robotmoney" });
      }
    }
  });

  test("(44, smoke half) the receipt's preflight is the full §7 registry — all seven checks, each passed", () => {
    const receipt = readReceipt(h.paths)!;
    const checks = receipt.preflight.map((c) => c.check);
    expect([...checks].sort()).toEqual(
      ["env_credentials", "env_identity", "privileges", "roles_authenticate", "schema_compatibility", "schema_integrity", "subject_scheduling"].sort(),
    );
    for (const check of receipt.preflight) expect({ check: check.check, pass: check.pass }).toEqual({ check: check.check, pass: true });
    expect(boot.output()).toContain("phase: preflight");
  });

  test("criterion 14: the printed plan holds no role password, owner password, service token or participant key", () => {
    const plan = printedPlan();
    // The roster WAS read — the plan carries it by name and fingerprint.
    expect(plan).toContain("agent: athena role member key fp:");
    expect(plan).toContain("judge: themis role judge key fp:");
    expect(serviceTokens.length).toBe(3);
    const secrets = {
      ...Object.fromEntries(Object.entries(ROLE_PASSWORDS).map(([k, v]) => [`role password ${k}`, v])),
      "participant bearer": PARTICIPANT.bearer,
      "participant model key": PARTICIPANT.modelKey,
      "participant private key": PARTICIPANT.privateD,
      "judge bearer": JUDGE.bearer,
      "judge model key": JUDGE.modelKey,
      "judge private key": JUDGE.privateD,
      ...Object.fromEntries(serviceTokens.map((t, i) => [`service token ${i}`, t])),
    };
    for (const [kind, secret] of Object.entries(secrets)) {
      expect({ kind, printed: plan.includes(secret) }).toEqual({ kind, printed: false });
    }
    // Nor did the journal or the receipt persist one.
    const persisted = `${readFileSync(h.paths.journalFile, "utf8")}${readFileSync(h.paths.receiptFile, "utf8")}`;
    for (const [kind, secret] of Object.entries(secrets)) {
      expect({ kind, persisted: persisted.includes(secret) }).toEqual({ kind, persisted: false });
    }
  });

  test("criterion 14, boot-level red control: a planted shapeless secret in a plan-carried value makes the REAL boot refuse before it prepares", () => {
    // The plan's ANALYTICS_FLOOR_SEED is set equal to a saved role password,
    // and separately to the saved OWNER password (rm_owner): both shapeless,
    // so only the by-value list can catch them. If the boot's by-value secret
    // list did not reach computePlanId, the plan would be printed, hashed and
    // journaled with the secret in it.
    //
    // NOT driven here: the TYPED owner password. It exists only on the remote
    // path, where `--migrate` prompts for it on a terminal and verifies it
    // against a reachable server before the plan is built; a shell
    // MIGRATE_DATABASE_URL is dropped at the top of every boot, so it is not a
    // run secret at all (smoke-compose-env.ts dropShellMigrationCredential).
    const cases: Array<{ what: string; secret: string; env: Record<string, string> }> = [
      { what: "saved role password (rm_app)", secret: ROLE_PASSWORDS.rm_app, env: {} },
      { what: "saved owner password (rm_owner)", secret: ROLE_PASSWORDS.rm_owner, env: {} },
    ];
    for (const c of cases) {
      const r = harness("redctl");
      try {
        const paths = instancePaths(r.root, r.instance, { create: true });
        writeFileSync(paths.rolePasswordsFile, JSON.stringify(ROLE_PASSWORDS), { mode: 0o600 });
        chmodSync(paths.rolePasswordsFile, 0o600);
        const proc = Bun.spawnSync(bootArgs(r, ["--credentials", r.emptyRoster]), {
          cwd: repoRoot,
          // A dead daemon: were the refusal ever lost, the boot fails at its
          // Docker check (visibly past "phase: prepare") instead of leaving a
          // real stack running behind a red test.
          env: { ...r.env, ...c.env, ANALYTICS_FLOOR_SEED: c.secret, DOCKER_HOST: "tcp://127.0.0.1:1" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
        expect({ what: c.what, code: proc.exitCode === 0 ? 0 : "non-zero" }).toEqual({ what: c.what, code: "non-zero" });
        expect({ what: c.what, refused: out.includes("contains one of this run's secrets") }).toEqual({ what: c.what, refused: true });
        expect({ what: c.what, prepared: out.includes("phase: prepare") }).toEqual({ what: c.what, prepared: false });
        expect({ what: c.what, printed: out.includes(c.secret) }).toEqual({ what: c.what, printed: false });
        expect(existsSync(paths.journalFile)).toBe(false);
      } finally {
        rmSync(r.root, { recursive: true, force: true });
      }
    }
  }, 120_000);

  test("red control: these secrets have no shape — the heuristic alone would pass a plan that carried one", () => {
    const receipt = readReceipt(h.paths)!;
    const leaky: DeploymentPlan = { ...receipt.plan, configuration: { ...receipt.plan.configuration, NOTE: ROLE_PASSWORDS.rm_app } };
    expect(() => assertPlanRedacted(leaky)).not.toThrow();
    expect(() => assertPlanRedacted(leaky, { secrets: [ROLE_PASSWORDS.rm_app] })).toThrow(/contains one of this run's secrets/);
  });

  test("criterion 40: every state file is under the instance directory, and the checkout's .agents/ is untouched", () => {
    for (const file of [h.paths.journalFile, h.paths.receiptFile, h.paths.stackStateFile, h.paths.logFile, ...Object.values(h.paths.tokenFiles)]) {
      expect({ file, exists: existsSync(file) }).toEqual({ file, exists: true });
    }
    expect(existsSync(join(h.paths.webDir, "current"))).toBe(true);
    expect(listTree(join(repoRoot, ".agents"))).toEqual(agentsBefore);
    // …and the boot released its deployment lock on exit.
    expect(existsSync(h.paths.lockFile)).toBe(false);
  });

  test("criterion 26: while the run was in progress a second process observed it through smoke:status and smoke:tui", () => {
    expect(duringStatus.code).toBe(0);
    expect(duringStatus.out).toContain("source: journal — this deployment is IN PROGRESS or was interrupted");
    expect(duringStatus.out).toMatch(/a run is IN PROGRESS: pid \d+ holds the deployment lock/);
    expect(duringTui.code).toBe(0);
    expect(duringTui.out).toContain("source: journal — this deployment is IN PROGRESS or was interrupted");
    expect(duringTui.out).toContain("run in progress: yes");
  });

  test("criterion 26: on a terminal, the boot drew no TUI — no alternate screen, no cursor games", () => {
    const out = boot.output();
    expect(out).toContain("READY");
    // No alternate screen and no absolute cursor positioning: nothing repaints.
    // (Docker's own build/up progress, inherited on the same terminal, may hide
    // the cursor while it animates a line; that is the child's output, not a
    // TUI of the boot's.)
    expect(out).not.toContain("\x1b[?1049h");
    expect(out).not.toMatch(/\x1b\[\d+;\d+H/);
    // Every orchestrator line is a plain line.
    for (const line of out.split(/\r?\n/).filter((l) => /^(phase:|READY|── plan ──)/.test(l))) {
      expect(line.includes("\x1b[")).toBe(false);
    }
  });

  test("criterion 29: smoke:status reads the receipt back — plan id, schema identity, preflight results", () => {
    const receipt = readReceipt(h.paths)!;
    const status = runCommand(h, "smoke-status.ts", ["--instance", h.instance]);
    expect(status.code).toBe(0);
    expect(status.out).toContain(`source: receipt (HISTORY) — reached readiness under plan ${receipt.planId}`);
    const tail = receipt.schema.migrations.at(-1)!;
    expect(status.out).toContain(`schema: manifest ${receipt.schema.manifestHash}; ${receipt.schema.migrations.length} migration(s), ending ${tail}`);
    expect(receipt.preflight.length).toBeGreaterThan(0);
    for (const check of receipt.preflight) {
      expect(status.out).toContain(`preflight ${check.check}: ${check.pass ? "pass" : "FAIL"} (${check.detail})`);
    }
    const tui = runCommand(h, "smoke-tui.ts", ["--instance", h.instance, "--once"]);
    expect(tui.out).toContain("source: receipt — this deployment FINISHED");
  });
});
