// scripts/tests/unit/release-run.test.ts — `bun run release:run` (D61), the
// agent-executed runbook runner (scripts/release/).
//
// What is pinned, each with a red control:
//   - the target schema: both committed targets are valid; an unknown key, a
//     bad commit, a secret boot setting and a prod target on another instance
//     refuse;
//   - D61 rule 2: the step list is one list, and its hash is the same for
//     stage and prod; the rendered commands differ only by target values;
//   - D61 rule 1: the go file must name this release, commit and target;
//   - SP.8: prod refuses without a passed stage journal of the same step-list
//     hash at the same commit;
//   - resume: a failed run prints the resume command, and `--from` runs that
//     step onward and nothing before it;
//   - secret scrubbing of output, receipts and journals;
//   - the env rewrite's key partition, the baseline comparison, the host guards.
// Nothing here opens an ssh connection: the runner's exec is injected.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateGo } from "../../release/go.ts";
import { checkResume, checkStageJournal, runStatus, selectSteps, type RunJournal } from "../../release/journal.ts";
import { lineScrubber, scrubSecrets, forbiddenReceiptPath } from "../../release/scrub.ts";
import { RELEASE_STEPS, fill, renderStep, stepIds, stepListHash, templateValues, type StepTemplate } from "../../release/steps.ts";
import { CONFIRM_TARGET_PLACEHOLDER, loadTarget, validateTarget } from "../../release/target.ts";
import { parseArgs, receiptPathsInOutput, runRelease, type RunnerDeps } from "../../release/run.ts";
import { partitionEnv } from "../../release/env-rewrite.ts";
import { compareBaseline } from "../../release/compare-baseline.ts";
import { keysOutsideAllowlist, socketMounts, tokenFileProblems } from "../../release/host-guards.ts";
import { composeDownArgv, retiredPath } from "../../release/stop-legacy.ts";
import { baselineProblems, WOULD_CLEAR_SQL } from "../../release/baseline.ts";
import { identityProblems } from "../../release/identity-check.ts";
import { IDENTITY_MIGRATION, preconditionProblems } from "../../release/precondition.ts";
import { D61_ENV_ALLOWLIST, confirmTargetOf } from "../../release/env-keys.ts";
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
    expect(prod.confirmTarget).toBe(CONFIRM_TARGET_PLACEHOLDER);
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

  test("red: a short commit, no commit or tag, a prod target on another instance, a secret boot setting", () => {
    const bad = (patch: Record<string, unknown>) => validateTarget("prod", { ...prodRaw(), ...patch });
    expect("errors" in bad({ commit: "a502de30" })).toBe(true);
    const noCommit = prodRaw();
    delete noCommit.commit;
    expect("errors" in validateTarget("prod", noCommit)).toBe(true);
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
    for (const id of ["R1.1", "R2.1", "R2.3", "R2.5", "R6.1", "R6.2", "R6.2b", "R6.3", "S8.1", "R6.4", "R6.5", "R6.7a", "R6.7c", "R6.7d", "R6.10", "R7.1", "R7.3", "R7.3a", "R7.3b", "R7.5", "R7.7"]) {
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

  test("every remote command runs from the checkout with HOME set, and no step carries a secret or -v", () => {
    const values = templateValues(prod, SHA, "20261008T000000Z");
    for (const s of RELEASE_STEPS) {
      const r = renderStep(s, prod, values);
      expect(r.remote).toContain("cd ");
      expect(r.remote).toContain("HOME=");
      expect(r.remote).not.toMatch(/(^|\s)-v(\s|$)|--volumes|rm_owner=|doadmin=|PGPASSWORD/);
    }
  });
});

describe("R2.5 grades the legacy stack with the legacy checkout's own gate", () => {
  test("it runs from the legacy checkout, with HOME and no RM_ENV, on both targets", () => {
    for (const t of [loadTarget(join(targetsDir, "prod.json")), loadTarget(join(targetsDir, "stage.json"))]) {
      const r = renderStep(RELEASE_STEPS.find((s) => s.id === "R2.5")!, t, templateValues(t, SHA, "20261008T000000Z"));
      expect(r.remote).toContain(`cd ${t.legacy.checkout} && env HOME=${t.home} bun run prod:gate --mode baseline --state-file ${t.legacy.checkout}/.agents/smoke-state.json`);
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
  const expected = { release: "v0.6.0", commit: SHA, target: "prod" };
  const good = `# owner go, 2026-10-08\nrelease: v0.6.0\ncommit: ${SHA}\ntarget: prod\noperator: lucas\n`;

  test("a go naming this release, commit and target passes, with its hash", () => {
    const r = validateGo(good, expected);
    expect("go" in r && r.go.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("red: another commit, target or release; an unknown or missing key; a short sha", () => {
    expect("errors" in validateGo(good.replace(SHA, OTHER_SHA), expected)).toBe(true);
    expect("errors" in validateGo(good.replace("target: prod", "target: stage"), expected)).toBe(true);
    expect("errors" in validateGo(good.replace("v0.6.0", "v0.6.1"), expected)).toBe(true);
    expect("errors" in validateGo(`${good}skip: R2.5\n`, expected)).toBe(true);
    expect("errors" in validateGo(good.replace(/target: prod\n/, ""), expected)).toBe(true);
    expect("errors" in validateGo(good.replace(SHA, "a502de30"), { ...expected, commit: "a502de30" })).toBe(true);
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
  raw.commit = SHA;
  const name = rmEnv === "prod" ? "prod" : "stage";
  const targetFile = join(dir, `${name}.json`);
  writeFileSync(targetFile, JSON.stringify(raw));
  const goFile = join(dir, "go.txt");
  writeFileSync(goFile, `release: v0.6.0\ncommit: ${SHA}\ntarget: ${name}\n`);
  return { dir, targetFile, goFile, journalRoot: join(dir, "journal") };
}

function fakeDeps(opts: { fail?: Set<string>; out?: string; receipt?: string } = {}) {
  const ran: string[] = [];
  const logs: string[] = [];
  const deps: RunnerDeps = {
    async exec(_host, remote, onStdout) {
      const id = /\.step-([A-Za-z0-9.]+)/.exec(remote)![1]!;
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
    resolveTag: () => undefined,
    readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
    now: () => new Date("2026-10-08T12:00:00Z"),
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
    home: "/nonexistent",
  };
  return { deps, ran, logs };
}

describe("runRelease", () => {
  test("refuses without a go file, and with a go for another commit; --dry-run needs none", async () => {
    const f = fixture();
    const a = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--journal-root", f.journalRoot], a.deps, TINY)).toBe(2);
    expect(a.ran).toEqual([]);
    expect(a.logs.join("\n")).toContain("no --go");
    writeFileSync(f.goFile, `release: v0.6.0\ncommit: ${OTHER_SHA}\ntarget: stage\n`);
    const b = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], b.deps, TINY)).toBe(2);
    expect(b.ran).toEqual([]);
    const c = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--dry-run"], c.deps, TINY)).toBe(0);
    expect(c.ran).toEqual([]);
    expect(c.logs.join("\n")).toContain("ssh -T rm-frontend-stage-2");
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
    expect(p.keptKeys).toEqual(["host", "port", "database", "sslmode", "rm_app", "rm_worker", "rm_readonly", "rm_owner", "doadmin", "RM_CREDENTIALS"]);
    expect(p.retiredKeys).toEqual(["OPENCODE_API_KEY", "ADMIN_TOKEN", "(line 14)"]);
    expect(p.keptText).toContain("# connection");
    expect(p.retiredText).toBe("OPENCODE_API_KEY=z\nexport ADMIN_TOKEN=t\na bare value\n");
    expect(p.missingRequired).toEqual([]);
  });
  test("red: a file without rm_owner, doadmin or RM_CREDENTIALS reports them", () => {
    const p = partitionEnv("host=h\ndatabase=d\nrm_readonly=r\n");
    expect(p.missingRequired).toEqual(["rm_owner", "doadmin", "RM_CREDENTIALS"]);
  });
  test("the D61 allowlist is preflight check 4's list plus rm_owner and doadmin", () => {
    for (const k of ENV_FILE_ALLOWED_KEYS) expect(D61_ENV_ALLOWLIST).toContain(k);
    expect(D61_ENV_ALLOWLIST.filter((k) => !ENV_FILE_ALLOWED_KEYS.includes(k)).sort()).toEqual(["doadmin", "rm_owner"]);
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
    expect(identityProblems(null, null, SHA).length).toBe(2);
  });
});
