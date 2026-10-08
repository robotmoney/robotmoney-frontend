// scripts/release/steps.ts — THE step list of `bun run release:run` (D61 rule 2).
//
// One ordered list, identical for every target. A step names its commands as
// templates (`{instance}`, `{confirmTarget}`, …); the target file fills them.
// Nothing in this file branches on the target. The step-list hash is taken
// over the templates, so a stage run and a production run of the same list at
// the same commit carry the same hash, and production refuses to start unless a
// passed stage journal with that hash exists (standing check SP.8, ./journal.ts).
//
// Each step runs on the target host or on the capture host, over ssh, as
//   ssh -T -o BatchMode=yes <host> 'mkdir -p <run dir> && touch <marker> && cd <checkout> && env -i HOME=<home> PATH=<REMOTE_PATH> LANG=C.UTF-8 RM_ENV=<env> <cmd>'
// with stdin closed. The marker lets the runner copy back only the receipts a
// step wrote (find -newer).
//
// The ids follow the v0.6.0 runbook (docs/runbooks/v0-6-0-rollout.md): R1 the
// release identity, R2 the baseline, R6 the cutover, S8 the recovery matrix's
// legacy rename, R7 the postflight. `standing` names the standing runbook rows
// each step satisfies (docs/runbooks/release-standing-runbook.md).
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReleaseTarget } from "./target.ts";

/**
 * Where a step runs: the target host, the capture host, or the control
 * machine itself (the release tags, R5.rc and W3).
 */
export type StepHost = "target" | "capture" | "control";

/** The runner's host name for a control-machine step; never an ssh alias. */
export const CONTROL_HOST = "(control)";

/**
 * The one PATH every remote command runs with (`env -i`), the same on every
 * host. It finds bun in either host user's ~/.bun/bin, and docker, tmux and git
 * in the system directories. R1.2 and R1.5 prove each tool resolves under it
 * and record where.
 */
export const REMOTE_PATH = "/root/.bun/bin:/home/stage-server/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Files a step leaves behind that the runner copies into the local journal. */
export interface ReceiptSpec {
  /** Remote directory, templated. */
  readonly dir: string;
  /** A `find -name` pattern. */
  readonly pattern: string;
  /** A missing required receipt fails the step. */
  readonly required: boolean;
}

export interface StepTemplate {
  readonly id: string;
  /** The standing runbook rows this step satisfies. */
  readonly standing: readonly string[];
  readonly description: string;
  readonly host: StepHost;
  /**
   * `legacy` runs the step from the target's LEGACY checkout, with HOME set and
   * no RM_ENV: the old code grades the old stack it started (R2.5). Default:
   * the release checkout.
   */
  readonly checkout?: "release" | "legacy";
  /** Commands as argv templates; they run in order joined by `&&`. */
  readonly cmds: readonly (readonly string[])[];
  /** Extra non-secret environment for every command, templated. */
  readonly env?: Readonly<Record<string, string>>;
  /** The step also exports the target's `bootEnv` (runbook R6.2a). */
  readonly bootEnv?: boolean;
  readonly expectExit: number;
  readonly receipts: readonly ReceiptSpec[];
  /** Past this step a code-only rollback is impossible (runbook section 8). */
  readonly irreversible: boolean;
  /**
   * The step runs only for this policy and is recorded `skipped: <rmEnv>` on
   * any other. It is data in the template, so the hash is the same for every
   * target. Only the release tags (R5.rc, W3) use it: a stage run tags nothing.
   */
  readonly onlyFor?: "prod";
  /**
   * The step may not start before `afterStep` ended plus `hours`. The runner
   * stops there, prints when it becomes runnable, and `--run <ts>` resumes it.
   * `hours: "watchHours"` names the target's watch length (./watch.ts), so the
   * template, and the step-list hash, stay the same for every target.
   */
  readonly notBefore?: NotBeforeTemplate;
  /**
   * A baseline gate: a non-zero exit passes when `--triage <file>` covers every
   * failed finding of its JSON report (scripts/release/triage.ts). Only R2.5.
   */
  readonly triage?: boolean;
}

/** The remote journal directory of one run on the target host. */
const RUN_DIR = "{home}/.local/state/robotmoney-release/{target}/{runTs}";
/** The same on the capture host. */
const CAPTURE_RUN_DIR = "{captureHome}/.local/state/robotmoney-release/{target}/{runTs}";
/** The instance's smoke state directory (scripts/lib/smoke-state.ts). */
const STATE_DIR = "{home}/.local/state/robotmoney-smoke/{instance}";
/** The fresh capture for this run (policy 4.3 fresh dump rule: a new directory every run). */
const CAPTURE_DIR = "{captureHome}/rm-backup-{target}-{runTs}";

const BOOT_ENV = { PROJECTS_SOURCE: "live" } as const;

const runReceipts = (pattern: string, required = true): ReceiptSpec => ({ dir: RUN_DIR, pattern, required });
const stateReceipts = (pattern: string, required = true): ReceiptSpec => ({ dir: STATE_DIR, pattern, required });
const prodInitReceipt = (command: string): ReceiptSpec => ({ dir: `${STATE_DIR}/prod-init`, pattern: `${command}-*.json`, required: true });

/**
 * The watch window after READY: the target's `watchHours`, by default long
 * enough for the slowest subject's first epoch to publish (./watch.ts).
 */
const WATCH = { afterStep: "R6.9", hours: "watchHours" } as const;

/** A step's wait as the template states it: fixed hours, or the target's watch length. */
export interface NotBeforeTemplate { readonly afterStep: string; readonly hours: number | "watchHours" }
/** The wait resolved against one target. */
export interface NotBefore { readonly afterStep: string; readonly hours: number }

/** Resolve a step's wait for a target. PURE. */
export function notBeforeOf(step: { readonly notBefore?: NotBeforeTemplate }, target: Pick<ReleaseTarget, "watchHours">): NotBefore | undefined {
  const nb = step.notBefore;
  if (nb === undefined) return undefined;
  return { afterStep: nb.afterStep, hours: nb.hours === "watchHours" ? target.watchHours : nb.hours };
}

const prodInit = (command: string): string[] => ["bun", "scripts/prod-init.ts", command, "--instance", "{instance}", "--confirm-target", "{confirmTarget}"];
const status = (): string[] => ["bun", "run", "smoke:status", "--instance", "{instance}"];
const boot = (): string[] => ["bun", "run", "smoke", "--static-port", "--instance", "{instance}"];

/** The release run, in order. Read docs/runbooks/release-run.md for the table. */
export const RELEASE_STEPS: readonly StepTemplate[] = Object.freeze([
  // ── R1 release identity, on both hosts ────────────────────────────────────
  {
    id: "R1.1", standing: ["SP.1"], host: "target", irreversible: false, expectExit: 0, receipts: [],
    description: "Target checkout: fetch, then detach at the release commit",
    cmds: [["git", "fetch", "--tags", "origin"], ["git", "-c", "advice.detachedHead=false", "checkout", "--detach", "{commit}"]],
  },
  {
    id: "R1.2", standing: ["SP.1"], host: "target", irreversible: false, expectExit: 0, receipts: [runReceipts("host-identity.json")],
    description: "Target identity and precondition: HEAD is the commit, the tree is clean, the tools exist, ~/.env resolves to confirmTarget, the database answers, its ledger is a supported baseline, its identity is absent or matches RM_ENV; before R6.1, ~/.env holds a non-empty rm_owner line and rm_owner logs in (SELECT 1, read-only; refuses with \"run bun run role-passwords --target <target> first\"); no release step reads doadmin; RM_CREDENTIALS is not required (R6.2a writes it)",
    cmds: [["bun", "scripts/release/host-identity.ts", "--commit", "{commit}", "--confirm-target", "{confirmTarget}", "--receipt-dir", RUN_DIR]],
  },
  {
    id: "R1.3", standing: ["SP.1"], host: "target", irreversible: false, expectExit: 0, receipts: [],
    description: "Target install: bun install --force, root and backend",
    cmds: [["bun", "install", "--force"], ["bun", "install", "--force", "--cwd", "backend"]],
  },
  {
    id: "R1.4", standing: ["SP.1"], host: "capture", irreversible: false, expectExit: 0, receipts: [],
    description: "Capture checkout: fetch, then detach at the release commit",
    cmds: [["git", "fetch", "--tags", "origin"], ["git", "-c", "advice.detachedHead=false", "checkout", "--detach", "{commit}"]],
  },
  {
    id: "R1.5", standing: ["SP.1"], host: "capture", irreversible: false, expectExit: 0, receipts: [{ dir: CAPTURE_RUN_DIR, pattern: "host-identity.json", required: true }],
    description: "Capture identity: HEAD is the commit and the tree is clean",
    cmds: [["bun", "scripts/release/host-identity.ts", "--commit", "{commit}", "--receipt-dir", CAPTURE_RUN_DIR]],
  },
  {
    id: "R1.6", standing: ["SP.1"], host: "capture", irreversible: false, expectExit: 0, receipts: [],
    description: "Capture install: bun install --force, root and backend",
    cmds: [["bun", "install", "--force"], ["bun", "install", "--force", "--cwd", "backend"]],
  },
  // ── R2 baseline and backup ────────────────────────────────────────────────
  {
    id: "R2.1", standing: ["SR.0", "SP.2"], host: "capture", irreversible: false, expectExit: 0,
    receipts: [{ dir: CAPTURE_DIR, pattern: "manifest.json", required: true }],
    description: "Fresh capture from production's read replica into a new dated directory (never a reused dump)",
    cmds: [["bun", "run", "smoke:capture", "--out", CAPTURE_DIR]],
  },
  {
    id: "R2.2", standing: ["SP.2"], host: "capture", irreversible: false, expectExit: 0,
    receipts: [{ dir: CAPTURE_DIR, pattern: "SHA256SUMS", required: true }],
    description: "Record the sha256 of the encrypted dump files beside the manifest",
    cmds: [["sh", "-c", `cd ${CAPTURE_DIR} && sha256sum -- *.gpg > SHA256SUMS`]],
  },
  {
    id: "R2.4r", standing: ["SP.2"], host: "capture", irreversible: false, expectExit: 0,
    receipts: [{ dir: CAPTURE_RUN_DIR, pattern: "restore-proof.json", required: true }],
    description: "Restore proof: restore the R2.1 dump into a throwaway local Postgres container, record the restore time, drop the container",
    cmds: [["bun", "scripts/release/restore-proof.ts", "--dump", CAPTURE_DIR, "--receipt-dir", CAPTURE_RUN_DIR]],
  },
  {
    id: "R2.3", standing: ["SP.3", "SP.6"], host: "target", irreversible: false, expectExit: 0,
    receipts: [{ dir: `${STATE_DIR}/release/{runTs}`, pattern: "baseline*", required: true }],
    description: "Baseline through rm_readonly: ledger, identity, roles, migration 0101's would-clear list, supported-baseline match, R2.4 counts and size",
    cmds: [["bun", "scripts/release/baseline.ts", "--instance", "{instance}", "--run", "{runTs}"]],
  },
  {
    id: "R2.5", standing: ["SP.5"], host: "target", checkout: "legacy", irreversible: false, expectExit: 0, triage: true, receipts: [runReceipts("prod-gate-baseline.*")],
    description: "Log baseline of the running legacy stack, graded by the legacy checkout's own prod:gate (its .agents/smoke-state.json names the stack)",
    cmds: [["bun", "run", "prod:gate", "--mode", "baseline", "--state-file", "{legacyCheckout}/.agents/smoke-state.json", "--report", `${RUN_DIR}/prod-gate-baseline.md`]],
  },
  // ── R5 release candidate tag (prod only; stage records it skipped) ────────
  {
    id: "R5.rc", standing: [], host: "control", onlyFor: "prod", irreversible: false, expectExit: 0, receipts: [],
    description: "Tag the release candidate at the commit (the next free <release>-rc.N) unless one already points there; push it",
    cmds: [["bun", "scripts/release/tag.ts", "rc", "--release", "{release}", "--commit", "{commit}"]],
  },
  // ── R6 cutover ────────────────────────────────────────────────────────────
  {
    id: "R6.1", standing: ["SC.2"], host: "target", irreversible: true, expectExit: 0, receipts: [runReceipts("stop-legacy.json")],
    description: "Stop the legacy stack: its tmux driver, then docker compose down (never -v); prove no legacy container remains",
    cmds: [["bun", "scripts/release/stop-legacy.ts", "stop", "--session", "{legacySession}", "--project", "{legacyProject}",
      "--legacy-checkout", "{legacyCheckout}", "--compose-files", "{legacyComposeFiles}", "--receipt-dir", RUN_DIR]],
  },
  {
    id: "R6.2a", standing: [], host: "target", irreversible: false, expectExit: 0, receipts: [runReceipts("credentials-init.json")],
    description: "Write the in-house roster's credential.json (fresh keys, the model key from ~/.env, placeholder bearers for R6.7c) and RM_CREDENTIALS; an existing file with the same roster is kept",
    cmds: [["bun", "scripts/release/credentials-init.ts", "--receipt-dir", RUN_DIR]],
  },
  {
    id: "R6.2", standing: ["SV.6"], host: "target", irreversible: false, expectExit: 0, receipts: [runReceipts("env-rewrite.json")],
    description: "Rewrite ~/.env to the D61 allowlist (rm_owner, never doadmin); every other key, a stray doadmin line included, moves to ~/.env.retired-<ts> (mode 0600); refuses without rm_owner or RM_CREDENTIALS; key names only",
    cmds: [["bun", "scripts/release/env-rewrite.ts", "--run", "{runTs}", "--receipt-dir", RUN_DIR]],
  },
  {
    id: "R6.3", standing: ["SC.2"], host: "target", irreversible: true, expectExit: 0,
    receipts: [stateReceipts("migrate-receipt-*.json"), stateReceipts("migrate-journal-*.json", false)],
    description: "The first migrate: 0081 first with the identity RM_ENV implies, then every pending file",
    cmds: [["bun", "run", "migrate", "--instance", "{instance}", "--confirm-target", "{confirmTarget}"]],
  },
  {
    id: "S8.1", standing: [], host: "target", irreversible: false, expectExit: 0, receipts: [runReceipts("retire-legacy.json")],
    description: "Rename the legacy checkout to <path>.<version>-retired, then move its .env secrets (database URLs, model keys) to ~/.env.legacy-retired-<ts> and make that .env 0600",
    cmds: [["bun", "scripts/release/stop-legacy.ts", "retire", "--legacy-checkout", "{legacyCheckout}", "--version", "{legacyVersion}", "--run", "{runTs}", "--receipt-dir", RUN_DIR]],
  },
  {
    id: "R6.4", standing: [], host: "target", irreversible: false, expectExit: 0, receipts: [prodInitReceipt("set-identity")],
    description: "Report the deployment identity the migrate wrote (prod-init set-identity)",
    cmds: [prodInit("set-identity")],
  },
  {
    id: "R6.5", standing: [], host: "target", irreversible: false, expectExit: 0, receipts: [prodInitReceipt("provision-tokens")],
    description: "Mint the three service tokens (prod-init provision-tokens)",
    cmds: [prodInit("provision-tokens")],
  },
  {
    id: "R6.7a", standing: ["SP.4"], host: "target", irreversible: false, expectExit: 0, receipts: [], env: BOOT_ENV, bootEnv: true,
    description: "Boot 1: bun smoke --static-port (preflight, replace, readiness, exit)",
    cmds: [boot()],
  },
  {
    id: "R6.7b", standing: ["SV.2"], host: "target", irreversible: false, expectExit: 0, receipts: [],
    description: "Status after boot 1",
    cmds: [status()],
  },
  {
    id: "R6.7c", standing: [], host: "target", irreversible: true, expectExit: 0, receipts: [prodInitReceipt("rebind-members")],
    description: "One-time credential migration: rebind the in-house members to credential.json (one-way)",
    cmds: [prodInit("rebind-members")],
  },
  {
    id: "R6.7d", standing: ["SP.4"], host: "target", irreversible: false, expectExit: 0, receipts: [], env: BOOT_ENV, bootEnv: true,
    description: "Boot 2: a new plan that recreates the participants on the new bearers",
    cmds: [boot()],
  },
  {
    id: "R6.9", standing: ["SV.2"], host: "target", irreversible: false, expectExit: 0, receipts: [],
    description: "Status after boot 2: the receipt as history, the daemon as now",
    cmds: [status()],
  },
  {
    id: "R6.10", standing: [], host: "target", irreversible: false, expectExit: 0, receipts: [],
    description: "Site: bun smoke:web (refuses a site whose apiRange excludes the api)",
    cmds: [["bun", "run", "smoke:web", "--instance", "{instance}"]],
  },
  // ── R7 postflight ─────────────────────────────────────────────────────────
  {
    id: "R7.1", standing: ["SV.1"], host: "target", irreversible: false, expectExit: 0, receipts: [runReceipts("identity-check.json")],
    description: "Identity: /api/version and /version.json carry the release commit, no +dirty or +unknown",
    cmds: [["bun", "scripts/release/identity-check.ts", "--origin", "{publicOrigin}", "--commit", "{commit}", "--receipt-dir", RUN_DIR]],
  },
  {
    id: "R7.2", standing: ["SV.2"], host: "target", irreversible: false, expectExit: 0, receipts: [],
    description: "Status: preflight green, readiness green",
    cmds: [status()],
  },
  {
    id: "R7.3", standing: ["SV.3"], host: "target", irreversible: false, expectExit: 0, receipts: [],
    description: "Product verification, readonly tier",
    cmds: [["bun", "run", "verify:live", "--instance", "{instance}", "--emit-receipt=R7.verify"]],
  },
  {
    id: "R7.3a", standing: ["SV.4"], host: "target", irreversible: false, expectExit: 0, receipts: [runReceipts("prod-gate-post-release.*")],
    description: "Log verdict after the release (sessions graded later: the first one publishes hours after the cutover)",
    cmds: [["bun", "run", "prod:gate", "--mode", "post-release", "--defer-sessions", "--instance", "{instance}", "--report", `${RUN_DIR}/prod-gate-post-release.md`]],
  },
  {
    id: "R7.3b", standing: ["SW.2"], host: "target", irreversible: false, expectExit: 0,
    receipts: [runReceipts("soak-record.*"), runReceipts("soak-full.*"), stateReceipts("soak-baseline.json", false)],
    description: "Standing soak checks: record the baseline at READY, then the full run",
    cmds: [
      ["bun", "run", "soak:checks", "--instance", "{instance}", "--record", "--report", `${RUN_DIR}/soak-record.md`],
      ["bun", "run", "soak:checks", "--instance", "{instance}", "--full", "--report", `${RUN_DIR}/soak-full.md`],
    ],
  },
  {
    id: "R7.5", standing: ["SV.5"], host: "target", irreversible: false, expectExit: 0,
    receipts: [{ dir: `${STATE_DIR}/release/{runTs}`, pattern: "compare-baseline.json", required: true }],
    description: "Compare with the R2.3 baseline: row counts only grow, database size within the bound",
    cmds: [["bun", "scripts/release/compare-baseline.ts", "--instance", "{instance}", "--run", "{runTs}", "--max-size-ratio", "1.5"]],
  },
  {
    id: "R7.7", standing: ["SV.6"], host: "target", irreversible: false, expectExit: 0, receipts: [runReceipts("host-guards.json")],
    description: "Host guards: no container mounts docker.sock, ~/.env keys within the allowlist, token files 0600, no world-readable file under home or the retired checkout holds a postgres URL with a password",
    cmds: [["bun", "scripts/release/host-guards.ts", "--instance", "{instance}", "--legacy-retired", "{legacyCheckout}.{legacyVersion}-retired", "--receipt-dir", RUN_DIR]],
  },
  // ── W watch: every subject publishes once after READY ─────────────────────
  {
    id: "W1", standing: ["SW.1"], host: "target", notBefore: WATCH, irreversible: false, expectExit: 0, receipts: [runReceipts("prod-gate-watch.*")],
    description: "Every subject publishes once: prod:gate post-release since READY, sessions graded (every subject publishes judged sessions, the judge never restarted)",
    cmds: [["bun", "run", "prod:gate", "--mode", "post-release", "--instance", "{instance}", "--since", "{readyIso}", "--min-attendance", "{watchMinAttendance}", "--report", `${RUN_DIR}/prod-gate-watch.md`]],
  },
  {
    id: "R7.4a", standing: ["SW.1"], host: "target", notBefore: WATCH, irreversible: false, expectExit: 0, receipts: [runReceipts("schedule-parity.json")],
    description: "Schedule parity: 6 h epochs, every session in flight at R2.3 published on its normal close, the regime run at :30, the last parity sweep's duration",
    cmds: [["bun", "scripts/release/schedule-parity.ts", "--instance", "{instance}", "--run", "{runTs}", "--receipt-dir", RUN_DIR]],
  },
  {
    id: "W3", standing: ["SW.3"], host: "control", onlyFor: "prod", irreversible: false, expectExit: 0, receipts: [],
    description: "Tag the running commit with the release tag and push it (prod only)",
    cmds: [["bun", "scripts/release/tag.ts", "final", "--release", "{release}", "--commit", "{commit}"]],
  },
] satisfies StepTemplate[]);

/** The control machine's checkout, where control steps run. */
export const CONTROL_REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The environment every remote command starts from: `env -i` plus exactly these. */
export const BASE_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: REMOTE_PATH, LANG: "C.UTF-8" });

/** What the not-yet-known READY instant renders as in a plan. */
export const READY_PENDING = "READY-ISO-FROM-R6.9";

/** The values a template may name. */
export interface TemplateValues {
  readonly [key: string]: string;
}

/** The template values of one run of one target. */
export function templateValues(target: ReleaseTarget, commit: string, runTs: string, readyIso: string = READY_PENDING): TemplateValues {
  return {
    readyIso,
    target: target.name,
    release: target.release,
    commit,
    runTs,
    instance: target.instance,
    home: target.home,
    checkout: target.checkout,
    captureHome: target.capture.home,
    captureCheckout: target.capture.checkout,
    confirmTarget: target.confirmTarget,
    publicOrigin: target.publicOrigin,
    watchMinAttendance: String(target.watchMinAttendance),
    legacyCheckout: target.legacy.checkout,
    legacySession: target.legacy.tmuxSession,
    legacyProject: target.legacy.composeProject,
    legacyComposeFiles: target.legacy.composeFiles.join(","),
    legacyVersion: target.legacy.version,
  };
}

/** Fill `{name}` placeholders. An unknown name throws: a typo must never reach a host as a literal. */
export function fill(template: string, values: TemplateValues): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`template names {${key}}, which no target value fills`);
    return v;
  });
}

/** POSIX single-quote a word unless it is plainly safe. */
export function shellQuote(word: string): string {
  if (word !== "" && /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export interface RenderedStep {
  readonly id: string;
  readonly standing: readonly string[];
  readonly description: string;
  readonly host: string;
  readonly hostRole: StepHost;
  readonly irreversible: boolean;
  readonly expectExit: number;
  /** The remote shell command passed to ssh as one argument. */
  readonly remote: string;
  /** The marker file the step touches first; receipts newer than it are this step's. */
  readonly marker: string;
  readonly receipts: readonly ReceiptSpec[];
  readonly onlyFor?: "prod";
  readonly notBefore?: NotBefore;
}

/** Turn one template into the command a host runs. */
export function renderStep(step: StepTemplate, target: ReleaseTarget, values: TemplateValues): RenderedStep {
  const common = {
    id: step.id, standing: step.standing, description: step.description, hostRole: step.host,
    irreversible: step.irreversible, expectExit: step.expectExit,
    receipts: step.receipts.map((r) => ({ ...r, dir: fill(r.dir, values) })),
    onlyFor: step.onlyFor, notBefore: notBeforeOf(step, target),
  };
  if (step.host === "control") {
    // The control machine: its own checkout and its own environment (the git
    // credentials that push a tag live there, never on a host).
    const commands = step.cmds.map((argv) => argv.map((a) => shellQuote(fill(a, values))).join(" "));
    return { ...common, host: CONTROL_HOST, remote: [`cd ${shellQuote(CONTROL_REPO)}`, ...commands].join(" && "), marker: "" };
  }
  const onCapture = step.host === "capture";
  const host = onCapture ? target.capture.host : target.host;
  const legacy = !onCapture && step.checkout === "legacy";
  const checkout = onCapture ? target.capture.checkout : legacy ? target.legacy.checkout : target.checkout;
  const home = onCapture ? target.capture.home : target.home;
  const runDir = fill(onCapture ? CAPTURE_RUN_DIR : RUN_DIR, values);
  const marker = `${runDir}/.step-${step.id}`;
  // `env -i`: nothing the login shell exports reaches a command. Production's
  // /etc/environment exports a doadmin DATABASE_URL and its parts; stage's
  // does not. Only these variables exist, the same names on every host.
  const envPairs: string[] = [`HOME=${shellQuote(home)}`];
  for (const [k, v] of Object.entries(BASE_ENV)) envPairs.push(`${k}=${shellQuote(v)}`);
  if (!onCapture && !legacy) envPairs.push(`RM_ENV=${shellQuote(target.rmEnv)}`);
  for (const [k, v] of Object.entries(step.env ?? {})) envPairs.push(`${k}=${shellQuote(fill(v, values))}`);
  if (step.bootEnv) for (const [k, v] of Object.entries(target.bootEnv).sort()) envPairs.push(`${k}=${shellQuote(v)}`);
  const commands = step.cmds.map((argv) => `env -i ${envPairs.join(" ")} ${argv.map((a) => shellQuote(fill(a, values))).join(" ")}`);
  const remote = [`mkdir -p ${shellQuote(runDir)}`, `touch ${shellQuote(marker)}`, `cd ${shellQuote(checkout)}`, ...commands].join(" && ");
  return { ...common, host, remote, marker };
}

/**
 * sha256 over the templates, in order. It never sees a target value, so it is
 * the same for every target by construction; it changes whenever a step, a
 * command, an order or a flag changes.
 */
export function stepListHash(steps: readonly StepTemplate[] = RELEASE_STEPS): string {
  const canonical = steps.map((s) => ({
    id: s.id, standing: s.standing, description: s.description, host: s.host, checkout: s.checkout ?? "release", cmds: s.cmds,
    env: s.env ?? {}, bootEnv: s.bootEnv ?? false, expectExit: s.expectExit, receipts: s.receipts, irreversible: s.irreversible,
    onlyFor: s.onlyFor ?? null, notBefore: s.notBefore ?? null, triage: s.triage ?? false,
  }));
  // The base environment is part of every remote command, so it is part of the list.
  const base = { envClear: true, env: BASE_ENV, runDir: RUN_DIR, captureRunDir: CAPTURE_RUN_DIR };
  return createHash("sha256").update(JSON.stringify({ base, steps: canonical })).digest("hex");
}

/** Step ids, in order. Duplicate ids throw. */
export function stepIds(steps: readonly StepTemplate[] = RELEASE_STEPS): string[] {
  const ids = steps.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`step id ${dup} appears twice`);
  return ids;
}
