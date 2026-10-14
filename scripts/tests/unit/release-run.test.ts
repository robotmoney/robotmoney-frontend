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
//     ref is the one source of every {commit}: a stage go names a commit, a
//     production go names the rc tag, resolved on the control machine (D64);
//   - D64: the commit must be on origin/releases-A.B.x, in the preflight and
//     in the live run; the rc is no step;
//   - SP.8: prod refuses without a passed stage journal of the same step-list
//     hash at the same commit;
//   - resume: a failed run prints the resume command, and `--from` runs that
//     step onward and nothing before it;
//   - secret scrubbing of output, receipts and journals;
//   - the env rewrite's key partition, the baseline comparison, the host guards;
//   - issue 1272: the runner holds no past-upgrade fact. The ledger is judged
//     against backend/migrations by filename set, never against a baseline
//     constant or a count; a target carries no `legacy` block, previous commit
//     or tmux session; the cutover is rolling and stops nothing (owner,
//     2026-10-14); the one-time v0.6.0 cutover steps are gone from the list;
//     the recorded step-list hash in the runbook equals the computed one.
// Nothing here opens an ssh connection: the runner's exec is injected.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { originProblems, qaBranchPrefix, releaseBranch, validateGo } from "../../release/go.ts";
import { checkResume, checkStageJournal, runStatus, selectSteps, type RunJournal } from "../../release/journal.ts";
import { lineScrubber, scrubSecrets, forbiddenReceiptPath } from "../../release/scrub.ts";
import { READY_PENDING, REMOTE_PATH, RELEASE_REPO_URL, RELEASE_STEPS, fill, renderStep, stepIds, stepListHash, templateValues, type StepTemplate } from "../../release/steps.ts";
import { CAPTURE_CHECKOUT, CONFIRM_TARGET_PLACEHOLDER, PAST_FACT_KEYS, loadTarget, validateTarget } from "../../release/target.ts";
import { STAGE_TARGET } from "../../release/stage-target-lib.ts";
import { parseArgs, receiptPathsInOutput, resolveGo, runRelease, type RunnerDeps } from "../../release/run.ts";
import { checkAfterPreflight, ciProblems, laneOf, preflightOrder, preflightSteps, REQUIRED_CI, type PreflightReport } from "../../release/preflight.ts";
import { TIMED_OUT } from "../../release/step-exec.ts";
import { cutoverSeconds, skipReason } from "../../release/run.ts";
import { DEFAULT_MAX_MINUTES, maxMillisOf } from "../../release/steps.ts";
import { partitionEnv } from "../../release/env-rewrite.ts";
import { compareBaseline } from "../../release/compare-baseline.ts";
import { exposesPostgresUrl, keysOutsideAllowlist, othersCanTraverse, scanForPostgresUrls, socketMounts, tokenFileProblems } from "../../release/host-guards.ts";
import type { StackStateRecord } from "../../lib/smoke-state.ts";
import { ledgerNotInRepo, ledgerProblems, parseRunningVersion, reconcileLedger, repoMigrations, runningPinRef } from "../../release/ledger.ts";
import { checkAddOnly, loadTemplate, type ReleaseRunbook, type RunbookStep } from "../../release/runbook.ts";
import { nextRcTag, rcStageProblems, rcTagsAt } from "../../release/tag.ts";
import { epochProblems, inFlightCloseProblems, inFlightProblems, inFlightProblemsFor, parseSessionsFlag, paritySweep, regimeCronProblems } from "../../release/schedule-parity.ts";
import { baselineProblems, WOULD_CLEAR_SQL } from "../../release/baseline.ts";
import { identityProblems } from "../../release/identity-check.ts";
import { IDENTITY_MIGRATION, preconditionProblems } from "../../release/precondition.ts";
import { D61_ENV_ALLOWLIST, D61_REQUIRED_KEYS, PRE_CUTOVER_REQUIRED_KEYS, RUN_WRITTEN_KEYS, confirmTargetOf, preCutoverKeyProblems } from "../../release/env-keys.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const targetsDir = join(repoRoot, "scripts", "release", "targets");
/** The release the committed targets name: the go files below must match it. */
const RELEASE = loadTarget(join(targetsDir, "prod.json")).release;
const SHA = "a502de30068e0c1cc2e232a76098364e0b709033";
const OTHER_SHA = "0".repeat(40);
const TREE = "7".repeat(40);
const OTHER_TREE = "8".repeat(40);
/** The rc tag a production go names (D64); the fake control machine resolves it to SHA. */
const TAG = `${RELEASE}-rc.0`;

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
    expect(prod.confirmTarget).not.toBe(CONFIRM_TARGET_PLACEHOLDER);
    expect(prod.confirmTarget).toMatch(/^[a-z0-9.-]+:25060\/defaultdb$/);
    expect(stage.rmEnv).toBe("stage");
    expect(stage.release).toBe(prod.release);
    // The capture checkout convention: one runner-owned folder on stage-2 for both targets.
    for (const t of [prod, stage]) {
      expect(t.capture.host).toBe(CAPTURE_CHECKOUT.host);
      expect(t.capture.checkout).toBe(CAPTURE_CHECKOUT.checkout);
    }
  });

  test("red: a capture checkout that is the stage target's checkout or the target's own refuses, with the rule", () => {
    // prod: the stage target's checkout on stage-2 (the 2026-10-08 R1.4 failure).
    const p = prodRaw();
    (p.capture as Record<string, unknown>).checkout = STAGE_TARGET.checkout;
    const rp = validateTarget("prod", p);
    expect("errors" in rp && rp.errors).toEqual([
      "prod.capture.checkout /home/stage-server/rm-stage-target is the stage target's checkout, which stage-target down removes: " +
        "the capture checkout is a dedicated folder the release runner owns (convention: rm-frontend-stage-2:/home/stage-server/rm-capture), never a release checkout",
    ]);
    // stage: the old stage.json named both rules at once.
    const s = JSON.parse(readFileSync(join(targetsDir, "stage.json"), "utf8")) as Record<string, unknown>;
    (s.capture as Record<string, unknown>).checkout = s.checkout;
    const rs = validateTarget("stage", s);
    const errs = "errors" in rs ? rs.errors : [];
    expect(errs).toHaveLength(2);
    expect(errs[1]).toContain("stage.capture.checkout /home/stage-server/rm-stage-target is this target's own checkout on rm-frontend-stage-2");
    // its own checkout on the same host, away from the stage target's path.
    const own = prodRaw();
    own.host = "rm-frontend-stage-2";
    (own.capture as Record<string, unknown>).checkout = own.checkout;
    const ro = validateTarget("prod", own);
    expect("errors" in ro && ro.errors.join()).toContain("is this target's own checkout on rm-frontend-stage-2");
    // green controls: the same path on another host is not the target's own; the convention passes.
    const other = prodRaw();
    (other.capture as Record<string, unknown>).checkout = other.checkout;
    expect("target" in validateTarget("prod", other)).toBe(true);
    expect("target" in validateTarget("prod", prodRaw())).toBe(true);
  });

  test("red: an unknown key refuses, top level and nested", () => {
    const top = { ...prodRaw(), drainFirst: true };
    expect(validateTarget("prod", top)).toEqual({ errors: ['prod: unknown key "drainFirst"'] });
    const nested = prodRaw();
    (nested.capture as Record<string, unknown>).tmux = "driver";
    const r = validateTarget("prod", nested);
    expect("errors" in r && r.errors.join()).toContain('prod.capture: unknown key "tmux"');
  });

  test("a target holds no past-upgrade fact: no legacy block, no previous commit, no tmux session, no v0.5.4 (issue 1272)", () => {
    for (const name of ["prod", "stage"]) {
      const text = readFileSync(join(targetsDir, `${name}.json`), "utf8");
      const raw = JSON.parse(text) as Record<string, unknown>;
      expect(raw).not.toHaveProperty("legacy");
      expect(raw).not.toHaveProperty("commit");
      expect(raw).not.toHaveProperty("tag");
      expect(text).not.toMatch(/[0-9a-f]{40}/);
      expect(text).not.toContain("v0.5.4");
      expect(text).not.toMatch(/tmux|driver|smoke-archive/);
      expect("target" in validateTarget(name, raw)).toBe(true);
      expect(Object.keys(loadTarget(join(targetsDir, `${name}.json`)))).not.toContain("legacy");
    }
    // red controls: each past-fact key refuses by name, at the top level.
    for (const key of ["legacy", "commit", "tmuxSession"]) {
      const r = validateTarget("prod", { ...prodRaw(), [key]: key === "legacy" ? { checkout: "/root/rm-060" } : key === "commit" ? SHA : "driver" });
      expect("errors" in r && r.errors.join("\n"), key).toContain(`prod: "${key}" is not a target key`);
    }
    expect(Object.keys(PAST_FACT_KEYS).sort()).toEqual(["commit", "legacy", "tag", "tmuxSession"]);
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

  test("R1.1 and R1.4 detach at the go's ref: the rc tag on prod, the commit on stage; one template, one hash (D64)", () => {
    for (const id of ["R1.1", "R1.4"]) {
      const step = RELEASE_STEPS.find((s) => s.id === id)!;
      expect(step.cmds).toEqual([["git", "fetch", "--tags", "origin"], ["git", "-c", "advice.detachedHead=false", "checkout", "--detach", "{ref}"]]);
      expect(renderStep(step, prod, templateValues(prod, SHA, "20261008T000000Z", READY_PENDING, TAG)).remote).toContain(`checkout --detach ${TAG}`);
      expect(renderStep(step, stage, templateValues(stage, SHA, "20261008T000000Z", READY_PENDING, SHA)).remote).toContain(`checkout --detach ${SHA}`);
    }
    // The tag fetch precedes the detach, so the host holds the rc tag the boot reports as RM_BUILD_TAG.
    const r11 = renderStep(RELEASE_STEPS.find((s) => s.id === "R1.1")!, prod, templateValues(prod, SHA, "20261008T000000Z", READY_PENDING, TAG)).remote;
    expect(r11.indexOf("git fetch --tags origin")).toBeLessThan(r11.indexOf(`checkout --detach ${TAG}`));
    // red control: the ref defaults to the commit, and never to anything a target names.
    expect(templateValues(prod, SHA, "20261008T000000Z").ref).toBe(SHA);
    // R7.1 checks the ref: a production boot must serve the rc tag.
    expect(renderStep(RELEASE_STEPS.find((s) => s.id === "R7.1")!, prod, templateValues(prod, SHA, "20261008T000000Z", READY_PENDING, TAG)).remote).toContain(`--commit ${SHA} --ref ${TAG}`);
  });

  test("R1.4 clones the capture checkout when it is missing, then fetches and detaches; the same command on both targets", () => {
    const r14 = RELEASE_STEPS.find((s) => s.id === "R1.4")!;
    expect(r14.cloneFrom).toBe(RELEASE_REPO_URL);
    expect(RELEASE_STEPS.filter((s) => s.cloneFrom).map((s) => s.id)).toEqual(["R1.1", "R1.4"]);
    const env = `env -i HOME=/home/stage-server PATH=${REMOTE_PATH} LANG=C.UTF-8`;
    const render = (t: typeof prod) => renderStep(r14, t, templateValues(t, SHA, "20261008T000000Z"));
    const rp = render(prod);
    expect(rp.host).toBe("rm-frontend-stage-2");
    expect(rp.remote).toBe([
      "mkdir -p /home/stage-server/.local/state/robotmoney-release/prod/20261008T000000Z",
      "touch /home/stage-server/.local/state/robotmoney-release/prod/20261008T000000Z/.step-R1.4",
      `{ test -e /home/stage-server/rm-capture/.git || ${env} git clone --quiet git@github.com:robotmoney/robotmoney-frontend.git /home/stage-server/rm-capture; }`,
      "cd /home/stage-server/rm-capture",
      `${env} git fetch --tags origin`,
      `${env} git -c advice.detachedHead=false checkout --detach ${SHA}`,
    ].join(" && "));
    // Stage renders the same command; only the run directory's target name differs.
    expect(render(stage).remote).toBe(rp.remote.replaceAll("/robotmoney-release/prod/", "/robotmoney-release/stage/"));
    // Idempotent: the clone runs only when .git is missing, the fetch and detach run every time.
    expect(rp.remote.indexOf("test -e")).toBeLessThan(rp.remote.indexOf("cd /home/stage-server/rm-capture"));
  });

  test("R1.1 clones the release checkout when it is missing, then fetches and detaches (the v0.6.1 preflight: cd /root/rm-061 failed, 2026-10-10)", () => {
    const r11 = RELEASE_STEPS.find((s) => s.id === "R1.1")!;
    expect(r11.cloneFrom).toBe(RELEASE_REPO_URL);
    const render = (t: typeof prod) => renderStep(r11, t, templateValues(t, SHA, "20261008T000000Z"));
    const rp = render(prod);
    expect(rp.host).toBe(prod.host);
    const envp = `env -i HOME=${prod.home} PATH=${REMOTE_PATH} LANG=C.UTF-8 RM_ENV=prod`;
    expect(rp.remote).toBe([
      `mkdir -p ${prod.home}/.local/state/robotmoney-release/prod/20261008T000000Z`,
      `touch ${prod.home}/.local/state/robotmoney-release/prod/20261008T000000Z/.step-R1.1`,
      `{ test -e ${prod.checkout}/.git || ${envp} git clone --quiet git@github.com:robotmoney/robotmoney-frontend.git ${prod.checkout}; }`,
      `cd ${prod.checkout}`,
      `${envp} git fetch --tags origin`,
      `${envp} git -c advice.detachedHead=false checkout --detach ${SHA}`,
    ].join(" && "));
    // A plain clone: never --reference another checkout.
    expect(rp.remote).not.toContain("--reference");
    // Stage renders the same shape on its own host and checkout.
    const rs = render(stage);
    expect(rs.host).toBe(stage.host);
    expect(rs.remote).toContain(`{ test -e ${stage.checkout}/.git || env -i HOME=${stage.home} PATH=${REMOTE_PATH} LANG=C.UTF-8 RM_ENV=stage git clone --quiet git@github.com:robotmoney/robotmoney-frontend.git ${stage.checkout}; } && cd ${stage.checkout} && `);
  });

  test("the clone source is part of the step-list hash", () => {
    const without = RELEASE_STEPS.map((s) => (s.id === "R1.4" ? { ...s, cloneFrom: undefined } : s));
    expect(stepListHash(without)).not.toBe(stepListHash());
  });

  test("the hash is the same for stage and prod; the one-time v0.6.0 steps are gone (issue 1272)", () => {
    expect(stepListHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(stepListHash([...RELEASE_STEPS])).toBe(stepListHash());
    const ids = stepIds();
    for (const gone of ["R6.2a", "R6.7c", "R6.7d", "S8.1", "R6.2b", "R5.rc"]) expect(ids).not.toContain(gone);
    for (const s of RELEASE_STEPS) {
      for (const c of s.cmds) expect(c.join(" "), s.id).not.toMatch(/credentials-init|rebind-members|\bretire\b|tmux|--legacy|--session(?!s)|--project\b/);
    }
    // red control: a stage journal at the previous list's hash no longer satisfies SP.8.
    const OLD_HASH = "7c8b4bd9a0a4c43ea92dbf4b7ef4b0c0d30c6a0a65ab6d1f40c8c7f5d0a1e9b2";
    expect(OLD_HASH).not.toBe(stepListHash());
    const journal: RunJournal = {
      version: 1, target: "stage", rmEnv: "stage", release: RELEASE, commit: SHA, tree: TREE, stepListHash: OLD_HASH, stepIds: ids, goSha256: "x", runTs: "20261008T000000Z",
      startedAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z", status: "passed",
      steps: Object.fromEntries(ids.map((id) => [id, { id, status: "ok", exit: 0, expectExit: 0, startedAt: "2026-10-08T00:00:00.000Z", endedAt: "2026-10-08T00:00:01.000Z", receipts: [], attempt: 1 }])),
    };
    expect(checkStageJournal(journal, { stepListHash: stepListHash(), tree: TREE, stepIds: ids }).join()).toContain(`used step list ${OLD_HASH.slice(0, 12)}`);
    expect(checkStageJournal({ ...journal, stepListHash: stepListHash() }, { stepListHash: stepListHash(), tree: TREE, stepIds: ids })).toEqual([]);
  });

  test("no release script imports the supported-baseline constant (issue 1272)", () => {
    const dir = join(repoRoot, "scripts", "release");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/from\s+["'][^"']*supported-releases(\.ts)?["']/);
    }
  });

  test("a one-time step a release's runbook adds is gated on a receipt's absence; the template holds none", () => {
    expect(RELEASE_STEPS.some((s) => s.gateAbsent !== undefined)).toBe(false);
    const prod = loadTarget(join(targetsDir, "prod.json"));
    const oneTime: RunbookStep = {
      id: "D6.2a", added: "v0.7.0", standing: [], description: "one-time credential file", host: "target", irreversible: false, expectExit: 0, receipts: [],
      gateAbsent: "{home}/.config/robotmoney/credential.json", cmds: [["bun", "scripts/release/credentials-init.ts", "--receipt-dir", "{home}/r"]],
    };
    const at = RELEASE_STEPS.findIndex((s) => s.id === "R6.2") + 1;
    const runbook: ReleaseRunbook = { release: "v0.7.0", template: "kitchen-sink", recovery: "fix forward", steps: [...RELEASE_STEPS.slice(0, at), oneTime, ...RELEASE_STEPS.slice(at)] };
    expect(checkAddOnly(loadTemplate(), runbook)).toEqual([]);
    expect(stepListHash(runbook.steps)).not.toBe(stepListHash());
    const r = renderStep(oneTime, prod, templateValues(prod, SHA, "20261008T000000Z"));
    expect(r.remote).toContain(`if test -e ${prod.home}/.config/robotmoney/credential.json; then echo`);
    expect(r.remote).toContain("credentials-init.ts");
  });

  test("the rendered commands differ only by the target's values", () => {
    // Drop every word that carries a target value (and every env assignment);
    // what is left is the commands' shape, which must be the same for both.
    const shape = (t: typeof prod, steps: readonly StepTemplate[] = RELEASE_STEPS) => {
      const values = templateValues(t, SHA, "20261008T000000Z");
      const own = [...Object.entries(values).filter(([k]) => k !== "target" && k !== "release").map(([, v]) => v), t.host, t.capture.host]
        .filter((v) => v.length >= 3);
      const carriesValue = (w: string) => /^[A-Z_]+=/.test(w) || /robotmoney-release\/|rm-backup-/.test(w) || w === t.name || own.some((v) => w.includes(v));
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

  test("the prod-only tag is data: the hash is shared, and dropping onlyFor changes it; the rc is no step (D64)", () => {
    const tags = RELEASE_STEPS.filter((s) => s.onlyFor === "prod").map((s) => s.id);
    expect(tags).toEqual(["C1"]);
    expect(RELEASE_STEPS.filter((s) => s.host === "control").map((s) => s.id)).toEqual(["C0", "C1", "C9"]);
    expect(RELEASE_STEPS.some((s) => s.id === "R5.rc" || s.cmds.some((c) => c.includes("rc")))).toBe(false);
    const unmarked = RELEASE_STEPS.map((s) => (s.id === "C1" ? { ...s, onlyFor: undefined } : s));
    expect(stepListHash(unmarked)).not.toBe(stepListHash());
    const ids = stepIds();
    expect(ids.indexOf("R2.5")).toBe(ids.indexOf("C0") - 1);
    expect(ids.indexOf("R2.4r")).toBe(ids.indexOf("R2.2") + 1);
    expect(ids.slice(-4)).toEqual(["W1", "W2", "R7.4a", "W3"]);
    expect(RELEASE_STEPS.filter((s) => s.notBefore).map((s) => [s.id, s.notBefore!.afterStep, s.notBefore!.hours])).toEqual([["W1", "R6.9", "watchHours"], ["W2", "R6.9", "watchHours"], ["R7.4a", "R6.9", "watchHours"], ["W3", "R6.9", "watchHours"]]);
    // red control: W1 never hard-codes deferral; the target's watchSessions decides, since READY.
    const w1 = RELEASE_STEPS.find((s) => s.id === "W1")!.cmds[0]!;
    expect(w1).not.toContain("--defer-sessions");
    expect(w1.join(" ")).toContain("--sessions {watchSessions}");
    expect(w1).toContain("{readyIso}");
  });
});

describe("R2.5 grades the running stack from the release checkout; every target step runs there", () => {
  test("R2.5 runs prod:gate --mode baseline for the instance from the release checkout, under RM_ENV, on both targets", () => {
    for (const t of [loadTarget(join(targetsDir, "prod.json")), loadTarget(join(targetsDir, "stage.json"))]) {
      const r = renderStep(RELEASE_STEPS.find((s) => s.id === "R2.5")!, t, templateValues(t, SHA, "20261008T000000Z"));
      expect(r.remote).toContain(`cd ${t.checkout} && env -i HOME=${t.home} PATH=${REMOTE_PATH} LANG=C.UTF-8 RM_ENV=${t.rmEnv} bun run prod:gate --mode baseline --instance ${t.instance}`);
    }
  });
  test("every target step runs from the release checkout; no step names another checkout", () => {
    const t = loadTarget(join(targetsDir, "prod.json"));
    const values = templateValues(t, SHA, "20261008T000000Z");
    for (const s of RELEASE_STEPS.filter((x) => x.host === "target")) {
      expect(renderStep(s, t, values).remote).toContain(`cd ${t.checkout} && `);
    }
  });
});

// The ledger is reconciled with backend/migrations and the bytes at the tag the
// running stack reports (D67; issues 1272, 1273): a 116-row ledger passes, an
// unknown name refuses by name, an edited applied file refuses with both
// hashes, a count never decides, and neither does the number order. R1.2 and
// R2.3 share one helper; precondition.ts stays pure over its receipt.
describe("the ledger reconciliation (R1.2, R2.3): 116 rows pass, an unknown name refuses, the bytes are pinned, no number order", () => {
  const repo = repoMigrations();
  /** A 116-row ledger: the first 116 repository files, as production held after v0.6.0. */
  const ledger116 = repo.slice(0, 116);
  const UNKNOWN = "0999_never_shipped.sql";
  /** The checkout's own tree, tagged, so check 3 has a pin to resolve. */
  const work = mkdtempSync(join(tmpdir(), "rm-release-ledger-"));
  const migrationsDir = join(work, "backend", "migrations");
  spawnSync("mkdir", ["-p", migrationsDir]);
  spawnSync("cp", ["-r", `${join(repoRoot, "backend", "migrations")}/.`, migrationsDir]);
  const vcs = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: work, encoding: "utf8" });
  vcs("init", "-q", "-b", "main");
  vcs("add", ".");
  vcs("commit", "-q", "-m", "release");
  vcs("tag", "v0.6.0");
  const TAG_COMMIT = vcs("rev-parse", "v0.6.0^{commit}").stdout.trim();
  const at = (ledger: readonly string[], pinRef?: string) => reconcileLedger(ledger, { migrationsDir, ...(pinRef ? { pinRef } : {}) });

  test("the repository holds at least 116 migrations, so the fixture is a real prefix", () => {
    expect(repo.length).toBeGreaterThanOrEqual(116);
    expect(ledger116).toHaveLength(116);
    expect(ledger116).toContain(IDENTITY_MIGRATION);
  });

  test("a 116-row ledger passes R1.2 and R2.3 against the tag; the pending set is the rest of the repository", () => {
    const receipt = at(ledger116, "v0.6.0");
    expect(receipt.verdict).toBe("ok");
    expect(receipt.pinCommit).toBe(TAG_COMMIT);
    expect(receipt.perFile).toHaveLength(116);
    expect(receipt.pending).toEqual(repo.slice(116));
    expect(ledgerProblems(receipt)).toEqual([]);
    expect(preconditionProblems({ rmEnv: "prod", ledger: ledger116, identity: "production", reconcile: receipt })).toEqual([]);
    expect(preconditionProblems({ rmEnv: "stage", ledger: ledger116, identity: "rehearsal", reconcile: receipt })).toEqual([]);
    expect(baselineProblems(receipt, [])).toEqual([]);
    // The whole repository recorded: nothing pending. A shorter ledger passes too: the count never decides.
    expect(at(repo, "v0.6.0").pending).toEqual([]);
    expect(at(repo.slice(0, 76), "v0.6.0").verdict).toBe("ok");
  });

  test("red: one filename backend/migrations lacks refuses, naming it (R1.2 and R2.3)", () => {
    const withUnknown = [...ledger116, UNKNOWN];
    const receipt = at(withUnknown, "v0.6.0");
    expect(receipt.verdict).toBe("ledger-not-subset");
    expect(ledgerProblems(receipt).join()).toContain(UNKNOWN);
    expect(preconditionProblems({ rmEnv: "prod", ledger: withUnknown, identity: "production", reconcile: receipt }).join()).toContain(UNKNOWN);
    expect(baselineProblems(receipt, []).join()).toContain(UNKNOWN);
    expect(ledgerNotInRepo(withUnknown, repo)).toEqual([UNKNOWN]);
    // green control: an empty ledger reconciles; the identity rules still apply.
    expect(at([], "v0.6.0").verdict).toBe("ok");
  });

  test("no number order (D67): a ledger that skips a file below its newest row passes, and so does production's out-of-order set", () => {
    // The 1272 gap rule refused this; the issue 1273 rule reads no number.
    const gapped = ledger116.filter((n) => n !== ledger116[3]);
    const receipt = at(gapped, "v0.6.0");
    expect(receipt.verdict).toBe("ok");
    expect(receipt.pending).toContain(ledger116[3]!);
    // 0032 after 0033, 0061 after 0062, 0056 to 0062 after 0081: the names alone are read.
    const shuffled = [...ledger116].reverse();
    expect(at(shuffled, "v0.6.0").verdict).toBe("ok");
  });

  test("red: an applied file edited after the tag refuses with both hashes; a pending file edited does not", () => {
    const applied = ledger116[0]!;
    writeFileSync(join(migrationsDir, applied), `${readFileSync(join(migrationsDir, applied), "utf8")}\n-- edited after it ran\n`);
    try {
      const receipt = at(ledger116, "v0.6.0");
      expect(receipt.verdict).toBe("bytes-differ");
      const file = receipt.perFile.find((f) => f.name === applied)!;
      expect(file.verdict).toBe("bytes-differ");
      expect(file.pinSha256).not.toBeNull();
      expect(file.pinSha256).not.toBe(file.sha256);
      expect(ledgerProblems(receipt).join()).toContain(applied);
      // The same edit on a file the ledger does not record is not an applied-bytes difference.
      expect(at(ledger116.filter((n) => n !== applied), "v0.6.0").verdict).toBe("ok");
    } finally {
      vcs("checkout", "--", join("backend", "migrations", applied));
    }
  });

  test("red: an unresolvable pin ref refuses with pin-ref-unresolved and no fallback; no pin ref skips check 3 and says so", () => {
    const unresolved = at(ledger116, "v9.9.9");
    expect(unresolved.verdict).toBe("pin-ref-unresolved");
    expect({ pinCommit: unresolved.pinCommit, perFile: unresolved.perFile }).toEqual({ pinCommit: null, perFile: [] });
    expect(preconditionProblems({ rmEnv: "prod", ledger: ledger116, identity: "production", reconcile: unresolved }).join()).toContain("pin-ref-unresolved");
    const unpinned = at(ledger116);
    expect({ verdict: unpinned.verdict, pinRef: unpinned.pinRef, perFile: unpinned.perFile }).toEqual({ verdict: "ok", pinRef: null, perFile: [] });
  });

  test("the pin ref is the running stack's tag, else its commit; a stack reporting no version gives none", () => {
    const sha = "a".repeat(40);
    expect(runningPinRef({ commit: sha, tag: "v0.6.0" })).toBe("v0.6.0");
    expect(runningPinRef({ commit: sha, tag: null })).toBe(sha);
    const parsed = parseRunningVersion(JSON.stringify({ commit: sha, tag: "v0.6.0" }));
    expect("error" in parsed ? parsed : runningPinRef(parsed)).toBe("v0.6.0");
    expect(parseRunningVersion(null)).toHaveProperty("error");
    expect(parseRunningVersion(JSON.stringify({ commit: `${sha}+dirty` }))).toHaveProperty("error");
    // R1.2 and R2.3 hand the running stack's origin to their scripts.
    for (const id of ["R1.2", "R2.3"]) {
      const cmd = RELEASE_STEPS.find((s) => s.id === id)!.cmds[0]!;
      expect(cmd[cmd.indexOf("--origin") + 1]).toBe("{publicOrigin}");
    }
  });

  test("red: the wrong identity, 0081 without a row, no RM_ENV", () => {
    const receipt = at(ledger116, "v0.6.0");
    expect(preconditionProblems({ rmEnv: "prod", ledger: ledger116, identity: "rehearsal", reconcile: receipt }).join()).toContain("rehearsal");
    expect(preconditionProblems({ rmEnv: "stage", ledger: ledger116, identity: "production", reconcile: receipt }).join()).toContain("production");
    expect(preconditionProblems({ rmEnv: "prod", ledger: ledger116, identity: null, reconcile: receipt }).join()).toContain(`${IDENTITY_MIGRATION} but deployment_identity has no row`);
    expect(preconditionProblems({ rmEnv: undefined, ledger: ledger116, identity: null, reconcile: receipt }).length).toBe(1);
    // A pre-identity ledger with no row passes: the first migrate writes the row.
    const before81 = repo.filter((n) => n < IDENTITY_MIGRATION);
    expect(preconditionProblems({ rmEnv: "prod", ledger: before81, identity: null, reconcile: at(before81, "v0.6.0") })).toEqual([]);
  });
});

describe("the go file (D61 rule 1, D70): the ref, the operator, the date", () => {
  const expected = { release: "v0.6.0", target: "stage", rmEnv: "stage" as const };
  const good = `# owner go\ncommit: ${SHA}\noperator: lucas\ndate: 2026-10-14\n`;
  const prodExpected = { release: "v0.6.0", target: "prod", rmEnv: "prod" as const };
  const prodGood = good.replace(`commit: ${SHA}`, "tag: v0.6.0-rc.3");

  test("a stage go passes with its hash; the release and target come from the run, never the file", () => {
    const r = validateGo(good, expected);
    expect("go" in r && r.go.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect("go" in r && r.go.commit).toBe(SHA);
    expect("go" in r && r.go.tag).toBeUndefined();
    expect("go" in r && [r.go.release, r.go.target, r.go.operator, r.go.date]).toEqual(["v0.6.0", "stage", "lucas", "2026-10-14"]);
    const other = validateGo(good.replace(SHA, OTHER_SHA), expected);
    expect("go" in other && other.go.commit).toBe(OTHER_SHA);
  });

  test("a production go names the rc tag of its release, never a commit", () => {
    const r = validateGo(prodGood, prodExpected);
    expect("go" in r && r.go.tag).toBe("v0.6.0-rc.3");
    expect("go" in r && r.go.commit).toBeUndefined();
    const bare = validateGo(good, prodExpected);
    expect("errors" in bare && bare.errors.join()).toContain("a bare commit does not authorize a production run");
    expect((validateGo(`${prodGood}commit: ${SHA}\n`, prodExpected) as { errors: string[] }).errors.join()).toContain("both commit and tag");
    expect("errors" in validateGo(prodGood.replace(/tag: .*\n/, ""), prodExpected)).toBe(true);
    expect("errors" in validateGo(prodGood.replace("v0.6.0-rc.3", "v0.6.1-rc.0"), prodExpected)).toBe(true);
    expect("errors" in validateGo(prodGood.replace("v0.6.0-rc.3", "v0.6.0"), prodExpected)).toBe(true);
    expect("errors" in validateGo(prodGood.replace("v0.6.0-rc.3", "releases-0.6.x"), prodExpected)).toBe(true);
    const stageTag = validateGo(prodGood, expected);
    expect("errors" in stageTag && stageTag.errors.join()).toContain("never names a tag");
  });

  test("where a run's commit lives (D70): stage on a QA branch of the line, prod on the release branch", () => {
    expect(releaseBranch("v0.6.1")).toBe("releases-0.6.x");
    expect(releaseBranch("v1.12.0")).toBe("releases-1.12.x");
    expect(qaBranchPrefix("v0.6.2")).toBe("qa/0.6.x-");
    expect(() => releaseBranch("main")).toThrow();
    expect(originProblems("v0.6.1", SHA, "  origin/main\n  origin/releases-0.6.x\n")).toEqual([]);
    expect(originProblems("v0.6.1", SHA, "  origin/main\n").join()).toContain("not on origin/releases-0.6.x");
    expect(originProblems("v0.6.1", SHA, "  origin/qa/0.6.x-2026-10-10\n").join()).toContain("not on origin/releases-0.6.x");
    expect(originProblems("v0.6.1", SHA, "").join()).toContain("no branch of origin");
    expect(originProblems("v0.6.1", SHA, "  origin/qa/0.6.x-2026-10-10\n", "stage")).toEqual([]);
    expect(originProblems("v0.6.1", SHA, "  origin/qa/0.6.x-2026-10-10-2\n", "stage")).toEqual([]);
    // red controls: stage refuses the release branch alone, a PR head, and another line's QA branch.
    expect(originProblems("v0.6.1", SHA, "  origin/releases-0.6.x\n", "stage").join()).toContain("not on a QA branch");
    expect(originProblems("v0.6.1", SHA, "  origin/fix/x\n", "stage")).toHaveLength(1);
    expect(originProblems("v0.6.1", SHA, "  origin/qa/0.7.x-2026-10-10\n", "stage")).toHaveLength(1);
    expect(originProblems("v0.7.0", SHA, "  origin/releases-0.6.x\n")).toHaveLength(1);
  });

  test("red: retired keys, an unknown or missing key, a short sha, a bad date", () => {
    expect(validateGo(good.replace(/commit: .*\n/, ""), expected)).toEqual({ errors: ["the go names no commit; a stage go names a commit on a QA branch qa/0.6.x-<date> (D70)"] });
    for (const [key, where] of [["release: v0.6.0", "target file"], ["target: stage", "--target"], ["recovery: /root/m.md", "runbook YAML"]] as const) {
      const r = validateGo(`${good}${key}\n`, expected);
      expect("errors" in r && r.errors.join(), key).toContain(where);
    }
    expect("errors" in validateGo(`${good}skip: R2.5\n`, expected)).toBe(true);
    expect("errors" in validateGo(good.replace(SHA, "a502de30"), expected)).toBe(true);
    expect(validateGo(good.replace(/operator: .*\n/, ""), expected)).toEqual({ errors: ["the go names no operator"] });
    expect(validateGo(good.replace(/date: .*\n/, ""), expected)).toEqual({ errors: ["the go names no date"] });
    expect("errors" in validateGo(good.replace("2026-10-14", "14 Oct"), expected)).toBe(true);
  });
});

function journal(patch: Partial<RunJournal> = {}): RunJournal {
  const ids = stepIds();
  return {
    version: 1, target: "stage", rmEnv: "stage", release: "v0.6.0", commit: SHA, tree: TREE, stepListHash: stepListHash(), stepIds: ids,
    goSha256: "g", runTs: "20261008T000000Z", startedAt: "", updatedAt: "", status: "passed",
    steps: Object.fromEntries(ids.map((id) => [id, { id, status: "ok", exit: 0, expectExit: 0, startedAt: "", receipts: [], attempt: 1 }])),
    ...patch,
  } as RunJournal;
}

describe("SP.8: prod runs only what stage passed", () => {
  const expected = { stepListHash: stepListHash(), tree: TREE, stepIds: stepIds() };

  test("a passed stage journal on the same tree and hash lets prod start, whatever commit stage ran (D70)", () => {
    expect(checkStageJournal(journal(), expected)).toEqual([]);
    // Stage ran the QA commit; production runs the squash commit with the same tree.
    expect(checkStageJournal(journal({ commit: OTHER_SHA }), expected)).toEqual([]);
  });

  test("red: missing, another hash, another tree, no tree, a failed step, a prod journal", () => {
    expect(checkStageJournal(undefined, expected).join()).toContain("no stage run journal");
    expect(checkStageJournal(journal({ stepListHash: "f".repeat(64) }), expected).join()).toContain("step list");
    expect(checkStageJournal(journal({ tree: OTHER_TREE }), expected).join()).toContain("tree");
    expect(checkStageJournal(journal({ tree: undefined }), expected).join()).toContain("records no tree");
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

function fixture(rmEnv: "stage" | "prod" = "stage", overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-run-"));
  const raw = rmEnv === "prod" ? prodRaw() : JSON.parse(readFileSync(join(targetsDir, "stage.json"), "utf8"));
  raw.confirmTarget = "db.example.com:25060/rm";
  Object.assign(raw, overrides);
  const name = rmEnv === "prod" ? "prod" : "stage";
  const targetFile = join(dir, `${name}.json`);
  writeFileSync(targetFile, JSON.stringify(raw));
  const goFile = join(dir, "go.txt");
  writeFileSync(goFile, `${rmEnv === "prod" ? `tag: ${TAG}` : `commit: ${SHA}`}\noperator: lucas\ndate: 2026-10-14\n`);
  return { dir, targetFile, goFile, journalRoot: join(dir, "journal") };
}

/** What the control machine and the live-checkout probe answer in a preflight, by command fragment. */
const GREEN_CI = REQUIRED_CI.map((n) => `${n}\tcompleted\tsuccess`).join("\n");
const PREFLIGHT_ANSWERS: Record<string, { code: number; stdout: string }> = {
  "git rev-parse HEAD": { code: 0, stdout: `${SHA}\n` },
  "git status --porcelain": { code: 0, stdout: "" },
  "git branch -r --contains": { code: 0, stdout: `  origin/${releaseBranch(RELEASE)}\n  origin/${qaBranchPrefix(RELEASE)}2026-10-14\n` },
  // The commit's tree (D70: SP.8 compares trees).
  "^{tree}": { code: 0, stdout: `${TREE}\n` },
  // The control machine resolves the production go's rc tag (D64).
  [`git rev-parse --verify --quiet '${TAG}^{commit}'`]: { code: 0, stdout: `${SHA}\n` },
  "gh api": { code: 0, stdout: `${GREEN_CI}\n` },
  "docker ps -q": { code: 0, stdout: "0\n" },
  // Stage's P.lockfile: a fresh resolve gives the committed lockfiles.
  "lockfile.ts check": { code: 0, stdout: "fresh\n" },
};

function fakeDeps(opts: { fail?: Set<string>; out?: string; receipt?: string; answers?: Record<string, { code: number; stdout: string }>; recovery?: string | null } = {}) {
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
      const answers = { ...PREFLIGHT_ANSWERS, ...opts.answers };
      // A test's own answers win over the defaults, so a specific fragment can override a general one.
      const hit = Object.keys(opts.answers ?? {}).find((k) => remote.includes(k)) ?? Object.keys(PREFLIGHT_ANSWERS).find((k) => remote.includes(k));
      if (hit !== undefined) return answers[hit]!;
      return { code: 1, stdout: "" };
    },
    readText: (p) => {
      // The release's runbook YAML (SC.1): the fixture's recovery decision, or none.
      if (p.endsWith(`/runbooks/releases/${RELEASE}.yaml`)) return opts.recovery === null ? `release: ${RELEASE}\n` : `release: ${RELEASE}\nrecovery: ${opts.recovery ?? "fix forward"}\n`;
      try { return readFileSync(p, "utf8"); } catch { return undefined; }
    },
    now: () => new Date("2026-10-08T12:00:00Z"),
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
    home: "/nonexistent",
  };
  return { deps, ran, logs };
}

describe("runRelease", () => {
  test("refuses without a go file, and with a production go on stage; --preflight needs none", async () => {
    const f = fixture();
    const a = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--journal-root", f.journalRoot], a.deps, TINY)).toBe(2);
    expect(a.ran).toEqual([]);
    expect(a.logs.join("\n")).toContain("no --go");
    writeFileSync(f.goFile, `tag: ${TAG}\noperator: lucas\ndate: 2026-10-14\n`);
    const b = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], b.deps, TINY)).toBe(2);
    expect(b.ran).toEqual([]);
    const c = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--preflight", "--journal-root", f.journalRoot], c.deps, TINY)).toBe(0);
    expect(c.ran).toEqual(["T1"]);
    expect(c.logs.join("\n")).toMatch(/PENDING\s+P\.go/);
  });

  test("the go's commit is rendered into every {commit}; a preflight without a go uses the control checkout's HEAD", async () => {
    const CHECKOUT: StepTemplate[] = [
      { id: "C1", standing: [], description: "detach", host: "target", cmds: [["checkout", "--detach", "{commit}"]], expectExit: 0, receipts: [], irreversible: false },
    ];
    const f = fixture();
    const seen: string[] = [];
    const a = fakeDeps();
    const exec = a.deps.exec;
    a.deps.exec = async (h, r, o, e) => { seen.push(r); return exec(h, r, o, e); };
    expect(await runRelease(["--target", f.targetFile, "--dry-run", "--journal-root", f.journalRoot], a.deps, CHECKOUT)).toBe(0);
    expect(seen.join()).toContain(`--detach ${SHA}`);
    writeFileSync(f.goFile, `commit: ${OTHER_SHA}\noperator: lucas\ndate: 2026-10-14\n`);
    // A go naming another commit than the control checkout's HEAD is red: the printed step list is not that commit's.
    const b = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--preflight", "--journal-root", f.journalRoot], b.deps, CHECKOUT)).toBe(2);
    expect(b.logs.join("\n")).toMatch(/RED\s+P\.commit/);
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

    // red control: a prod go naming an rc at another commit than the stage run passed at refuses (SP.8).
    writeFileSync(f.goFile, `tag: ${RELEASE}-rc.1\noperator: lucas\ndate: 2026-10-14\n`);
    const d = fakeDeps({ receipt: "{}", answers: {
      [`git rev-parse --verify --quiet '${RELEASE}-rc.1^{commit}'`]: { code: 0, stdout: `${OTHER_SHA}\n` },
      [`${OTHER_SHA}^{tree}`]: { code: 0, stdout: `${OTHER_TREE}\n` },
    } });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", join(f.dir, "j3"), "--stage-journal", stageDir], d.deps, TINY)).toBe(2);
    expect(d.ran).toEqual([]);
    expect(d.logs.join("\n")).toContain("commit");
  });

  test("D64: a production go's tag resolves on the control machine; a tag origin lacks refuses before any step", async () => {
    const f = fixture("prod");
    const seen: string[] = [];
    const a = fakeDeps({ receipt: "{}" });
    const collect = a.deps.collect;
    a.deps.collect = async (h, r) => { seen.push(r); return collect(h, r); };
    const r = await resolveGo({ release: RELEASE, tag: TAG, target: "prod", operator: "lucas", date: "2026-10-14", sha256: "s" }, a.deps);
    expect("go" in r && r.go.commit).toBe(SHA);
    expect("go" in r && r.go.ref).toBe(TAG);
    expect(seen[0]).toContain("git fetch -q --tags origin");
    // A stage go resolves without git.
    expect(await resolveGo({ release: RELEASE, commit: SHA, target: "stage", operator: "lucas", date: "2026-10-14", sha256: "s" }, { collect: async () => { throw new Error("never"); } })).toEqual({ go: { release: RELEASE, commit: SHA, target: "stage", operator: "lucas", date: "2026-10-14", sha256: "s", ref: SHA } });
    // red control: an unknown tag refuses the run, and nothing ran.
    writeFileSync(f.goFile, `tag: ${RELEASE}-rc.9\noperator: lucas\ndate: 2026-10-14\n`);
    const b = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], b.deps, TINY)).toBe(2);
    expect(b.ran).toEqual([]);
    expect(b.logs.join("\n")).toContain(`${RELEASE}-rc.9, which origin has no tag for`);
  });

  test("D70: stage refuses a commit off a QA branch, prod one off the release branch; the journal records the tag and the tree", async () => {
    const s = fixture("stage");
    const off = fakeDeps({ receipt: "{}", answers: { "git branch -r --contains": { code: 0, stdout: `  origin/main\n  origin/${releaseBranch(RELEASE)}\n` } } });
    expect(await runRelease(["--target", s.targetFile, "--go", s.goFile, "--journal-root", s.journalRoot], off.deps, TINY)).toBe(2);
    expect(off.ran).toEqual([]);
    expect(off.logs.join("\n")).toContain("not on a QA branch");
    // Green: on a QA branch the stage run passes, and prod runs the rc on the same tree.
    const st = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", s.targetFile, "--go", s.goFile, "--journal-root", s.journalRoot], st.deps, TINY)).toBe(0);
    const stageDir = join(s.journalRoot, "stage", "20261008T120000Z");
    expect((JSON.parse(readFileSync(join(stageDir, "run.json"), "utf8")) as RunJournal).tag).toBeUndefined();
    const p = fixture("prod");
    const pOff = fakeDeps({ receipt: "{}", answers: { "git branch -r --contains": { code: 0, stdout: "  origin/main\n" } } });
    expect(await runRelease(["--target", p.targetFile, "--go", p.goFile, "--journal-root", p.journalRoot, "--stage-journal", stageDir], pOff.deps, TINY)).toBe(2);
    expect(pOff.ran).toEqual([]);
    const seen: string[] = [];
    const pr = fakeDeps({ receipt: "{}" });
    const exec = pr.deps.exec;
    pr.deps.exec = async (h, r, o, e) => { seen.push(r); return exec(h, r, o, e); };
    expect(await runRelease(["--target", p.targetFile, "--go", p.goFile, "--journal-root", p.journalRoot, "--stage-journal", stageDir], pr.deps, TINY)).toBe(0);
    const j = JSON.parse(readFileSync(join(p.journalRoot, "prod", "20261008T120000Z", "run.json"), "utf8")) as RunJournal;
    expect(j.commit).toBe(SHA);
    expect(j.tree).toBe(TREE);
    expect(j.tag).toBe(TAG);
    expect(pr.logs.join("\n")).toContain(`for ${RELEASE} ${TAG} (${SHA}) on prod`);
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
  test("the baseline refuses an in-house seat and an unknown ledger name; a reconciled ledger passes", () => {
    const repo = repoMigrations();
    expect(baselineProblems(reconcileLedger(repo.slice(0, 100)), [])).toEqual([]);
    expect(baselineProblems(reconcileLedger([...repo.slice(0, 100), "0999_x.sql"]), []).join()).toContain("0999_x.sql");
    expect(baselineProblems(reconcileLedger(repo.slice(0, 100)), [{ handle: "themis" }]).join()).toContain("themis");
    expect(WOULD_CLEAR_SQL).toContain("m.handle <> ALL (ARRAY['athena','noop-analyst','robot-money','themis'])");
  });
});

describe("host guards, the rolling cutover and identity (R6.3, R7.1, R7.7)", () => {
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
  test("the cutover is rolling: no step stops the stack, the probe brackets it, and the version tag follows the first irreversible step (owner, 2026-10-14)", () => {
    const ids = RELEASE_STEPS.map((s) => s.id);
    for (const s of RELEASE_STEPS) {
      for (const c of s.cmds) expect(c.join(" "), s.id).not.toMatch(/smoke:down|stop-legacy|compose down|\bdown\b/);
    }
    expect(ids).not.toContain("R6.1");
    expect(RELEASE_STEPS.find((s) => s.irreversible)?.id).toBe("R6.3");
    expect(RELEASE_STEPS.filter((s) => s.irreversible).map((s) => s.id)).toEqual(["R6.3"]);
    // The probe starts before the first irreversible step and is graded after the site switch.
    expect(ids.indexOf("C0")).toBeLessThan(ids.indexOf("R6.3"));
    expect(ids.indexOf("C9")).toBeGreaterThan(ids.indexOf("R6.10"));
    expect(ids.indexOf("C9")).toBeGreaterThan(ids.indexOf("R6.7a"));
    // The version tag is cut as soon as the cutover starts (D70), on prod only.
    expect(ids.indexOf("C1")).toBe(ids.indexOf("R6.3") + 1);
    expect(RELEASE_STEPS.find((s) => s.id === "C1")!.onlyFor).toBe("prod");
    for (const name of ["prod", "stage"]) {
      const t = loadTarget(join(targetsDir, `${name}.json`));
      const boot = renderStep(RELEASE_STEPS.find((s) => s.id === "R6.7a")!, t, templateValues(t, SHA, "20261008T000000Z")).remote;
      expect(boot).toContain(`bun run smoke --static-port --instance ${t.instance}`);
    }
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
    // D64: with the rc tag as the ref, /api/version must carry it as tag (RM_BUILD_TAG).
    expect(identityProblems(JSON.stringify({ api: "1.0.0", commit: SHA, tag: TAG }), `{"commit":"${SHA}"}`, SHA, TAG)).toEqual([]);
    expect(identityProblems(JSON.stringify({ api: "1.0.0", commit: SHA, tag: null }), `{"commit":"${SHA}"}`, SHA, TAG).join()).toContain(`tag is null, expected ${TAG}`);
    expect(identityProblems(JSON.stringify({ api: "1.0.0", commit: SHA, tag: `${RELEASE}-rc.1` }), `{"commit":"${SHA}"}`, SHA, TAG)).toHaveLength(1);
    // A commit ref (stage) asks nothing of the tag.
    expect(identityProblems(JSON.stringify({ api: "1.0.0", commit: SHA, tag: null }), `{"commit":"${SHA}"}`, SHA, SHA)).toEqual([]);
  });
});

// ── the scripted watch, tags, recovery and the host guard ─────────────────────
const WATCHED: StepTemplate[] = [
  { id: "R6.9", standing: [], description: "ready", host: "target", cmds: [["echo", "ready"]], expectExit: 0, receipts: [], irreversible: false },
  { id: "W1", standing: [], description: "watch", host: "target", notBefore: { afterStep: "R6.9", hours: 6 }, cmds: [["echo", "{readyIso}"]], expectExit: 0, receipts: [], irreversible: false },
  { id: "W3", standing: [], description: "tag", host: "control", onlyFor: "prod", cmds: [["echo", "W3"]], expectExit: 0, receipts: [], irreversible: false },
];

describe("watch steps, prod-only steps and the recovery decision", () => {
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

  test("a watchHours wait takes the target's watch length: READY + 37 h, not + 6 h", async () => {
    const steps: StepTemplate[] = WATCHED.map((s) => (s.id === "W1" ? { ...s, notBefore: { afterStep: "R6.9", hours: "watchHours" } } : s));
    // A graded watch at the derived length, as production runs it.
    const f = fixture("stage", { watchHours: 37, watchSessions: "graded" });
    const early = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], early.deps, steps)).toBe(3);
    expect(early.logs.join("\n")).toContain("W1 becomes runnable at 2026-10-10T01:00:00.000Z");
    expect(early.logs.join("\n")).toContain("+ 37 h");
    // red control: READY + 6 h is no longer enough.
    const six = fakeDeps();
    six.deps.now = () => new Date("2026-10-08T18:00:01Z");
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z"], six.deps, steps)).toBe(3);
    expect(six.ran).toEqual([]);
    const later = fakeDeps();
    later.deps.now = () => new Date("2026-10-10T01:00:01Z");
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z"], later.deps, steps)).toBe(0);
    expect(later.ran).toEqual(["W1"]);
  });

  test("the committed stage target soaks 30 minutes (owner, 2026-10-14)", async () => {
    const steps: StepTemplate[] = WATCHED.map((s) => (s.id === "W1" ? { ...s, notBefore: { afterStep: "R6.9", hours: "watchHours" } } : s));
    const f = fixture("stage");
    const early = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], early.deps, steps)).toBe(3);
    expect(early.logs.join("\n")).toContain("W1 becomes runnable at 2026-10-08T12:30:00.000Z");
    // red control: one second before READY + 30 min nothing runs.
    const before = fakeDeps();
    before.deps.now = () => new Date("2026-10-08T12:29:59Z");
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z"], before.deps, steps)).toBe(3);
    expect(before.ran).toEqual([]);
    const later = fakeDeps();
    later.deps.now = () => new Date("2026-10-08T12:30:01Z");
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z"], later.deps, steps)).toBe(0);
    expect(later.ran).toEqual(["W1"]);
  });

  test("red: a release runbook with no recovery decision refuses before anything runs (SC.1)", async () => {
    const f = fixture("stage");
    const a = fakeDeps({ recovery: null });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], a.deps, WATCHED)).toBe(2);
    expect(a.ran).toEqual([]);
    expect(a.logs.join("\n")).toContain("SC.1");
  });
});

describe("release tags (tag.ts rc after stage, C1)", () => {
  test("rc: the stage journal must have passed, for this release, on the squash commit's tree (D70)", () => {
    expect(rcStageProblems(journal(), "v0.6.0", TREE)).toEqual([]);
    expect(rcStageProblems(undefined, "v0.6.0", TREE).join()).toContain("no stage run journal");
    expect(rcStageProblems(journal(), "v0.6.0", OTHER_TREE).join()).toContain("is not this commit's tree");
    expect(rcStageProblems(journal({ tree: undefined }), "v0.6.0", TREE).join()).toContain("records no tree");
    expect(rcStageProblems(journal({ rmEnv: "prod" }), "v0.6.0", TREE).join()).toContain("not a stage run");
    expect(rcStageProblems(journal(), "v0.6.1", TREE).join()).toContain("not v0.6.1");
    const failed = journal();
    failed.steps["R6.3"]!.status = "failed";
    expect(rcStageProblems(failed, "v0.6.0", TREE).join()).toContain("did not pass");
  });

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
  test("24 h epochs, an on-time publish, a :30 regime cron and a live sweep pass", () => {
    expect(epochProblems([{ id: "eth", epoch_duration_seconds: 86400 }])).toEqual([]);
    expect(epochProblems([{ id: "eth", epoch_duration_seconds: 21600 }]).length).toBe(1);
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
  test("deferred (stage's 15-minute watch): a still-collecting in-flight session passes; graded fails it", () => {
    const collecting = [{ id: "s1", state: "collecting", window_closes_at: close, published_at: null, judging_duration_seconds: 900 }];
    expect(inFlightProblemsFor("deferred", base, collecting)).toEqual([]);
    expect(inFlightProblemsFor("graded", base, collecting).join()).toContain("not published");
  });
  test("red: deferred still fails a gone session and a moved close", () => {
    expect(inFlightCloseProblems(base, []).join()).toContain("gone");
    expect(inFlightCloseProblems(base, [{ id: "s1", state: "collecting", window_closes_at: "2026-10-08T13:00:00.000Z", published_at: null, judging_duration_seconds: 900 }]).join()).toContain("close moved");
    expect(inFlightCloseProblems(base, [{ id: "s1", state: "collecting", window_closes_at: null, published_at: null, judging_duration_seconds: 900 }]).join()).toContain("close moved");
  });
  test("--sessions: absent is graded; an unknown value refuses", () => {
    expect(parseSessionsFlag(undefined)).toBe("graded");
    expect(parseSessionsFlag("deferred")).toBe("deferred");
    expect(parseSessionsFlag("")).toHaveProperty("error");
    expect(parseSessionsFlag("skip")).toHaveProperty("error");
  });
});

describe("the postgres URL guard (R7.7)", () => {
  test("R7.7 scans the home only: no retired checkout, no legacy argument", () => {
    const t = loadTarget(join(targetsDir, "prod.json"));
    const r = renderStep(RELEASE_STEPS.find((s) => s.id === "R7.7")!, t, templateValues(t, SHA, "20261008T000000Z"));
    expect(r.remote).toContain(`bun scripts/release/host-guards.ts --instance ${t.instance} --receipt-dir`);
    expect(r.remote).not.toMatch(/--legacy-retired|-retired/);
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


// R1.2 proves every ~/.env key the cutover needs before R6.3 starts it:
// production's /root/.env once lacked rm_owner, and a run that migrated and
// then refused at R6.2 would have stopped mid-cutover. The runbook uses
// rm_owner only; no release step reads doadmin (D61 amendment, owner, 2026-10-08).
describe("the cutover's ~/.env keys are proven at R1.2, before the first irreversible step", () => {
  const ENV_PATH = "/root/.env";
  const SECRET = "Sup3r-s3cret-value";

  test("a non-empty rm_owner line passes", () => {
    expect(preCutoverKeyProblems({ rm_owner: SECRET, RM_CREDENTIALS: "/root/.config/robotmoney/credential.json" }, ENV_PATH)).toEqual([]);
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
    const ids = stepIds();
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

  test("every precondition check precedes the first irreversible step (R6.3)", () => {
    expect(RELEASE_STEPS[keyCheckIndex(RELEASE_STEPS)]?.id).toBe("R1.2");
    expect(RELEASE_STEPS[firstIrreversible(RELEASE_STEPS)]?.id).toBe("R6.3");
    expect(keysCheckedFirst(RELEASE_STEPS)).toBe(true);
    // R6.2, the defence-in-depth check, needs only keys R1.2 checked or the run wrote.
    for (const key of D61_REQUIRED_KEYS) expect(PRE_CUTOVER_REQUIRED_KEYS.includes(key) || key in RUN_WRITTEN_KEYS, key).toBe(true);
    const r12 = RELEASE_STEPS.find((s) => s.id === "R1.2")!;
    expect(r12.description).toContain("rm_owner logs in");
    expect(r12.description).toContain("RM_CREDENTIALS");
    expect(r12.description).not.toContain("R6.2a");
  });

  test("red: R1.2 moved after R6.3, or R1.2 without --confirm-target, fails the order check", () => {
    const r12 = RELEASE_STEPS.find((s) => s.id === "R1.2")!;
    const without = RELEASE_STEPS.filter((s) => s.id !== "R1.2");
    const r61 = without.findIndex((s) => s.id === "R6.3");
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
      expect(x.out).toMatch(/REFUSE: .*has no non-empty rm_owner.*; run `bun run role-passwords --target <target>` first/);
      expect(x.receipt).toContain(`"ownerLogin": "not-tried"`);
      clean(x);
    }, 60_000);

    test("red: an empty rm_owner line refuses like a missing one", () => {
      const x = run(`${conn}rm_owner=\n`);
      expect(x.out).toMatch(/REFUSE: .*has no non-empty rm_owner/);
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

// ── the preflight (--preflight, alias --dry-run): every check green, nothing live changes ──
describe("preflight", () => {
  const LANES: StepTemplate[] = [
    { id: "A1", standing: [], description: "target one", host: "target", cmds: [["echo", "A1"]], expectExit: 0, receipts: [], irreversible: false },
    { id: "A2", standing: [], description: "target two", host: "target", cmds: [["echo", "A2"]], expectExit: 0, receipts: [], irreversible: false },
    { id: "B1", standing: [], description: "capture", host: "capture", cmds: [["echo", "B1"]], expectExit: 0, receipts: [], irreversible: false },
    { id: "K1", standing: [], description: "tag", host: "control", cmds: [["echo", "K1"]], expectExit: 0, receipts: [], irreversible: false },
    { id: "X1", standing: [], description: "cutover", host: "target", cmds: [["echo", "X1"]], expectExit: 0, receipts: [], irreversible: true },
    { id: "A3", standing: [], description: "after", host: "target", cmds: [["echo", "A3"]], expectExit: 0, receipts: [], irreversible: false },
  ];
  const preflight = (f: ReturnType<typeof fixture>, deps: RunnerDeps, extra: string[] = [], steps = LANES) =>
    runRelease(["--target", f.targetFile, "--preflight", "--journal-root", f.journalRoot, ...extra], deps, steps);
  const report = (f: ReturnType<typeof fixture>, target = "stage") =>
    JSON.parse(readFileSync(join(f.journalRoot, target, "preflight-20261008T120000Z", "preflight.json"), "utf8")) as { exit: number; checks: { id: string; status: string; detail: string }[] };
  const status = (r: ReturnType<typeof report>, id: string) => r.checks.find((c) => c.id === id)?.status;

  test("the real step list: the preflight runs R1.1 to R2.5, never R6.3 or anything after", () => {
    const ids = preflightSteps(RELEASE_STEPS).map((s) => s.id);
    expect(ids).toEqual(["R1.1", "R1.2", "R1.3", "R1.4", "R1.5", "R1.6", "R2.1", "R2.2", "R2.4r", "R2.3", "R2.5"]);
    expect(preflightSteps(RELEASE_STEPS).some((s) => s.irreversible || s.host === "control")).toBe(false);
  });

  test("without a go: runs only the remote steps before the first irreversible one, the go is pending, exit 0, no run journal", async () => {
    const f = fixture();
    const a = fakeDeps();
    expect(await preflight(f, a.deps)).toBe(0);
    // The target lane first, then the capture lane, in the run's order.
    expect(a.ran).toEqual(["A1", "A2", "B1"]);
    const r = report(f);
    expect(status(r, "P.go")).toBe("pending");
    expect(status(r, "P.recovery")).toBe("green");
    expect(status(r, "P.commit")).toBe("green");
    expect(status(r, "P.ci")).toBe("green");
    expect(r.checks.find((c) => c.id === "P.stage")).toBeUndefined();
    expect(readdirSync(join(f.journalRoot, "stage"))).toEqual(["preflight-20261008T120000Z"]);
  });

  test("with a valid go: the go and the recovery decision are green", async () => {
    const f = fixture();
    const a = fakeDeps();
    expect(await preflight(f, a.deps, ["--go", f.goFile])).toBe(0);
    expect(status(report(f), "P.go")).toBe("green");
    expect(status(report(f), "P.recovery")).toBe("green");
  });

  test("red: a release runbook with no recovery decision", async () => {
    const f = fixture();
    expect(await preflight(f, fakeDeps({ recovery: null }).deps, ["--go", f.goFile])).toBe(2);
    expect(status(report(f), "P.recovery")).toBe("red");
  });

  test("red: no CI on the commit, a commit on no origin branch, a dirty control checkout", async () => {
    const f = fixture();
    const a = fakeDeps({ answers: { "gh api": { code: 0, stdout: "" }, "git branch -r --contains": { code: 0, stdout: "" }, "git status --porcelain": { code: 0, stdout: " M x.ts\n" } } });
    expect(await preflight(f, a.deps)).toBe(2);
    const r = report(f);
    expect(status(r, "P.ci")).toBe("red");
    expect(status(r, "P.origin")).toBe("red");
    expect(status(r, "P.commit")).toBe("red");
  });

  test("red: a live release checkout blocks its steps on that host", async () => {
    const f = fixture();
    const a = fakeDeps({ answers: { "docker ps -q": { code: 0, stdout: "3\n" } } });
    expect(await preflight(f, a.deps)).toBe(2);
    expect(a.ran).toEqual([]);
    const r = report(f);
    expect(status(r, "P.live.target")).toBe("red");
    expect(status(r, "A1")).toBe("blocked");
    expect(status(r, "B1")).toBe("blocked");
  });

  test("red: a target file that still carries a legacy block refuses before any check", async () => {
    const f = fixture("stage", { legacy: { checkout: "/home/stage-server/rm-stage-legacy", tmuxSession: "stage-driver" } });
    const a = fakeDeps();
    expect(await preflight(f, a.deps)).toBe(2);
    expect(a.ran).toEqual([]);
    expect(a.logs.join("\n")).toContain('"legacy" is not a target key');
  });

  test("red: a run of the same target in flight blocks every remote step", async () => {
    const f = fixture();
    // A run that stops before its watch window stays incomplete; one killed mid-step reads running.
    const r = fakeDeps({ fail: new Set(["T2"]), receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], r.deps, TINY)).toBe(1);
    const runFile = join(f.journalRoot, "stage", "20261008T120000Z", "run.json");
    writeFileSync(runFile, JSON.stringify({ ...JSON.parse(readFileSync(runFile, "utf8")), status: "running" }));
    const a = fakeDeps();
    a.deps.now = () => new Date("2026-10-08T12:00:01Z");
    expect(await preflight(f, a.deps)).toBe(2);
    expect(a.ran).toEqual([]);
    const rep = JSON.parse(readFileSync(join(f.journalRoot, "stage", "preflight-20261008T120001Z", "preflight.json"), "utf8")) as ReturnType<typeof report>;
    expect(status(rep, "P.busy")).toBe("red");
    expect(status(rep, "A1")).toBe("blocked");
    expect(status(rep, "B1")).toBe("blocked");
  });

  test("a failed step blocks the rest of its lane only (prod: the capture host is another lane)", async () => {
    const f = fixture("prod");
    const a = fakeDeps({ fail: new Set(["A1"]) });
    expect(await preflight(f, a.deps)).toBe(2);
    expect(a.ran).toEqual(["A1", "B1"]);
    const r = report(f, "prod");
    expect(status(r, "A1")).toBe("red");
    expect(status(r, "A2")).toBe("blocked");
    expect(status(r, "B1")).toBe("green");
  });

  test("lanes: host plus checkout path; cheap lanes first; the capture lane is its own on both targets", () => {
    const stage = loadTarget(join(targetsDir, "stage.json"));
    const prod = loadTarget(join(targetsDir, "prod.json"));
    expect(laneOf({ host: "target" }, stage)).not.toBe(laneOf({ host: "capture" }, stage));
    expect(laneOf({ host: "target" }, prod)).not.toBe(laneOf({ host: "capture" }, prod));
    expect(laneOf({ host: "capture" }, stage)).toBe(laneOf({ host: "capture" }, prod));
    expect(laneOf({ host: "target" }, prod)).toBe(`${prod.host}:${prod.checkout}`);
    // Stage rehearses prod's preflight order exactly: the target lane, then the capture lane.
    const order = ["R1.1", "R1.2", "R1.3", "R2.3", "R2.5", "R1.4", "R1.5", "R1.6", "R2.1", "R2.2", "R2.4r"];
    expect(preflightOrder(RELEASE_STEPS, prod).map((s) => s.id)).toEqual(order);
    expect(preflightOrder(RELEASE_STEPS, stage).map((s) => s.id)).toEqual(order);
  });

  test("the capture checkout steps R1.4 to R1.6 run on stage as on prod: no step is skipped for a shared checkout", async () => {
    const stage = loadTarget(join(targetsDir, "stage.json"));
    const prod = loadTarget(join(targetsDir, "prod.json"));
    for (const id of ["R1.4", "R1.5", "R1.6"]) {
      const step = RELEASE_STEPS.find((s) => s.id === id)!;
      expect(skipReason(step, stage)).toBeUndefined();
      expect(skipReason(step, prod)).toBeUndefined();
    }
    // Through the runner: a stage run runs its capture step.
    const SPLIT: StepTemplate[] = [
      { id: "T1", standing: [], description: "target", host: "target", cmds: [["echo", "T1"]], expectExit: 0, receipts: [], irreversible: false },
      { id: "C1", standing: [], description: "capture", host: "capture", cmds: [["echo", "C1"]], expectExit: 0, receipts: [], irreversible: false },
    ];
    const f = fixture("stage");
    const a = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], a.deps, SPLIT)).toBe(0);
    expect(a.ran).toEqual(["T1", "C1"]);
  });

  test("a step that runs past its bound is failed as timed out; the bound is in the rendered step", async () => {
    expect(maxMillisOf({})).toBe(DEFAULT_MAX_MINUTES * 60_000);
    expect(maxMillisOf({ maxMinutes: 30 })).toBe(30 * 60_000);
    expect(RELEASE_STEPS.find((s) => s.id === "R2.1")!.maxMinutes).toBe(30);
    const f = fixture();
    const a = fakeDeps();
    const bounds: (number | undefined)[] = [];
    a.deps.exec = async (_h, _r, _o, _e, timeoutMs) => { bounds.push(timeoutMs); return TIMED_OUT; };
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], a.deps, TINY)).toBe(1);
    expect(bounds).toEqual([DEFAULT_MAX_MINUTES * 60_000]);
    const j = JSON.parse(readFileSync(join(f.journalRoot, "stage", "20261008T120000Z", "run.json"), "utf8")) as RunJournal;
    expect(j.steps.T1!.status).toBe("failed");
    expect(j.steps.T1!.error).toContain("timed out after 10 min");
  });

  test("--abandon marks a dead run failed, so P.busy clears; it refuses a run that is not running", async () => {
    const f = fixture();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], fakeDeps({ fail: new Set(["T2"]), receipt: "{}" }).deps, TINY)).toBe(1);
    const runFile = join(f.journalRoot, "stage", "20261008T120000Z", "run.json");
    const dead = JSON.parse(readFileSync(runFile, "utf8")) as RunJournal;
    dead.status = "running";
    dead.steps.T2!.status = "running";
    writeFileSync(runFile, JSON.stringify(dead));
    const a = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--journal-root", f.journalRoot, "--abandon", "20261008T120000Z"], a.deps, TINY)).toBe(0);
    const j = JSON.parse(readFileSync(runFile, "utf8")) as RunJournal;
    expect(j.status).toBe("failed");
    expect(j.steps.T2!.status).toBe("failed");
    expect(j.steps.T2!.error).toContain("abandoned");
    expect(await runRelease(["--target", f.targetFile, "--journal-root", f.journalRoot, "--abandon", "20261008T120000Z"], fakeDeps().deps, TINY)).toBe(2);
    const b = fakeDeps();
    b.deps.now = () => new Date("2026-10-08T12:00:01Z");
    expect(await preflight(f, b.deps, [], TINY)).toBe(0);
    expect(parseArgs(["--target", "stage", "--abandon", "20261008T120000Z", "--go", "x"])).toHaveProperty("error");
    expect(parseArgs(["--target", "stage", "--abandon", "nope"])).toHaveProperty("error");
  });

  test("--accept records the owner's acceptance of one failed step in the journal, and --from then runs past it (issue 1282)", async () => {
    const f = fixture();
    const first = fakeDeps({ fail: new Set(["T1"]), receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], first.deps, TINY)).toBe(1);
    expect(first.logs.join("\n")).toContain("--accept T1 --reason");
    const runDir = join(f.journalRoot, "stage", "20261008T120000Z");
    // red control: without an acceptance, --from past the failed step refuses and runs nothing.
    const refused = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z", "--from", "T2"], refused.deps, TINY)).toBe(2);
    expect(refused.ran).toEqual([]);
    expect(refused.logs.join("\n")).toContain("skips steps that are not ok: T1");

    const accept = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z", "--accept", "T1", "--reason", "boot race, stack healthy", "--issue", "1280"], accept.deps, TINY)).toBe(0);
    expect(accept.ran).toEqual([]);
    const j1 = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunJournal;
    expect(j1.steps.T1!.status).toBe("accepted");
    expect(j1.steps.T1!.accepted).toEqual({ reason: "boot race, stack healthy", issue: 1280, at: "2026-10-08T12:00:00.000Z" });
    expect(j1.steps.T1!.exit).toBe(1);
    expect(j1.status).toBe("incomplete");
    const result = JSON.parse(readFileSync(join(runDir, "T1", "result.json"), "utf8")) as RunJournal["steps"][string];
    expect(result.status).toBe("accepted");
    expect(result.accepted?.issue).toBe(1280);

    const second = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z", "--from", "T2"], second.deps, TINY)).toBe(0);
    expect(second.ran).toEqual(["T2", "T3"]);
    const j2 = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunJournal;
    expect(j2.status).toBe("passed");
    expect(j2.steps.T1!.status).toBe("accepted");

    // red controls: an ok step, an unknown step and an already accepted step refuse; the journal is unchanged.
    for (const step of ["T2", "T9", "T1"]) {
      const r = fakeDeps();
      expect(await runRelease(["--target", f.targetFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z", "--accept", step, "--reason", "x", "--issue", "1"], r.deps, TINY)).toBe(2);
    }
    expect(readFileSync(join(runDir, "run.json"), "utf8")).toBe(JSON.stringify(j2, null, 2) + "\n");
  });

  test("red: --accept refuses an irreversible step, a running run, a missing journal, and malformed arguments", async () => {
    const f = fixture();
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot], fakeDeps({ fail: new Set(["T2"]), receipt: "{}" }).deps, TINY)).toBe(1);
    const runFile = join(f.journalRoot, "stage", "20261008T120000Z", "run.json");
    const args = ["--target", f.targetFile, "--journal-root", f.journalRoot, "--run", "20261008T120000Z", "--accept", "T2", "--reason", "x", "--issue", "1"];
    const irreversible = fakeDeps();
    expect(await runRelease(args, irreversible.deps, TINY)).toBe(2);
    expect(irreversible.logs.join("\n")).toContain("irreversible");
    expect((JSON.parse(readFileSync(runFile, "utf8")) as RunJournal).steps.T2!.status).toBe("failed");
    const dead = JSON.parse(readFileSync(runFile, "utf8")) as RunJournal;
    dead.status = "running";
    dead.steps.T2!.status = "running";
    writeFileSync(runFile, JSON.stringify(dead));
    const running = fakeDeps();
    expect(await runRelease(args, running.deps, TINY)).toBe(2);
    expect(running.logs.join("\n")).toContain("running");
    expect(await runRelease([...args.slice(0, 5), "20261008T000000Z", ...args.slice(6)], fakeDeps().deps, TINY)).toBe(2);
    expect(parseArgs(["--target", "stage", "--accept", "T1", "--reason", "x", "--issue", "1"])).toHaveProperty("error");
    expect(parseArgs(["--target", "stage", "--run", "20261008T120000Z", "--accept", "T1", "--issue", "1"])).toHaveProperty("error");
    expect(parseArgs(["--target", "stage", "--run", "20261008T120000Z", "--accept", "T1", "--reason", "x", "--issue", "x"])).toHaveProperty("error");
    expect(parseArgs(["--target", "stage", "--run", "20261008T120000Z", "--accept", "T1", "--reason", "x", "--issue", "1", "--go", "g"])).toHaveProperty("error");
    expect(parseArgs(["--target", "stage", "--run", "20261008T120000Z", "--reason", "x"])).toHaveProperty("error");
    expect(parseArgs(["--target", "stage", "--run", "20261008T120000Z", "--accept", "T1", "--reason", "x", "--issue", "1"])).not.toHaveProperty("error");
  });

  test("SP.8: a stage run with an accepted step does not authorize production", () => {
    const j = journal();
    j.steps["R7.3a"]!.status = "accepted";
    const refusals = checkStageJournal(j, { stepListHash: stepListHash(), tree: TREE, stepIds: stepIds() });
    expect(refusals.join("\n")).toContain("accepted a failure");
    expect(refusals.join("\n")).toContain("R7.3a");
    expect(runStatus(j, stepIds())).toBe("passed");
  });

  test("--after-preflight continues a run from a green preflight within the hour: same run stamp, R-steps carried, nothing repeated", async () => {
    const f = fixture();
    const BEFORE_AND_AFTER: StepTemplate[] = [...TINY.slice(0, 1), { ...TINY[1]!, receipts: [] }, TINY[2]!];
    const pre = fakeDeps();
    expect(await preflight(f, pre.deps, [], BEFORE_AND_AFTER)).toBe(0);
    expect(pre.ran).toEqual(["T1"]);
    const preDir = join(f.journalRoot, "stage", "preflight-20261008T120000Z");
    const run = fakeDeps();
    run.deps.now = () => new Date("2026-10-08T12:30:00Z");
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--after-preflight", preDir], run.deps, BEFORE_AND_AFTER)).toBe(0);
    expect(run.ran).toEqual(["T2", "T3"]);
    const j = JSON.parse(readFileSync(join(f.journalRoot, "stage", "20261008T120000Z", "run.json"), "utf8")) as RunJournal;
    expect(j.runTs).toBe("20261008T120000Z");
    expect(j.status).toBe("passed");
    expect(j.steps.T1!.status).toBe("ok");
    expect(j.afterPreflight?.runTs).toBe("20261008T120000Z");
    // red controls: too old, another commit, another list, a red preflight.
    const rep = JSON.parse(readFileSync(join(preDir, "preflight.json"), "utf8")) as PreflightReport;
    const exp = { target: "stage", commit: SHA, stepListHash: rep.stepListHash, stepIds: ["T1", "T2", "T3"] };
    expect(checkAfterPreflight(rep, exp, new Date("2026-10-08T12:59:00Z"))).toEqual([]);
    expect(checkAfterPreflight(rep, exp, new Date("2026-10-08T13:01:00Z")).join()).toContain("more than 60 min");
    expect(checkAfterPreflight(rep, { ...exp, commit: OTHER_SHA }, new Date("2026-10-08T12:30:00Z")).join()).toContain("the go names");
    expect(checkAfterPreflight(rep, { ...exp, stepListHash: "0".repeat(64) }, new Date("2026-10-08T12:30:00Z")).join()).toContain("step list");
    expect(checkAfterPreflight({ ...rep, checks: [{ id: "P.ci", status: "red", detail: "" }] }, exp, new Date("2026-10-08T12:30:00Z")).join()).toContain("not green: P.ci");
    expect(checkAfterPreflight(undefined, exp, new Date()).join()).toContain("no preflight.json");
    const late = fakeDeps();
    late.deps.now = () => new Date("2026-10-08T14:00:00Z");
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", join(f.dir, "j2"), "--after-preflight", preDir], late.deps, BEFORE_AND_AFTER)).toBe(2);
    expect(late.ran).toEqual([]);
    expect(parseArgs(["--target", "stage", "--after-preflight", "x", "--run", "20261008T000000Z"])).toHaveProperty("error");
  });

  test("the cutover window is R6.3's start to R6.9's end, journaled once both passed", () => {
    const ok = (startedAt: string, endedAt: string) => ({ id: "x", status: "ok" as const, exit: 0, expectExit: 0, startedAt, endedAt, receipts: [], attempt: 1 });
    expect(cutoverSeconds({ steps: { "R6.3": ok("2026-10-08T12:00:00Z", "2026-10-08T12:00:27Z"), "R6.9": ok("2026-10-08T12:02:26Z", "2026-10-08T12:02:29Z") } })).toBe(149);
    expect(cutoverSeconds({ steps: { "R6.3": ok("2026-10-08T12:00:00Z", "2026-10-08T12:00:27Z") } })).toBeUndefined();
  });

  test("prod: P.stage is red without a passed stage run, green when one exists under the journal root", async () => {
    const f = fixture("prod");
    const a = fakeDeps({ receipt: "{}" });
    expect(await preflight(f, a.deps, [], TINY)).toBe(2);
    expect(status(report(f, "prod"), "P.stage")).toBe("red");
    // A passed stage run of the same list at the same commit, in the same journal root.
    const s = fixture("stage");
    expect(await runRelease(["--target", s.targetFile, "--go", s.goFile, "--journal-root", f.journalRoot], fakeDeps({ receipt: "{}" }).deps, TINY)).toBe(0);
    const b = fakeDeps({ receipt: "{}" });
    b.deps.now = () => new Date("2026-10-08T12:00:01Z");
    expect(await preflight(f, b.deps, [], TINY)).toBe(0);
    const r = JSON.parse(readFileSync(join(f.journalRoot, "prod", "preflight-20261008T120001Z", "preflight.json"), "utf8")) as ReturnType<typeof report>;
    expect(r.checks.find((c) => c.id === "P.stage")).toMatchObject({ status: "green" });
    expect(r.checks.find((c) => c.id === "P.stage")!.detail).toContain(join(f.journalRoot, "stage", "20261008T120000Z"));
  });

  test("a preflight journal is never a stage run: SP.8 refuses it", async () => {
    const s = fixture("stage");
    expect(await preflight(s, fakeDeps({ receipt: "{}" }).deps, [], TINY)).toBe(0);
    const f = fixture("prod");
    const a = fakeDeps({ receipt: "{}" });
    expect(await runRelease(["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, "--stage-journal", join(s.journalRoot, "stage", "preflight-20261008T120000Z")], a.deps, TINY)).toBe(2);
    expect(a.ran).toEqual([]);
  });

  test("--preflight and --dry-run are one flag; neither takes --run or --only", () => {
    expect(parseArgs(["--target", "stage", "--dry-run"])).toMatchObject({ preflight: true });
    expect(parseArgs(["--target", "stage", "--preflight"])).toMatchObject({ preflight: true });
    expect(parseArgs(["--target", "stage", "--preflight", "--run", "20261008T000000Z"])).toHaveProperty("error");
    expect(parseArgs(["--target", "stage", "--preflight", "--only", "R1.2"])).toHaveProperty("error");
  });

  test("ciProblems: green, a missing required workflow, a failure, a run still in progress", () => {
    const green = REQUIRED_CI.map((n) => `${n}\tcompleted\tsuccess`);
    expect(ciProblems(green)).toEqual([]);
    expect(ciProblems(["e2e-web\tcompleted\tsuccess", ...green.slice(1)])).toEqual([]);
    expect(ciProblems(green.slice(1)).join()).toContain("no e2e check run");
    expect(ciProblems([...green, "unit\tcompleted\tfailure"]).join()).toContain("unit concluded failure");
    expect(ciProblems([...green, "backend\tin_progress\t"]).join()).toContain("backend is in_progress");
    expect(ciProblems([])).toEqual(["no check run on the commit: CI never ran there"]);
  });
});
