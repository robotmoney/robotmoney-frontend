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
//   (25, stack half) `bun smoke` exits 0 at readiness and the stack outlives it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPlanRedacted, DEPLOYMENT_PHASES, readReceipt, type DeploymentPlan } from "../../lib/smoke-journal.ts";
import { instancePaths } from "../../lib/smoke-state.ts";
import {
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
  serviceTokens = [
    containerEnv(h.project, "api", "ADMIN_TOKEN"),
    containerEnv(h.project, "api", "AUTOMATION_TOKEN"),
    existsSync(h.paths.tokenFiles["analytics-producer"]) ? readFileSync(h.paths.tokenFiles["analytics-producer"], "utf8").trim() : undefined,
  ].filter((t): t is string => typeof t === "string" && t.length > 0);
}, BOOT_TIMEOUT_MS);

afterAll(() => {
  if (h) teardown(h, boot);
}, 300_000);

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
    for (const service of ["postgres", "api", "website-server", "system-scheduler"]) {
      expect({ service, alive: ["running", "restarting"].includes(containersAfterExit[service] ?? "absent") }).toEqual({ service, alive: true });
    }
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

  test("red control: these secrets have no shape — the heuristic alone would pass a plan that carried one", () => {
    const receipt = readReceipt(h.paths)!;
    const leaky: DeploymentPlan = { ...receipt.plan, configuration: { ...receipt.plan.configuration, NOTE: ROLE_PASSWORDS.rm_app } };
    expect(() => assertPlanRedacted(leaky)).not.toThrow();
    expect(() => assertPlanRedacted(leaky, { secrets: [ROLE_PASSWORDS.rm_app] })).toThrow(/contains one of this run's secrets/);
  });

  test("criterion 40: every state file is under the instance directory, and the checkout's .agents/ is untouched", () => {
    for (const file of [h.paths.journalFile, h.paths.receiptFile, h.paths.stackStateFile, h.paths.logFile, h.paths.tokenFiles["analytics-producer"]]) {
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
    expect(status.out).toContain(`source: receipt — reached readiness under plan ${receipt.planId}`);
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
