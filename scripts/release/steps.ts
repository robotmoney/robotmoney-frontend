// scripts/release/steps.ts — the step model of `bun run release:run` (D61 rule 2).
//
// The steps themselves are YAML: a template (./runbooks/templates/) and each
// release's own copy of it (./runbooks/releases/), which only adds (./runbook.ts).
// One ordered list per release, identical for every target. A step names its commands as
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
// The ids keep the shape the v0.6.0 runbook introduced: R1 the release
// identity, R2 the baseline, R6 the cutover, R7 the postflight, W the watch.
// `standing` names the standing runbook rows each step satisfies
// (docs/technical/release-runbooks.md §9).
//
// The list holds no past-upgrade fact (issue 1272): it reads the running
// system (the ledger against backend/migrations, the stack the host's smoke
// state names, /api/version) and runs any patch from the version production
// actually runs. A one-time action one release needs is a step that release's
// runbook adds, gated on a precondition receipt that proves it has not run
// (`gateAbsent`); it never joins a template.
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TEMPLATE, loadTemplate } from "./runbook.ts";
import type { ReleaseTarget } from "./target.ts";

/**
 * Where a step runs: the target host, the capture host, or the control
 * machine itself (the release tag, C22-collect-logs).
 */
export type StepHost = "target" | "capture" | "control";

/**
 * Which part of a release a step belongs to (owner, 2026-10-16). A step runs on
 * one target only, and its id's letter names its phase:
 *   - `qa` (Q): stage only, as often as needed. Stage's preparation (the
 *     lockfile, the dump, the target, its passwords, the scope), then the whole
 *     upgrade as production will run it (checkout, install, baseline, backup and
 *     restore proof, migrate, rolling boot, site), then the soak, then the
 *     release's own version checks. A stage run that passes is the rehearsal.
 *   - `preflight` (P): production only. Read-only gates, once per rc, at most 60
 *     minutes before the cutover; it assumes every QA step passed. The cutover
 *     carries their records instead of running them again.
 *   - `cutover` (C): production only. The release as it happens, backup and
 *     restore proof first, through the site switch and the probe's grade, then
 *     the soak and the version checks, as stage ran them.
 * Every production step has a QA twin of the same name and commands
 * (./runbook.ts twinProblems), so production runs only what stage ran.
 */
export type StepPhase = "qa" | "preflight" | "cutover";

/** The runner's host name for a control-machine step; never an ssh alias. */
export const CONTROL_HOST = "(control)";

/**
 * The one PATH every remote command runs with (`env -i`), the same on every
 * host. It finds bun in either host user's ~/.bun/bin, and docker and git
 * in the system directories. P02-host-identity and P05-capture-identity prove each tool resolves under it
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
  readonly phase: StepPhase;
  /** Commands as argv templates; they run in order joined by `&&`. */
  readonly cmds: readonly (readonly string[])[];
  /** Extra non-secret environment for every command, templated. */
  readonly env?: Readonly<Record<string, string>>;
  /** The step also exports the target's `bootEnv` (the boots). */
  readonly bootEnv?: boolean;
  readonly expectExit: number;
  readonly receipts: readonly ReceiptSpec[];
  /** Past this step a code-only rollback is impossible (runbook section 8). */
  readonly irreversible: boolean;
  /**
   * The step runs only for this policy and is recorded `skipped: <rmEnv>` on
   * any other. It is data in the template, so the hash is the same for every
   * target. The release tag (C22-collect-logs) is prod's: a stage run tags nothing. The rc is
   * no step (D64): it is cut after the stage run passes, before the production
   * go names it (`bun scripts/release/tag.ts rc`). Stage's preparation (Q02-dump to
   * Q04-role-passwords: the dump, the target, its role passwords) is stage's: production has
   * its own backup and credentials, so it skips them.
   */
  readonly onlyFor?: "prod" | "stage";
  /**
   * The step may not start before `afterStep` ended plus `hours`. The runner
   * stops there, prints when it becomes runnable, and `--run <ts>` resumes it.
   * `hours: "watchHours"` names the target's watch length (./watch.ts), so the
   * template, and the step-list hash, stay the same for every target.
   */
  readonly notBefore?: NotBeforeTemplate;
  /**
   * A baseline gate: a non-zero exit passes when `--triage <file>` covers every
   * failed finding of its JSON report (scripts/release/triage.ts). Only P08-log-baseline.
   */
  readonly triage?: boolean;
  /**
   * The step fails when its command runs longer than this. A hung ssh or a
   * stuck dump never hangs the run. Default DEFAULT_MAX_MINUTES; the dump, the
   * restore proof and the boots name their own.
   */
  readonly maxMinutes?: number;
  /**
   * The first release whose runbook must carry this template step (`vA.B.C`).
   * A template that gains a step names the release that gains it, so the
   * runbook of an earlier release, a record of what it ran, stays untouched
   * (runbook.ts checkAddOnly). Absent: every release carries the step.
   */
  readonly since?: string;
  /**
   * The step belongs to the breaking cutover (spec section 8.5): it runs only for a release whose
   * runbook declares `breaking:` and is recorded skipped for any other. The rolling steps it replaces
   * (BREAKING_SKIPS) are the converse: a release that declares `breaking:` skips them.
   */
  readonly breakingOnly?: boolean;
  /**
   * The step creates its checkout when it is missing: before it cds in, it
   * runs `git clone <cloneFrom> <checkout>` unless `<checkout>/.git` exists.
   * P01-checkout sets it: every release names a new release checkout on the host
   * (`/root/rm-060`, `/root/rm-061`), and the v0.6.1 production preflight's
   * P01-checkout failed with `cd: /root/rm-061: No such file or directory`
   * (2026-10-10). P04-capture-checkout sets it: the capture checkout is the release runner's
   * own folder (CAPTURE_CHECKOUT, ./target.ts), so a fresh capture host or a
   * deleted folder heals instead of failing. A folder that exists without
   * `.git` is never touched: the clone refuses a non-empty directory, and the
   * step fails. The clone is plain, never `--reference <another checkout>`:
   * a checkout that later moves would break an alternates pointer.
   */
  readonly cloneFrom?: string;
  /**
   * A one-time step's gate: the step runs only while this file (templated) is
   * absent on its host, and is recorded `skipped: <path> exists` once it is
   * there. A one-time action proves it has not run by the receipt it leaves
   * (for example credential.json), so a second run of the same list never
   * repeats it. Only a step a release's runbook adds carries it.
   */
  readonly gateAbsent?: string;
}

/** The repository every checkout fetches from; P01-checkout and P04-capture-checkout clone a missing checkout from it. */
export const RELEASE_REPO_URL = "git@github.com:robotmoney/robotmoney-frontend.git";

/** The time a step may take unless it names its own `maxMinutes`. */
export const DEFAULT_MAX_MINUTES = 10;

/** PURE. A step's bound in milliseconds. */
export function maxMillisOf(step: Pick<StepTemplate, "maxMinutes">): number {
  return (step.maxMinutes ?? DEFAULT_MAX_MINUTES) * 60_000;
}

/** The remote journal directory of one run on the target host. */
const RUN_DIR = "{home}/.local/state/robotmoney-release/{target}/{runTs}";
/** The same on the capture host. */
const CAPTURE_RUN_DIR = "{captureHome}/.local/state/robotmoney-release/{target}/{runTs}";
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

/**
 * The kitchen-sink template's steps, in order: the general runbook every
 * full-stack release copies (./runbooks/templates/kitchen-sink.yaml, read by
 * ./runbook.ts). A release runs its own runbook, which only adds to it
 * (loadReleaseRunbook). The policy is docs/technical/release-runbooks.md.
 */
export const RELEASE_STEPS: readonly StepTemplate[] = loadTemplate(DEFAULT_TEMPLATE).steps;

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

/**
 * The template values of one run of one target. `ref` is what the go wrote
 * (the rc tag on prod, the commit on stage, D64); P01-checkout and P04-capture-checkout detach at it,
 * C14-verify-version checks it. It defaults to the commit.
 */
export function templateValues(target: ReleaseTarget, commit: string, runTs: string, readyIso: string = READY_PENDING, ref: string = commit): TemplateValues {
  return {
    readyIso,
    target: target.name,
    release: target.release,
    commit,
    ref,
    runTs,
    instance: target.instance,
    home: target.home,
    checkout: target.checkout,
    captureHome: target.capture.home,
    captureCheckout: target.capture.checkout,
    confirmTarget: target.confirmTarget,
    publicOrigin: target.publicOrigin,
    watchMinAttendance: String(target.watchMinAttendance),
    watchSessions: target.watchSessions,
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
  readonly onlyFor?: "prod" | "stage";
  readonly notBefore?: NotBefore;
  readonly maxMillis: number;
}

/** The rolling cutover steps (by name) a release that declares `breaking:` does not run: the migrate under the running release and the one-at-a-time boot. Their breaking replacements are the `breakingOnly` steps. */
export const BREAKING_SKIPS: readonly string[] = ["migrate", "rolling-boot"];

/** The steps that read the release (`RM_RELEASE`): the baseline step, on stage and on production, honours the release runbook's `breaking:` declaration. Others get no new variable. */
export const RELEASE_AWARE_STEPS: readonly string[] = ["Q12-state-baseline", "P07-state-baseline"];

/** Turn one template into the command a host runs. */
export function renderStep(step: StepTemplate, target: ReleaseTarget, values: TemplateValues): RenderedStep {
  const common = {
    id: step.id, standing: step.standing, description: step.description, hostRole: step.host,
    irreversible: step.irreversible, expectExit: step.expectExit,
    receipts: step.receipts.map((r) => ({ ...r, dir: fill(r.dir, values) })),
    onlyFor: step.onlyFor, notBefore: notBeforeOf(step, target), maxMillis: maxMillisOf(step),
  };
  if (step.host === "control") {
    // The control machine: its own checkout and its own environment (the git
    // credentials that push a tag live there, never on a host).
    const commands = step.cmds.map((argv) => argv.map((a) => shellQuote(fill(a, values))).join(" "));
    return { ...common, host: CONTROL_HOST, remote: [`cd ${shellQuote(CONTROL_REPO)}`, ...commands].join(" && "), marker: "" };
  }
  const onCapture = step.host === "capture";
  const host = onCapture ? target.capture.host : target.host;
  const checkout = onCapture ? target.capture.checkout : target.checkout;
  const home = onCapture ? target.capture.home : target.home;
  const runDir = fill(onCapture ? CAPTURE_RUN_DIR : RUN_DIR, values);
  const marker = `${runDir}/.step-${step.id}`;
  // `env -i`: nothing the login shell exports reaches a command. Production's
  // /etc/environment exports a doadmin DATABASE_URL and its parts; stage's
  // does not. Only these variables exist, the same names on every host.
  const envPairs: string[] = [`HOME=${shellQuote(home)}`];
  for (const [k, v] of Object.entries(BASE_ENV)) envPairs.push(`${k}=${shellQuote(v)}`);
  if (!onCapture) envPairs.push(`RM_ENV=${shellQuote(target.rmEnv)}`);
  // The release the target file names: a step that honours what only this release declares (the baseline step and `breaking:`) reads it.
  if (!onCapture && RELEASE_AWARE_STEPS.includes(step.id)) envPairs.push(`RM_RELEASE=${shellQuote(target.release)}`);
  for (const [k, v] of Object.entries(step.env ?? {})) envPairs.push(`${k}=${shellQuote(fill(v, values))}`);
  if (step.bootEnv) for (const [k, v] of Object.entries(target.bootEnv).sort()) envPairs.push(`${k}=${shellQuote(v)}`);
  const envCmd = (argv: readonly string[]) => `env -i ${envPairs.join(" ")} ${argv.map((a) => shellQuote(fill(a, values))).join(" ")}`;
  const commands = step.cmds.map(envCmd);
  // A step that owns its checkout clones it first when it is missing (P01-checkout, P04-capture-checkout).
  const clone = step.cloneFrom === undefined ? []
    : [`{ test -e ${shellQuote(`${checkout}/.git`)} || ${envCmd(["git", "clone", "--quiet", step.cloneFrom, checkout])}; }`];
  // A one-time step runs only while its gate file is absent: its own receipt proves the one-time action ran.
  const body = step.gateAbsent === undefined ? commands
    : [`{ if test -e ${shellQuote(fill(step.gateAbsent, values))}; then echo ${shellQuote(`[release] ${step.id} skipped: ${fill(step.gateAbsent, values)} exists`)}; else ${commands.join(" && ")}; fi; }`];
  const remote = [`mkdir -p ${shellQuote(runDir)}`, `touch ${shellQuote(marker)}`, ...clone, `cd ${shellQuote(checkout)}`, ...body].join(" && ");
  return { ...common, host, remote, marker };
}

/**
 * sha256 over the templates, in order. It never sees a target value, so it is
 * the same for every target by construction; it changes whenever a step, a
 * command, an order or a flag changes.
 */
export function stepListHash(steps: readonly StepTemplate[] = RELEASE_STEPS): string {
  const canonical = steps.map((s) => ({
    id: s.id, standing: s.standing, description: s.description, host: s.host, phase: s.phase, cmds: s.cmds,
    env: s.env ?? {}, bootEnv: s.bootEnv ?? false, expectExit: s.expectExit, receipts: s.receipts, irreversible: s.irreversible,
    onlyFor: s.onlyFor ?? null, notBefore: s.notBefore ?? null, triage: s.triage ?? false, cloneFrom: s.cloneFrom ?? null, gateAbsent: s.gateAbsent ?? null,
    // Only a step that carries it: every earlier release's list hashes as it did.
    ...(s.breakingOnly === true ? { breakingOnly: true } : {}),
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
