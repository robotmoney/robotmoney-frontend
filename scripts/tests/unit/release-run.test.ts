// scripts/tests/unit/release-run.test.ts — `bun run release:run` (D61), the
// agent-executed runbook runner (scripts/release/).
//
// What is pinned, each with a red control:
//   - the target schema: both committed targets are valid; an unknown key, a
//     release commit or tag pin, a secret boot setting and a prod target on
//     another instance refuse;
//   - D61 rule 2: the step list is one list, and its hash is the same for
//     stage and prod; the rendered commands differ only by target values;
//   - D61 rule 1: the go file must name this release and target, and its
//     commit is the one source of every {commit};
//   - SP.8: prod refuses without a passed stage journal of the same step-list
//     hash at the same commit;
//   - resume: a failed run prints the resume command, and `--from` runs that
//     step onward and nothing before it;
//   - secret scrubbing of output, receipts and journals;
//   - the env rewrite's key partition, the baseline comparison, the host guards.
// Nothing here opens an ssh connection: the runner's exec is injected.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateGo } from "../../release/go.ts";
import { checkResume, checkStageJournal, runStatus, selectSteps, type RunJournal } from "../../release/journal.ts";
import { lineScrubber, scrubSecrets, forbiddenReceiptPath } from "../../release/scrub.ts";
import { REMOTE_PATH, RELEASE_STEPS, fill, renderStep, stepIds, stepListHash, templateValues, type StepTemplate } from "../../release/steps.ts";
import { CONFIRM_TARGET_PLACEHOLDER, loadTarget, validateTarget } from "../../release/target.ts";
import { COMMIT_FROM_GO, parseArgs, receiptPathsInOutput, runRelease, type RunnerDeps } from "../../release/run.ts";
import { partitionEnv } from "../../release/env-rewrite.ts";
import { compareBaseline } from "../../release/compare-baseline.ts";
import { exposesPostgresUrl, keysOutsideAllowlist, othersCanTraverse, scanForPostgresUrls, socketMounts, tokenFileProblems } from "../../release/host-guards.ts";
import { composeDownArgv, partitionLegacyEnv, retiredPath } from "../../release/stop-legacy.ts";
import { nextRcTag, rcTagsAt } from "../../release/tag.ts";
import { epochProblems, inFlightProblems, paritySweep, regimeCronProblems } from "../../release/schedule-parity.ts";
import { baselineProblems, WOULD_CLEAR_SQL } from "../../release/baseline.ts";
import { identityProblems } from "../../release/identity-check.ts";
import { IDENTITY_MIGRATION, preconditionProblems } from "../../release/precondition.ts";
import { D61_ENV_ALLOWLIST, D61_REQUIRED_KEYS, PRE_CUTOVER_REQUIRED_KEYS, RUN_WRITTEN_KEYS, confirmTargetOf, preCutoverKeyProblems } from "../../release/env-keys.ts";
import { SUPPORTED_RELEASES } from "../../../backend/src/db/supported-releases.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const targetsDir = join(repoRoot, "scripts", "release", "targets");
const SHA = "a502de30068e0c1cc2e232a76098364e0b709033";
const OTHER_SHA = "0".repeat(40);

// preflight.ts loads the backend config at import, so its check 4 list is read from the source text.
const ENV_FILE_ALLOWED_KEYS: string[] = (() => {
  const src = readFileSync(join(repoRoot, "backend", "src", "db", "preflight.ts"), "utf8");
  const body = /ENV_FILE_ALLOWED_KEYS: readonly string\[\] = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src)![1]!;
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
})();

const prodRaw = () => JSON.parse(readFileSync(join(targetsDir, "prod.json"), "utf8")) as Record<string, unknown>;

describe("target schema", () => {
  test("the committed prod and stage targets are valid", () => {
    const prod = loadTarget(join(targetsDir, "prod.json"));
    const stage = loadTarget(join(targetsDir, "stage.json"));
    expect(prod.rmEnv).toBe("prod");
    expect(prod.host).toBe("rm-frontend-prod-1");
    expect(prod.checkout).toBe("/root/rm-060");
    expect(prod.instance).toBe("rm_prod");
    expect(prod.legacy.checkout).toBe("/root/robotmoney-frontend");
    expect(prod.legacy.tmuxSession).toBe("driver");
    expect(prod.capture.host).toBe("rm-frontend-stage-2");
    expect(prod.confirmTarget).not.toBe(CONFIRM_TARGET_PLACEHOLDER);
    expect(prod.confirmTarget).toMatch(/^[a-z0-9.-]+:25060\/defaultdb$/);
    expect(stage.rmEnv).toBe("stage");
    expect(stage.home).toBe("/home/stage-server/stage-target");
    expect(stage.instance).toBe("stage_target");
    expect(stage.checkout).toBe("/home/stage-server/rm-stage-target");
    expect(stage.legacy.checkout).toBe("/home/stage-server/rm-stage-legacy");
    expect(stage.legacy.tmuxSession).toBe("stage-driver");
  });

  test("red: an unknown key refuses, top level and nested", () => {
    const top = { ...prodRaw(), drainFirst: true };
    expect(validateTarget("prod", top)).toEqual({ errors: ['prod: unknown key "drainFirst"'] });
    const nested = prodRaw();
    (nested.legacy as Record<string, unknown>).volumes = "-v";
    const r = validateTarget("prod", nested);
    expect("errors" in r && r.errors.join()).toContain('prod.legacy: unknown key "volumes"');
  });

  test("a target names no release commit: the go file is its one source", () => {
    expect(prodRaw()).not.toHaveProperty("commit");
    expect(prodRaw()).not.toHaveProperty("tag");
    expect(loadTarget(join(targetsDir, "stage.json"))).not.toHaveProperty("commit");
    // the legacy stack's commit stays: it is the old stack, not the release.
    expect(loadTarget(join(targetsDir, "prod.json")).legacy.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("red: a commit or tag pin, a prod target on another instance, a secret boot setting", () => {
    const bad = (patch: Record<string, unknown>) => validateTarget("prod", { ...prodRaw(), ...patch });
    expect(bad({ commit: SHA })).toEqual({ errors: ['prod: "commit" is not a target key; the release commit comes from the go file\'s commit: line'] });
    expect("errors" in bad({ tag: "v0.6.0" })).toBe(true);
    expect("errors" in bad({ instance: "stage_target" })).toBe(true);
    expect("errors" in bad({ bootEnv: { BASE_RPC_URL: "https://x" } })).toBe(true);
    expect("errors" in bad({ confirmTarget: "not a target" })).toBe(true);
    expect("errors" in bad({ checkout: "relative/path" })).toBe(true);
    // green control: a filled confirmTarget and a plain boot setting pass.
    expect("target" in bad({ confirmTarget: "db.example.com:25060/defaultdb", bootEnv: { WEBAUTHN_RP_ID: "robotmoney.network" } })).toBe(true);
  });
});

describe("one step list for every target (D61 rule 2)", () => {
  const prod = loadTarget(join(targetsDir, "prod.json"));
  const stage = loadTarget(join(targetsDir, "stage.json"));

  test("the hash is the same for stage and prod, and the list covers the runbook ids", () => {
    expect(stepListHash()).toMatch(/^[0-9a-f]{64}$/);
    const ids = stepIds();
    for (const id of ["R1.1", "R2.1", "R2.3", "R2.5", "R6.1", "R6.2", "R6.3", "S8.1", "R6.4", "R6.5", "R6.7a", "R6.7c", "R6.7d", "R6.10", "R7.1", "R7.3", "R7.3a", "R7.3b", "R7.5", "R7.7"]) {
      expect(ids).toContain(id);
    }
    expect(ids.indexOf("S8.1")).toBe(ids.indexOf("R6.3") + 1);
    expect(RELEASE_STEPS.filter((s) => s.irreversible).map((s) => s.id)).toEqual(["R6.1", "R6.3", "R6.7c"]);
  });

  test("the rendered commands differ only by the target's values", () => {
    // Drop every word that carries a target value (and every env assignment);
    // what is left is the commands' shape, which must be the same for both.
    const shape = (t: typeof prod, steps: readonly StepTemplate[] = RELEASE_STEPS) => {
      const values = templateValues(t, SHA, "20261008T000000Z");
      const own = [...Object.entries(values).filter(([k]) => k !== "target" && k !== "release").map(([, v]) => v), t.host, t.capture.host]
        .filter((v) => v.length >= 3);
      const carriesValue = (w: string) => /^[A-Z_]+=/.test(w) || /robotmoney-release\/|rm-backup-/.test(w) || own.some((v) => w.includes(v));
      return steps.map((s) => renderStep(s, t, values).remote.split(" && ").map((seg) => seg.split(" ").filter((w) => !carriesValue(w)).join(" ")));
    };
    expect(shape(prod)).toEqual(shape(stage));
    // red control: a list that adds one flag for one target is caught.
    const forked = RELEASE_STEPS.map((s) => (s.id === "R6.3" ? { ...s, cmds: [[...s.cmds[0]!, "--skip-identity"]] } : s));
    expect(shape(prod, forked)).not.toEqual(shape(stage));
  });

  test("red: changing the list changes the hash; an unknown placeholder throws", () => {
    const dropped = RELEASE_STEPS.filter((s) => s.id !== "R2.5");
    expect(stepListHash(dropped)).not.toBe(stepListHash());
    const reordered = [RELEASE_STEPS[1]!, RELEASE_STEPS[0]!, ...RELEASE_STEPS.slice(2)];
    expect(stepListHash(reordered)).not.toBe(stepListHash());
    expect(() => fill("bun x --db {databse}", templateValues(prod, SHA, "20261008T000000Z"))).toThrow("{databse}");
  });

  test("every remote command starts under env -i with HOME, the fixed PATH and LANG; no step carries a secret or -v", () => {
    const values = templateValues(prod, SHA, "20261008T000000Z");
    for (const s of RELEASE_STEPS) {
      const r = renderStep(s, prod, values);
      expect(r.remote).toContain("cd ");
      expect(r.remote).not.toMatch(/(^|\s)-v(\s|$)|--volumes|rm_owner=|doadmin=|PGPASSWORD|DATABASE_/);
      if (s.host === "control") continue;
      const commands = r.remote.split(" && ").filter((c) => c.startsWith("env "));
      expect(commands.length).toBe(s.cmds.length);
      for (const c of commands) {
        expect(c.startsWith(`env -i HOME=${s.host === "capture" ? prod.capture.home : prod.home} PATH=${REMOTE_PATH} LANG=C.UTF-8 `)).toBe(true);
      }
    }
  });

  test("a rendered command never inherits DATABASE_*: run it under a polluted environment", () => {
    const step: StepTemplate = { id: "X", standing: [], description: "x", host: "target", cmds: [["sh", "-c", "env"]], expectExit: 0, receipts: [], irreversible: false };
    const scratch = mkdtempSync(join(tmpdir(), "release-env-"));
    const t = { ...prod, home: scratch, checkout: scratch };
    const r = renderStep(step, t, templateValues(t, SHA, "20261008T000000Z"));
    const polluted = { ...process.env, DATABASE_URL: "postgres://doadmin:x@h/d", DATABASE_PASSWORD: "x" };
    const out = spawnSync("sh", ["-c", r.remote], { env: polluted, encoding: "utf8" });
    expect(out.status).toBe(0);
    expect(out.stdout).not.toContain("DATABASE_");
    expect(out.stdout).toContain(`HOME=${scratch}`);
    expect(out.stdout).toContain("RM_ENV=prod");
    // red control: the same command without env -i inherits it.
    const leaky = spawnSync("sh", ["-c", r.remote.replace(/env -i /g, "env ")], { env: polluted, encoding: "utf8" });
    expect(leaky.stdout).toContain("DATABASE_URL=");
  });

  test("the prod-only tags are data: the hash is shared, and dropping onlyFor changes it", () => {
    const tags = RELEASE_STEPS.filter((s) => s.onlyFor === "prod").map((s) => s.id);
    expect(tags).toEqual(["R5.rc", "W3"]);
    expect(RELEASE_STEPS.filter((s) => s.host === "control").map((s) => s.id)).toEqual(["R5.rc", "W3"]);
    const unmarked = RELEASE_STEPS.map((s) => (s.id === "W3" ? { ...s, onlyFor: undefined } : s));
    expect(stepListHash(unmarked)).not.toBe(stepListHash());
    const ids = stepIds();
    expect(ids.indexOf("R5.rc")).toBe(ids.indexOf("R6.1") - 1);
    expect(ids.indexOf("R2.4r")).toBe(ids.indexOf("R2.2") + 1);
    expect(ids.slice(-3)).toEqual(["W1", "R7.4a", "W3"]);
    expect(RELEASE_STEPS.filter((s) => s.notBefore).map((s) => [s.id, s.notBefore!.afterStep, s.notBefore!.hours])).toEqual([["W1", "R6.9", "watchHours"], ["R7.4a", "R6.9", "watchHours"]]);
    // red control: W1 must grade sessions (no --defer-sessions) since READY.
    const w1 = RELEASE_STEPS.find((s) => s.id === "W1")!.cmds[0]!;
    expect(w1).not.toContain("--defer-sessions");
    expect(w1).toContain("{readyIso}");
  });
});

describe("R2.5 grades the legacy stack with the legacy checkout's own gate", () => {
  test("it runs from the legacy checkout, with HOME and no RM_ENV, on both targets", () => {
    for (const t of [loadTarget(join(targetsDir, "prod.json")), loadTarget(join(targetsDir, "stage.json"))]) {
      const r = renderStep(RELEASE_STEPS.find((s) => s.id === "R2.5")!, t, templateValues(t, SHA, "20261008T000000Z"));
      expect(r.remote).toContain(`cd ${t.legacy.checkout} && env -i HOME=${t.home} PATH=${REMOTE_PATH} LANG=C.UTF-8 bun run prod:gate --mode baseline --state-file ${t.legacy.checkout}/.agents/smoke-state.json`);
      expect(r.remote).not.toContain("RM_ENV=");
    }
  });
  test("red: every other target step runs from the release checkout", () => {
    const t = loadTarget(join(targetsDir, "prod.json"));
    const values = templateValues(t, SHA, "20261008T000000Z");
    for (const s of RELEASE_STEPS.filter((x) => x.host === "target" && x.id !== "R2.5")) {
      expect(renderStep(s, t, values).remote).toContain(`cd ${t.checkout} && `);
    }
  });
});

describe("the target precondition (R1.2)", () => {
  const baseline = SUPPORTED_RELEASES[0]!.migrations;
  test("a supported ledger with no identity row passes on both policies", () => {
    expect(preconditionProblems({ rmEnv: "prod", ledger: baseline, identity: null })).toEqual([]);
    expect(preconditionProblems({ rmEnv: "stage", ledger: baseline, identity: null })).toEqual([]);
  });
  test("a stage twin with 0081 and identity rehearsal passes", () => {
    expect(preconditionProblems({ rmEnv: "stage", ledger: [...baseline, IDENTITY_MIGRATION], identity: "rehearsal" })).toEqual([]);
  });
  test("red: the wrong identity, an unsupported ledger, 0081 without a row, no RM_ENV", () => {
    expect(preconditionProblems({ rmEnv: "prod", ledger: baseline, identity: "rehearsal" }).join()).toContain("rehearsal");
    expect(preconditionProblems({ rmEnv: "stage", ledger: baseline, identity: "production" }).join()).toContain("production");
    expect(preconditionProblems({ rmEnv: "prod", ledger: baseline.slice(1), identity: null }).join()).toContain("no supported baseline");
    expect(preconditionProblems({ rmEnv: "prod", ledger: [...baseline, IDENTITY_MIGRATION], identity: null }).join()).toContain("no supported baseline");
    expect(preconditionProblems({ rmEnv: undefined, ledger: baseline, identity: null }).length).toBe(1);
  });
});

describe("the go file (D61 rule 1)", () => {
  const expected = { release: "v0.6.0", target: "prod" };
  const good = `# owner go, 2026-10-08\nrelease: v0.6.0\ncommit: ${SHA}\ntarget: prod\nrecovery: /root/recovery-matrix-v0.6.0.signed.md\noperator: lucas\n`;

  test("a go naming this release and target passes, with its hash; its commit is the run's commit", () => {
    const r = validateGo(good, expected);
    expect("go" in r && r.go.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect("go" in r && r.go.commit).toBe(SHA);
    const other = validateGo(good.replace(SHA, OTHER_SHA), expected);
    expect("go" in other && other.go.commit).toBe(OTHER_SHA);
  });

  test("red: another target or release; an unknown or missing key; a short sha", () => {
    expect(validateGo(good.replace(/commit: .*\n/, ""), expected)).toEqual({ errors: ["the go names no commit"] });
    expect("errors" in validateGo(good.replace("target: prod", "target: stage"), expected)).toBe(true);
    expect("errors" in validateGo(good.replace("v0.6.0", "v0.6.1"), expected)).toBe(true);
    expect("errors" in validateGo(`${good}skip: R2.5\n`, expected)).toBe(true);
    expect("errors" in validateGo(good.replace(/target: prod\n/, ""), expected)).toBe(true);
    expect("errors" in validateGo(good.replace(SHA, "a502de30"), expected)).toBe(true);
    // SC.1: no recovery matrix, or a recovery that is neither a path nor a sha.
    expect(validateGo(good.replace(/recovery: .*\n/, ""), expected)).toEqual({ errors: ["the go names no recovery"] });
    expect("errors" in validateGo(good.replace(/recovery: .*\n/, "recovery: signed\n"), expected)).toBe(true);
    expect("go" in validateGo(good.replace(/recovery: .*\n/, `recovery: ${"a".repeat(64)}\n`), expected)).toBe(true);
  });
});

function journal(patch: Partial<RunJournal> = {}): RunJournal {
  const ids = stepIds();
  return {
    version: 1, target: "stage", rmEnv: "stage", release: "v0.6.0", commit: SHA, stepListHash: stepListHash(), stepIds: ids,
    goSha256: "g", runTs: "20261008T000000Z", startedAt: "", updatedAt: "", status: "passed",
    steps: Object.fromEntries(ids.map((id) => [id, { id, status: "ok", exit: 0, expectExit: 0, startedAt: "", receipts: [], attempt: 1 }])),
    ...patch,
  } as RunJournal;
}

describe("SP.8: prod runs only what stage passed", () => {
  const expected = { stepListHash: stepListHash(), commit: SHA, stepIds: stepIds() };

  test("a passed stage journal at the same commit and hash lets prod start", () => {
    expect(checkStageJournal(journal(), expected)).toEqual([]);
  });

  test("red: missing, another hash, another commit, a failed step, a prod journal", () => {
    expect(checkStageJournal(undefined, expected).join()).toContain("no stage run journal");
    expect(checkStageJournal(journal({ stepListHash: "f".repeat(64) }), expected).join()).toContain("step list");
    expect(checkStageJournal(journal({ commit: OTHER_SHA }), expected).join()).toContain("commit");
    const failed = journal();
    failed.steps["R6.3"]!.status = "failed";
    expect(checkStageJournal(failed, expected).join()).toContain("did not pass");
    const missingStep = journal();
    delete missingStep.steps["R7.7"];
    expect(checkStageJournal(missingStep, expected).join()).toContain("R7.7");
    expect(checkStageJournal(journal({ rmEnv: "prod" }), expected).join()).toContain("not a stage run");
  });
});

describe("step selection and resume rules", () => {
  const ids = ["A", "B", "C"];
  test("--from and --only select; unknown ids refuse", () => {
    expect(selectSteps(ids, {})).toEqual(ids);
    expect(selectSteps(ids, { from: "B" })).toEqual(["B", "C"]);
    expect(selectSteps(ids, { only: "C" })).toEqual(["C"]);
    expect(() => selectSteps(ids, { from: "Z" })).toThrow();
  });
  test("red: a resume that skips a step that is not ok refuses", () => {
    const j = journal();
    j.steps["R2.3"]!.status = "failed";
    const exp = { target: "stage", commit: SHA, stepListHash: stepListHash(), goSha256: "g", stepIds: stepIds() };
    expect(checkResume(j, exp, { from: "R2.3" })).toEqual([]);
    expect(checkResume(j, exp, { from: "R2.5" }).join()).toContain("R2.3");
    expect(checkResume(j, { ...exp, goSha256: "other" }, { from: "R2.3" }).join()).toContain("go");
    expect(runStatus(j, stepIds())).toBe("failed");
  });
  test("--from needs --run", () => {
    expect(parseArgs(["--target", "stage", "--from", "R6.3"])).toHaveProperty("error");
    expect(parseArgs(["--target", "stage", "--from", "R6.3", "--run", "20261008T000000Z"])).not.toHaveProperty("error");
  });
});

// ── the runner, end to end, against an injected exec ──────────────────────────
const TINY: StepTemplate[] = [
  { id: "T1", standing: [], description: "one", host: "target", cmds: [["echo", "{instance}"]], expectExit: 0, receipts: [], irreversible: false },
  { id: "T2", standing: [], description: "two", host: "target", cmds: [["echo", "two"]], expectExit: 0,
    receipts: [{ dir: "{home}/r", pattern: "receipt.json", required: true }], irreversible: true },
  { id: "T3", standing: [], description: "three", host: "capture", cmds: [["echo", "three"]], expectExit: 0, receipts: [], irreversible: false },
];

function fixture(rmEnv: "stage" | "prod" = "stage") {
  const dir = mkdtempSync(join(tmpdir(), "release-run-"));
  const raw = rmEnv === "prod" ? prodRaw() : JSON.parse(readFileSync(join(targetsDir, "stage.json"), "utf8"));
  raw.confirmTarget = "db.example.com:25060/rm";
  const name = rmEnv === "prod" ? "prod" : "stage";
  const targetFile = join(dir, `${name}.json`);
  writeFileSync(targetFile, JSON.stringify(raw));
  const goFile = join(dir, "go.txt");
  const recovery = join(dir, "recovery-matrix.md");
  writeFileSync(recovery, "signed recovery matrix\n");
  writeFileSync(goFile, `release: v0.6.0\ncommit: ${SHA}\ntarget: ${name}\nrecovery: ${recovery}\n`);
  return { dir, targetFile, goFile, journalRoot: join(dir, "journal") };
}

function fakeDeps(opts: { fail?: Set<string>; out?: string; receipt?: string } = {}) {
  const ran: string[] = [];
  const logs: string[] = [];
  const deps: RunnerDeps = {
    async exec(_host, remote, onStdout) {
      const id = (/\.step-([A-Za-z0-9.]+)/.exec(remote) ?? /echo ([A-Za-z0-9.]+)$/.exec(remote))![1]!;
      ran.push(id);
      if (opts.out) {
        onStdout(opts.out.slice(0, 7));
        onStdout(opts.out.slice(7));
      }
      return opts.fail?.has(id) ? 1 : 0;
    },
    async collect(_host, remote) {
      if (remote.startsWith("find ")) return { code: 0, stdout: opts.receipt === undefined ? "" : "/remote/r/receipt.json\n" };
      if (remote.startsWith("cat ")) return { code: 0, stdout: opts.receipt ?? "" };
      return { code: 1, stdout: "" };
    },
    readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
    now: () => new Date("2026-10-08T12:00:00Z"),
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
    home: "/nonexistent",
  };
  return { deps, ran, logs };
}

describe("runRelease", () => {
  test("refuses without a go file, and with a go for another target; --dry-run needs none", async () => {
    const f = fixture();
    const a = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--journal-root", f.journalRoot], a.deps, TINY)).toBe(2);
    expect(a.ran).toEqual([]);
    expect(a.logs.join("\n")).toContain("no --go");
    writeFileSync(f.goFile, `release: v0.6.0\ncommit: ${SHA}\ntarget: prod\nrecovery: ${join(f.dir, "recovery-matrix.md")}\n`);
    const b = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], b.deps, TINY)).toBe(2);
    expect(b.ran).toEqual([]);
    const c = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--dry-run"], c.deps, TINY)).toBe(0);
    expect(c.ran).toEqual([]);
    expect(c.logs.join("\n")).toContain("ssh -T rm-frontend-stage-2");
  });

  test("the go's commit is rendered into every {commit}; a dry run without a go renders the placeholder", async () => {
    const CHECKOUT: StepTemplate[] = [
      { id: "C1", standing: [], description: "detach", host: "target", cmds: [["checkout", "--detach", "{commit}"]], expectExit: 0, receipts: [], irreversible: false },
    ];
    const f = fixture();
    const a = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--dry-run"], a.deps, CHECKOUT)).toBe(0);
    expect(a.logs.join("\n")).toContain(`--detach ${COMMIT_FROM_GO}`);
    expect(a.logs.join("\n").split("\n").filter((l) => l.includes("--detach")).join()).not.toMatch(/[0-9a-f]{40}/);
    writeFileSync(f.goFile, `release: v0.6.0\ncommit: ${OTHER_SHA}\ntarget: stage\nrecovery: ${join(f.dir, "recovery-matrix.md")}\n`);
    const b = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--dry-run"], b.deps, CHECKOUT)).toBe(0);
    expect(b.logs.join("\n")).toContain(`--detach ${OTHER_SHA}`);
    expect(b.logs.join("\n")).not.toContain(COMMIT_FROM_GO);
    // A live run journals the go's commit.
    const c = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], c.deps, CHECKOUT)).toBe(0);
    const j = JSON.parse(readFileSync(join(f.journalRoot, "stage", "20261008T120000Z", "run.json"), "utf8")) as RunJournal;
    expect(j.commit).toBe(OTHER_SHA);
  });

  test("red: a placeholder confirmTarget refuses a live run", async () => {
    const f = fixture();
    const raw = JSON.parse(readFileSync(f.targetFile, "utf8"));
    raw.confirmTarget = CONFIRM_TARGET_PLACEHOLDER;
    writeFileSync(f.targetFile, JSON.stringify(raw));
    const a = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], a.deps, TINY)).toBe(2);
    expect(a.ran).toEqual([]);
  });

  test("stops at the first failed step, prints the resume command, and --from resumes there", async () => {
    const f = fixture();
    const first = fakeDeps({ fail: new Set(["T2"]), receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], first.deps, TINY)).toBe(1);
    expect(first.ran).toEqual(["T1", "T2"]);
    const resume = first.logs.find((l) => l.includes("--from T2"));
    expect(resume).toContain("--run 20261008T120000Z");
    const runDir = join(f.journalRoot, "stage", "20261008T120000Z");
    const j1 = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunJournal;
    expect(j1.status).toBe("failed");
    expect(j1.steps.T1!.status).toBe("ok");
    expect(j1.steps.T2!.status).toBe("failed");

    const second = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z", "--from", "T2"], second.deps, TINY)).toBe(0);
    expect(second.ran).toEqual(["T2", "T3"]);
    const j2 = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunJournal;
    expect(j2.status).toBe("passed");
    expect(j2.steps.T2!.attempt).toBe(2);

    // red control: --from past a step that is not ok refuses.
    const f2 = fixture();
    const third = fakeDeps({ fail: new Set(["T1"]) });
    await runRelease(["--target", f2.targetFile, "--go", f2.goFile, "--journal-root", f2.journalRoot], third.deps, TINY);
    const fourth = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", f2.targetFile, "--go", f2.goFile, "--journal-root", f2.journalRoot, "--run", "20261008T120000Z", "--from", "T3"], fourth.deps, TINY)).toBe(2);
    expect(fourth.ran).toEqual([]);
  });

  test("red: a required receipt that never appeared fails the step", async () => {
    const f = fixture();
    const a = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], a.deps, TINY)).toBe(1);
    expect(a.ran).toEqual(["T1", "T2"]);
    expect(a.logs.join("\n")).toContain("required receipt missing");
  });

  test("secrets in output and receipts never reach the console or the journal", async () => {
    const f = fixture();
    const a = fakeDeps({ out: "rm_owner = hunter2-secret\npostgres://rm_owner:pw-secret@db:5432/x\n", receipt: '{"doadmin": "da-secret"}' });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], a.deps, TINY)).toBe(0);
    const all: string[] = [a.logs.join("\n")];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p); else all.push(readFileSync(p, "utf8"));
      }
    };
    walk(f.journalRoot);
    const text = all.join("\n");
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain("pw-secret");
    expect(text).not.toContain("da-secret");
    expect(text).toContain("rm_owner = ***");
  });

  test("SP.8 through the runner: prod refuses without a stage journal, then starts with a passed one", async () => {
    const f = fixture("prod");
    const a = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], a.deps, TINY)).toBe(2);
    expect(a.ran).toEqual([]);
    expect(a.logs.join("\n")).toContain("SP.8");

    // A passed stage run of the same tiny list at the same commit.
    const s = fixture("stage");
    const st = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", s.targetFile, "--go", s.goFile, "--journal-root", s.journalRoot], st.deps, TINY)).toBe(0);
    const stageDir = join(s.journalRoot, "stage", "20261008T120000Z");
    const b = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--stage-journal", stageDir], b.deps, TINY)).toBe(0);
    expect(b.ran).toEqual(["T1", "T2", "T3"]);

    // red control: the same stage journal does not authorize a different list.
    const c = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", join(f.dir, "j2"), "--stage-journal", stageDir], c.deps, TINY.slice(0, 2))).toBe(2);
    expect(c.ran).toEqual([]);

    // red control: a prod go at another commit than the stage run passed at refuses (SP.8).
    writeFileSync(f.goFile, `release: v0.6.0\ncommit: ${OTHER_SHA}\ntarget: prod\nrecovery: ${join(f.dir, "recovery-matrix.md")}\n`);
    const d = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", join(f.dir, "j3"), "--stage-journal", stageDir], d.deps, TINY)).toBe(2);
    expect(d.ran).toEqual([]);
    expect(d.logs.join("\n")).toContain("commit");
  });
});

describe("secret scrubbing", () => {
  test("known keys, URL passwords and bearer tokens are scrubbed", () => {
    expect(scrubSecrets("rm_owner=abc")).toBe("rm_owner=***");
    expect(scrubSecrets("export doadmin = 'x y'")).toBe("export doadmin = ***");
    expect(scrubSecrets('{"COINGECKO_API_KEY":"CG-123"}')).toBe('{"COINGECKO_API_KEY":"***"}');
    expect(scrubSecrets("postgres://rm_app:pa55@h:5432/d")).toBe("postgres://rm_app:***@h:5432/d");
    expect(scrubSecrets("Authorization: Bearer abc.def")).toBe("Authorization: ***");
    expect(scrubSecrets("sent Bearer abc.def")).toBe("sent Bearer ***");
  });
  test("red: harmless lines stay as they are", () => {
    for (const line of ["tokenValid=false", "target rm_readonly@db:5432/rm", "rm_owner login=true", "[migrate] 36 files applied"]) {
      expect(scrubSecrets(line)).toBe(line);
    }
  });
  test("a secret split across stream chunks is still scrubbed", () => {
    const s = lineScrubber();
    const out = s.push("rm_ow") + s.push("ner=sec") + s.push("ret\nnext") + s.end();
    expect(out).toBe("rm_owner=***\nnext");
  });
  test("receipt paths: names in output are found; secret files are never copied", () => {
    expect(receiptPathsInOutput("[x] receipt: /a/b.json\nreport: /c/d.md (+ .json)")).toEqual(["/a/b.json", "/c/d.md"]);
    expect(forbiddenReceiptPath("/s/rm_prod/tokens/operator/token")).toBe(true);
    expect(forbiddenReceiptPath("/root/.env.retired-20261008T000000Z")).toBe(true);
    expect(forbiddenReceiptPath("/s/rm_prod/role-passwords.json")).toBe(true);
    expect(forbiddenReceiptPath("/s/rm_prod/migrate-receipt-1.json")).toBe(false);
  });
});

describe("env rewrite key partition (R6.2)", () => {
  const text = [
    "# connection",
    "host = db.example.com",
    "port=25060",
    "database=rm",
    "sslmode=require",
    "rm_app=a", "rm_worker=w", "rm_readonly=r", "rm_owner=o", "doadmin=d",
    "RM_CREDENTIALS=/root/credential.json",
    "OPENCODE_API_KEY=z",
    "export ADMIN_TOKEN=t",
    "a bare value",
    "",
  ].join("\n");

  test("allowlisted keys and comments stay; everything else moves", () => {
    const p = partitionEnv(text);
    expect(p.keptKeys).toEqual(["host", "port", "database", "sslmode", "rm_app", "rm_worker", "rm_readonly", "rm_owner", "RM_CREDENTIALS"]);
    // A stray doadmin line moves out like any other key off the list (D61 amendment).
    expect(p.retiredKeys).toEqual(["doadmin", "OPENCODE_API_KEY", "ADMIN_TOKEN", "(line 14)"]);
    expect(p.keptText).toContain("# connection");
    expect(p.keptText).not.toContain("doadmin");
    expect(p.retiredText).toBe("doadmin=d\nOPENCODE_API_KEY=z\nexport ADMIN_TOKEN=t\na bare value\n");
    expect(p.missingRequired).toEqual([]);
  });
  test("red: a file without rm_owner or RM_CREDENTIALS reports them; doadmin is never required", () => {
    const p = partitionEnv("host=h\ndatabase=d\nrm_readonly=r\ndoadmin=x\n");
    expect(p.missingRequired).toEqual(["rm_owner", "RM_CREDENTIALS"]);
    expect(partitionEnv("host=h\ndatabase=d\nrm_owner=o\nRM_CREDENTIALS=/c\n").missingRequired).toEqual([]);
  });
  test("the rm_owner line stays through R6.2, so R6.3 (the migrate) still finds it", () => {
    const p = partitionEnv("host=h\ndatabase=d\nrm_owner=o\nRM_CREDENTIALS=/c\n");
    expect(p.keptKeys).toContain("rm_owner");
    expect(p.retiredKeys).toEqual([]);
  });
  test("the D61 allowlist is exactly preflight check 4's list: rm_owner on it, doadmin off it", () => {
    expect([...D61_ENV_ALLOWLIST].sort()).toEqual([...ENV_FILE_ALLOWED_KEYS].sort());
    expect(D61_ENV_ALLOWLIST).toContain("rm_owner");
    expect(D61_ENV_ALLOWLIST).not.toContain("doadmin");
  });
  test("the confirm target is host:port/database from ~/.env", () => {
    expect(confirmTargetOf({ host: "h", port: "25060", database: "d" })).toBe("h:25060/d");
    expect(confirmTargetOf({ host: "h", dbname: "d" })).toBe("h:5432/d");
    expect(confirmTargetOf({ host: "h" })).toBeUndefined();
  });
});

describe("baseline and comparison (R2.3, R7.5)", () => {
  const before = { counts: { swarm_sessions: 10, swarm_recommendations: 5, gone_later: 1, absent: null }, databaseSizeBytes: 1000 };
  test("growth within the size bound passes", () => {
    expect(compareBaseline(before, { counts: { swarm_sessions: 12, swarm_recommendations: 5, gone_later: 1, absent: 3 }, databaseSizeBytes: 1400 }, 1.5)).toEqual([]);
  });
  test("red: a shrunk count, a vanished table, an oversized database", () => {
    const after = { counts: { swarm_sessions: 9, swarm_recommendations: 5, absent: null }, databaseSizeBytes: 1600 };
    const p = compareBaseline(before, after, 1.5);
    expect(p.join("\n")).toContain("swarm_sessions: shrank from 10 to 9");
    expect(p.join("\n")).toContain("gone_later");
    expect(p.join("\n")).toContain("1.5x");
  });
  test("the baseline refuses an unmatched ledger and an in-house seat; it matches the supported one", () => {
    const supported = SUPPORTED_RELEASES[0]!.migrations;
    expect(baselineProblems(supported, [])).toEqual([]);
    expect(baselineProblems(supported.slice(1), []).join()).toContain("no supported baseline");
    expect(baselineProblems(supported, [{ handle: "themis" }]).join()).toContain("themis");
    expect(WOULD_CLEAR_SQL).toContain("m.handle <> ALL (ARRAY['athena','noop-analyst','robot-money','themis'])");
  });
});

describe("host guards, legacy stop and identity (R6.1, S8.1, R7.1, R7.7)", () => {
  test("a container mounting the Docker socket is named; a clean one is not", () => {
    expect(socketMounts([
      { Name: "/rm_prod-api-1", Mounts: [{ Source: "/data", Destination: "/data" }] },
      { Name: "/rm_prod-agent-1", Mounts: [{ Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" }] },
      { Name: "/rm_prod-x-1", HostConfig: { Binds: ["/run/docker.sock:/sock"] } },
    ])).toEqual(["rm_prod-agent-1", "rm_prod-x-1"]);
  });
  test("keys outside the allowlist and token files not 0600", () => {
    expect(keysOutsideAllowlist(["host", "rm_owner", "ADMIN_TOKEN"])).toEqual(["ADMIN_TOKEN"]);
    expect(tokenFileProblems([{ path: "a", mode: 0o100600 }, { path: "b", mode: 0o100644 }, { path: "c", mode: null }])).toEqual(["b is mode 644, not 600", "c is missing"]);
  });
  test("compose down never removes volumes; the retired path carries the version", () => {
    const argv = composeDownArgv("rm_prod", ["docker-compose.yml"]);
    expect(argv).toEqual(["compose", "--env-file", "/dev/null", "-p", "rm_prod", "-f", "docker-compose.yml", "down", "--remove-orphans"]);
    expect(argv).not.toContain("-v");
    expect(argv).not.toContain("--volumes");
    expect(retiredPath("/root/robotmoney-frontend/", "v0.5.4")).toBe("/root/robotmoney-frontend.v0.5.4-retired");
  });
  test("identity: the commit must be served, without +dirty", () => {
    expect(identityProblems(JSON.stringify({ api: "1.0.0", commit: SHA }), `{"commit":"${SHA}"}`, SHA)).toEqual([]);
    expect(identityProblems(JSON.stringify({ api: "1.0.0", commit: OTHER_SHA }), `{"commit":"${SHA}+dirty"}`, SHA).length).toBe(2);
    // The site stamps a short commit: a 7+ hex prefix of the release commit names it.
    expect(identityProblems(JSON.stringify({ api: "0.5.1", commit: SHA }), `{"version":"0.1.0","commit":"${SHA.slice(0, 8)}","apiRange":"^0.5.0"}`, SHA)).toEqual([]);
    // red controls: a short commit of another release, a 6-character prefix, a non-JSON body.
    expect(identityProblems(JSON.stringify({ api: "0.5.1", commit: SHA }), `{"commit":"${OTHER_SHA.slice(0, 8)}"}`, SHA)).toHaveLength(1);
    expect(identityProblems(JSON.stringify({ api: "0.5.1", commit: SHA }), `{"commit":"${SHA.slice(0, 6)}"}`, SHA)).toHaveLength(1);
    expect(identityProblems(JSON.stringify({ api: "0.5.1", commit: SHA }), `<html>${SHA}</html>`, SHA)).toHaveLength(1);
    expect(identityProblems(null, null, SHA).length).toBe(2);
  });
});

// ── the scripted watch, tags, recovery and legacy cleanup ─────────────────────
const WATCHED: StepTemplate[] = [
  { id: "R6.9", standing: [], description: "ready", host: "target", cmds: [["echo", "ready"]], expectExit: 0, receipts: [], irreversible: false },
  { id: "W1", standing: [], description: "watch", host: "target", notBefore: { afterStep: "R6.9", hours: 6 }, cmds: [["echo", "{readyIso}"]], expectExit: 0, receipts: [], irreversible: false },
  { id: "W3", standing: [], description: "tag", host: "control", onlyFor: "prod", cmds: [["echo", "W3"]], expectExit: 0, receipts: [], irreversible: false },
];

describe("watch steps, prod-only steps and the recovery go key", () => {
  test("a watch step waits for READY + 6 h, prints when it becomes runnable, and --run resumes it then", async () => {
    const f = fixture("stage");
    const early = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], early.deps, WATCHED)).toBe(3);
    expect(early.ran).toEqual(["R6.9"]);
    expect(early.logs.join("\n")).toContain("W1 becomes runnable at 2026-10-08T18:00:00.000Z");
    // red control: still early, a resume does not run it either.
    const again = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z"], again.deps, WATCHED)).toBe(3);
    expect(again.ran).toEqual([]);
    const later = fakeDeps();
    later.deps.now = () => new Date("2026-10-08T18:00:01Z");
    const seen: string[] = [];
    const exec = later.deps.exec;
    later.deps.exec = async (h, r, o, e) => { seen.push(r); return exec(h, r, o, e); };
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z"], later.deps, WATCHED)).toBe(0);
    expect(seen[0]).toContain("2026-10-08T12:00:00.000Z");
    const j = JSON.parse(readFileSync(join(f.journalRoot, "stage", "20261008T120000Z", "run.json"), "utf8")) as RunJournal;
    expect(j.status).toBe("passed");
    expect(j.steps.W3!.status).toBe("skipped");
    expect(j.steps.W3!.skipped).toBe("stage");
    expect(j.recovery?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a prod-only step runs on prod; a stage journal with it skipped still satisfies SP.8", async () => {
    const s = fixture("stage");
    const st = fakeDeps();
    st.deps.now = () => new Date("2026-10-08T12:00:00Z");
    await runRelease(["--target", s.targetFile, "--go", s.goFile, "--journal-root", s.journalRoot], st.deps, WATCHED);
    const st2 = fakeDeps();
    st2.deps.now = () => new Date("2026-10-08T19:00:00Z");
    expect(await runRelease(["--target", s.targetFile, "--go", s.goFile, "--journal-root", s.journalRoot, "--run", "20261008T120000Z"], st2.deps, WATCHED)).toBe(0);
    expect(st2.ran).toEqual(["W1"]);
    const p = fixture("prod");
    const pr = fakeDeps();
    expect(await runRelease(["--target", p.targetFile, "--go", p.goFile, "--journal-root", p.journalRoot, "--stage-journal", join(s.journalRoot, "stage", "20261008T120000Z")], pr.deps, WATCHED)).toBe(3);
    expect(pr.ran).toEqual(["R6.9"]);
    const pr2 = fakeDeps();
    pr2.deps.now = () => new Date("2026-10-08T19:00:00Z");
    expect(await runRelease(["--target", p.targetFile, "--go", p.goFile, "--journal-root", p.journalRoot, "--stage-journal", join(s.journalRoot, "stage", "20261008T120000Z"), "--run", "20261008T120000Z"], pr2.deps, WATCHED)).toBe(0);
    expect(pr2.ran).toEqual(["W1", "W3"]);
  });

  test("a watchHours wait takes the target's watch length: READY + 10 h, not + 6 h", async () => {
    const steps: StepTemplate[] = WATCHED.map((s) => (s.id === "W1" ? { ...s, notBefore: { afterStep: "R6.9", hours: "watchHours" } } : s));
    const f = fixture("stage");
    const early = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], early.deps, steps)).toBe(3);
    expect(early.logs.join("\n")).toContain("W1 becomes runnable at 2026-10-08T22:00:00.000Z");
    expect(early.logs.join("\n")).toContain("+ 10 h");
    // red control: READY + 6 h is no longer enough.
    const six = fakeDeps();
    six.deps.now = () => new Date("2026-10-08T18:00:01Z");
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z"], six.deps, steps)).toBe(3);
    expect(six.ran).toEqual([]);
    const later = fakeDeps();
    later.deps.now = () => new Date("2026-10-08T22:00:01Z");
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z"], later.deps, steps)).toBe(0);
    expect(later.ran).toEqual(["W1"]);
  });

  test("red: a go whose recovery file cannot be read refuses before anything runs", async () => {
    const f = fixture("stage");
    writeFileSync(f.goFile, `release: v0.6.0\ncommit: ${SHA}\ntarget: stage\nrecovery: ${join(f.dir, "missing.md")}\n`);
    const a = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], a.deps, WATCHED)).toBe(2);
    expect(a.ran).toEqual([]);
    expect(a.logs.join("\n")).toContain("SC.1");
  });
});

describe("release tags (R5.rc, W3)", () => {
  test("the next rc number follows the existing tags; rc tags at a commit are found", () => {
    expect(nextRcTag("v0.6.0", [])).toBe("v0.6.0-rc.0");
    expect(nextRcTag("v0.6.0", ["v0.6.0-rc.0", "v0.6.0-rc.2", "v0.5.4-rc.7", "v0.6.0"])).toBe("v0.6.0-rc.3");
    expect(rcTagsAt("v0.6.0", ["v0.6.0-rc.1", "v0.6.0", "v0.6.01-rc.1"])).toEqual(["v0.6.0-rc.1"]);
    // red control: another release's rc never counts.
    expect(nextRcTag("v0.6.0", ["v0.6.1-rc.4"])).toBe("v0.6.0-rc.0");
  });
});

describe("schedule parity (R7.4a)", () => {
  const close = "2026-10-08T12:00:00.000Z";
  const base = [{ id: "s1", subject: "eth", state: "collecting", window_closes_at: close }];
  test("6 h epochs, an on-time publish, a :30 regime cron and a live sweep pass", () => {
    expect(epochProblems([{ id: "eth", epoch_duration_seconds: 21600 }])).toEqual([]);
    expect(inFlightProblems(base, [{ id: "s1", state: "published", window_closes_at: close, published_at: "2026-10-08T12:10:00.000Z", judging_duration_seconds: 900 }])).toEqual([]);
    expect(regimeCronProblems("30 */3 * * *")).toEqual([]);
    expect(paritySweep({ status: "succeeded", secs: 21.5 })).toEqual({ problems: [], detail: "last parity sweep succeeded in 21.5 s" });
  });
  test("red: a short epoch, a moved close, a late or missing publish, a :00 cron, a dead sweep", () => {
    expect(epochProblems([{ id: "eth", epoch_duration_seconds: 900 }]).length).toBe(1);
    expect(inFlightProblems(base, []).join()).toContain("gone");
    expect(inFlightProblems(base, [{ id: "s1", state: "collecting", window_closes_at: close, published_at: null, judging_duration_seconds: 900 }]).join()).toContain("not published");
    expect(inFlightProblems(base, [{ id: "s1", state: "published", window_closes_at: "2026-10-08T11:00:00.000Z", published_at: "2026-10-08T11:05:00.000Z", judging_duration_seconds: 900 }]).join()).toContain("close moved");
    expect(inFlightProblems(base, [{ id: "s1", state: "published", window_closes_at: close, published_at: "2026-10-08T14:00:00.000Z", judging_duration_seconds: 900 }]).join()).toContain("120 min after");
    expect(regimeCronProblems("0 */3 * * *").length).toBe(1);
    expect(paritySweep({ status: "dead", secs: 240 }).problems.length).toBe(1);
  });
});

describe("legacy secret cleanup (S8.1) and the postgres URL guard (R7.7)", () => {
  test("database URLs and model keys move; settings stay", () => {
    const text = "PROJECTS_SOURCE=live\nMIGRATE_DATABASE_URL=postgresql://doadmin:pw@db:25060/defaultdb\nWORKER_DATABASE_URL=x\nOPENCODE_API_KEY=k\nSOME_URL=postgres://u:p@h/d\n# note\n";
    const p = partitionLegacyEnv(text);
    expect(p.movedKeys).toEqual(["MIGRATE_DATABASE_URL", "WORKER_DATABASE_URL", "OPENCODE_API_KEY", "SOME_URL"]);
    expect(p.kept).toBe("PROJECTS_SOURCE=live\n# note\n");
    expect(p.moved).not.toContain("PROJECTS_SOURCE");
    // red control: a URL without a password and a plain setting stay.
    expect(partitionLegacyEnv("BASE=postgres://h/d\nX=1\n").movedKeys).toEqual([]);
  });
  test("a world-readable file with a postgres password is found; a 0600 one is not", () => {
    expect(exposesPostgresUrl(0o100644, "MIGRATE_DATABASE_URL=postgresql://doadmin:pw@h/d")).toBe(true);
    expect(exposesPostgresUrl(0o100600, "MIGRATE_DATABASE_URL=postgresql://doadmin:pw@h/d")).toBe(false);
    expect(exposesPostgresUrl(0o100644, "url=postgres://h:5432/d")).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "release-scan-"));
    writeFileSync(join(dir, "open.env"), "U=postgres://a:b@h/d\n", { mode: 0o644 });
    writeFileSync(join(dir, "closed.env"), "U=postgres://a:b@h/d\n", { mode: 0o600 });
    // red control: inside a 0700 directory even a 0644 file is not exposed.
    chmodSync(dir, 0o700);
    expect(scanForPostgresUrls([dir])).toEqual([]);
    // Opened up, the world-readable file is found, if this machine's tmpdir is itself traversable by others.
    chmodSync(dir, 0o755);
    const tmpTraversable = tmpdir().split("/").reduce<{ p: string; ok: boolean }>((acc, part) => {
      const p = part === "" ? "/" : join(acc.p, part);
      return { p, ok: acc.ok && (statSync(p).mode & 0o001) !== 0 };
    }, { p: "/", ok: true }).ok;
    if (tmpTraversable) expect(scanForPostgresUrls([dir])).toEqual([join(dir, "open.env")]);
  });
  test("a path is exposed only when every directory above it lets others traverse it", () => {
    expect(othersCanTraverse([0o40755, 0o41777, 0o40755])).toBe(true);
    // red controls: a 0700 home (prod's /root) or a 0750 home (stage-2) hides everything below it.
    expect(othersCanTraverse([0o40755, 0o40700, 0o40755])).toBe(false);
    expect(othersCanTraverse([0o40755, 0o40750, 0o40755])).toBe(false);
  });
});

describe("W1's attendance threshold is target data, not a template change", () => {
  const targetsDir = join(import.meta.dir, "../../release/targets");
  const w1 = RELEASE_STEPS.find((s) => s.id === "W1")!;
  const render = (name: string) => {
    const t = loadTarget(join(targetsDir, `${name}.json`));
    return renderStep(w1, t, templateValues(t, "a".repeat(40), "20261008T000000Z", "2026-10-08T00:00:00.000Z")).remote;
  };
  test("prod keeps the gate's default 0.5; stage passes 0.4, because external members never file against stage", () => {
    expect(render("prod")).toContain("--min-attendance 0.5");
    expect(render("stage")).toContain("--min-attendance 0.4");
  });
  test("red control: a threshold outside (0, 1] refuses the target file", () => {
    const raw = JSON.parse(readFileSync(join(targetsDir, "stage.json"), "utf8"));
    expect("errors" in validateTarget("stage", raw)).toBe(false);
    raw.watchMinAttendance = 0;
    expect("errors" in validateTarget("stage", raw)).toBe(true);
    raw.watchMinAttendance = 1.5;
    expect("errors" in validateTarget("stage", raw)).toBe(true);
  });
});


// R1.2 proves every ~/.env key the cutover needs before R6.1 stops the legacy
// stack: production's /root/.env once lacked rm_owner, and a run that stopped
// the site and then refused at R6.2 would have left it down. The runbook uses
// rm_owner only; no release step reads doadmin (D61 amendment, owner, 2026-10-08).
describe("the cutover's ~/.env keys are proven at R1.2, before the first irreversible step", () => {
  const ENV_PATH = "/root/.env";
  const SECRET = "Sup3r-s3cret-value";

  test("a non-empty rm_owner line passes", () => {
    expect(preCutoverKeyProblems({ rm_owner: SECRET }, ENV_PATH)).toEqual([]);
  });

  test("red: rm_owner missing, empty or blank refuses, naming the key, the file and the fix; doadmin alone does not satisfy it", () => {
    for (const env of [{}, { doadmin: SECRET }, { rm_owner: "" }, { rm_owner: "   " }]) {
      const problems = preCutoverKeyProblems(env, ENV_PATH);
      expect(problems.length, JSON.stringify(env)).toBe(1);
      expect(problems[0]).toContain("rm_owner");
      expect(problems[0]).toContain(ENV_PATH);
      expect(problems[0]).toContain("bun run role-passwords --target <target>");
    }
  });

  test("a refusal never holds a value", () => {
    for (const env of [{ doadmin: SECRET }, { rm_owner: "", doadmin: SECRET }]) {
      expect(preCutoverKeyProblems(env, ENV_PATH).join("\n")).not.toContain(SECRET);
    }
  });

  test("no release step reads doadmin, and R6.2b (enable-owner-login) is gone", () => {
    expect(stepIds()).not.toContain("R6.2b");
    for (const s of RELEASE_STEPS) {
      for (const c of s.cmds) expect(c.join(" "), s.id).not.toMatch(/doadmin|enable-owner-login|role-passwords/);
    }
    expect([...PRE_CUTOVER_REQUIRED_KEYS]).toEqual(["rm_owner"]);
    expect(RUN_WRITTEN_KEYS).toEqual({ RM_CREDENTIALS: "R6.2a" });
    expect([...D61_REQUIRED_KEYS]).toEqual(["rm_owner", "RM_CREDENTIALS"]);
    // R6.2 requires RM_CREDENTIALS: R6.2a writes it first.
    const ids = stepIds();
    expect(ids.indexOf("R6.2a")).toBeLessThan(ids.indexOf("R6.2"));
    for (const [key, writer] of Object.entries(RUN_WRITTEN_KEYS)) expect(ids, key).toContain(writer);
  });

  /** The index of the step that checks the pre-cutover keys: host-identity with --confirm-target. */
  const keyCheckIndex = (steps: readonly StepTemplate[]) =>
    steps.findIndex((s) => s.cmds.some((c) => c.includes("scripts/release/host-identity.ts") && c.includes("--confirm-target")));
  const firstIrreversible = (steps: readonly StepTemplate[]) => steps.findIndex((s) => s.irreversible);
  const keysCheckedFirst = (steps: readonly StepTemplate[]) => {
    const check = keyCheckIndex(steps);
    return check >= 0 && check < firstIrreversible(steps);
  };

  test("every precondition check precedes the first irreversible step (R6.1)", () => {
    expect(RELEASE_STEPS[keyCheckIndex(RELEASE_STEPS)]?.id).toBe("R1.2");
    expect(RELEASE_STEPS[firstIrreversible(RELEASE_STEPS)]?.id).toBe("R6.1");
    expect(keysCheckedFirst(RELEASE_STEPS)).toBe(true);
    // R6.2, the defence-in-depth check, needs only keys R1.2 checked or the run wrote.
    for (const key of D61_REQUIRED_KEYS) expect(PRE_CUTOVER_REQUIRED_KEYS.includes(key) || key in RUN_WRITTEN_KEYS, key).toBe(true);
    const r12 = RELEASE_STEPS.find((s) => s.id === "R1.2")!;
    expect(r12.description).toContain("rm_owner logs in");
    expect(r12.description).toContain("RM_CREDENTIALS is not required");
  });

  test("red: R1.2 moved after R6.1, or R1.2 without --confirm-target, fails the order check", () => {
    const r12 = RELEASE_STEPS.find((s) => s.id === "R1.2")!;
    const without = RELEASE_STEPS.filter((s) => s.id !== "R1.2");
    const r61 = without.findIndex((s) => s.id === "R6.1");
    expect(keysCheckedFirst([...without.slice(0, r61 + 1), r12, ...without.slice(r61 + 1)])).toBe(false);
    const noConfirm = { ...r12, cmds: [r12.cmds[0]!.filter((a, i, all) => a !== "--confirm-target" && all[i - 1] !== "--confirm-target")] };
    expect(keysCheckedFirst(RELEASE_STEPS.map((s) => (s.id === "R1.2" ? noConfirm : s)))).toBe(false);
  });

  // The real script, end to end, against an unreachable database: the key
  // refusal and the rm_owner login failure print key names, never a value.
  describe("host-identity.ts prints key names, never values", () => {
    const OWNER = "owner-Pw-9f3a1c";
    const ADMIN = "admin-Pw-7b2e4d";
    function run(envText: string): { out: string; receipt: string; code: number | null } {
      const work = mkdtempSync(join(tmpdir(), "rm-host-identity-"));
      const home = join(work, "home");
      const repo = join(work, "repo");
      const receipts = join(work, "receipts");
      for (const d of [home, repo]) spawnSync("mkdir", ["-p", d]);
      writeFileSync(join(home, ".env"), envText, { mode: 0o600 });
      const vcs = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
      vcs("init", "-q");
      vcs("commit", "-q", "--allow-empty", "-m", "x");
      const sha = vcs("rev-parse", "HEAD").stdout.trim();
      const env: Record<string, string> = { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", RM_ENV: "prod" };
      const r = spawnSync("bun", [join(repoRoot, "scripts/release/host-identity.ts"), "--commit", sha, "--confirm-target", "127.0.0.1:1/rm", "--receipt-dir", receipts],
        { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
      let receipt = "";
      try { receipt = readFileSync(join(receipts, "host-identity.json"), "utf8"); } catch { /* none */ }
      return { out: `${r.stdout}\n${r.stderr}`, receipt, code: r.status };
    }
    const conn = "host=127.0.0.1\nport=1\ndatabase=rm\nsslmode=disable\nrm_readonly=ro-Pw-1\n";
    const clean = (x: { out: string; receipt: string }) => {
      for (const v of [OWNER, ADMIN, encodeURIComponent(OWNER), encodeURIComponent(ADMIN)]) {
        expect(x.out).not.toContain(v);
        expect(x.receipt).not.toContain(v);
      }
    };

    test("red: rm_owner missing refuses, naming rm_owner and the fix; a doadmin line is not read and never prints", () => {
      const x = run(`${conn}doadmin=${ADMIN}\n`);
      expect(x.code).toBe(1);
      expect(x.out).toMatch(/REFUSE: .*has no non-empty rm_owner line; run `bun run role-passwords --target <target>` first/);
      expect(x.receipt).toContain(`"ownerLogin": "not-tried"`);
      clean(x);
    }, 60_000);

    test("red: an empty rm_owner line refuses like a missing one", () => {
      const x = run(`${conn}rm_owner=\n`);
      expect(x.out).toMatch(/REFUSE: .*has no non-empty rm_owner line/);
      expect(x.receipt).toContain(`"ownerLogin": "not-tried"`);
      clean(x);
    }, 60_000);

    test("rm_owner present: no key refusal; the login is tried, and its failure names role-passwords for the target and holds no password", () => {
      const x = run(`${conn}rm_owner=${OWNER}\n`);
      expect(x.out).not.toMatch(/non-empty rm_owner line/);
      expect(x.out).toContain("REFUSE: rm_owner login: rm_owner cannot log in; run `bun run role-passwords --target prod` first");
      expect(x.receipt).toContain(`"ownerLogin": "failed"`);
      clean(x);
    }, 60_000);
  });
});
